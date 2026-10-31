const COLS = 21;
const ROWS = 21;
const COLORS = ['#d96b2b', '#7dcea0', '#e8c07a', '#d4a0a0', '#9bb8c9', '#c9b6e4'];
const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const statusEl = document.getElementById('status');

let mode = 'solo';
let playerId = null;
let host = false;
let players = [];
let snakes = [];
let food = [10, 10];
let timer = null;
let direction = 'right';
let pending = 'right';

function resize() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
  draw();
}

function cellSize() {
  return Math.max(8, Math.floor(Math.min(canvas.width / COLS, canvas.height / ROWS)));
}

function occupied() {
  const taken = new Set();
  for (const snake of snakes) {
    for (const part of snake.body) taken.add(`${part[0]},${part[1]}`);
  }
  return taken;
}

function emptyCell() {
  const taken = occupied();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const cell = [Math.floor(Math.random() * COLS), Math.floor(Math.random() * ROWS)];
    if (!taken.has(`${cell[0]},${cell[1]}`)) return cell;
  }
  return [0, 0];
}

function spawn(id, name, color, index) {
  const y = 4 + (index % 5) * 3;
  const x = 4;
  return {
    id,
    name,
    color,
    dir: 'right',
    next: 'right',
    alive: true,
    score: 0,
    body: [[x, y], [x - 1, y], [x - 2, y]],
  };
}

function soloSnake() {
  snakes = [
    {
      id: 'solo',
      name: 'You',
      color: COLORS[0],
      dir: 'right',
      next: direction,
      alive: true,
      score: 0,
      body: [[4, 10], [3, 10], [2, 10]],
    },
  ];
  food = emptyCell();
  direction = 'right';
  pending = 'right';
}

function publish(payload) {
  if (window.parent === window) return;
  window.parent.postMessage({ channel: 'vibehandoff', type: 'publish', payload }, '*');
}

function names() {
  return players.map((player) => player.displayName).filter(Boolean).join(', ');
}

function setStatus(text) {
  statusEl.textContent = text;
}

function draw() {
  const size = cellSize();
  const width = size * COLS;
  const height = size * ROWS;
  const offsetX = Math.floor((canvas.width - width) / 2);
  const offsetY = Math.floor((canvas.height - height) / 2);
  ctx.fillStyle = '#1b1713';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#2a241e';
  ctx.fillRect(offsetX, offsetY, width, height);
  ctx.fillStyle = '#f4ead8';
  ctx.fillRect(offsetX + food[0] * size, offsetY + food[1] * size, size - 1, size - 1);
  for (const snake of snakes) {
    ctx.fillStyle = snake.alive ? snake.color : '#5c5148';
    for (const part of snake.body) {
      ctx.fillRect(offsetX + part[0] * size, offsetY + part[1] * size, size - 1, size - 1);
    }
  }
  const total = snakes.reduce((sum, snake) => sum + snake.score, 0);
  scoreEl.textContent = mode === 'solo' ? `Score ${snakes[0] ? snakes[0].score : 0}` : `Score ${total}`;
}

function stepSnake(snake) {
  if (!snake.alive) return;
  if (OPPOSITE[snake.dir] !== snake.next) snake.dir = snake.next;
  const vector = DIRS[snake.dir];
  const head = snake.body[0];
  const next = [(head[0] + vector.x + COLS) % COLS, (head[1] + vector.y + ROWS) % ROWS];
  const eating = next[0] === food[0] && next[1] === food[1];
  const hit = snakes.some((other) => other.body.some((part, index) => {
    if (other === snake && index === 0) return false;
    if (!eating && other === snake && index === other.body.length - 1) return false;
    return part[0] === next[0] && part[1] === next[1];
  }));
  if (hit) {
    snake.alive = false;
    return;
  }
  snake.body.unshift(next);
  if (next[0] === food[0] && next[1] === food[1]) {
    snake.score += 1;
    food = emptyCell();
  } else {
    snake.body.pop();
  }
}

function snapshot() {
  return {
    kind: 'state',
    food,
    snakes: snakes.map((snake) => ({
      id: snake.id,
      name: snake.name,
      color: snake.color,
      alive: snake.alive,
      score: snake.score,
      body: snake.body,
    })),
  };
}

