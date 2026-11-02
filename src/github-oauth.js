'use strict';

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';
const GITHUB_EMAILS = 'https://api.github.com/user/emails';
const GITHUB_ISSUER = 'https://github.com';

function selectAuthRoute(settings) {
  if (settings.authAdapter === 'dev') return 'dev';
  if (settings.platformMode === 'public' && settings.authAdapter === 'oauth') return 'github';
  return 'oidc';
}

function githubRedirectUri(portalOrigin) {
  return `${portalOrigin}/auth/callback`;
}

function githubAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  return url.toString();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function mapGithubIdentity(profile, emails, organization) {
  const list = Array.isArray(emails) ? emails : [];
  const primary = list.find((item) => item && item.primary && item.verified && item.email);
  const verified = list.find((item) => item && item.verified && item.email);
  const email = String(primary?.email || verified?.email || '').trim().toLowerCase();
  if (!email) throw httpError(400, 'GitHub account has no verified email');
  if (!profile || profile.id == null) throw httpError(502, 'GitHub did not return an account');
  return {
    issuer: GITHUB_ISSUER,
    subject: String(profile.id),
    email,
    displayName: profile.name || profile.login || email,
    role: 'member',
    organizationSlug: organization.slug,
    organizationName: organization.name,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function fetchGithubIdentity({ code, redirectUri, clientId, clientSecret, organization, fetchImpl }) {
  const request = fetchImpl || fetch;
  let tokenResponse;
  try {
    tokenResponse = await request(GITHUB_TOKEN, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'vibehandoff',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch {
    throw httpError(502, 'GitHub sign-in failed');
  }
  const tokenBody = await readJson(tokenResponse);
  if (!tokenResponse.ok || !tokenBody.access_token || tokenBody.error) {
    throw httpError(502, 'GitHub sign-in failed');
  }

  async function githubGet(url) {
    let response;
    try {
      response = await request(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${tokenBody.access_token}`,
          'User-Agent': 'vibehandoff',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      throw httpError(502, 'GitHub sign-in failed');
    }
    if (!response.ok) throw httpError(502, 'GitHub sign-in failed');
    return readJson(response);
  }

  const profile = await githubGet(GITHUB_USER);
  const emails = await githubGet(GITHUB_EMAILS);
  return mapGithubIdentity(profile, emails, organization);
}

module.exports = {
  GITHUB_ISSUER,
  selectAuthRoute,
  githubRedirectUri,
  githubAuthorizeUrl,
  mapGithubIdentity,
  fetchGithubIdentity,
};
