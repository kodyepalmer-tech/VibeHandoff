'use strict';

const config = require('./config');
const db = require('./db');
const logger = require('./logger');

db.getPool(config.databaseUrl);
db.migrate()
  .then(() => {
    logger.info('migrations complete');
    return db.getPool().end();
  })
  .catch((err) => {
    logger.error({ err }, 'migration failed');
    process.exit(1);
  });
