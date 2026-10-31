'use strict';

const crypto = require('crypto');
const { Issuer, generators } = require('openid-client');
const config = require('./config');
const db = require('./db');
const audit = require('./audit');
const { clientIp } = require('./security');

let oidcClientPromise;

function encodeSession(user) {
  const body = Buffer.from(
    JSON.stringify({
      sub: user.id,
      org: user.organization_id,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function decodeSession(token) {
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

function cookieOptions() {
  const portal = new URL(config.portalOrigin);
  return {
    httpOnly: true,
    secure: portal.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionTtlSeconds * 1000,
  };
}

function setSessionCookie(res, user) {
  res.cookie(config.sessionCookieName, encodeSession(user), cookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(config.sessionCookieName, { ...cookieOptions(), maxAge: 0 });
}

function normalizeRole(value) {
  const role = String(value || '').toLowerCase();
  if (role === 'admin' || role === 'owner') return 'admin';
  if (role === 'publisher') return 'publisher';
  return 'member';
}

async function saveOidcTransaction({ state, nonce, codeVerifier }) {
  await db.query(`DELETE FROM oidc_transactions WHERE created_at < now() - interval '10 minutes'`);
  await db.query(
    `INSERT INTO oidc_transactions (state, nonce, code_verifier) VALUES ($1, $2, $3)`,
    [state, nonce, codeVerifier]
  );
}

async function takeOidcTransaction(state) {
  if (!state) return null;
  const result = await db.query(
    `DELETE FROM oidc_transactions
     WHERE state = $1 AND created_at > now() - interval '10 minutes'
     RETURNING nonce, code_verifier`,
    [state]
  );
  return result.rows[0] || null;
}

function pruneOidcTransactions() {
  if (!db.hasPool()) return Promise.resolve();
  return db.query(`DELETE FROM oidc_transactions WHERE created_at < now() - interval '10 minutes'`);
}

async function ensureOrganization(client, slug, name) {
  const existing = await client.query('SELECT * FROM organizations WHERE slug = $1', [slug]);
  if (existing.rowCount) return existing.rows[0];
  const created = await client.query(
    'INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING *',
    [slug, name || slug]
  );
  return created.rows[0];
}

async function upsertUserFromIdentity(identity) {
  return db.withTransaction(async (client) => {
    const org = await ensureOrganization(
      client,
      identity.organizationSlug || config.organizationSlug,
      identity.organizationName || config.organizationName
    );
    const existing = await client.query(
      'SELECT * FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2',
      [identity.issuer, identity.subject]
    );
    if (existing.rowCount) {
      const updated = await client.query(
        `UPDATE users
         SET email = $1, display_name = $2, last_login_at = now()
         WHERE id = $3
         RETURNING *`,
        [identity.email, identity.displayName, existing.rows[0].id]
      );
      return updated.rows[0];
    }
    const created = await client.query(
      `INSERT INTO users (
         organization_id, oidc_issuer, oidc_subject, email, display_name, role, last_login_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now())
       RETURNING *`,
      [
        org.id,
        identity.issuer,
        identity.subject,
        identity.email,
        identity.displayName,
        normalizeRole(identity.role),
      ]
    );
    return created.rows[0];
  });
}

function claimsToIdentity(claims, issuer) {
  const orgValue = claims[config.oidc.orgClaim];
  const organizationSlug =
    (typeof orgValue === 'string' && orgValue) ||
    (Array.isArray(orgValue) && orgValue[0]) ||
    config.organizationSlug;
  return {
    issuer,
    subject: claims.sub,
    email: claims.email || `${claims.sub}@users.invalid`,
    displayName: claims[config.oidc.displayNameClaim] || claims.email || claims.sub,
    role: normalizeRole(claims[config.oidc.roleClaim] || config.oidc.defaultRole),
    organizationSlug: String(organizationSlug).toLowerCase(),
    organizationName: String(organizationSlug),
  };
}

async function getOidcClient() {
  if (!oidcClientPromise) {
    oidcClientPromise = Issuer.discover(config.oidc.issuer).then((issuer) =>
      new issuer.Client({
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        redirect_uris: [config.oidc.redirectUri],
        response_types: ['code'],
      })
    );
  }
  return oidcClientPromise;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    organizationId: user.organization_id,
  };
}

async function loadUser(id) {
  const result = await db.query(
    `SELECT users.*, organizations.slug AS organization_slug, organizations.name AS organization_name
     FROM users
     JOIN organizations ON organizations.id = users.organization_id
     WHERE users.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function sessionMiddleware(req, res, next) {
  const token = req.cookies?.[config.sessionCookieName];
  const claims = decodeSession(token);
  if (!claims) {
    req.user = null;
    next();
    return;
  }
  try {
    req.user = await loadUser(claims.sub);
  } catch (err) {
    next(err);
    return;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient role' });
      return;
    }
    next();
  };
}

function attachAuthRoutes(app) {
  app.get('/auth/login', async (req, res, next) => {
    try {
      if (config.authAdapter === 'dev') {
        res.redirect('/login');
        return;
      }
      const client = await getOidcClient();
      const state = generators.state();
      const nonce = generators.nonce();
      const codeVerifier = generators.codeVerifier();
      const codeChallenge = generators.codeChallenge(codeVerifier);
      await saveOidcTransaction({ state, nonce, codeVerifier });
      const url = client.authorizationUrl({
        scope: config.oidc.scopes,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      res.redirect(url);
    } catch (err) {
      next(err);
    }
  });

  app.get('/auth/callback', async (req, res, next) => {
    try {
      if (config.authAdapter !== 'oidc') {
        res.status(404).json({ error: 'OIDC is not enabled' });
        return;
      }
      const client = await getOidcClient();
      const params = client.callbackParams(req);
      const pending = await takeOidcTransaction(params.state);
      if (!pending) {
        res.status(400).send('OIDC state is invalid or expired');
        return;
      }
      const tokenSet = await client.callback(config.oidc.redirectUri, params, {
        state: params.state,
        nonce: pending.nonce,
        code_verifier: pending.code_verifier,
      });
      const claims = tokenSet.claims();
      const identity = claimsToIdentity(claims, config.oidc.issuer);
      const user = await upsertUserFromIdentity(identity);
      setSessionCookie(res, user);
      await audit.record({
        organizationId: user.organization_id,
        userId: user.id,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
        ip: clientIp(req),
        metadata: { adapter: 'oidc', email: user.email },
      });
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  app.post('/auth/logout', async (req, res) => {
    if (req.user) {
      await audit.record({
        organizationId: req.user.organization_id,
        userId: req.user.id,
        action: 'auth.logout',
        resourceType: 'user',
        resourceId: req.user.id,
        ip: clientIp(req),
      });
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    res.json({
      user: publicUser(req.user),
      organization: {
        id: req.user.organization_id,
        slug: req.user.organization_slug,
        name: req.user.organization_name,
      },
    });
  });

  if (config.authAdapter === 'dev') {
    app.post('/api/dev/login', async (req, res, next) => {
      try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (!email) {
          res.status(400).json({ error: 'email is required' });
          return;
        }
        const found = await db.query(
          `SELECT users.*, organizations.slug AS organization_slug, organizations.name AS organization_name
           FROM users
           JOIN organizations ON organizations.id = users.organization_id
           WHERE lower(users.email) = $1`,
          [email]
        );
        if (!found.rowCount) {
          res.status(404).json({ error: 'Unknown development identity' });
          return;
        }
        const user = found.rows[0];
        await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
        setSessionCookie(res, user);
        await audit.record({
          organizationId: user.organization_id,
          userId: user.id,
          action: 'auth.login',
          resourceType: 'user',
          resourceId: user.id,
          ip: clientIp(req),
          metadata: { adapter: 'dev', email: user.email },
        });
        res.json({ user: publicUser(user) });
      } catch (err) {
        next(err);
      }
    });

    app.get('/api/dev/identities', async (req, res, next) => {
      try {
        const result = await db.query(
          `SELECT email, display_name, role
           FROM users
           ORDER BY role DESC, display_name`
        );
        res.json({ identities: result.rows });
      } catch (err) {
        next(err);
      }
    });
  }
}

setInterval(() => {
  pruneOidcTransactions().catch(() => {});
}, 60_000).unref();

module.exports = {
  encodeSession,
  decodeSession,
  setSessionCookie,
  clearSessionCookie,
  upsertUserFromIdentity,
  claimsToIdentity,
  publicUser,
  sessionMiddleware,
  requireAuth,
  requireRole,
  attachAuthRoutes,
  normalizeRole,
  saveOidcTransaction,
  takeOidcTransaction,
};
