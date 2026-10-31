'use strict';

const path = require('path');
const express = require('express');
const pinoHttp = require('pino-http');
const mime = require('mime-types');
const config = require('./config');
const logger = require('./logger');
const storage = require('./storage');
const { verifyLaunchTicket } = require('./tickets');
const security = require('./security');

function safeRelativePath(urlPath) {
  const decoded = decodeURIComponent(urlPath || 'index.html');
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('..')) {
    return null;
  }
  return normalized;
}

function createArtifactApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(pinoHttp({ logger, autoLogging: config.nodeEnv !== 'test' }));
  app.use(security.artifactSecurity());
  app.use((req, res, next) => {
    res.set('X-VibeHandoff-Isolation', 'artifact-origin');
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', async (req, res) => {
    try {
      await storage.healthcheck();
      res.json({
        status: 'ok',
        role: 'artifact',
        mode: config.platformMode,
        product: config.platform.productName,
        origin: config.artifactHostOrigin,
      });
    } catch (err) {
      res.status(503).json({ status: 'error', error: err.message });
    }
  });

  app.get('/launch/:ticket/*', async (req, res) => {
    const verified = verifyLaunchTicket(req.params.ticket);
    if (!verified.ok) {
      res.status(403).type('html').send(`<!doctype html><title>Launch denied</title><p>${verified.error}</p>`);
      return;
    }
    const relative = safeRelativePath(req.params[0]);
    if (!relative) {
      res.status(400).send('Invalid artifact path');
      return;
    }
    const key = storage.immutableObjectKey(verified.claims.prefix, relative);
    try {
      const object = await storage.getObject(key);
      const contentType = mime.lookup(relative) || object.contentType || 'application/octet-stream';
      res.set('Content-Type', contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(object.body);
    } catch (err) {
      if (err.$metadata?.httpStatusCode === 404 || err.name === 'NoSuchKey' || err.Code === 'NoSuchKey') {
        res.status(404).send('Artifact file not found');
        return;
      }
      logger.error({ err, key }, 'artifact fetch failed');
      res.status(500).send('Artifact host error');
    }
  });

  app.use((req, res) => {
    res.status(404).send('Not found');
  });

  return app;
}

module.exports = { createArtifactApp };
