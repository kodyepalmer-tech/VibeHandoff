# VibeHandoff deployment runbook

VibeHandoff is an Express/JavaScript internal app store. Production needs four things: PostgreSQL, S3-compatible object storage, an OIDC provider, and a second origin for untrusted artifacts.

## Topology

| Process | Role |
| --- | --- |
| `portal` | Trusted management UI and API |
| `artifact-host` | Untrusted static app origin |
| `postgres` | Catalog, memberships, releases, launches, audit |
| object storage | Private quarantine and immutable release objects |
| OIDC issuer | Organization identity |

`PORTAL_ORIGIN` and `ARTIFACT_HOST_ORIGIN` must be different hostnames. Launched apps load only from the artifact origin, inside a sandboxed iframe, and only after a launch request resolves a published immutable release.

## Configuration

Copy `.env.example` to `.env` and fill every production value from that single file:

- `DATABASE_URL`
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
- `AUTH_ADAPTER=oidc` plus `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`
- `PORTAL_ORIGIN` and `ARTIFACT_HOST_ORIGIN`
- `SESSION_SECRET`

Optional claim mapping: `OIDC_ORG_CLAIM`, `OIDC_ROLE_CLAIM`, `OIDC_DISPLAY_NAME_CLAIM`. Missing org claims fall back to `ORGANIZATION_SLUG`.

Register this callback on the identity provider:

```
${PORTAL_ORIGIN}/auth/callback
```

The bucket must stay private. Never put a public-read policy on quarantine or release prefixes.

## Local staging

```bash
cp .env.example .env
docker compose up --build
```

Compose starts Postgres, MinIO, the portal, the artifact host, and seeds Maya Chen (publisher) plus Jordan Lee (member) with three published demo apps. Open `http://localhost:3000` and use the development identities.

Without Docker, install PostgreSQL and an S3-compatible endpoint, export the same `.env`, then:

```bash
npm ci
npm run migrate
npm run seed
npm start
```

## Production

1. Provision Postgres 16+ and a private S3-compatible bucket.
2. Provision two HTTPS hostnames (portal + artifact).
3. Create an OIDC confidential client with authorization-code + PKCE.
4. Set `NODE_ENV=production` and `AUTH_ADAPTER=oidc`.
5. Build and run the image twice (`APP_ROLE=portal` and `APP_ROLE=artifact`).
6. Run `node scripts/seed.js` only if you want the demo catalog. Skip seed in a real tenant.
7. Confirm `/healthz` on both processes.
8. Publish a static ZIP from a publisher identity, then launch it from a member identity.

Put a reverse proxy in front of both origins. Do not share cookies across hosts. Do not place the portal’s identity-aware proxy in front of the artifact host; launch tickets are the only access path.

## Health and operations

- `GET /healthz` — database + object storage
- Structured logs include `audit: true` events and a durable `audit_logs` table
- Upload quotas and rate limits are environment-tunable
- One published release per application; history remains queryable

## From-scratch verification

```bash
./scripts/from-scratch-verify.sh
```
