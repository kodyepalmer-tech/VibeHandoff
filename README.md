# VibeHandoff

Your company is full of builders. VibeHandoff is the internal shelf where their games, tools, and shared experiments go live. Someone publishes a static web app. Everyone else in the organization can find it and play it. The portal never runs their code.

## What you can do

| Who | What they do |
| --- | --- |
| Member | Search the marketplace, open an app, and launch the current release in a sandboxed frame. |
| Publisher | Create an app, upload a static ZIP, read validation feedback, and publish or unpublish a version. |
| Admin | Read the audit log, change who can publish, and pull a live app without waiting on its creator. |

Uploads are static files only: HTML, CSS, JavaScript, and assets, with `index.html` at the root. Server code, build manifests, and executables are rejected. Nothing is built or executed on the platform.

A launch is served from a second origin. The iframe sandbox does not get `allow-same-origin`, and the artifact host does not accept the portal session.

## Run it locally

Docker Compose is the supported local deploy. It starts Postgres, private object storage (SeaweedFS), the portal, the artifact host, and the demo catalog.

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) and sign in as one of the seeded people:

| Person | Email | Role |
| --- | --- | --- |
| Maya Chen | maya@acme.example | publisher |
| Jordan Lee | jordan@acme.example | member |
| Avery Quinn | avery@acme.example | admin |

Maya owns Orbit Sketch, Standup Timer, and Pulse Board. Jordan can find those apps and launch them. Avery’s Admin desk can change a role or pull a release off the shelf.

The portal listens on port 3000. Launched apps load from port 3001. Leave `NODE_ENV=development` for this stack. Production mode refuses the development login.

### Without Docker

You need PostgreSQL 16 and an S3-compatible endpoint. Copy the template, then start both processes from one checkout. `APP_ROLE=all` listens on both ports.

```bash
cp .env.example .env
npm ci
npm run migrate
npm run seed
npm start
```

`npm start` serves the portal on `PORTAL_PORT` (3000) and the artifact host on `ARTIFACT_PORT` (3001).

## Deploy it for a company

Production needs four things, all set from one environment file (see [`.env.example`](.env.example)):

1. PostgreSQL 16 or newer.
2. A private S3-compatible bucket. Do not grant public read.
3. Two HTTPS hostnames: one for the portal, one for launched apps.
4. An OIDC confidential client (authorization code + PKCE). Register the callback `${PORTAL_ORIGIN}/auth/callback`.

```bash
docker build -t vibehandoff:local .
# Fill .env with production values, including AUTH_ADAPTER=oidc.
docker compose -f deploy/docker-compose.production.yml up -d
```

`NODE_ENV=production` will not start unless `AUTH_ADAPTER=oidc`. The development login route is absent in that mode. The identity-provider role claim (`admin`, `publisher`, or `member`) is stored the first time someone signs in. A role an admin sets later is kept on the next sign-in.

Both processes apply database migrations when they start. A Postgres lock keeps them from applying the same file twice, so there is no separate migrate step. Skip `npm run seed` for a real organization. The demo people exist only for local staging. The image runs as the `node` user.

Put a reverse proxy in front of each origin. Do not share cookies across the two hostnames, and do not put the portal’s login proxy in front of the artifact host. Launch tickets are the only way to read a published file. A Caddy example is [`deploy/Caddyfile`](deploy/Caddyfile).

The operator steps, health checks, and claim mapping are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The pilot gate is [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md).

Confirm both processes:

```bash
curl -fsS https://apps.example.com/healthz
curl -fsS https://play.example.com/healthz
```

## Tests

```bash
npm run syntax
npm test
npm run audit
```

GitHub Actions runs that suite on every pull request and on every push to `main`. The tests cover the marketplace, ZIP policy, organization isolation, the admin pull, and a browser launch of another creator’s release.

## Layout

```
src/            Portal, artifact host, auth, publishing, storage
public/         Marketplace, studio, admin desk, launch frame
migrations/     Postgres schema
deploy/         Production Compose file and Caddy example
fixtures/apps/  Demo static apps seeded locally
docs/           Deployment runbook and launch checklist
```
