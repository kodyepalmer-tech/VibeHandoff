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
    [
      '001_init.sql',
      '002_admin_and_shared_state.sql',
      '003_live_rooms.sql',
      '004_platform_modes.sql',
      '005_export_approvals.sql',
    ]
  );
  const apps = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'applications'"
  );
  assert.equal(apps.rowCount, 1);

  await db.migrate();
  const again = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(again.rows[0].n, 5);
  const view = await pool.query(
    `SELECT 1 FROM information_schema.views
     WHERE table_schema = 'public' AND table_name = 'export_approvals'`
  );
  assert.equal(view.rowCount, 1);

  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS vibe_schema_check CASCADE');
    await client.query('CREATE SCHEMA vibe_schema_check');
    await client.query('SET search_path TO vibe_schema_check');
    const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'schema.sql'), 'utf8');
    await client.query(sql);
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'vibe_schema_check'
         AND table_name IN (
           'users', 'reviews', 'leaderboard_entries', 'organization_quotas',
           'audit_logs', 'application_memberships', 'asset_export_requests', 'user_save_states'
         )
       ORDER BY table_name`
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [
        'application_memberships',
        'asset_export_requests',
        'audit_logs',
        'leaderboard_entries',
        'organization_quotas',
        'reviews',
        'user_save_states',
        'users',
      ]
    );
  } finally {
    await client.query('DROP SCHEMA IF EXISTS vibe_schema_check CASCADE');
    client.release();
  }
  await db.closePool();
});
