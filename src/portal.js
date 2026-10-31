'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const storage = require('./storage');
const audit = require('./audit');
const queries = require('./queries');
const publish = require('./publish');
const { issueLaunchTicket } = require('./tickets');
const auth = require('./auth');
const security = require('./security');
const { attachAdminRoutes } = require('./admin');
const { attachRoomRoutes } = require('./rooms');
const { mountPlatform } = require('./platform-router');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.maxUploadBytes, files: 1 },
});

function catalogOrganizationId(user) {
  if (config.platform.catalog === 'public') return null;
  return user.organization_id;
}

function sendError(res, err) {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) {
    logger.error({ err }, 'portal error');
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
}

function createPortalApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(pinoHttp({ logger, autoLogging: config.nodeEnv !== 'test' }));
  app.use(security.portalSecurity());
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());
  app.use(auth.sessionMiddleware);
  app.use(security.requireSameOrigin);
  app.use('/api', security.apiLimiter);
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: '1h' }));

  auth.attachAuthRoutes(app);

  app.get('/healthz', async (req, res) => {
    try {
      const database = await db.healthcheck();
      const objectStorage = await storage.healthcheck();
      res.json({
        status: 'ok',
        role: 'portal',
        mode: config.platformMode,
        product: config.platform.productName,
        database,
        objectStorage,
        artifactHostOrigin: config.artifactHostOrigin,
      });
    } catch (err) {
      res.status(503).json({ status: 'error', error: err.message });
    }
  });

  app.get('/api/apps', auth.requireAuth, async (req, res) => {
    try {
      const apps = await queries.listMarketplace({
        organizationId: catalogOrganizationId(req.user),
        q: req.query.q,
        tag: req.query.tag,
      });
      res.json({ apps });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/tags', auth.requireAuth, async (req, res) => {
    try {
      const tags = await queries.listTags(catalogOrganizationId(req.user));
      res.json({ tags });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/metrics', auth.requireAuth, async (req, res) => {
    try {
      const metrics = await queries.marketplaceMetrics(catalogOrganizationId(req.user));
      res.json({ metrics });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/apps/:slug', auth.requireAuth, async (req, res) => {
    try {
      const appRow = await queries.getMarketplaceApp({
        organizationId: catalogOrganizationId(req.user),
        slug: req.params.slug,
      });
      if (!appRow) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      res.json({ app: appRow });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/apps', auth.requireRole('publisher'), async (req, res) => {
    try {
      const created = await publish.createApplication({
        user: req.user,
        name: req.body.name,
        slug: req.body.slug,
        description: req.body.description,
        tags: req.body.tags,
        multiplayer: req.body.multiplayer,
      });
      await audit.record({
        organizationId: req.user.organization_id,
        userId: req.user.id,
        action: 'application.create',
        resourceType: 'application',
        resourceId: created.id,
        ip: security.clientIp(req),
        metadata: { slug: created.slug },
      });
      res.status(201).json({ app: created });
    } catch (err) {
      if (err.code === '23505') {
        err.status = 409;
        err.message = 'An application with that slug already exists';
      }
      sendError(res, err);
    }
  });

  app.get('/api/studio/apps', auth.requireRole('publisher'), async (req, res) => {
    try {
      const apps = await queries.listStudioApps(req.user.id, req.user.organization_id);
      res.json({ apps });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/apps/:slug/releases', auth.requireRole('publisher'), async (req, res) => {
    try {
      const application = await queries.getApplicationBySlug({
        organizationId: req.user.organization_id,
        slug: req.params.slug,
      });
      if (!application) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      await publish.assertCanPublish(req.user, application.id);
      const releases = await queries.listReleases(application.id, req.user.organization_id);
      res.json({ releases });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post(
    '/api/apps/:slug/releases',
    auth.requireRole('publisher'),
    security.uploadLimiter,
    upload.single('artifact'),
    async (req, res) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'artifact ZIP is required' });
          return;
        }
        const application = await queries.getApplicationBySlug({
          organizationId: req.user.organization_id,
          slug: req.params.slug,
        });
        if (!application) {
          res.status(404).json({ error: 'Application not found' });
          return;
        }
        const { release, validation } = await publish.ingestRelease({
          user: req.user,
          application,
          version: req.body.version,
          zipBuffer: req.file.buffer,
        });
        await audit.record({
          organizationId: req.user.organization_id,
          userId: req.user.id,
          action: validation.ok ? 'release.validate' : 'release.reject',
          resourceType: 'release',
          resourceId: release.id,
          ip: security.clientIp(req),
          metadata: {
            slug: application.slug,
            version: release.version,
            status: release.status,
            errors: validation.errors,
          },
        });
        res.status(validation.ok ? 201 : 422).json({ release, validation });
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  app.post('/api/apps/:slug/releases/:releaseId/publish', auth.requireRole('publisher'), async (req, res) => {
    try {
      const application = await queries.getApplicationBySlug({
        organizationId: req.user.organization_id,
        slug: req.params.slug,
      });
      if (!application) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      const release = await publish.publishRelease({
        user: req.user,
        application,
        releaseId: req.params.releaseId,
      });
      await audit.record({
        organizationId: req.user.organization_id,
        userId: req.user.id,
        action: 'release.publish',
        resourceType: 'release',
        resourceId: release.id,
        ip: security.clientIp(req),
        metadata: { slug: application.slug, version: release.version },
      });
      res.json({ release });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/apps/:slug/releases/:releaseId/unpublish', auth.requireRole('publisher'), async (req, res) => {
    try {
      const application = await queries.getApplicationBySlug({
        organizationId: req.user.organization_id,
        slug: req.params.slug,
      });
      if (!application) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      const release = await publish.unpublishRelease({
        user: req.user,
        application,
        releaseId: req.params.releaseId,
      });
      await audit.record({
        organizationId: req.user.organization_id,
        userId: req.user.id,
        action: 'release.unpublish',
        resourceType: 'release',
        resourceId: release.id,
        ip: security.clientIp(req),
        metadata: { slug: application.slug, version: release.version },
      });
      res.json({ release });
    } catch (err) {
      sendError(res, err);
    }
  });

  attachAdminRoutes(app);
  attachRoomRoutes(app, { requireAuth: auth.requireAuth });
  // PLATFORM_MODE chooses reviews, export approval, quotas, and leaderboard scope.
  mountPlatform(app);

  app.post('/api/apps/:slug/launch', auth.requireAuth, async (req, res) => {
    try {
      const appRow = await queries.getMarketplaceApp({
        organizationId: catalogOrganizationId(req.user),
        slug: req.params.slug,
      });
      if (!appRow) {
        res.status(404).json({ error: 'No published release is available to launch' });
        return;
      }
      const release = await db.query(
        `SELECT * FROM releases WHERE id = $1 AND organization_id = $2 AND status = 'published'`,
        [appRow.release_id, appRow.organization_id]
      );
      if (!release.rowCount || !release.rows[0].immutable_prefix) {
        res.status(404).json({ error: 'Published artifact is not available' });
        return;
      }
      const ticket = issueLaunchTicket({
        userId: req.user.id,
        organizationId: appRow.organization_id,
        applicationId: appRow.id,
        releaseId: release.rows[0].id,
        prefix: release.rows[0].immutable_prefix,
      });
      await queries.recordLaunch({
        organizationId: appRow.organization_id,
        applicationId: appRow.id,
        releaseId: release.rows[0].id,
        userId: req.user.id,
      });
      await audit.record({
        organizationId: appRow.organization_id,
        userId: req.user.id,
        action: 'release.launch',
        resourceType: 'release',
        resourceId: release.rows[0].id,
        ip: security.clientIp(req),
        metadata: { slug: appRow.slug, version: release.rows[0].version },
      });
      res.json({
        launchUrl: `${config.artifactHostOrigin}/launch/${ticket}/index.html`,
        ticketTtlSeconds: config.limits.launchTicketTtlSeconds,
        release: {
          id: release.rows[0].id,
          version: release.rows[0].version,
        },
        sandbox: 'allow-scripts allow-forms allow-pointer-lock',
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  const pages = {
    '/': 'index.html',
    '/login': 'login.html',
    '/studio': 'studio.html',
    '/admin': 'admin.html',
  };

  app.get(Object.keys(pages), (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', pages[req.path]));
  });

  app.get('/apps/:slug', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
  });

  app.get('/apps/:slug/launch', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'launch.html'));
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(404).sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((err, req, res, _next) => {
    sendError(res, err);
  });

  return app;
}

module.exports = { createPortalApp };
