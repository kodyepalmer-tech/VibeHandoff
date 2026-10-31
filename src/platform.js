'use strict';

const MODES = ['enterprise', 'public'];

/**
 * Pure mode profile. The process reads PLATFORM_MODE once at startup.
 * A public store and an on-prem hub are separate deployments with separate
 * databases. This profile never copies rows from one mode into the other.
 */
function platformProfile(mode) {
  const resolved = mode || 'enterprise';
  if (!MODES.includes(resolved)) {
    throw new Error('PLATFORM_MODE must be enterprise or public');
  }
  if (resolved === 'public') {
    return {
      mode: 'public',
      productName: 'VibeHandoff',
      tagline: 'Public',
      auth: 'oauth',
      catalog: 'public',
      leaderboardScope: 'global',
      reviews: true,
      exports: 'creator',
      csp: 'standard',
    };
  }
  return {
    mode: 'enterprise',
    productName: 'Vibe Handoff Enterprise',
    tagline: 'Internal studio',
    auth: 'oidc',
    catalog: 'organization',
    leaderboardScope: 'organization',
    reviews: false,
    exports: 'admin-approval',
    csp: 'strict',
  };
}

module.exports = { platformProfile, MODES };
