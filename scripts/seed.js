'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const storage = require('../src/storage');
const auth = require('../src/auth');
const publish = require('../src/publish');
const logger = require('../src/logger');
const { zipFiles } = require('./zip-files');

function readApp(dir) {
  const root = path.join(__dirname, '..', 'fixtures', 'apps', dir);
  const entries = {};
  for (const file of fs.readdirSync(root)) {
    entries[file] = fs.readFileSync(path.join(root, file));
  }
  return entries;
}

async function seed() {
  db.getPool(config.databaseUrl);
  await db.migrate();
  await storage.ensureBucket();

  const maya = await auth.upsertUserFromIdentity({
    issuer: 'https://id.vibehandoff.dev',
    subject: 'maya',
    email: 'maya@acme.example',
    displayName: 'Maya Chen',
    role: 'publisher',
    organizationSlug: config.organizationSlug,
    organizationName: config.organizationName,
  });

  const jordan = await auth.upsertUserFromIdentity({
    issuer: 'https://id.vibehandoff.dev',
    subject: 'jordan',
    email: 'jordan@acme.example',
    displayName: 'Jordan Lee',
    role: 'member',
    organizationSlug: config.organizationSlug,
    organizationName: config.organizationName,
  });

  const apps = [
    {
      name: 'Orbit Sketch',
      slug: 'orbit-sketch',
      description: 'A one-file canvas doodle for cooling down between meetings.',
      tags: ['game', 'creative'],
      version: '1.0.0',
      files: readApp('orbit-sketch'),
    },
    {
      name: 'Standup Timer',
      slug: 'standup-timer',
      description: 'Keep the daily to fifteen minutes without another SaaS tab.',
      tags: ['tool', 'meetings'],
      version: '1.2.0',
      files: readApp('standup-timer'),
    },
    {
      name: 'Pulse Board',
      slug: 'pulse-board',
      description: 'Pin local retro notes. No server, no feed, no social graph.',
      tags: ['tool', 'collaboration'],
      version: '1.0.1',
      files: readApp('pulse-board'),
    },
  ];

  for (const spec of apps) {
    const existing = await db.query(
      'SELECT * FROM applications WHERE organization_id = $1 AND slug = $2',
      [maya.organization_id, spec.slug]
    );
    const application = existing.rowCount
      ? existing.rows[0]
      : (await publish.createApplication({
          user: maya,
          name: spec.name,
          slug: spec.slug,
          description: spec.description,
          tags: spec.tags,
        }));

    const releaseExists = await db.query(
      'SELECT 1 FROM releases WHERE application_id = $1 AND version = $2',
      [application.id, spec.version]
    );
    if (releaseExists.rowCount) continue;

    const zip = await zipFiles(spec.files);
    const { release, validation } = await publish.ingestRelease({
      user: maya,
      application,
      version: spec.version,
      zipBuffer: zip,
    });
    if (!validation.ok) {
      throw new Error(`Seed validation failed for ${spec.slug}: ${validation.errors.join('; ')}`);
    }
    await publish.publishRelease({
      user: maya,
      application,
      releaseId: release.id,
    });
  }

  logger.info({ maya: maya.email, jordan: jordan.email }, 'seeded demo identities and published apps');
}

if (require.main === module) {
  seed()
    .then(async () => {
      await db.getPool().end();
    })
    .catch((err) => {
      logger.error({ err }, 'seed failed');
      process.exit(1);
    });
}

module.exports = { seed };
