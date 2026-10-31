'use strict';

const db = require('./db');

const marketplaceSelect = `
  SELECT
    applications.id,
    applications.organization_id,
    applications.slug,
    applications.name,
    applications.description,
    applications.created_at,
    applications.updated_at,
    applications.multiplayer,
    users.display_name AS creator_name,
    users.email AS creator_email,
    releases.id AS release_id,
    releases.version,
    releases.published_at,
    COALESCE(metrics.launch_count, 0)::int AS launch_count,
    COALESCE(
      (
        SELECT json_agg(json_build_object('slug', tags.slug, 'name', tags.name) ORDER BY tags.slug)
        FROM application_tags
        JOIN tags ON tags.id = application_tags.tag_id
        WHERE application_tags.application_id = applications.id
      ),
      '[]'::json
    ) AS tags
  FROM applications
  JOIN users ON users.id = applications.created_by
  JOIN releases ON releases.application_id = applications.id AND releases.status = 'published'
  LEFT JOIN (
    SELECT application_id, COUNT(*)::int AS launch_count
    FROM launch_events
    GROUP BY application_id
  ) metrics ON metrics.application_id = applications.id
`;

async function listMarketplace({ organizationId, q, tag }) {
  const params = [];
  const where = [];
  if (organizationId) {
    params.push(organizationId);
    where.push(`applications.organization_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(
      `(lower(applications.name) LIKE $${params.length} OR lower(applications.description) LIKE $${params.length} OR lower(applications.slug) LIKE $${params.length})`
    );
  }
  if (tag) {
    params.push(tag.toLowerCase());
    where.push(`EXISTS (
      SELECT 1 FROM application_tags
      JOIN tags ON tags.id = application_tags.tag_id
      WHERE application_tags.application_id = applications.id
        AND tags.slug = $${params.length}
    )`);
  }
  const result = await db.query(
    `${marketplaceSelect}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY metrics.launch_count DESC NULLS LAST, applications.updated_at DESC`,
    params
  );
  return result.rows;
}

async function getMarketplaceApp({ organizationId, slug }) {
  if (!organizationId) {
    const result = await db.query(
      `${marketplaceSelect}
       WHERE applications.slug = $1`,
      [slug]
    );
    if (result.rowCount > 1) {
      const error = new Error('More than one application uses that slug');
      error.status = 409;
      throw error;
    }
    return result.rows[0] || null;
  }
  const result = await db.query(
    `${marketplaceSelect}
     WHERE applications.organization_id = $1 AND applications.slug = $2`,
    [organizationId, slug]
  );
  return result.rows[0] || null;
}

async function getApplicationBySlug({ organizationId, slug }) {
  const result = await db.query(
    `SELECT * FROM applications WHERE organization_id = $1 AND slug = $2`,
    [organizationId, slug]
  );
  return result.rows[0] || null;
}

async function listStudioApps(userId, organizationId) {
  const result = await db.query(
    `SELECT
       applications.*,
       application_memberships.role AS membership_role,
       COALESCE(
         (
           SELECT json_agg(json_build_object(
             'id', releases.id,
             'version', releases.version,
             'status', releases.status,
             'validation_errors', releases.validation_errors,
             'validation_warnings', releases.validation_warnings,
             'created_at', releases.created_at,
             'published_at', releases.published_at
           ) ORDER BY releases.created_at DESC)
           FROM releases
           WHERE releases.application_id = applications.id
         ),
         '[]'::json
       ) AS releases,
       COALESCE(
         (
           SELECT json_agg(json_build_object('slug', tags.slug, 'name', tags.name) ORDER BY tags.slug)
           FROM application_tags
           JOIN tags ON tags.id = application_tags.tag_id
           WHERE application_tags.application_id = applications.id
         ),
         '[]'::json
       ) AS tags
     FROM applications
     JOIN application_memberships ON application_memberships.application_id = applications.id
     WHERE application_memberships.user_id = $1
       AND applications.organization_id = $2
     ORDER BY applications.updated_at DESC`,
    [userId, organizationId]
  );
  return result.rows;
}

async function listReleases(applicationId, organizationId) {
  const result = await db.query(
    `SELECT releases.*, users.display_name AS created_by_name
     FROM releases
     JOIN users ON users.id = releases.created_by
     WHERE releases.application_id = $1 AND releases.organization_id = $2
     ORDER BY releases.created_at DESC`,
    [applicationId, organizationId]
  );
  return result.rows;
}

async function recordLaunch({ organizationId, applicationId, releaseId, userId }) {
  const result = await db.query(
    `INSERT INTO launch_events (organization_id, application_id, release_id, user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [organizationId, applicationId, releaseId, userId]
  );
  return result.rows[0];
}

async function listTags(organizationId) {
  const params = [];
  let orgFilter = '';
  if (organizationId) {
    params.push(organizationId);
    orgFilter = 'WHERE tags.organization_id = $1';
  }
  const result = await db.query(
    `SELECT tags.slug, tags.name, COUNT(application_tags.application_id)::int AS app_count
     FROM tags
     LEFT JOIN application_tags ON application_tags.tag_id = tags.id
     LEFT JOIN applications ON applications.id = application_tags.application_id
     LEFT JOIN releases ON releases.application_id = applications.id AND releases.status = 'published'
     ${orgFilter}
     GROUP BY tags.id
     ORDER BY tags.slug`,
    params
  );
  return result.rows;
}

async function marketplaceMetrics(organizationId) {
  const orgApps = organizationId ? 'WHERE organization_id = $1' : '';
  const orgReleases = organizationId ? 'WHERE organization_id = $1 AND status = \'published\'' : 'WHERE status = \'published\'';
  const orgLaunches = organizationId ? 'WHERE organization_id = $1' : '';
  const result = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM applications ${orgApps})::int AS application_count,
       (SELECT COUNT(*) FROM releases ${orgReleases})::int AS published_release_count,
       (SELECT COUNT(*) FROM launch_events ${orgLaunches})::int AS launch_count`,
    organizationId ? [organizationId] : []
  );
  return result.rows[0];
}

async function listAuditLogs(organizationId, limit = 100) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const result = await db.query(
    `SELECT audit_logs.id, audit_logs.action, audit_logs.resource_type, audit_logs.resource_id,
            audit_logs.ip, audit_logs.metadata, audit_logs.created_at,
            users.email AS actor_email, users.display_name AS actor_name
     FROM audit_logs
     LEFT JOIN users ON users.id = audit_logs.user_id
     WHERE audit_logs.organization_id = $1
     ORDER BY audit_logs.created_at DESC
     LIMIT $2`,
    [organizationId, capped]
  );
  return result.rows;
}

async function listOrgUsers(organizationId) {
  const result = await db.query(
    `SELECT id, email, display_name, role, last_login_at, created_at
     FROM users
     WHERE organization_id = $1
     ORDER BY role, display_name`,
    [organizationId]
  );
  return result.rows;
}

async function listOrgApps(organizationId) {
  const result = await db.query(
    `SELECT
       applications.id,
       applications.slug,
       applications.name,
       users.display_name AS creator_name,
       published.id AS published_release_id,
       published.version AS published_version
     FROM applications
     JOIN users ON users.id = applications.created_by
     LEFT JOIN releases published
       ON published.application_id = applications.id AND published.status = 'published'
     WHERE applications.organization_id = $1
     ORDER BY applications.name`,
    [organizationId]
  );
  return result.rows;
}

async function setUserRole({ organizationId, userId, role }) {
  const allowed = ['admin', 'publisher', 'member'];
  if (!allowed.includes(role)) {
    const error = new Error('Role must be admin, publisher, or member');
    error.status = 400;
    throw error;
  }
  return db.withTransaction(async (client) => {
    const found = await client.query(
      `SELECT id, role FROM users WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [userId, organizationId]
    );
    if (!found.rowCount) {
      const error = new Error('User not found');
      error.status = 404;
      throw error;
    }
    if (found.rows[0].role === 'admin' && role !== 'admin') {
      const admins = await client.query(
        `SELECT COUNT(*)::int AS count FROM users WHERE organization_id = $1 AND role = 'admin'`,
        [organizationId]
      );
      if (admins.rows[0].count <= 1) {
        const error = new Error('The organization needs at least one admin');
        error.status = 409;
        throw error;
      }
    }
    const updated = await client.query(
      `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, display_name, role`,
      [role, userId]
    );
    return { previousRole: found.rows[0].role, user: updated.rows[0] };
  });
}

module.exports = {
  listMarketplace,
  getMarketplaceApp,
  getApplicationBySlug,
  listStudioApps,
  listReleases,
  recordLaunch,
  listTags,
  marketplaceMetrics,
  listAuditLogs,
  listOrgUsers,
  listOrgApps,
  setUserRole,
};
