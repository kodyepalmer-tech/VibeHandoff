'use strict';

const http = require('http');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const storage = require('./storage');
const { createPortalApp } = require('./portal');
const { createArtifactApp } = require('./artifact-host');

async function start() {
  db.getPool(config.databaseUrl);
  await db.migrate();
  await storage.ensureBucket();

  const servers = [];
  const role = config.appRole;

  if (role === 'portal' || role === 'all') {
    const portal = http.createServer(createPortalApp());
    await new Promise((resolve) => portal.listen(config.portalPort, resolve));
    logger.info({ port: config.portalPort, origin: config.portalOrigin }, 'portal listening');
    servers.push(portal);
  }

  if (role === 'artifact' || role === 'all') {
    const artifacts = http.createServer(createArtifactApp());
    await new Promise((resolve) => artifacts.listen(config.artifactPort, resolve));
    logger.info({ port: config.artifactPort, origin: config.artifactHostOrigin }, 'artifact host listening');
    servers.push(artifacts);
  }

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
          })
      )
    );
    await db.getPool().end();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((err) => {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  });
}

module.exports = { start };
