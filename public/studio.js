const { api, loadSession, renderChrome, logout, state, $ } = window.VibeHandoff;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function releaseRow(app, release) {
  const errors = (release.validation_errors || []).join(' ');
  const actions =
    release.status === 'validated' || release.status === 'unpublished'
      ? `<button data-act="publish" data-slug="${app.slug}" data-id="${release.id}">Publish</button>`
      : release.status === 'published'
        ? `<button class="ghost" data-act="unpublish" data-slug="${app.slug}" data-id="${release.id}">Unpublish</button>`
        : '';
  return `
    <tr>
      <td>${escapeHtml(release.version)}</td>
      <td><span class="status ${release.status}">${release.status}</span></td>
      <td>${escapeHtml(errors || '—')}</td>
      <td>${actions}</td>
    </tr>
  `;
}

function appBlock(app) {
  return `
    <article class="stack" data-app="${app.slug}">
      <div>
        <h2>${escapeHtml(app.name)}</h2>
        <p class="meta">/${escapeHtml(app.slug)} · ${escapeHtml(app.membership_role)}</p>
      </div>
      <form class="toolbar upload" data-slug="${app.slug}">
        <input name="version" placeholder="1.0.1" required />
        <input name="artifact" type="file" accept=".zip,application/zip" required />
        <button type="submit">Upload ZIP</button>
      </form>
      <table>
        <thead><tr><th>Version</th><th>Status</th><th>Validation</th><th></th></tr></thead>
        <tbody>${(app.releases || []).map((release) => releaseRow(app, release)).join('') || '<tr><td colspan="4">No releases yet.</td></tr>'}</tbody>
      </table>
    </article>
  `;
}

let shop = false;

async function refresh() {
  const data = await api('/api/studio/apps');
  const heading = shop ? 'Your games' : 'Owned apps';
  const empty = shop ? 'Upload a game to put it on the shelf.' : 'Create an app to publish your first handoff.';
  $('#owned').innerHTML = `<h2>${heading}</h2>${data.apps.map(appBlock).join('') || `<p class="empty">${empty}</p>`}`;
}

async function boot() {
  await loadSession();
  const platform = await renderChrome('studio');
  shop = platform?.mode === 'public';
  $('#logout').addEventListener('click', logout);
  const kinds = document.getElementById('kind-row');
  if (shop) {
    document.title = 'Upload · VibeHandoff';
    $('#studio-title').textContent = 'Upload a game';
    $('#studio-lede').textContent = 'Post a static game. HTML, CSS, JavaScript, and assets only, with index.html at the root.';
    $('#field-name').placeholder = 'Game name';
    $('#field-description').placeholder = 'What is this game, and how do you play it?';
    $('#field-tags').placeholder = 'tags, comma separated';
    $('#multiplayer-label').lastChild.textContent = ' Friends can join a live room';
    $('#create-submit').textContent = 'Create game';
    if (kinds) kinds.hidden = true;
  } else if (kinds) {
    for (const kind of ['Shortcut', 'Tool', 'App']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.textContent = kind;
      button.addEventListener('click', () => {
        $('#field-tags').value = kind.toLowerCase();
      });
      kinds.append(button);
    }
  }
  if (!shop && state.user?.role !== 'publisher') {
    $('#owned').innerHTML = '<p class="empty">Studio is limited to publishers in this organization.</p>';
    return;
  }
  $('#create').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    $('#create-error').hidden = true;
    try {
      await api('/api/apps', {
        method: 'POST',
        body: {
          name: form.get('name'),
          slug: form.get('slug'),
          description: form.get('description'),
          tags: String(form.get('tags') || '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          multiplayer: form.get('multiplayer') === 'on',
        },
      });
      event.target.reset();
      await refresh();
    } catch (err) {
      $('#create-error').hidden = false;
      $('#create-error').textContent = err.message;
    }
  });
  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form.upload');
    if (!form) return;
    event.preventDefault();
    const payload = new FormData();
    payload.set('version', form.version.value);
    payload.set('artifact', form.artifact.files[0]);
    try {
      await api(`/api/apps/${form.dataset.slug}/releases`, { method: 'POST', body: payload });
    } catch (err) {
      window.alert(err.message);
    }
    await refresh();
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    await api(`/api/apps/${button.dataset.slug}/releases/${button.dataset.id}/${button.dataset.act}`, {
      method: 'POST',
      body: {},
    });
    await refresh();
  });
  await refresh();
}

boot();
