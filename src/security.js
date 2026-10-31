'use strict';

const helmet = require('helmet');
const config = require('./config');
const db = require('./db');

async function consumeRateLimit(client, key, windowMs, max) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  const existing = await client.query(
    'SELECT window_start, hit_count FROM rate_limit_buckets WHERE bucket_key = $1',
    [key]
  );
  const now = Date.now();
  if (!existing.rowCount || now - new Date(existing.rows[0].window_start).getTime() >= windowMs) {
    await client.query(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, hit_count)
       VALUES ($1, now(), 1)
       ON CONFLICT (bucket_key) DO UPDATE SET window_start = now(), hit_count = 1`,
      [key]
    );
    return { allowed: true, remaining: max - 1, retryAfter: 0 };
  }
  const count = existing.rows[0].hit_count + 1;
  const start = new Date(existing.rows[0].window_start).getTime();
  await client.query('UPDATE rate_limit_buckets SET hit_count = $2 WHERE bucket_key = $1', [key, count]);
  if (count > max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((windowMs - (now - start)) / 1000)),
    };
  }
  return { allowed: true, remaining: Math.max(0, max - count), retryAfter: 0 };
}

function createLimiter({ windowMs, max, name, skip }) {
  return function rateLimit(req, res, next) {
    if (typeof skip === 'function' && skip(req)) {
      next();
      return;
    }
    const key = `${name}:${clientIp(req)}:${req.baseUrl || ''}${req.path}`;
    db.withTransaction((client) => consumeRateLimit(client, key, windowMs, max))
      .then((result) => {
        if (!result.allowed) {
          res.set('Retry-After', String(result.retryAfter));
          res.set('X-RateLimit-Remaining', '0');
          res.status(429).json({ error: 'Too many requests' });
          return;
        }
        res.set('X-RateLimit-Remaining', String(result.remaining));
        next();
      })
      .catch(next);
  };
}

function isLiveRoomTraffic(req) {
  return /\/rooms\/[^/]+\/events$/.test(req.path);
}

const apiLimiter = createLimiter({
  name: 'api',
  windowMs: config.limits.rateLimitWindowMs,
  max: config.limits.rateLimitMax,
  skip: isLiveRoomTraffic,
});

const roomEventsLimiter = createLimiter({
  name: 'room',
  windowMs: 10_000,
  max: 250,
});

const uploadLimiter = createLimiter({
  name: 'upload',
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
        connectSrc: config.platform.csp === 'strict' ? ["'none'"] : ["'self'"],
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
  consumeRateLimit,
  apiLimiter,
  roomEventsLimiter,
  uploadLimiter,
  portalSecurity,
  artifactSecurity,
  requireSameOrigin,
  clientIp,
};
