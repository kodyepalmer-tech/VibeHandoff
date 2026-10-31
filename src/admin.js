'use strict';

const audit = require('./audit');
const auth = require('./auth');
const publish = require('./publish');
const queries = require('./queries');
const { clientIp } = require('./security');

function attachAdminRoutes(app) {
  app.get('/api/admin/audit', auth.requireRole('admin'), async (req, res, next) => {
    try {
      const logs = await queries.listAuditLogs(req.user.organization_id, req.query.limit);
      res.json({ logs });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/users', auth.requireRole('admin'), async (req, res, next) => {
    try {
      const users = await queries.listOrgUsers(req.user.organization_id);
      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/users/:userId/role', auth.requireRole('admin'), async (req, res, next) => {
    try {
      const result = await queries.setUserRole({
        organizationId: req.user.organization_id,
        userId: req.params.userId,
        role: req.body?.role,
      });
      await audit.record({
        organizationId: req.user.organization_id,
        userId: req.user.id,
        action: 'user.role',
        resourceType: 'user',
        resourceId: result.user.id,
        ip: clientIp(req),
        metadata: {
          email: result.user.email,
          from: result.previousRole,
          to: result.user.role,
        },
      });
      res.json({ user: result.user });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/apps', auth.requireRole('admin'), async (req, res, next) => {
    try {
      const apps = await queries.listOrgApps(req.user.organization_id);
      res.json({ apps });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/apps/:slug/takedown', auth.requireRole('admin'), async (req, res, next) => {
    try {
      const application = await queries.getApplicationBySlug({
        organizationId: req.user.organization_id,
        slug: req.params.slug,
      });
      if (!application) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      const apps = await queries.listOrgApps(req.user.organization_id);
      const current = apps.find((appRow) => appRow.id === application.id);
      if (!current?.published_release_id) {
        res.status(409).json({ error: 'This application has no published release' });
        return;
      }
      const release = await publish.unpublishRelease({
        user: req.user,
        application,
        releaseId: current.published_release_id,
        bypassMembership: true,
      });
      await audit.record({
        organizationId: req.user.organization_id,
        userId: req.user.id,
        action: 'release.takedown',
        resourceType: 'release',
        resourceId: release.id,
        ip: clientIp(req),
        metadata: { slug: application.slug, version: release.version },
      });
      res.json({ release });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { attachAdminRoutes };
