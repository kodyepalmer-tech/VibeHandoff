'use strict';

const crypto = require('crypto');
const config = require('./config');

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function issueLaunchTicket({ userId, organizationId, applicationId, releaseId, prefix }) {
  const exp = Math.floor(Date.now() / 1000) + config.limits.launchTicketTtlSeconds;
  const nonce = crypto.randomBytes(16).toString('hex');
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      userId,
      organizationId,
      applicationId,
      releaseId,
      prefix,
      exp,
      nonce,
    })
  ).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifyLaunchTicket(ticket) {
  if (!ticket || !ticket.includes('.')) {
    return { ok: false, error: 'Missing launch ticket' };
  }
  const [body, signature] = ticket.split('.');
  const expected = sign(body);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, error: 'Invalid launch ticket' };
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Malformed launch ticket' };
  }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'Launch ticket expired' };
  }
  if (!claims.releaseId || !claims.prefix) {
    return { ok: false, error: 'Launch ticket is incomplete' };
  }
  return { ok: true, claims };
}

module.exports = {
  issueLaunchTicket,
  verifyLaunchTicket,
};
