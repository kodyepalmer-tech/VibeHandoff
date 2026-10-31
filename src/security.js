'use strict';

const helmet = require('helmet');
const config = require('./config');

function createLimiter({ windowMs, max }) {
  const hits = new Map();

  function prune(now) {
    for (const [key, bucket] of hits) {
      if (now - bucket.start >= windowMs) hits.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    if (hits.size > 5000) prune(now);
    const key = `${req.ip}:${req.baseUrl || ''}${req.path}`;
    const bucket = hits.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      res.set('X-RateLimit-Remaining', String(max - 1));
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - bucket.start)) / 1000)));
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    next();
  };
}

const apiLimiter = createLimiter({
  windowMs: config.limits.rateLimitWindowMs,
  max: config.limits.rateLimitMax,
});

const uploadLimiter = createLimiter({
  windowMs: config.limits.uploadRateLimitWindowMs,
  max: config.limits.uploadRateLimitMax,
});

function portalSecurity() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: [config.artifactHostOrigin],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  });
}

function artifactSecurity() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'"],
        connectSrc: ["'none'"],
        formAction: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: [config.portalOrigin],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: false,
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  });
}

function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }
  if (origin !== config.portalOrigin) {
    res.status(403).json({ error: 'Cross-origin request blocked' });
    return;
  }
  next();
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
}

module.exports = {
  createLimiter,
  apiLimiter,
  uploadLimiter,
  portalSecurity,
  artifactSecurity,
  requireSameOrigin,
  clientIp,
};
