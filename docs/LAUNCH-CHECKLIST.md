# Launch checklist

Use this before inviting a pilot team onto VibeHandoff.

## Product gate

- [ ] Marketplace lists only published, org-scoped apps
- [ ] App detail shows creator, tags, version, description, and Launch
- [ ] Creator studio can create an app, upload a ZIP, see validation, publish, and unpublish
- [ ] Duplicate versions are rejected
- [ ] A second identity can search, open, and launch another creator’s release
- [ ] Profiles and social features remain out of scope

## Security gate

- [ ] `PORTAL_ORIGIN` ≠ `ARTIFACT_HOST_ORIGIN`
- [ ] OIDC login works against the real issuer (`AUTH_ADAPTER=oidc`)
- [ ] Publisher/member roles are enforced on API routes
- [ ] Artifact bucket has no public ACL
- [ ] Direct artifact URLs 403/404 without a launch ticket
- [ ] Launch iframe `sandbox` has no `allow-same-origin`
- [ ] Artifact CSP includes `connect-src 'none'` and `frame-ancestors` of the portal
- [ ] Portal session cookie is `HttpOnly`, `SameSite=Lax`, and host-scoped
- [ ] Rate limits, upload quotas, and security headers are enabled
- [ ] Audit log records login, publish, unpublish, reject, and launch

## Upload policy

- [ ] Static ZIP only (`index.html` at the root)
- [ ] Server files, build manifests, executables, and zip-slip paths are rejected
- [ ] Platform does not build or run uploaded code

## Operations gate

- [ ] `npm run syntax`, `npm test`, and `npm run audit` are green
- [ ] `/healthz` is green on portal and artifact host
- [ ] Postgres migrations apply on a clean database
- [ ] Seeded demo data is optional and documented
- [ ] Deployment runbook reviewed (`docs/DEPLOYMENT.md`)
- [ ] Session secret and OIDC client secret are not committed

## CI

GitHub Actions runs syntax checks, API/upload/browser tests, and `npm audit --audit-level=high` on every pull request.
