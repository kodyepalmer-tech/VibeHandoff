'use strict';

require('./env');

const http = require('http');
const request = require('supertest');
const { createS3Mock } = require('./s3-mock');

let shared;

async function resetDatabase(db) {
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
  await db.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
  await db.migrate();
}

async function startHarness(options = {}) {
  if (shared && !options.fresh) return shared;

  const s3 = createS3Mock();
  const s3Url = await s3.listen(0);
  process.env.S3_ENDPOINT = s3Url;

  try {
  const config = require('../../src/config');
  const db = require('../../src/db');
  const storage = require('../../src/storage');
  storage.setClient(storage.createS3Client({ endpoint: s3Url }));
  db.getPool(config.databaseUrl);
  await resetDatabase(db);
  await storage.ensureBucket();
  const { seed } = require('../../scripts/seed');
  await seed();

  const { createPortalApp } = require('../../src/portal');
  const { createArtifactApp } = require('../../src/artifact-host');
  const portalApp = createPortalApp();
  const artifactApp = createArtifactApp();

  let portalServer;
  let artifactServer;
  if (options.listen) {
    portalServer = http.createServer(portalApp);
    artifactServer = http.createServer(artifactApp);
    await new Promise((resolve) => portalServer.listen(13000, '127.0.0.1', resolve));
    await new Promise((resolve) => artifactServer.listen(13001, '127.0.0.1', resolve));
  }

  shared = {
    portalApp,
    artifactApp,
    portalServer,
    artifactServer,
    s3,
    db,
    request: request(portalApp),
    artifactRequest: request(artifactApp),
    async login(email) {
      const agent = request.agent(portalApp);
      const response = await agent.post('/api/dev/login').send({ email });
      if (response.status !== 200) {
        throw new Error(`login failed for ${email}: ${response.status} ${response.text}`);
      }
      return agent;
    },
    async close() {
      if (portalServer) await new Promise((resolve) => portalServer.close(resolve));
      if (artifactServer) await new Promise((resolve) => artifactServer.close(resolve));
      await s3.close();
      await db.closePool();
      shared = null;
    },
  };
  return shared;
  } catch (err) {
    await s3.close();
    throw err;
  }
}

module.exports = { startHarness };