function applySnapshot(payload) {
  food = payload.food || food;
  snakes = (payload.snakes || []).map((snake) => ({ ...snake, dir: 'right', next: 'right' }));
  const alive = snakes.filter((snake) => snake.alive).length;
  setStatus(alive ? `Live · ${names()}` : `Live · ${names()} · waiting for the host to restart`);
  draw();
}

function syncPlayers() {
  const seen = new Set(players.map((player) => player.id));
  snakes = snakes.filter((snake) => seen.has(snake.id));
  players.forEach((player, index) => {
    if (!snakes.some((snake) => snake.id === player.id)) {
      snakes.push(spawn(player.id, player.displayName, COLORS[index % COLORS.length], index));
    }
  });
}

function hostTick() {
  syncPlayers();
  for (const snake of snakes) stepSnake(snake);
  draw();
  publish(snapshot());
  const alive = snakes.filter((snake) => snake.alive);
  if (!alive.length) setStatus(`Live · ${names()} · every snake is out`);
  else setStatus(`Live · ${names()}`);
}

function soloTick() {
  const snake = snakes[0];
  if (!snake) return;
  snake.next = pending;
  stepSnake(snake);
  draw();
  setStatus(snake.alive ? 'Solo' : 'Solo · space to restart');
}

function ensureLoop(nextMode) {
  if (timer && mode === nextMode) return;
  if (timer) clearInterval(timer);
  mode = nextMode;
  timer = null;
  if (mode === 'solo') {
    if (!snakes.length) soloSnake();
    timer = setInterval(soloTick, 180);
    setStatus('Solo');
  } else if (host) {
    timer = setInterval(hostTick, 180);
    setStatus(`Live · ${names()}`);
  } else {
    setStatus(`Live · ${names()}`);
  }
  draw();
}

function onKey(event) {
  const map = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    s: 'down',
    a: 'left',
    d: 'right',
  };
  const next = map[event.key];
  if (event.key === ' ' && mode === 'solo' && snakes[0] && !snakes[0].alive) {
    soloSnake();
    return;
  }
  if (event.key === ' ' && host && snakes.length && snakes.every((snake) => !snake.alive)) {
    snakes = [];
    syncPlayers();
    return;
  }
  if (!next) return;
  event.preventDefault();
  if (mode === 'solo') {
    if (OPPOSITE[direction] !== next) pending = next;
    direction = pending;
    return;
  }
  const mine = snakes.find((snake) => snake.id === playerId);
  if (host && mine && OPPOSITE[mine.dir] !== next) mine.next = next;
  publish({ kind: 'input', direction: next });
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.channel !== 'vibehandoff') return;
  if (data.type === 'hello' || data.type === 'players') {
    playerId = data.playerId || playerId;
    host = Boolean(data.host);
    players = data.players || players;
    if ((data.mode || mode) === 'multi' || data.type === 'players') {
      if (data.type === 'hello' && data.mode === 'solo') {
        ensureLoop('solo');
        return;
      }
      ensureLoop(host ? 'multi' : 'guest');
      if (!host) setStatus(`Live · ${names()}`);
      return;
    }
    ensureLoop('solo');
  }
  if (data.type !== 'event' || !data.payload) return;
  if (data.payload.kind === 'state' && !host) applySnapshot(data.payload);
  if (data.payload.kind === 'input' && host) {
    const snake = snakes.find((item) => item.id === data.from);
    const next = data.payload.direction;
    if (snake && DIRS[next] && OPPOSITE[snake.dir] !== next) snake.next = next;
  }
}

canvas.tabIndex = 0;
canvas.addEventListener('pointerdown', () => canvas.focus());
window.addEventListener('keydown', onKey);
window.addEventListener('message', onMessage);
window.addEventListener('resize', resize);
resize();
if (window.parent !== window) {
  window.parent.postMessage({ channel: 'vibehandoff', type: 'hello' }, '*');
}
setTimeout(() => {
  if (!timer) ensureLoop('solo');
  canvas.focus();
}, 500);
