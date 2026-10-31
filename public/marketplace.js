const { api, loadSession, renderChrome, logout, $ } = window.VibeHandoff;

function card(app) {
  const tags = (app.tags || []).map((tag) => `<span class="tag">${tag.name}</span>`).join('');
  return `
    <a class="card" href="/apps/${encodeURIComponent(app.slug)}">
      <div class="tags">${tags}</div>
      <h3>${escapeHtml(app.name)}</h3>
      <p class="meta">${escapeHtml(app.description || 'No description yet.')}</p>
      <p class="meta">v${escapeHtml(app.version)} · ${escapeHtml(app.creator_name)} · ${app.launch_count} launches</p>
    </a>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function refresh() {
  const q = $('#q').value.trim();
  const tag = $('#tag').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  const data = await api(`/api/apps?${params}`);
  const root = $('#apps');
  root.innerHTML = data.apps.length
    ? data.apps.map(card).join('')
    : '<p class="empty">No published apps match this shelf yet.</p>';
}

async function boot() {
  await loadSession();
  renderChrome('market');
  $('#logout').addEventListener('click', logout);
  const [metrics, tags] = await Promise.all([api('/api/metrics'), api('/api/tags')]);
  $('#metrics').innerHTML = `
    <div class="metric"><b>${metrics.metrics.application_count}</b><span>apps in the org</span></div>
    <div class="metric"><b>${metrics.metrics.published_release_count}</b><span>live releases</span></div>
    <div class="metric"><b>${metrics.metrics.launch_count}</b><span>launches</span></div>
  `;
  for (const tag of tags.tags) {
    const option = document.createElement('option');
    option.value = tag.slug;
    option.textContent = `${tag.name} (${tag.app_count})`;
    $('#tag').append(option);
  }
  $('#q').addEventListener('input', () => refresh());
  $('#tag').addEventListener('change', () => refresh());
  await refresh();
}

boot();
