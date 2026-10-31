'use strict';

const path = require('path');

require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env') });

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function required(name, value) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const { platformProfile } = require('./platform');

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const platform = platformProfile((process.env.PLATFORM_MODE || 'enterprise').toLowerCase());

const config = {
  nodeEnv,
  isProduction,
  logLevel: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  appRole: process.env.APP_ROLE || 'all',
  portalPort: intEnv('PORTAL_PORT', intEnv('PORT', 3000)),
  artifactPort: intEnv('ARTIFACT_PORT', 3001),
  portalOrigin: process.env.PORTAL_ORIGIN || `http://localhost:${intEnv('PORTAL_PORT', intEnv('PORT', 3000))}`,
  artifactHostOrigin:
    process.env.ARTIFACT_HOST_ORIGIN || `http://localhost:${intEnv('ARTIFACT_PORT', 3001)}`,
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://vibehandoff:vibehandoff@localhost:5432/vibehandoff',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-session-secret-change-me',
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'vh_session',
  sessionTtlSeconds: intEnv('SESSION_TTL_SECONDS', 60 * 60 * 12),
  platformMode: platform.mode,
  platform,
  authAdapter: (process.env.AUTH_ADAPTER || 'dev').toLowerCase(),
  organizationSlug: process.env.ORGANIZATION_SLUG || 'acme',
  organizationName: process.env.ORGANIZATION_NAME || 'Acme',
  oidc: {
    issuer: process.env.OIDC_ISSUER || '',
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    redirectUri: process.env.OIDC_REDIRECT_URI || '',
    scopes: process.env.OIDC_SCOPES || 'openid email profile',
    orgClaim: process.env.OIDC_ORG_CLAIM || 'organization',
    roleClaim: process.env.OIDC_ROLE_CLAIM || 'role',
    displayNameClaim: process.env.OIDC_DISPLAY_NAME_CLAIM || 'name',
    defaultRole: process.env.OIDC_DEFAULT_ROLE || 'member',
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT || '',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'vibehandoff-artifacts',
    accessKey: process.env.S3_ACCESS_KEY || 'vibehandoff',
    secretKey: process.env.S3_SECRET_KEY || 'vibehandoff-secret',
    forcePathStyle: boolEnv('S3_FORCE_PATH_STYLE', true),
  },
  limits: {
    maxUploadBytes: intEnv('MAX_UPLOAD_BYTES', 15 * 1024 * 1024),
    maxUncompressedBytes: intEnv('MAX_UNCOMPRESSED_BYTES', 50 * 1024 * 1024),
    maxZipFiles: intEnv('MAX_ZIP_FILES', 500),
    maxUserStorageBytes: intEnv('MAX_USER_STORAGE_BYTES', 200 * 1024 * 1024),
    launchTicketTtlSeconds: intEnv('LAUNCH_TICKET_TTL_SECONDS', 900),
    rateLimitWindowMs: intEnv('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMax: intEnv('RATE_LIMIT_MAX', 120),
    uploadRateLimitWindowMs: intEnv('UPLOAD_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
    uploadRateLimitMax: intEnv('UPLOAD_RATE_LIMIT_MAX', 10),
  },
};

function assertProductionConfig() {
  if (!isProduction) return;
  required('SESSION_SECRET', process.env.SESSION_SECRET);
  required('DATABASE_URL', process.env.DATABASE_URL);
  required('S3_BUCKET', process.env.S3_BUCKET);
  required('S3_ACCESS_KEY', process.env.S3_ACCESS_KEY);
  required('S3_SECRET_KEY', process.env.S3_SECRET_KEY);
  required('PORTAL_ORIGIN', process.env.PORTAL_ORIGIN);
  required('ARTIFACT_HOST_ORIGIN', process.env.ARTIFACT_HOST_ORIGIN);
  if (config.portalOrigin === config.artifactHostOrigin) {
    throw new Error('PORTAL_ORIGIN and ARTIFACT_HOST_ORIGIN must be different origins');
  }
  if (config.platformMode === 'public') {
    if (config.authAdapter !== 'oauth') {
      throw new Error('AUTH_ADAPTER must be oauth in production when PLATFORM_MODE=public');
    }
    const providerIds = [
      process.env.OAUTH_DISCORD_CLIENT_ID,
      process.env.OAUTH_GOOGLE_CLIENT_ID,
      process.env.OAUTH_GITHUB_CLIENT_ID,
      process.env.OAUTH_APPLE_CLIENT_ID,
    ];
    if (!providerIds.some((value) => value)) {
      throw new Error('At least one public OAuth provider client id is required');
    }
    return;
  }
  if (config.authAdapter !== 'oidc') {
    throw new Error('AUTH_ADAPTER must be oidc in production');
  }
  required('OIDC_ISSUER', process.env.OIDC_ISSUER);
  required('OIDC_CLIENT_ID', process.env.OIDC_CLIENT_ID);
  required('OIDC_CLIENT_SECRET', process.env.OIDC_CLIENT_SECRET);
  required('OIDC_REDIRECT_URI', process.env.OIDC_REDIRECT_URI);
}

assertProductionConfig();

module.exports = config;
