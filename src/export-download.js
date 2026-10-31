'use strict';

const yazl = require('yazl');
const config = require('./config');
const db = require('./db');
const publish = require('./publish');
const queries = require('./queries');
const storage = require('./storage');
const { exportDownloadDecision } = require('./storage-profile');

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function approvedExport(application) {
  const result = await db.query(
    `SELECT id, release_id, organization_id, status
     FROM export_approvals
     WHERE application_id = $1 AND organization_id = $2 AND status = 'approved'
     ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [application.id, application.organization_id]
  );
  return result.rows[0] || null;
}

async function publishedRelease(application) {
  const result = await db.query(
    `SELECT id, version, immutable_prefix
     FROM releases
     WHERE application_id = $1 AND organization_id = $2 AND status = 'published'`,
    [application.id, application.organization_id]
  );
  return result.rows[0] || null;
}

async function releaseById(application, releaseId) {
  const result = await db.query(
    `SELECT id, version, immutable_prefix
     FROM releases
     WHERE id = $1 AND application_id = $2 AND organization_id = $3`,
    [releaseId, application.id, application.organization_id]
  );
  return result.rows[0] || null;
}

async function isCreator(user, application) {
  try {
    await publish.assertCanPublish(user, application.id);
    return true;
  } catch (err) {
    if (err.status === 403) return false;
    throw err;
  }
}

function zipBuffers(files) {
  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    for (const file of files) zipfile.addBuffer(file.body, file.name);
    const chunks = [];
    zipfile.outputStream.on('data', (chunk) => chunks.push(chunk));
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.outputStream.on('error', reject);
    zipfile.end();
  });
}

async function filesForRelease(release) {
  if (!release?.immutable_prefix) throw httpError(404, 'Published files are not available');
  const keys = await storage.listObjects(release.immutable_prefix);
  const prefix = `${release.immutable_prefix}/`;
  const names = keys.filter((key) => key.startsWith(prefix));
  if (!names.length) throw httpError(404, 'Published files are not available');
  if (names.length > config.limits.maxZipFiles) {
    throw httpError(413, 'This package has too many files to download');
  }
  const files = [];
  let total = 0;
  for (const key of names) {
    const name = key.slice(prefix.length);
    if (!name || name.includes('..') || name.startsWith('/')) continue;
    const object = await storage.getObject(key);
    total += object.body.length;
    if (total > config.limits.maxUncompressedBytes) {
      throw httpError(413, 'This package is too large to download');
    }
    files.push({ name, body: object.body });
  }
  if (!files.length) throw httpError(404, 'Published files are not available');
  files.sort((left, right) => left.name.localeCompare(right.name));
  return files;
}

async function buildExportArchive({ user, slug }) {
  const application = await queries.getApplicationBySlug({
    organizationId: user.organization_id,
    slug,
  });
  if (!application) throw httpError(404, 'Application not found');

  const approved = await approvedExport(application);
  const creator = config.platform.mode === 'public' ? await isCreator(user, application) : false;
  const decision = exportDownloadDecision({
    mode: config.platform.mode,
    sameOrganization: application.organization_id === user.organization_id,
    isCreator: creator,
    approved: Boolean(approved),
  });
  if (!decision.ok) throw httpError(decision.status, decision.error);

  let release;
  let exportId = approved ? approved.id : null;
  if (decision.autoApprove) {
    release = await publishedRelease(application);
    if (!release) throw httpError(404, 'Published release not found');
    const inserted = await db.query(
      `INSERT INTO asset_export_requests (
         organization_id, application_id, release_id, requested_by, reviewed_by, status, reviewed_at
       ) VALUES ($1, $2, $3, $4, $4, 'approved', now())
       RETURNING id`,
      [application.organization_id, application.id, release.id, user.id]
    );
    exportId = inserted.rows[0].id;
  } else {
    release = await releaseById(application, approved.release_id);
    if (!release) throw httpError(404, 'Approved release not found');
  }

  const files = await filesForRelease(release);
  const version = String(release.version || 'release').replace(/[^A-Za-z0-9._-]/g, '');
  return {
    body: await zipBuffers(files),
    filename: `${application.slug}-${version}.zip`,
    exportId,
    releaseId: release.id,
  };
}

module.exports = { buildExportArchive };
