const { api, loadSession, renderChrome, logout, applyBrand, $ } = window.VibeHandoff;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function coverStyle(slug) {
  const hues = [18, 152, 200, 262, 32, 338];
  let hash = 0;
  for (const char of String(slug)) hash = (hash + char.charCodeAt(0) * 17) % hues.length;
  const hue = hues[hash];
  return `background: linear-gradient(135deg, hsl(${hue} 62% 42%), hsl(${(hue + 28) % 360} 48% 22%));`;
}

function card(app, shop) {
  const tags = (app.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag.name)}</span>`).join('');
  const live = app.multiplayer ? '<span class="tag">Live</span>' : '<span class="tag">Solo</span>';
  if (!shop) {
    return `
      <a class="card" href="/apps/${encodeURIComponent(app.slug)}">
        <div class="tags">${tags}${app.multiplayer ? '<span class="tag">Live</span>' : ''}</div>
        <h3>${escapeHtml(app.name)}</h3>
        <p class="meta">${escapeHtml(app.description || 'No description yet.')}</p>
        <p class="meta">v${escapeHtml(app.version)} · ${escapeHtml(app.creator_name)} · ${app.launch_count} launches</p>
      </a>
    `;
  }
  return `
    <a class="card game" href="/apps/${encodeURIComponent(app.slug)}">
      <div class="cover" style="${coverStyle(app.slug)}"><span>${escapeHtml(app.name.slice(0, 1))}</span></div>
      <div class="tags">${tags}${live}</div>
      <h3>${escapeHtml(app.name)}</h3>
      <p>${escapeHtml(app.description || 'No description yet.')}</p>
      <p class="meta">Posted by ${escapeHtml(app.creator_name)}</p>
    </a>
  `;
}

async function refresh(shop) {
  const q = $('#q').value.trim();
  const tag = $('#tag').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  const data = await api(`/api/apps?${params}`);
  const root = $('#apps');
  root.innerHTML = data.apps.length
    ? data.apps.map((app) => card(app, shop)).join('')
    : `<p class="empty">${shop ? 'No games on the shelf yet.' : 'No published apps match this shelf yet.'}</p>`;
}

function shelf(title, cards, empty) {
  return `
    <section class="shelf">
      <h2>${title}</h2>
      ${cards.length ? `<div class="shelf-row">${cards}</div>` : `<p class="meta">${empty}</p>`}
    </section>
  `;
}

function mini(item, extra) {
  return `
    <a class="card mini" href="/apps/${encodeURIComponent(item.slug)}">
      <h3>${escapeHtml(item.name)}</h3>
      <p class="meta">${escapeHtml(extra)}</p>
    </a>
  `;
}

async function renderShelves() {
  const data = await api('/api/community');
  const root = $('#shelves');
  root.className = 'shelves';
  const friends = (data.friendsPlaying || []).map((item) =>
    mini({ ...item, name: item.name }, `${item.display_name} is playing`)
  );
  const fresh = (data.fresh || []).map((item) => mini(item, `Posted by ${item.creator_name}`));
  const heating = (data.heating || []).map((item) =>
    mini(item, `${item.plays} plays this week · 2× a typical game`)
  );
  const library = (data.library || []).map((item) => mini(item, 'Jump back in'));
  const saved = (data.wishlist || []).map((item) => mini(item, `Posted by ${item.creator_name}`));
  const floor = (data.activity || [])
    .map(
      (item) => `
      <a class="card mini" href="/apps/${encodeURIComponent(item.slug || '')}">
        <h3>${escapeHtml(item.app_name || 'VibeHandoff')}</h3>
        <p class="meta">${escapeHtml(item.display_name)} · ${escapeHtml(item.note || item.kind)}</p>
      </a>`
    );
  root.innerHTML = [
    shelf('Jump back in', library, 'Play something once and it stays here.'),
    shelf('Friends are playing', friends, 'Follow a creator from their game page.'),
    shelf('New on the shelf', fresh, 'Nothing new yet.'),
    shelf('Picked up', heating, 'A game shows up here when people play it at least twice as often as a typical game this week.'),
    shelf('Wishlist', saved, 'Save a game from its page.'),
    shelf('People are sharing', floor, 'A comment or a short moment shows up here.'),
  ].join('');
}

async function boot() {
  await loadSession();
  const platform = await renderChrome('market');
  const shop = platform?.mode === 'public';
  $('#logout').addEventListener('click', logout);
  if (shop) {
    document.title = 'VibeHandoff · Store';
    $('#hero-kicker').textContent = 'The public shelf';
    $('#hero-title').textContent = 'Play what people posted.';
    $('#hero-lede').textContent =
      'Friends pull you in, a new release gives you a reason to come back, and a game that people keep opening gets passed around.';
    $('#q').placeholder = 'Search games';
    await renderShelves();
  }
  const [metrics, tags] = await Promise.all([api('/api/metrics'), api('/api/tags')]);
  const counts = metrics.metrics;
  $('#metrics').innerHTML = shop
    ? `
    <div class="metric"><b>${counts.application_count}</b><span>games</span></div>
    <div class="metric"><b>${counts.published_release_count}</b><span>on the shelf</span></div>
    <div class="metric"><b>${counts.launch_count}</b><span>plays</span></div>`
    : `
    <div class="metric"><b>${counts.application_count}</b><span>apps in the org</span></div>
    <div class="metric"><b>${counts.published_release_count}</b><span>live releases</span></div>
    <div class="metric"><b>${counts.launch_count}</b><span>launches</span></div>`;
  for (const tag of tags.tags) {
    const option = document.createElement('option');
    option.value = tag.slug;
    option.textContent = `${tag.name} (${tag.app_count})`;
    $('#tag').append(option);
  }
  $('#q').addEventListener('input', () => refresh(shop));
  $('#tag').addEventListener('change', () => refresh(shop));
  await refresh(shop);
  if (!platform) await applyBrand();
}

boot();
