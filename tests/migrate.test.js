'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/env');

const db = require('../src/db');

test('two startups apply each migration once', async () => {
  const pool = db.getPool(process.env.DATABASE_URL);
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');

  await Promise.all([db.migrate(), db.migrate()]);

  const applied = await pool.query('SELECT id FROM schema_migrations ORDER BY id');
  assert.deepEqual(
    applied.rows.map((row) => row.id),
    ['001_init.sql', '002_admin_and_shared_state.sql']
  );
  const apps = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'applications'"
  );
  assert.equal(apps.rowCount, 1);

  await db.migrate();
  const again = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(again.rows[0].n, 2);
  await db.closePool();
});
