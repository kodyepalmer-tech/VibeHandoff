'use strict';

const pino = require('pino');
const config = require('./config');

const logger = pino({
  name: 'vibehandoff',
  level: config.logLevel,
  base: { role: config.appRole, service: 'vibehandoff' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
