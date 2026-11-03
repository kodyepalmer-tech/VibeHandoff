'use strict';

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function heatingUp(plays, medianOfActive) {
  if (plays < 2 || !medianOfActive) return false;
  return plays >= medianOfActive * 2;
}

function shareText({ kind, appName, creatorName, note, url }) {
  const line = String(note || '').trim();
  if (kind === 'moment') return `${line} — ${appName} ${url}`;
  if (kind === 'review') return `${line} — review of ${appName} ${url}`;
  if (kind === 'playing') return `Playing ${appName} on VibeHandoff ${url}`;
  return `${creatorName} posted ${appName} on VibeHandoff ${url}`;
}

module.exports = { median, heatingUp, shareText };
