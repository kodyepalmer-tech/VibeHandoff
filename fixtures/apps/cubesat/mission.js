'use strict';

const ORBIT_SECONDS = 28;
const PASS_CENTER = 0.42;
const PASS_HALF = 0.38;
const ECLIPSE_START = Math.PI * 0.95;
const ECLIPSE_END = Math.PI * 1.62;
const GOAL = 3;

function wrap(angle) {
  const turn = Math.PI * 2;
  return ((angle % turn) + turn) % turn;
}

function inRange(angle, start, end) {
  const value = wrap(angle);
  return value >= start && value <= end;
}

function inPass(angle) {
  const value = wrap(angle);
  const turn = Math.PI * 2;
  const delta = Math.min(Math.abs(value - PASS_CENTER), turn - Math.abs(value - PASS_CENTER));
  return delta <= PASS_HALF;
}

function createMission() {
  const state = {
    theta: 0.02,
    battery: 84,
    images: 1,
    downlinked: 0,
    mode: 'sun',
    camera: false,
    radio: false,
    captureCd: 0,
    downlinkCd: 0,
    elapsed: 0,
    log: ['One image is already aboard. A ground pass is coming.'],
    outcome: null,
  };

  function note(line) {
    state.log.unshift(line);
    state.log.length = Math.min(state.log.length, 6);
  }

  function finish(outcome, line) {
    state.outcome = outcome;
    note(line);
  }

  function step(dt) {
    if (state.outcome) return snapshot();
    const tick = Math.max(0, Math.min(dt, 0.05));
    state.elapsed += tick;
    state.theta = wrap(state.theta + ((Math.PI * 2) / ORBIT_SECONDS) * tick);
    state.captureCd = Math.max(0, state.captureCd - tick);
    state.downlinkCd = Math.max(0, state.downlinkCd - tick);

    const sun = !inRange(state.theta, ECLIPSE_START, ECLIPSE_END);
    const pass = inPass(state.theta);
    let solar = 0;
    if (sun) {
      if (state.mode === 'sun') solar = 22;
      else if (state.mode === 'nadir') solar = 9;
      else solar = 6;
    }
    let load = 4;
    if (state.camera) load += 11;
    if (state.radio) load += 16;
    state.battery = Math.max(0, Math.min(100, state.battery + (solar - load) * tick));

    if (state.camera && state.mode === 'nadir' && sun && state.images < 3 && state.captureCd === 0) {
      state.images += 1;
      state.captureCd = 5.5;
      note('Payload stored an image from nadir.');
    } else if (state.camera && state.mode !== 'nadir' && state.captureCd === 0) {
      state.captureCd = 2;
      note('Camera is on, but the bus is not nadir-pointed.');
    }

    if (state.radio && pass && state.mode === 'antenna' && state.images > 0 && state.battery > 12 && state.downlinkCd === 0) {
      state.images -= 1;
      state.downlinked += 1;
      state.downlinkCd = 2.1;
      note(`Ground station received image ${state.downlinked}.`);
      if (state.downlinked >= GOAL) finish('win', 'Pass complete. The station has the set.');
    } else if (state.radio && pass && state.mode !== 'antenna' && state.downlinkCd === 0) {
      state.downlinkCd = 2;
      note('The station hears a carrier, but the antenna is pointed away.');
    }

    if (!state.outcome && state.battery <= 0) {
      finish('lose', 'Battery is empty. The bus is safe-moded.');
    }
    return snapshot();
  }

  function snapshot() {
    const sun = !inRange(state.theta, ECLIPSE_START, ECLIPSE_END);
    const pass = inPass(state.theta);
    let phase = 'Sunlight';
    if (!sun) phase = 'Eclipse';
    if (pass) phase = sun ? 'Ground pass' : 'Ground pass in eclipse';
    return {
      theta: state.theta,
      battery: state.battery,
      images: state.images,
      downlinked: state.downlinked,
      mode: state.mode,
      camera: state.camera,
      radio: state.radio,
      sun,
      pass,
      phase,
      solarHint: state.mode,
      log: state.log.slice(),
      outcome: state.outcome,
      elapsed: state.elapsed,
      goal: GOAL,
    };
  }

  return {
    state,
    step,
    snapshot,
    setMode(mode) {
      if (state.outcome) return;
      state.mode = mode;
      note(mode === 'sun' ? 'Panels to the sun.' : mode === 'nadir' ? 'Camera to nadir.' : 'Antenna on the station.');
    },
    setCamera(on) {
      state.camera = Boolean(on);
    },
    setRadio(on) {
      state.radio = Boolean(on);
    },
  };
}

