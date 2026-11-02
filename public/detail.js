const { api, loadSession, renderChrome, logout, $ } = window.VibeHandoff;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function stars(rating) {
  return '★★★★★'.slice(0, rating) + '☆☆☆☆☆'.slice(rating);
}

async function boot() {
  await loadSession();
  const platform = await renderChrome('market');
  $('#logout').addEventListener('click', logout);
  const slug = location.pathname.split('/')[2];
  const data = await api(`/api/apps/${encodeURIComponent(slug)}`);
  const app = data.app;
  const product = document.querySelector('[data-product]')?.textContent?.trim() || 'Vibe Handoff Enterprise';
  document.title = `${app.name} · ${product}`;
  const launchHref = `/apps/${encodeURIComponent(app.slug)}/launch`;
  if (platform?.mode === 'public') {
    await renderShop(app, slug, launchHref);
    return;
  }
  renderEnterprise(app, launchHref);
}

function renderEnterprise(app, launchHref) {
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
  wireRooms(app, launchHref, { startLabel: null });
}

async function renderShop(app, slug, launchHref) {
  const live = app.multiplayer
    ? `<div class="play-actions">
        <a class="button" href="${launchHref}">Play solo</a>
        <button type="button" id="invite-friends">Invite friends</button>
        <input id="join-code" maxlength="4" placeholder="Room code" autocomplete="off" />
        <button class="ghost" type="button" id="join-room">Join live</button>
      </div>
      <div class="invite" id="invite-box" hidden></div>
      <div class="stack" id="open-rooms"></div>`
    : `<div class="play-actions"><a class="button" href="${launchHref}">Play solo</a></div>`;
  $('#detail').classList.remove('split');
  $('#detail').classList.add('shop-detail');
  $('#detail').innerHTML = `
    <article class="panel stack game-page">
      <div class="tags">${(app.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag.name)}</span>`).join('')}${app.multiplayer ? '<span class="tag">Live</span>' : '<span class="tag">Solo</span>'}</div>
      <h1>${escapeHtml(app.name)}</h1>
      <p class="lede">${escapeHtml(app.description || 'No description yet.')}</p>
      <p class="posted">Posted by ${escapeHtml(app.creator_name)}</p>
      <p class="meta">Version ${escapeHtml(app.version)} · ${app.launch_count} plays</p>
      ${live}
      <p class="error" id="play-error" hidden></p>
    </article>
    <section class="panel stack" id="comments">
      <h2>Comments</h2>
      <form id="comment-form" class="stack">
        <label class="check">Rating
          <select name="rating" aria-label="Rating">
            <option value="5">5</option>
            <option value="4">4</option>
            <option value="3">3</option>
            <option value="2">2</option>
            <option value="1">1</option>
          </select>
        </label>
        <textarea name="body" maxlength="2000" placeholder="What did you think of this game?" required></textarea>
        <button type="submit">Post comment</button>
      </form>
      <p class="error" id="comment-error" hidden></p>
      <div id="comment-list" class="stack"></div>
    </section>
  `;
  await loadComments(slug);
  $('#comment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    $('#comment-error').hidden = true;
    try {
      await api(`/api/apps/${encodeURIComponent(slug)}/reviews`, {
        method: 'POST',
        body: { rating: Number(form.get('rating')), body: form.get('body') },
      });
      event.target.reset();
      await loadComments(slug);
    } catch (err) {
      $('#comment-error').hidden = false;
      $('#comment-error').textContent = err.message;
    }
  });
  if (app.multiplayer) wireRooms(app, launchHref, { invite: true });
}

async function loadComments(slug) {
  const listed = await api(`/api/apps/${encodeURIComponent(slug)}/reviews`);
  const root = $('#comment-list');
  if (!listed.reviews.length) {
    root.innerHTML = '<p class="meta">No comments yet. Be the first.</p>';
    return;
  }
  root.innerHTML = listed.reviews
    .map(
      (review) => `
      <article class="comment">
        <p class="meta">${escapeHtml(review.display_name)} · ${stars(review.rating)}</p>
        <p>${escapeHtml(review.body || '')}</p>
      </article>`
    )
    .join('');
}

function wireRooms(app, launchHref, options) {
  async function refreshRooms() {
    const listed = await api(`/api/apps/${encodeURIComponent(app.slug)}/rooms`);
    const root = $('#open-rooms');
    if (!listed.rooms.length) {
      root.innerHTML = '<p class="meta">No live rooms open right now.</p>';
      return;
    }
    root.innerHTML = listed.rooms
      .map(
        (room) =>
          `<p class="meta">${escapeHtml(room.hostName)} · ${room.playerCount} playing · <a href="${launchHref}?mode=multi&room=${encodeURIComponent(room.code)}">Join ${escapeHtml(room.code)}</a></p>`
      )
      .join('');
  }

  const start = $('#start-room');
  if (start) {
    start.addEventListener('click', async () => {
      $('#play-error').hidden = true;
      try {
        const created = await api(`/api/apps/${encodeURIComponent(app.slug)}/rooms`, { method: 'POST', body: {} });
        location.href = `${launchHref}?mode=multi&room=${encodeURIComponent(created.room.code)}`;
      } catch (err) {
        $('#play-error').hidden = false;
        $('#play-error').textContent = err.message;
      }
    });
  }

  const invite = $('#invite-friends');
  if (invite && options.invite) {
    invite.addEventListener('click', async () => {
      $('#play-error').hidden = true;
      try {
        const created = await api(`/api/apps/${encodeURIComponent(app.slug)}/rooms`, { method: 'POST', body: {} });
        const code = created.room.code;
        const link = `${location.origin}${launchHref}?mode=multi&room=${encodeURIComponent(code)}`;
        const box = $('#invite-box');
        box.hidden = false;
        box.innerHTML = `
          <p>Room <strong class="room-code">${escapeHtml(code)}</strong> is open. Send this link, then play.</p>
          <input id="invite-link" readonly value="${escapeHtml(link)}" />
          <div class="play-actions">
            <button type="button" id="copy-invite">Copy invite link</button>
            <a class="button" href="${launchHref}?mode=multi&room=${encodeURIComponent(code)}">Play in this room</a>
          </div>
        `;
        $('#copy-invite').addEventListener('click', async () => {
          const field = $('#invite-link');
          field.focus();
          field.select();
          try {
            await navigator.clipboard.writeText(field.value);
          } catch {
            // The link stays selected when the clipboard is blocked.
          }
        });
        await refreshRooms();
      } catch (err) {
        $('#play-error').hidden = false;
        $('#play-error').textContent = err.message;
      }
    });
  }

  $('#join-room').addEventListener('click', () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (!code) return;
    location.href = `${launchHref}?mode=multi&room=${encodeURIComponent(code)}`;
  });
  refreshRooms();
}

boot();
