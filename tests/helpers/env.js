'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.AUTH_ADAPTER = 'dev';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-not-for-prod';
process.env.PORTAL_ORIGIN = process.env.PORTAL_ORIGIN || 'http://127.0.0.1:13000';
process.env.ARTIFACT_HOST_ORIGIN = process.env.ARTIFACT_HOST_ORIGIN || 'http://127.0.0.1:13001';
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://127.0.0.1:19000';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'vibehandoff-test';
process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'test';
process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'test';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://vibehandoff:vibehandoff@localhost:5432/vibehandoff_test';
process.env.ORGANIZATION_SLUG = 'acme';
process.env.ORGANIZATION_NAME = 'Acme';
