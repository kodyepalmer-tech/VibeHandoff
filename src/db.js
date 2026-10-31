'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const logger = require('./logger');

let pool;
let defaultDatabaseUrl;

function getPool(databaseUrl) {
  if (databaseUrl) defaultDatabaseUrl = databaseUrl;
  if (!pool) {
    pool = new Pool({
      connectionString: defaultDatabaseUrl,
      max: 10,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => {
      logger.error({ err }, 'postgres pool error');
    });
  }
  return pool;
}

function setPool(next) {
  pool = next;
}

function hasPool() {
  return Boolean(pool);
}

async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Stable lock so the portal and the artifact host can boot together.
const MIGRATION_LOCK_KEY = 748211;

async function migrate(databaseUrl) {
  const active = databaseUrl ? new Pool({ connectionString: databaseUrl }) : getPool();
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  let client;
  try {
    client = await active.connect();
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
      if (applied.rowCount) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      logger.info({ file }, 'applied migration');
    }
  } finally {
    if (client) {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch((err) => {
        logger.warn({ err: err.message }, 'migration lock release failed');
      });
      client.release();
    }
    if (databaseUrl) {
      await active.end();
    }
  }
}

async function healthcheck() {
  const result = await query('SELECT 1 AS ok');
  return result.rows[0].ok === 1;
}

module.exports = {
  getPool,
  setPool,
  hasPool,
  closePool,
  query,
  withTransaction,
  migrate,
  healthcheck,
};
