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
  const launchHref = `/apps/${encodeURIComponent(app.slug)}/launch`;
  const play = app.multiplayer
    ? `<div class="play-actions">
        <a class="button" href="${launchHref}">Play solo</a>
        <button type="button" id="start-room">Start a live game</button>
        <input id="join-code" maxlength="4" placeholder="Room code" autocomplete="off" />
        <button class="ghost" type="button" id="join-room">Join</button>
      </div>
      <div class="stack" id="open-rooms"></div>`
    : `<div><a class="button" href="${launchHref}">Launch</a></div>`;
  $('#detail').innerHTML = `
    <section class="panel stack">
      <div class="tags">${(app.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag.name)}</span>`).join('')}${app.multiplayer ? '<span class="tag">Live</span>' : ''}</div>
      <h1>${escapeHtml(app.name)}</h1>
      <p class="lede">${escapeHtml(app.description || '')}</p>
      <p class="meta">Created by ${escapeHtml(app.creator_name)} · current version ${escapeHtml(app.version)}</p>
      <p class="meta">${app.launch_count} launches inside this organization</p>
      ${play}
      <p class="error" id="play-error" hidden></p>
    </section>
    <aside class="panel stack">
      <h2>Release</h2>
      <p>Launches resolve an immutable published artifact. The app runs on a separate origin, inside a sandboxed iframe, without portal session access.</p>
      <p class="meta">Published ${app.published_at ? new Date(app.published_at).toLocaleString() : '—'}</p>
    </aside>
  `;
  if (!app.multiplayer) return;

  async function refreshRooms() {
    const listed = await api(`/api/apps/${encodeURIComponent(app.slug)}/rooms`);
    const root = $('#open-rooms');
    if (!listed.rooms.length) {
      root.innerHTML = '<p class="meta">No live rooms open right now.</p>';
      return;
    }
    root.innerHTML = listed.rooms
      .map(
        (room) => `<p class="meta">${escapeHtml(room.hostName)} · ${room.playerCount} playing · <a href="${launchHref}?mode=multi&room=${encodeURIComponent(room.code)}">${escapeHtml(room.code)}</a></p>`
      )
      .join('');
  }

  $('#start-room').addEventListener('click', async () => {
    $('#play-error').hidden = true;
    try {
      const created = await api(`/api/apps/${encodeURIComponent(app.slug)}/rooms`, { method: 'POST', body: {} });
      location.href = `${launchHref}?mode=multi&room=${encodeURIComponent(created.room.code)}`;
    } catch (err) {
      $('#play-error').hidden = false;
      $('#play-error').textContent = err.message;
    }
  });
  $('#join-room').addEventListener('click', () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (!code) return;
    location.href = `${launchHref}?mode=multi&room=${encodeURIComponent(code)}`;
  });
  await refreshRooms();
}

boot();
