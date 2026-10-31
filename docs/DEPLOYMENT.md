# Vibe Handoff Enterprise deployment runbook

Vibe Handoff Enterprise is an Express/JavaScript internal app store. The public site is VibeHandoff, on a separate host. Production needs four things: PostgreSQL, S3-compatible object storage, an OIDC provider, and a second origin for untrusted artifacts.

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

`NODE_ENV=production` refuses to start unless `AUTH_ADAPTER=oidc`. The development login (`/api/dev/login`) is not mounted in that mode. The IdP role claim sets a person's role the first time they sign in (`admin`, `publisher`, or `member`; `owner` is treated as `admin`). Later sign-ins keep the role an admin set in the product.

Optional claim mapping: `OIDC_ORG_CLAIM`, `OIDC_ROLE_CLAIM`, `OIDC_DISPLAY_NAME_CLAIM`. Missing org claims fall back to `ORGANIZATION_SLUG`.

OIDC login transactions and rate-limit counters are stored in Postgres, so more than one portal process can serve login and enforce the same limits.

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

Compose starts Postgres, SeaweedFS (private S3 on port 8333), the portal, the artifact host, and seeds Maya Chen (publisher), Jordan Lee (member), and Avery Quinn (admin) with three published demo apps. Open `http://localhost:3000` and use the development identities. `docker-compose.yml` keeps `NODE_ENV=development` unless you override it. A production override must set `AUTH_ADAPTER=oidc` and the OIDC variables or the portal will exit.

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
4. Copy `.env.example` to `.env`. Set `NODE_ENV=production`, `AUTH_ADAPTER=oidc`, both origins, the database URL, the bucket, and the OIDC client. Point `DATABASE_URL` and `S3_ENDPOINT` at those external services, not at the local Compose hostnames.
5. Build the image and start only the two app processes:

```bash
docker build -t vibehandoff:local .
docker compose -f deploy/docker-compose.production.yml up -d
```

Both processes apply migrations on startup. They take the same Postgres advisory lock, so a clean database is safe when portal and artifact host boot together. The image runs as the `node` user, and its health check uses port 3000 for the portal and `ARTIFACT_PORT` for the artifact role.

6. Skip `npm run seed` for a real organization. Seed is the local demo catalog (Maya, Jordan, and Avery).
7. Confirm `/healthz` on both processes.
8. Publish a static ZIP from a publisher identity, then launch it from a member identity.

Put a reverse proxy in front of both origins. [`deploy/Caddyfile`](../deploy/Caddyfile) is a two-host example. Do not share cookies across hosts. Do not place the portal’s identity-aware proxy in front of the artifact host; launch tickets are the only access path.

## Health and operations

- `GET /healthz` — database + object storage
- Structured logs include `audit: true` events and a durable `audit_logs` table
- Upload quotas and rate limits are environment-tunable
- One published release per application; history remains queryable

## From-scratch verification

```bash
./scripts/from-scratch-verify.sh
```
