const { api, loadSession, renderChrome, logout, state, $ } = window.VibeHandoff;

async function boot() {
  await loadSession();
  renderChrome('market');
  $('#logout').addEventListener('click', logout);
  const slug = location.pathname.split('/')[2];
  $('#back').href = `/apps/${encodeURIComponent(slug)}`;
  const params = new URLSearchParams(location.search);
  const multi = params.get('mode') === 'multi';
  const roomCode = (params.get('room') || '').trim().toUpperCase();

  const launched = await api(`/api/apps/${encodeURIComponent(slug)}/launch`, {
    method: 'POST',
    body: {},
  });
  const frame = $('#frame');
  frame.setAttribute('sandbox', launched.sandbox);
  let room = null;
  if (multi) {
    if (!roomCode) throw new Error('A live game needs a room code');
    const joined = await api(`/api/apps/${encodeURIComponent(slug)}/rooms/${encodeURIComponent(roomCode)}/join`, {
      method: 'POST',
      body: {},
    });
    room = joined.room;
    $('#room-line').hidden = false;
    $('#room-code').textContent = room.code;
    renderRoster(room.players);
  }

  let cursor = 0;
  let stopped = false;

  function tell(message) {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({ channel: 'vibehandoff', ...message }, '*');
  }

  function hello() {
    const you = state.user?.id;
    tell({
      type: 'hello',
      mode: room ? 'multi' : 'solo',
      playerId: you,
      displayName: state.user?.displayName,
      host: Boolean(room && room.hostUserId === you),
      room: room ? room.code : null,
      players: room ? room.players : [],
    });
  }

  function renderRoster(players) {
    $('#roster').textContent = (players || []).map((player) => player.displayName).join(', ') || 'waiting';
  }

  frame.addEventListener('load', () => {
    hello();
    frame.focus();
  });

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // The sandboxed frame's origin is the opaque string "null", so the parent
    // trusts event.source (this iframe) rather than a page-supplied origin.
    // The slug comes from this page. A game-supplied gameId is ignored.
    function reply(type, extra) {
      const targetOrigin = event.origin && event.origin !== 'null' ? event.origin : '*';
      event.source.postMessage({ type, requestId: data.requestId, ...extra }, targetOrigin);
    }

    if (data.type === 'VIBE_SAVE_PROGRESS' || data.type === 'VIBE_LOAD_PROGRESS') {
      const payload = data.payload || {};
      const key = payload.key;
      if (data.type === 'VIBE_SAVE_PROGRESS') {
        api('/api/user/save-state', {
          method: 'POST',
          body: { slug, key, data: payload.data },
        })
          .then(() => reply('VIBE_SAVE_SUCCESS'))
          .catch((err) => reply('VIBE_SAVE_ERROR', { error: err.message }));
        return;
      }
      const query = new URLSearchParams({ slug, key: String(key || '') });
      api(`/api/user/save-state?${query}`)
        .then((result) => reply('VIBE_LOAD_SUCCESS', { data: result.state ? result.state.data : null }))
        .catch((err) => reply('VIBE_LOAD_ERROR', { error: err.message }));
      return;
    }

    if (data.type === 'VIBE_SUBMIT_SCORE') {
      const payload = data.payload || {};
      api('/api/leaderboards/submit', {
        method: 'POST',
        body: { slug, score: payload.score },
      }).catch(() => {});
      return;
    }

    if (data.channel !== 'vibehandoff' || !room) return;
    if (data.type === 'hello') {
      hello();
      return;
    }
    if (data.type !== 'publish' || !data.payload || typeof data.payload !== 'object') return;
    api(`/api/apps/${encodeURIComponent(slug)}/rooms/${encodeURIComponent(room.code)}/events`, {
      method: 'POST',
      body: { payload: data.payload },
    }).catch(() => {});
  });

  async function poll() {
    if (!room || stopped) return;
    try {
      const batch = await api(
        `/api/apps/${encodeURIComponent(slug)}/rooms/${encodeURIComponent(room.code)}/events?after=${cursor}`
      );
      cursor = batch.cursor || cursor;
      room.players = batch.players || room.players;
      room.hostUserId = batch.hostUserId || room.hostUserId;
      renderRoster(room.players);
      tell({
        type: 'players',
        playerId: state.user?.id,
        host: room.hostUserId === state.user?.id,
        players: room.players,
      });
      for (const item of batch.events || []) {
        tell({ type: 'event', from: item.from, payload: item.payload });
      }
    } catch {
      // The next poll retries. A closed room ends when the ticket page is left.
    }
    if (!stopped) setTimeout(poll, 120);
  }

  frame.src = launched.launchUrl;
  if (room) poll();
  window.addEventListener('pagehide', () => {
    stopped = true;
  });

  const isolation = 'sandboxed on its own origin';
  $('#caption').textContent = room
    ? `Version ${launched.release.version} · ${isolation} · live room ${room.code}`
    : `Version ${launched.release.version} · ${isolation} · solo`;
}

boot();
