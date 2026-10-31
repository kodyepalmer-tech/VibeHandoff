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
    if (!data || data.channel !== 'vibehandoff' || !room) return;
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
