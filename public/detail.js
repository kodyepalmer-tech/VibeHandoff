const { api, loadSession, renderChrome, logout, $ } = window.VibeHandoff;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function boot() {
  await loadSession();
  renderChrome('market');
  $('#logout').addEventListener('click', logout);
  const slug = location.pathname.split('/')[2];
  const data = await api(`/api/apps/${encodeURIComponent(slug)}`);
  const app = data.app;
  document.title = `${app.name} · VibeHandoff`;
  $('#detail').innerHTML = `
    <section class="panel stack">
      <div class="tags">${(app.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag.name)}</span>`).join('')}</div>
      <h1>${escapeHtml(app.name)}</h1>
      <p class="lede">${escapeHtml(app.description || '')}</p>
      <p class="meta">Created by ${escapeHtml(app.creator_name)} · current version ${escapeHtml(app.version)}</p>
      <p class="meta">${app.launch_count} launches inside this organization</p>
      <div>
        <a class="button" href="/apps/${encodeURIComponent(app.slug)}/launch">Launch</a>
      </div>
    </section>
    <aside class="panel stack">
      <h2>Release</h2>
      <p>Launches resolve an immutable published artifact. The app runs on a separate origin, inside a sandboxed iframe, without portal session access.</p>
      <p class="meta">Published ${app.published_at ? new Date(app.published_at).toLocaleString() : '—'}</p>
    </aside>
  `;
}

boot();
