'use strict';

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const queries = require('./queries');
const publish = require('./publish');
const { clientIp } = require('./security');
const { buildExportArchive } = require('./export-download');

const SAVE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const HANDLE = /^[a-z0-9_]{3,24}$/;
const MAX_SAVE_CHARS = 16384;
const TRANSFER_NOTE =
  'Nothing is copied to another deployment. A person downloads the static package and uploads it on the other site.';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function reject(message) {
  return (req, res) => {
    res.status(404).json({ error: message });
  };
}

function profilePayload(profile) {
  return {
    mode: profile.mode,
    productName: profile.productName,
    tagline: profile.tagline,
    auth: profile.auth,
    catalog: profile.catalog,
    leaderboardScope: profile.leaderboardScope,
    reviews: profile.reviews,
    exports: profile.exports,
    csp: profile.csp,
  };
}

async function applicationForPlayer(user, slug) {
  if (config.platform.catalog === 'public') {
    const result = await db.query(
      `SELECT * FROM applications WHERE slug = $1 ORDER BY created_at ASC`,
      [slug]
    );
    if (result.rowCount > 1) {
      throw httpError(409, 'More than one application uses that slug');
    }
    return result.rows[0] || null;
  }
  return queries.getApplicationBySlug({
    organizationId: user.organization_id,
    slug,
  });
}

function parseSaveData(data) {
  if (data === null || typeof data !== 'object') {
    throw httpError(400, 'data must be a JSON object or array');
  }
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    throw httpError(400, 'data must be a JSON object or array');
  }
  if (serialized.length > MAX_SAVE_CHARS) {
    throw httpError(413, 'Saved progress is too large');
  }
  return data;
}

function parseScore(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw httpError(400, 'score must be an integer');
  }
  return value;
}

async function publishedRelease(application, releaseId) {
  const params = [application.id, application.organization_id];
  let sql = `SELECT * FROM releases
     WHERE application_id = $1 AND organization_id = $2 AND status = 'published'`;
  if (releaseId) {
    params.push(releaseId);
    sql = `SELECT * FROM releases
      WHERE application_id = $1 AND organization_id = $2 AND id = $3`;
  }
  const found = await db.query(sql, params);
  if (!found.rowCount) {
    throw httpError(404, 'Published release not found');
  }
  if (found.rows[0].status !== 'published') {
    throw httpError(409, 'Only a published release can be exported');
  }
  return found.rows[0];
}

