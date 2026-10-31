const { api, loadSession, renderChrome, logout, $ } = window.VibeHandoff;

async function boot() {
  await loadSession();
  renderChrome('market');
  $('#logout').addEventListener('click', logout);
  const slug = location.pathname.split('/')[2];
  $('#back').href = `/apps/${encodeURIComponent(slug)}`;
  const launched = await api(`/api/apps/${encodeURIComponent(slug)}/launch`, {
    method: 'POST',
    body: {},
  });
  const frame = $('#frame');
  frame.setAttribute('sandbox', launched.sandbox);
  frame.src = launched.launchUrl;
  $('#caption').textContent = `Version ${launched.release.version} · isolated artifact origin · ticket expires in ${launched.ticketTtlSeconds}s`;
}

boot();
