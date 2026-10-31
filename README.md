# VibeHandoff

Your company is full of builders. VibeHandoff is where their creations come to life. An internal app store for AI-built games, tools, and shared experiences. Build something. Hand it off. Let everyone play.

This repository is the production-shaped Express/JavaScript vertical slice: a marketplace, a creator studio, and a sandboxed launch path. Uploads are static ZIPs only. The platform never builds or runs server code.

## What is in this slice

- PostgreSQL catalog for users, applications, memberships, tags, releases, launch events, and audit logs
- S3-compatible object storage with quarantine uploads and promotion to immutable release objects
- Static-only ZIP validation, release history, publish/unpublish, and duplicate-version protection
- Marketplace search/filter, app detail, creator dashboard, and isolated iframe launch
- Generic OIDC adapter (plus a development identity adapter for local staging)
- Organization scoping, publisher/member roles, rate limits, upload quotas, and security headers
- Docker Compose staging, CI for tests/syntax/audit, and a launch checklist

## Quick start

```bash
cp .env.example .env
npm install
# PostgreSQL must be reachable at DATABASE_URL
npm run migrate
npm run seed
npm start
```

Open `http://localhost:3000`. Local staging uses the seeded identities:

| Person | Email | Role |
| --- | --- | --- |
| Maya Chen | maya@acme.example | publisher |
| Jordan Lee | jordan@acme.example | member |

Maya owns the demo apps. Jordan can search the marketplace and launch them.

## Tests and CI

```bash
npm run syntax
npm test
npm run audit
```

The suite covers API flows, ZIP validation, security headers/org isolation, and a Playwright launch where a second identity opens another creator’s release.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md).

```bash
docker compose up --build
```

Production uses one environment file for Postgres, object storage, OIDC, and the artifact-host origin. Keep those origins distinct so launched apps cannot share the portal session or become same-origin with privileged APIs.