function mountPlatform(app) {
  const profile = config.platform;

  app.get('/api/platform', (req, res) => {
    res.json(profilePayload(profile));
  });

  app.post('/api/user/save-state', auth.requireAuth, async (req, res, next) => {
    try {
      const key = String(req.body?.key || '');
      if (!SAVE_KEY.test(key)) {
        throw httpError(400, 'key must be 1-64 letters, numbers, or . _ : -');
      }
      const data = parseSaveData(req.body?.data);
      const application = await applicationForPlayer(req.user, String(req.body?.slug || ''));
      if (!application) {
        throw httpError(404, 'Application not found');
      }
      const saved = await db.query(
        `INSERT INTO user_save_states (user_id, application_id, state_key, data)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (user_id, application_id, state_key)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()
         RETURNING state_key, data, updated_at`,
        [req.user.id, application.id, key, JSON.stringify(data)]
      );
      res.json({ state: saved.rows[0] });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/user/save-state', auth.requireAuth, async (req, res, next) => {
    try {
      const key = String(req.query.key || '');
      if (!SAVE_KEY.test(key)) {
        throw httpError(400, 'key must be 1-64 letters, numbers, or . _ : -');
      }
      const application = await applicationForPlayer(req.user, String(req.query.slug || ''));
      if (!application) {
        throw httpError(404, 'Application not found');
      }
      const saved = await db.query(
        `SELECT state_key, data, updated_at
         FROM user_save_states
         WHERE user_id = $1 AND application_id = $2 AND state_key = $3`,
        [req.user.id, application.id, key]
      );
      res.json({ state: saved.rows[0] || null });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/leaderboards/submit', auth.requireAuth, async (req, res, next) => {
    try {
      const score = parseScore(req.body?.score);
      const application = await applicationForPlayer(req.user, String(req.body?.slug || ''));
      if (!application) {
        throw httpError(404, 'Application not found');
      }
      const saved = await db.query(
        `INSERT INTO leaderboard_entries (application_id, user_id, organization_id, score)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (application_id, user_id)
         DO UPDATE SET
           score = GREATEST(leaderboard_entries.score, EXCLUDED.score),
           updated_at = CASE
             WHEN EXCLUDED.score > leaderboard_entries.score THEN now()
             ELSE leaderboard_entries.updated_at
           END
         RETURNING score, updated_at`,
        [application.id, req.user.id, application.organization_id, score]
      );
      const stored = Number(saved.rows[0].score);
      res.json({ score: stored, kept: stored === score });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/leaderboards/:slug', auth.requireAuth, async (req, res, next) => {
    try {
      const application = await applicationForPlayer(req.user, req.params.slug);
      if (!application) {
        throw httpError(404, 'Application not found');
      }
      const orgFilter = profile.leaderboardScope === 'organization' ? application.organization_id : null;
      const rows = await db.query(
        `SELECT users.display_name, users.handle, leaderboard_entries.score, leaderboard_entries.updated_at
         FROM leaderboard_entries
         JOIN users ON users.id = leaderboard_entries.user_id
         WHERE leaderboard_entries.application_id = $1
           AND ($2::uuid IS NULL OR leaderboard_entries.organization_id = $2)
         ORDER BY leaderboard_entries.score DESC, leaderboard_entries.updated_at ASC
         LIMIT 20`,
        [application.id, orgFilter]
      );
      res.json({
        scope: profile.leaderboardScope,
        entries: rows.rows.map((row) => ({
          displayName: row.display_name,
          handle: row.handle,
          score: Number(row.score),
          updatedAt: row.updated_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  if (profile.reviews) {
    app.get('/api/apps/:slug/reviews', auth.requireAuth, async (req, res, next) => {
      try {
        const application = await applicationForPlayer(req.user, req.params.slug);
        if (!application) {
          throw httpError(404, 'Application not found');
        }
        const rows = await db.query(
          `SELECT reviews.rating, reviews.body, reviews.updated_at, users.display_name, users.handle
           FROM reviews
           JOIN users ON users.id = reviews.user_id
           WHERE reviews.application_id = $1
           ORDER BY reviews.updated_at DESC
           LIMIT 50`,
          [application.id]
        );
        res.json({ reviews: rows.rows });
      } catch (err) {
        next(err);
      }
    });

    app.post('/api/apps/:slug/reviews', auth.requireAuth, async (req, res, next) => {
      try {
        const rating = req.body?.rating;
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
          throw httpError(400, 'rating must be an integer from 1 to 5');
        }
        const body = String(req.body?.body || '').trim();
        if (body.length > 2000) {
          throw httpError(400, 'review is too long');
        }
        const application = await applicationForPlayer(req.user, req.params.slug);
        if (!application) {
          throw httpError(404, 'Application not found');
        }
        const saved = await db.query(
          `INSERT INTO reviews (application_id, user_id, organization_id, rating, body)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (application_id, user_id)
           DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, updated_at = now()
           RETURNING id, rating, body, updated_at`,
          [application.id, req.user.id, application.organization_id, rating, body]
        );
        res.status(201).json({ review: saved.rows[0] });
      } catch (err) {
        next(err);
      }
    });

    app.patch('/api/me/profile', auth.requireAuth, async (req, res, next) => {
      try {
        const handle = String(req.body?.handle || '').trim().toLowerCase();
        const profileBio = String(req.body?.profileBio || '').trim();
        if (!HANDLE.test(handle)) {
          throw httpError(400, 'handle must be 3-24 lowercase letters, numbers, or underscores');
        }
        if (profileBio.length > 280) {
          throw httpError(400, 'profile is too long');
        }
        const saved = await db.query(
          `UPDATE users SET handle = $2, profile_bio = $3 WHERE id = $1
           RETURNING handle, profile_bio`,
          [req.user.id, handle, profileBio]
        );
        res.json({ profile: saved.rows[0] });
      } catch (err) {
        if (err.code === '23505') {
          err.status = 409;
          err.message = 'That handle is already taken';
        }
        next(err);
      }
    });
  } else {
    const reviewsOff = reject('Reviews are part of the public store.');
    app.get('/api/apps/:slug/reviews', reviewsOff);
    app.post('/api/apps/:slug/reviews', reviewsOff);
    app.patch('/api/me/profile', reject('Public profiles are part of the public store.'));
  }

  app.get('/api/apps/:slug/export/download', auth.requireAuth, async (req, res, next) => {
    try {
      const archive = await buildExportArchive({ user: req.user, slug: req.params.slug });
      await audit.record({
        organizationId: req.user.organization_id,
        userId: req.user.id,
        action: 'export.download',
        resourceType: 'export',
        resourceId: archive.exportId,
        ip: clientIp(req),
        metadata: { slug: req.params.slug, releaseId: archive.releaseId },
      });
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="${archive.filename}"`);
      res.set('Cache-Control', 'no-store');
      res.send(archive.body);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/apps/:slug/exports', auth.requireRole('publisher'), async (req, res, next) => {
    try {
      const application = await queries.getApplicationBySlug({
        organizationId: req.user.organization_id,
        slug: req.params.slug,
      });
      if (!application) {
        throw httpError(404, 'Application not found');
      }
      await publish.assertCanPublish(req.user, application.id);
      const release = await publishedRelease(application, req.body?.releaseId);
      const approved = profile.exports === 'creator';
      const inserted = await db.query(
        `INSERT INTO asset_export_requests (
           organization_id, application_id, release_id, requested_by, reviewed_by, status, reviewed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'approved' THEN now() ELSE NULL END)
         RETURNING id, status, release_id, created_at`,
        [
          application.organization_id,
          application.id,
          release.id,
          req.user.id,
          approved ? req.user.id : null,
          approved ? 'approved' : 'pending',
        ]
      );
      await audit.record({
        organizationId: req.user.organization_id,
        userId: req.user.id,
        action: approved ? 'export.approved' : 'export.request',
        resourceType: 'export',
        resourceId: inserted.rows[0].id,
        ip: clientIp(req),
        metadata: { slug: application.slug, version: release.version },
      });
      res.status(201).json({ export: inserted.rows[0], transfer: TRANSFER_NOTE });
    } catch (err) {
      next(err);
    }
  });

  if (profile.exports === 'admin-approval') {
    app.get('/api/admin/quota', auth.requireRole('admin'), async (req, res, next) => {
      try {
        const row = await db.query(
          `SELECT max_upload_bytes, max_member_storage_bytes, updated_at
           FROM organization_quotas WHERE organization_id = $1`,
          [req.user.organization_id]
        );
        if (!row.rowCount) {
          res.json({
            custom: false,
            maxUploadBytes: config.limits.maxUploadBytes,
            maxMemberStorageBytes: config.limits.maxUserStorageBytes,
          });
          return;
        }
        res.json({
          custom: true,
          maxUploadBytes: Number(row.rows[0].max_upload_bytes),
          maxMemberStorageBytes: Number(row.rows[0].max_member_storage_bytes),
          updatedAt: row.rows[0].updated_at,
        });
      } catch (err) {
        next(err);
      }
    });

    app.put('/api/admin/quota', auth.requireRole('admin'), async (req, res, next) => {
      try {
        const maxUploadBytes = req.body?.maxUploadBytes;
        const maxMemberStorageBytes = req.body?.maxMemberStorageBytes;
        if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
          throw httpError(400, 'maxUploadBytes must be a positive integer');
        }
        if (!Number.isSafeInteger(maxMemberStorageBytes) || maxMemberStorageBytes <= 0) {
          throw httpError(400, 'maxMemberStorageBytes must be a positive integer');
        }
        if (maxUploadBytes > maxMemberStorageBytes) {
          throw httpError(400, 'maxUploadBytes cannot exceed maxMemberStorageBytes');
        }
        if (maxUploadBytes > config.limits.maxUploadBytes || maxMemberStorageBytes > config.limits.maxUserStorageBytes) {
          throw httpError(400, 'A quota can only tighten the deployment limits');
        }
        const saved = await db.query(
          `INSERT INTO organization_quotas (organization_id, max_upload_bytes, max_member_storage_bytes)
           VALUES ($1, $2, $3)
           ON CONFLICT (organization_id)
           DO UPDATE SET max_upload_bytes = EXCLUDED.max_upload_bytes,
                         max_member_storage_bytes = EXCLUDED.max_member_storage_bytes,
                         updated_at = now()
           RETURNING max_upload_bytes, max_member_storage_bytes`,
          [req.user.organization_id, maxUploadBytes, maxMemberStorageBytes]
        );
        await audit.record({
          organizationId: req.user.organization_id,
          userId: req.user.id,
          action: 'quota.update',
          resourceType: 'organization',
          resourceId: req.user.organization_id,
          ip: clientIp(req),
          metadata: {
            maxUploadBytes,
            maxMemberStorageBytes,
          },
        });
        res.json({
          custom: true,
          maxUploadBytes: Number(saved.rows[0].max_upload_bytes),
          maxMemberStorageBytes: Number(saved.rows[0].max_member_storage_bytes),
        });
      } catch (err) {
        next(err);
      }
    });

    app.get('/api/admin/exports', auth.requireRole('admin'), async (req, res, next) => {
      try {
        const rows = await db.query(
          `SELECT asset_export_requests.id, asset_export_requests.status,
                  asset_export_requests.created_at, applications.slug, releases.version,
                  users.display_name AS requested_by
           FROM asset_export_requests
           JOIN applications ON applications.id = asset_export_requests.application_id
           JOIN releases ON releases.id = asset_export_requests.release_id
           JOIN users ON users.id = asset_export_requests.requested_by
           WHERE asset_export_requests.organization_id = $1
           ORDER BY asset_export_requests.created_at DESC
           LIMIT 50`,
          [req.user.organization_id]
        );
        res.json({ exports: rows.rows });
      } catch (err) {
        next(err);
      }
    });

    app.post('/api/admin/exports/:exportId/decision', auth.requireRole('admin'), async (req, res, next) => {
      try {
        const decision = req.body?.decision;
        if (decision !== 'approved' && decision !== 'denied') {
          throw httpError(400, 'decision must be approved or denied');
        }
        const updated = await db.query(
          `UPDATE asset_export_requests
           SET status = $3, reviewed_by = $4, reviewed_at = now(), note = $5
           WHERE id = $1 AND organization_id = $2 AND status = 'pending'
           RETURNING id, status, reviewed_at`,
          [
            req.params.exportId,
            req.user.organization_id,
            decision,
            req.user.id,
            String(req.body?.note || '').slice(0, 500),
          ]
        );
        if (!updated.rowCount) {
          throw httpError(404, 'Pending export not found');
        }
        await audit.record({
          organizationId: req.user.organization_id,
          userId: req.user.id,
          action: decision === 'approved' ? 'export.approved' : 'export.denied',
          resourceType: 'export',
          resourceId: updated.rows[0].id,
          ip: clientIp(req),
          metadata: { decision },
        });
        res.json({ export: updated.rows[0], transfer: TRANSFER_NOTE });
      } catch (err) {
        next(err);
      }
    });
  } else {
    const exportsOff = reject('Export approval is an enterprise control.');
    app.get('/api/admin/exports', exportsOff);
    app.post('/api/admin/exports/:exportId/decision', exportsOff);
    const quotaOff = reject('Organization quotas are an enterprise control.');
    app.get('/api/admin/quota', quotaOff);
    app.put('/api/admin/quota', quotaOff);
  }
}

module.exports = { mountPlatform, profilePayload };
