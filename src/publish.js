'use strict';

const crypto = require('crypto');
const mime = require('mime-types');
const db = require('./db');
const storage = require('./storage');
const { validateZip } = require('./validate-zip');
const config = require('./config');

const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function normalizeVersion(value) {
  return String(value || '').trim();
}

function normalizeTag(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

async function userStorageBytes(userId) {
  const result = await db.query(
    `SELECT COALESCE(SUM(artifact_bytes), 0)::bigint AS total
     FROM releases
     WHERE created_by = $1 AND status <> 'rejected'`,
    [userId]
  );
  return Number(result.rows[0].total);
}

async function ensureTags(client, organizationId, tagNames) {
  const tags = [];
  for (const raw of tagNames || []) {
    const slug = normalizeTag(raw);
    if (!slug) continue;
    const existing = await client.query(
      'SELECT * FROM tags WHERE organization_id = $1 AND slug = $2',
      [organizationId, slug]
    );
    if (existing.rowCount) {
      tags.push(existing.rows[0]);
      continue;
    }
    const created = await client.query(
      'INSERT INTO tags (organization_id, slug, name) VALUES ($1, $2, $3) RETURNING *',
      [organizationId, slug, slug]
    );
    tags.push(created.rows[0]);
  }
  return tags;
}

async function replaceAppTags(client, applicationId, organizationId, tagNames) {
  const tags = await ensureTags(client, organizationId, tagNames);
  await client.query('DELETE FROM application_tags WHERE application_id = $1', [applicationId]);
  for (const tag of tags) {
    await client.query(
      'INSERT INTO application_tags (application_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [applicationId, tag.id]
    );
  }
  return tags;
}

async function createApplication({ user, name, slug, description, tags, multiplayer = false }) {
  const normalizedSlug = normalizeSlug(slug || name);
  if (!normalizedSlug || !SLUG_PATTERN.test(normalizedSlug)) {
    const error = new Error('Choose a URL-safe slug');
    error.status = 400;
    throw error;
  }
  const title = String(name || '').trim();
  if (title.length < 2 || title.length > 80) {
    const error = new Error('Name must be between 2 and 80 characters');
    error.status = 400;
    throw error;
  }

  return db.withTransaction(async (client) => {
    const created = await client.query(
      `INSERT INTO applications (organization_id, slug, name, description, created_by, multiplayer)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        user.organization_id,
        normalizedSlug,
        title,
        String(description || '').slice(0, 2000),
        user.id,
        Boolean(multiplayer),
      ]
    );
    const app = created.rows[0];
    await client.query(
      `INSERT INTO application_memberships (application_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [app.id, user.id]
    );
    const savedTags = await replaceAppTags(client, app.id, user.organization_id, tags);
    return { ...app, tags: savedTags };
  });
}

async function assertCanPublish(user, applicationId) {
  const result = await db.query(
    `SELECT application_memberships.role
     FROM application_memberships
     JOIN applications ON applications.id = application_memberships.application_id
     WHERE application_memberships.application_id = $1
       AND application_memberships.user_id = $2
       AND applications.organization_id = $3`,
    [applicationId, user.id, user.organization_id]
  );
  if (!result.rowCount) {
    const error = new Error('You are not a publisher on this application');
    error.status = 403;
    throw error;
  }
}

async function ingestRelease({ user, application, version, zipBuffer }) {
  const normalizedVersion = normalizeVersion(version);
  if (!VERSION_PATTERN.test(normalizedVersion)) {
    const error = new Error('Version must be 1-32 characters of letters, numbers, dots, underscores, or dashes');
    error.status = 400;
    throw error;
  }

  await assertCanPublish(user, application.id);
  const used = await userStorageBytes(user.id);
  const quota = await db.query(
    `SELECT max_upload_bytes, max_member_storage_bytes
     FROM organization_quotas WHERE organization_id = $1`,
    [user.organization_id]
  );
  const uploadLimit = quota.rowCount
    ? Math.min(config.limits.maxUploadBytes, Number(quota.rows[0].max_upload_bytes))
    : config.limits.maxUploadBytes;
  const storageLimit = quota.rowCount
    ? Math.min(config.limits.maxUserStorageBytes, Number(quota.rows[0].max_member_storage_bytes))
    : config.limits.maxUserStorageBytes;
  if (zipBuffer.length > uploadLimit) {
    const error = new Error('Upload exceeds the organization file limit');
    error.status = 413;
    throw error;
  }
  if (used + zipBuffer.length > storageLimit) {
    const error = new Error('Upload quota exceeded for this publisher');
    error.status = 413;
    throw error;
  }

  let release;
  try {
    const inserted = await db.query(
      `INSERT INTO releases (
         application_id, organization_id, version, status, created_by, artifact_bytes
       ) VALUES ($1, $2, $3, 'quarantine', $4, $5)
       RETURNING *`,
      [application.id, user.organization_id, normalizedVersion, user.id, zipBuffer.length]
    );
    release = inserted.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const error = new Error(`Version ${normalizedVersion} already exists for this application`);
      error.status = 409;
      throw error;
    }
    throw err;
  }

  const quarantineKey = storage.quarantineKey(user.organization_id, release.id);
  await storage.putObject(quarantineKey, zipBuffer, 'application/zip');
  await db.query('UPDATE releases SET quarantine_key = $1, status = $2 WHERE id = $3', [
    quarantineKey,
    'validating',
    release.id,
  ]);

  const validation = await validateZip(zipBuffer);
  if (!validation.ok) {
    await db.query(
      `UPDATE releases
       SET status = 'rejected',
           validation_errors = $1::jsonb,
           validation_warnings = $2::jsonb,
           file_count = $3,
           artifact_bytes = $4,
           validated_at = now()
       WHERE id = $5`,
      [
        JSON.stringify(validation.errors),
        JSON.stringify(validation.warnings),
        validation.fileCount,
        zipBuffer.length,
        release.id,
      ]
    );
    try {
      await storage.deleteObject(quarantineKey);
    } catch {
      // keep the rejected metadata even if quarantine cleanup fails
    }
    const refreshed = await db.query('SELECT * FROM releases WHERE id = $1', [release.id]);
    return { release: refreshed.rows[0], validation };
  }

  const sha256 = crypto.createHash('sha256').update(zipBuffer).digest('hex');
  const prefix = storage.immutablePrefix(user.organization_id, application.id, release.id);
  for (const file of validation.files) {
    const contentType = mime.lookup(file.path) || 'application/octet-stream';
    await storage.putObject(storage.immutableObjectKey(prefix, file.path), file.body, contentType);
  }

  await db.query(
    `UPDATE releases
     SET status = 'validated',
         validation_errors = '[]'::jsonb,
         validation_warnings = $1::jsonb,
         artifact_sha256 = $2,
         artifact_bytes = $3,
         file_count = $4,
         immutable_prefix = $5,
         quarantine_key = NULL,
         validated_at = now()
     WHERE id = $6`,
    [
      JSON.stringify(validation.warnings),
      sha256,
      validation.uncompressedBytes,
      validation.fileCount,
      prefix,
      release.id,
    ]
  );

  try {
    await storage.deleteObject(quarantineKey);
  } catch {
    // immutable copy is the source of truth
  }

  const refreshed = await db.query('SELECT * FROM releases WHERE id = $1', [release.id]);
  return { release: refreshed.rows[0], validation };
}

async function publishRelease({ user, application, releaseId }) {
  await assertCanPublish(user, application.id);
  return db.withTransaction(async (client) => {
    const found = await client.query(
      `SELECT * FROM releases
       WHERE id = $1 AND application_id = $2 AND organization_id = $3
       FOR UPDATE`,
      [releaseId, application.id, user.organization_id]
    );
    if (!found.rowCount) {
      const error = new Error('Release not found');
      error.status = 404;
      throw error;
    }
    const release = found.rows[0];
    if (!['validated', 'unpublished'].includes(release.status)) {
      const error = new Error('Only validated or unpublished releases can be published');
      error.status = 409;
      throw error;
    }
    if (!release.immutable_prefix) {
      const error = new Error('Release has no immutable artifact to publish');
      error.status = 409;
      throw error;
    }
    await client.query(
      `UPDATE releases
       SET status = 'unpublished', unpublished_at = now()
       WHERE application_id = $1 AND status = 'published'`,
      [application.id]
    );
    const published = await client.query(
      `UPDATE releases
       SET status = 'published', published_at = now(), unpublished_at = NULL
       WHERE id = $1
       RETURNING *`,
      [release.id]
    );
    await client.query('UPDATE applications SET updated_at = now() WHERE id = $1', [application.id]);
    return published.rows[0];
  });
}

async function unpublishRelease({ user, application, releaseId, bypassMembership = false }) {
  if (bypassMembership) {
    if (user.role !== 'admin' || application.organization_id !== user.organization_id) {
      const error = new Error('Only an organization admin can pull this release');
      error.status = 403;
      throw error;
    }
  } else {
    await assertCanPublish(user, application.id);
  }
  const found = await db.query(
    `SELECT * FROM releases
     WHERE id = $1 AND application_id = $2 AND organization_id = $3`,
    [releaseId, application.id, user.organization_id]
  );
  if (!found.rowCount) {
    const error = new Error('Release not found');
    error.status = 404;
    throw error;
  }
  if (found.rows[0].status !== 'published') {
    const error = new Error('Only a published release can be unpublished');
    error.status = 409;
    throw error;
  }
  const updated = await db.query(
    `UPDATE releases
     SET status = 'unpublished', unpublished_at = now()
     WHERE id = $1
     RETURNING *`,
    [releaseId]
  );
  return updated.rows[0];
}

module.exports = {
  normalizeSlug,
  normalizeVersion,
  createApplication,
  replaceAppTags,
  ingestRelease,
  publishRelease,
  unpublishRelease,
  assertCanPublish,
  VERSION_PATTERN,
  SLUG_PATTERN,
};