function boot() {
  const mission = createMission();
  const canvas = document.getElementById('orbit');
  const ctx = canvas.getContext('2d');
  let last = performance.now();
  let reported = false;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(320, Math.floor(rect.width));
    canvas.height = Math.max(280, Math.floor(rect.height));
  }

  function project(point, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const x = point[0] * c + point[2] * s;
    const z = -point[0] * s + point[2] * c;
    const y = point[1];
    const scale = 28 / (z + 4.2);
    return [x * scale, y * scale, z];
  }

  function drawCube(cx, cy, spin) {
    const verts = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ].map((vertex) => project(vertex, spin));
    const faces = [
      [0, 1, 2, 3, '#8fd3ff'],
      [4, 5, 6, 7, '#f4c542'],
      [0, 1, 5, 4, '#d7e7f5'],
      [2, 3, 7, 6, '#67d18a'],
      [1, 2, 6, 5, '#ef8b6a'],
      [0, 3, 7, 4, '#9aa7b8'],
    ];
    faces
      .map((face) => ({ face, depth: face.slice(0, 4).reduce((sum, index) => sum + verts[index][2], 0) }))
      .sort((a, b) => a.depth - b.depth)
      .forEach(({ face }) => {
        ctx.beginPath();
        face.slice(0, 4).forEach((index, corner) => {
          const [x, y] = verts[index];
          if (corner === 0) ctx.moveTo(cx + x, cy + y);
          else ctx.lineTo(cx + x, cy + y);
        });
        ctx.closePath();
        ctx.fillStyle = face[4];
        ctx.fill();
        ctx.strokeStyle = '#102033';
        ctx.stroke();
      });
  }

  function draw(view) {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w * 0.5;
    const cy = h * 0.52;
    const earth = Math.min(w, h) * 0.22;
    const orbit = earth * 2.15;

    const sky = ctx.createRadialGradient(cx, cy, earth * 0.2, cx, cy, orbit * 1.4);
    sky.addColorStop(0, '#1b3a57');
    sky.addColorStop(1, '#071018');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(232,241,248,0.35)';
    ctx.lineWidth = 2;
    ctx.arc(cx, cy, orbit, 0, Math.PI * 2);
    ctx.stroke();

    if (view.pass) {
      ctx.beginPath();
      ctx.strokeStyle = '#f4c542';
      ctx.lineWidth = 6;
      ctx.arc(cx, cy, orbit, PASS_CENTER - PASS_HALF, PASS_CENTER + PASS_HALF);
      ctx.stroke();
    }

    const earthFill = ctx.createRadialGradient(cx - earth * 0.3, cy - earth * 0.3, earth * 0.2, cx, cy, earth);
    earthFill.addColorStop(0, '#67d18a');
    earthFill.addColorStop(0.55, '#2f6f8f');
    earthFill.addColorStop(1, '#16324a');
    ctx.beginPath();
    ctx.fillStyle = earthFill;
    ctx.arc(cx, cy, earth, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = 'rgba(4, 10, 16, 0.55)';
    ctx.arc(cx, cy, earth, ECLIPSE_START, ECLIPSE_END);
    ctx.arc(cx, cy, earth * 0.2, ECLIPSE_END, ECLIPSE_START, true);
    ctx.fill();

    const sx = cx + Math.cos(view.theta) * orbit;
    const sy = cy + Math.sin(view.theta) * orbit;
    drawCube(sx, sy, view.elapsed * (view.mode === 'antenna' ? 0.4 : 1.3));

    ctx.fillStyle = '#f4c542';
    ctx.font = '12px sans-serif';
    ctx.fillText('Ground station', cx + Math.cos(PASS_CENTER) * (earth + 18) - 36, cy + Math.sin(PASS_CENTER) * (earth + 18));
  }

  function render() {
    const view = mission.snapshot();
    draw(view);
    document.getElementById('phase').textContent = view.phase;
    document.getElementById('battery').textContent = `${Math.round(view.battery)}%`;
    document.getElementById('aboard').textContent = `${view.images} / 3`;
    document.getElementById('down').textContent = `${view.downlinked} / ${view.goal}`;
    document.getElementById('power').textContent = view.sun ? 'arrays lit' : 'arrays dark';
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === view.mode);
    });
    document.getElementById('log').innerHTML = view.log.map((line) => `<li>${line}</li>`).join('');
    const end = document.getElementById('end');
    if (view.outcome) {
      end.hidden = false;
      end.textContent = view.outcome === 'win' ? 'Downlink complete.' : 'Safe mode. Battery empty.';
      if (!reported) {
        reported = true;
        const score = view.downlinked * 100 + Math.round(view.battery);
        parent.postMessage({ type: 'VIBE_SUBMIT_SCORE', payload: { score } }, '*');
        parent.postMessage(
          {
            type: 'VIBE_SAVE_PROGRESS',
            requestId: 'cubesat-mission',
            payload: { key: 'mission', data: { downlinked: view.downlinked, score } },
          },
          '*'
        );
      }
    }
  }

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => mission.setMode(button.dataset.mode));
  });
  document.getElementById('camera').addEventListener('change', (event) => mission.setCamera(event.target.checked));
  document.getElementById('radio').addEventListener('change', (event) => mission.setRadio(event.target.checked));
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if (key === '1') mission.setMode('sun');
    if (key === '2') mission.setMode('nadir');
    if (key === '3') mission.setMode('antenna');
    if (key === 'c') {
      const box = document.getElementById('camera');
      box.checked = !box.checked;
      mission.setCamera(box.checked);
    }
    if (key === 'r') {
      const box = document.getElementById('radio');
      box.checked = !box.checked;
      mission.setRadio(box.checked);
    }
  });

  window.addEventListener('resize', resize);
  resize();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    mission.step(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

if (typeof window !== 'undefined') boot();
if (typeof module !== 'undefined' && module.exports) module.exports = { createMission };
