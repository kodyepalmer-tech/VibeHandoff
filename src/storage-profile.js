'use strict';

/**
 * How this deployment talks to object storage.
 * Enterprise keeps the bucket private: uploads ask for AES-256, and reads
 * use a short-lived signed URL. Public mode addresses objects through a CDN
 * base URL (CloudFront or R2). Neither mode copies objects to the other.
 */
function storageProfile(mode, options = {}) {
  const signedUrlTtlSeconds = options.signedUrlTtlSeconds || 120;
  if (mode === 'public') {
    return {
      mode: 'public',
      distribution: 'cdn',
      encryption: null,
      serve: 'cdn',
      publicBaseUrl: String(options.publicBaseUrl || '').replace(/\/$/, ''),
      cacheControl: 'public, max-age=31536000, immutable',
      signedUrlTtlSeconds,
    };
  }
  return {
    mode: 'enterprise',
    distribution: 'private',
    encryption: options.sse === false ? null : 'AES256',
    serve: 'signed-url',
    publicBaseUrl: '',
    cacheControl: 'private, no-store',
    signedUrlTtlSeconds,
  };
}

function publicObjectUrl(profile, key) {
  if (!profile || profile.serve !== 'cdn' || !profile.publicBaseUrl || !key) return null;
  const encoded = String(key)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${profile.publicBaseUrl}/${encoded}`;
}

function exportDownloadDecision({ mode, sameOrganization, isCreator, approved }) {
  if (mode === 'public') {
    if (!isCreator) {
      return { ok: false, status: 403, error: 'Only the creator can download this package' };
    }
    return { ok: true, autoApprove: !approved };
  }
  if (!sameOrganization) {
    return { ok: false, status: 403, error: 'This package belongs to another organization' };
  }
  if (!approved) {
    return {
      ok: false,
      status: 403,
      error: 'An admin has to approve an export before this package can be downloaded',
    };
  }
  return { ok: true, autoApprove: false };
}

module.exports = { storageProfile, publicObjectUrl, exportDownloadDecision };
