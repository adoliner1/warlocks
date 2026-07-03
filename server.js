const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const TICK_RATE = 30;            // simulation ticks per second
const SNAPSHOT_EVERY = 1;        // broadcast every tick (30/s)
const DT = 1 / TICK_RATE;

const WORLD = 3200;              // world is WORLD x WORLD, arena centered
const CENTER = { x: WORLD / 2, y: WORLD / 2 };
const ARENA_START_R = 1280;
const ARENA_MIN_R = 110;
const SHRINK_PER_SEC = 24;

// static terrain: square pillars (half = half side length) of varying sizes;
// they block players and fireballs; sent to clients in welcome
const PILLARS = [
  { x: CENTER.x, y: CENTER.y, half: 60 },
  { x: CENTER.x - 424, y: CENTER.y - 424, half: 38 },
  { x: CENTER.x + 424, y: CENTER.y - 424, half: 52 },
  { x: CENTER.x - 424, y: CENTER.y + 424, half: 52 },
  { x: CENTER.x + 424, y: CENTER.y + 424, half: 38 },
  { x: CENTER.x - 600, y: CENTER.y, half: 30 },
  { x: CENTER.x + 600, y: CENTER.y, half: 30 },
  { x: CENTER.x - 700, y: CENTER.y - 700, half: 45 },
  { x: CENTER.x + 700, y: CENTER.y + 700, half: 42 },
  { x: CENTER.x - 700, y: CENTER.y + 700, half: 50 },
  { x: CENTER.x + 700, y: CENTER.y - 700, half: 48 }
];

const PLAYER_R = 16;
const MAX_HP = 100;
const LAVA_DPS = 16;
const FIREBALL_R = 9;
const FIREBALL_LIFE = 2.2;

// live-tunable gameplay values (slider panel in the client, T key).
// Synced to all clients on change: prediction physics must match exactly.
const TUNING = {
  moveSpeed: 190,
  friction: 3.2,          // knockback velocity decay per second
  dashSpeed: 700,
  dashCooldown: 0,
  castCooldown: 0.6,
  fireballSpeed: 420,
  fireballDmg: 10,
  kbBase: 260,            // knockback grows with damage taken (classic Warlocks)
  kbPerDmg: 4.5,
  pillarBounce: 0.3,      // fraction of impact speed reflected off pillars
  pillarSlide: 0.15       // fraction of along-face momentum kept on impact
};
const TUNING_RANGE = {
  moveSpeed: [50, 500], friction: [0.5, 10], dashSpeed: [0, 1500], dashCooldown: [0, 10],
  castCooldown: [0.05, 3], fireballSpeed: [100, 1200], fireballDmg: [0, 50],
  kbBase: [0, 800], kbPerDmg: [0, 20], pillarBounce: [0, 1], pillarSlide: [0, 1]
};

// simulated network conditions for testing feel (one-way ms; RTT is ~2x)
const FAKE_LAG = Number(process.env.FAKE_LAG || 0);
const FAKE_JITTER = Number(process.env.FAKE_JITTER || 0);

let nextId = 1;
const players = new Map();       // id -> player
let fireballs = [];
let nextFireballId = 1;
let hitEvents = [];              // fireball hits this tick, sent with the next snapshot

// round state: 'lobby' | 'countdown' | 'playing' | 'ended'
let round = { state: 'lobby', timer: 0, arenaR: ARENA_START_R, winner: null, participants: 0 };

function spawnPositions(n) {
  const out = [];
  const r = ARENA_START_R * 0.6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: CENTER.x + Math.cos(a) * r, y: CENTER.y + Math.sin(a) * r });
  }
  return out;
}

function startCountdown() {
  round = { state: 'countdown', timer: 3, arenaR: ARENA_START_R, winner: null, participants: 0 };
  const alive = [...players.values()];
  const spots = spawnPositions(alive.length);
  alive.forEach((p, i) => {
    p.x = spots[i].x; p.y = spots[i].y;
    p.vx = 0; p.vy = 0;
    p.hp = MAX_HP; p.dmgTaken = 0; p.alive = true; p.cooldown = 0; p.dashCd = 0;
  });
  fireballs = [];
}

function resetToLobby() {
  round = { state: 'lobby', timer: 0, arenaR: ARENA_START_R, winner: null, participants: 0 };
}

// One physics step for a player. Mirrored exactly on the client for prediction.
function stepPlayer(p, keys, dt) {
  let mx = 0, my = 0;
  if (keys.up) my -= 1;
  if (keys.down) my += 1;
  if (keys.left) mx -= 1;
  if (keys.right) mx += 1;
  const len = Math.hypot(mx, my);
  if (len > 0) { mx /= len; my /= len; }
  p.dashCd = Math.max(0, (p.dashCd || 0) - dt);
  if (keys.dash && p.dashCd === 0 && len > 0) {
    p.vx += mx * TUNING.dashSpeed;
    p.vy += my * TUNING.dashSpeed;
    p.dashCd = TUNING.dashCooldown;
  }
  p.x += (mx * TUNING.moveSpeed + p.vx) * dt;
  p.y += (my * TUNING.moveSpeed + p.vy) * dt;
  const decay = Math.exp(-TUNING.friction * dt);
  p.vx *= decay; p.vy *= decay;
  // square pillars: push out along the axis of least penetration and
  // reflect that axis's velocity with a small bounce
  for (const pl of PILLARS) {
    const e = pl.half + PLAYER_R;
    const dx = p.x - pl.x, dy = p.y - pl.y;
    if (Math.abs(dx) < e && Math.abs(dy) < e) {
      const ox = e - Math.abs(dx), oy = e - Math.abs(dy);
      if (ox <= oy) {
        p.x = pl.x + (dx < 0 ? -e : e);
        p.vx = -p.vx * TUNING.pillarBounce;
        p.vy *= TUNING.pillarSlide;
      } else {
        p.y = pl.y + (dy < 0 ? -e : e);
        p.vy = -p.vy * TUNING.pillarBounce;
        p.vx *= TUNING.pillarSlide;
      }
    }
  }
  p.x = Math.min(WORLD - PLAYER_R, Math.max(PLAYER_R, p.x));
  p.y = Math.min(WORLD - PLAYER_R, Math.max(PLAYER_R, p.y));
}

function damage(p, amount, kx, ky) {
  if (!p.alive) return;
  p.hp -= amount;
  p.dmgTaken += amount;
  if (kx || ky) {
    const kb = TUNING.kbBase + TUNING.kbPerDmg * p.dmgTaken;
    const len = Math.hypot(kx, ky) || 1;
    p.vx += (kx / len) * kb;
    p.vy += (ky / len) * kb;
  }
  if (p.hp <= 0) { p.hp = 0; p.alive = false; }
}

function tick() {
  // round management
  if (round.state === 'lobby') {
    if (players.size >= 1) startCountdown();
  } else if (round.state === 'countdown') {
    round.timer -= DT;
    if (round.timer <= 0) {
      round.state = 'playing';
      round.participants = [...players.values()].filter(p => p.alive).length;
    }
  } else if (round.state === 'ended') {
    round.timer -= DT;
    if (round.timer <= 0) {
      if (players.size >= 1) startCountdown(); else resetToLobby();
    }
  }

  const playing = round.state === 'playing';

  if (playing) {
    round.arenaR = Math.max(ARENA_MIN_R, round.arenaR - SHRINK_PER_SEC * DT);
  }

  for (const p of players.values()) {
    if (!p.alive) {
      if (p.inputQueue.length > 0) p.lastSeq = p.inputQueue[p.inputQueue.length - 1].seq;
      p.inputQueue.length = 0;
      continue;
    }
    p.cooldown = Math.max(0, p.cooldown - DT);

    // Consume queued sequenced inputs, one tick's worth of movement each.
    // Cap per tick so a client can't move faster by flooding inputs.
    const canMove = round.state !== 'countdown';
    let steps = 0;
    while (p.inputQueue.length > 0 && steps < 3) {
      const inp = p.inputQueue.shift();
      stepPlayer(p, canMove ? inp.keys : {}, DT);
      p.lastSeq = inp.seq;
      steps++;
    }
    if (steps === 0) stepPlayer(p, {}, DT); // no input this tick: still apply knockback physics

    // lava
    if (playing) {
      const d = Math.hypot(p.x - CENTER.x, p.y - CENTER.y);
      if (d > round.arenaR) damage(p, LAVA_DPS * DT, 0, 0);
    }
  }

  // fireballs
  if (playing) {
    for (const f of fireballs) {
      f.x += f.dx * TUNING.fireballSpeed * DT;
      f.y += f.dy * TUNING.fireballSpeed * DT;
      f.life -= DT;
      for (const pl of PILLARS) {
        const e = pl.half + FIREBALL_R;
        if (Math.abs(f.x - pl.x) < e && Math.abs(f.y - pl.y) < e) { f.life = 0; break; }
      }
      if (f.life <= 0) continue;
      for (const p of players.values()) {
        if (!p.alive || p.id === f.owner) continue;
        if (Math.hypot(p.x - f.x, p.y - f.y) < PLAYER_R + FIREBALL_R) {
          damage(p, TUNING.fireballDmg, f.dx, f.dy);
          hitEvents.push({
            fid: f.id, o: f.owner, v: p.id,
            x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10,
            dx: f.dx, dy: f.dy,
            kb: Math.round(TUNING.kbBase + TUNING.kbPerDmg * p.dmgTaken)
          });
          f.life = 0;
          break;
        }
      }
    }
    fireballs = fireballs.filter(f => f.life > 0);

    // win check
    const alive = [...players.values()].filter(p => p.alive);
    if (round.participants >= 2 && alive.length <= 1) {
      round.state = 'ended';
      round.timer = 4;
      round.winner = alive.length === 1 ? alive[0].name : null;
      if (alive.length === 1) alive[0].wins += 1;
    } else if (round.participants < 2 && players.size >= 2) {
      // someone joined during a solo practice round: restart with everyone
      startCountdown();
    } else if (alive.length === 0 && round.participants < 2) {
      round.state = 'ended';
      round.timer = 2;
      round.winner = null;
    }
  }
}

function snapshot() {
  const hits = hitEvents;
  hitEvents = [];
  return JSON.stringify({
    t: 's',
    now: Date.now(),
    hits,
    round: { state: round.state, timer: Math.max(0, round.timer), arenaR: round.arenaR, winner: round.winner },
    players: [...players.values()].map(p => ({
      id: p.id, n: p.name, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
      vx: Math.round(p.vx * 10) / 10, vy: Math.round(p.vy * 10) / 10,
      hp: Math.round(p.hp), a: p.alive ? 1 : 0, w: p.wins, seq: p.lastSeq,
      cd: Math.round(p.cooldown * 100) / 100, dcd: Math.round(p.dashCd * 100) / 100
    })),
    fireballs: fireballs.map(f => ({
      id: f.id, o: f.owner, x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10,
      dx: Math.round(f.dx * 1000) / 1000, dy: Math.round(f.dy * 1000) / 1000
    }))
  });
}

function netDelay() { return FAKE_LAG + Math.random() * FAKE_JITTER; }
// jittered delivery must stay in order (TCP never reorders)
function sendTo(p, data) {
  if (!FAKE_LAG && !FAKE_JITTER) {
    if (p.ws.readyState === 1) p.ws.send(data);
    return;
  }
  p.sendAt = Math.max(Date.now() + netDelay(), p.sendAt || 0);
  setTimeout(() => { if (p.ws.readyState === 1) p.ws.send(data); }, p.sendAt - Date.now());
}

let tickStats = { n: 0, sumGap: 0, maxGap: 0, last: 0 };

const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));
// Compact machine-readable diagnostics. Timing fields are ms between the
// rendered fireball visually reaching the impact point and the explosion
// (boom) / knockback (knock) rendering: negative = early, positive = late, ~0 ideal.
// p50 = typical, worst = largest magnitude in the rolling window (last 60 hits).
// Perspectives: shoot = own fireball hitting someone, self = got hit, spec = watched others.
app.get('/diag', (req, res) => {
  const clients = [...players.values()].map(p => {
    if (!p.diag) return { id: p.id, name: p.name, noDiagYet: true };
    const { at, ...d } = p.diag;
    return { id: p.id, name: p.name, reportAgeS: Math.round((Date.now() - at) / 1000), ...d };
  });

  const flags = [];
  for (const c of clients) {
    if (c.noDiagYet) continue;
    for (const [role, r] of Object.entries(c.hits || {})) {
      for (const kind of ['boom', 'knock']) {
        const a = r[kind];
        if (!a) continue;
        if (Math.abs(a.p50) > 60) flags.push(`${c.name}/${role}: ${kind} consistently ${a.p50 > 0 ? 'late' : 'early'} vs visual contact (p50=${a.p50}ms, n=${r.n})`);
        else if (Math.abs(a.worst) > 150) flags.push(`${c.name}/${role}: ${kind} spiked to ${a.worst}ms vs visual contact (p50=${a.p50}ms, n=${r.n})`);
      }
    }
    if (c.hardSnaps > 0) flags.push(`${c.name}: ${c.hardSnaps} hard position snaps since load (prediction diverged >120px)`);
    if (c.noContact > 0) flags.push(`${c.name}: ${c.noContact} hits with no contact reference (couldn't time the fireball's visual arrival)`);
    if (c.noKnock > 0) flags.push(`${c.name}: ${c.noKnock} hits with no detectable knockback jolt`);
    if (c.fps && c.fps < 40) flags.push(`${c.name}: low fps (${c.fps})`);
    if (c.maxErr > 40) flags.push(`${c.name}: prediction error peaked at ${c.maxErr}px in last report window`);
  }
  if (tickStats.maxGap > 100) flags.push(`server: tick interval spiked to ${tickStats.maxGap}ms (target ${Math.round(1000 / TICK_RATE)}ms)`);
  const avgTick = tickStats.n ? tickStats.sumGap / tickStats.n : null;
  if (avgTick && Math.abs(avgTick - 1000 / TICK_RATE) > 100 / TICK_RATE) {
    flags.push(`server: sim running ${Math.round((avgTick * TICK_RATE / 10) - 100)}% slow (avg tick ${Math.round(avgTick * 10) / 10}ms vs ${Math.round(1000 / TICK_RATE * 10) / 10}ms target)`);
  }

  res.json({
    flags,
    config: { tickRate: TICK_RATE, fakeLagMs: FAKE_LAG, fakeJitterMs: FAKE_JITTER, tuning: TUNING },
    server: {
      players: players.size, round: round.state,
      tickAvgMs: tickStats.n ? Math.round(tickStats.sumGap / tickStats.n * 10) / 10 : null,
      tickMaxMs: tickStats.maxGap
    },
    clients
  });
  tickStats = { n: 0, sumGap: 0, maxGap: 0, last: tickStats.last };
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = nextId++;
  const p = {
    id, name: 'Warlock' + id, ws,
    x: CENTER.x, y: CENTER.y, vx: 0, vy: 0,
    hp: MAX_HP, dmgTaken: 0, alive: true, cooldown: 0, dashCd: 0, wins: 0,
    inputQueue: [], lastSeq: 0
  };
  players.set(id, p);

  // joining mid-round: spectate as dead until next round
  if (round.state === 'playing') { p.alive = false; p.hp = 0; }

  sendTo(p, JSON.stringify({
    t: 'welcome', id,
    world: WORLD, center: CENTER, playerR: PLAYER_R, fireballR: FIREBALL_R,
    pillars: PILLARS, tuning: TUNING
  }));

  const handleMessage = (raw) => {
    if (!players.has(id)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'input' && msg.keys && Number.isFinite(msg.seq)) {
      const lastQueued = p.inputQueue.length ? p.inputQueue[p.inputQueue.length - 1].seq : p.lastSeq;
      if (msg.seq <= lastQueued) return; // stale or duplicate
      p.inputQueue.push({
        seq: msg.seq,
        keys: { up: !!msg.keys.up, down: !!msg.keys.down, left: !!msg.keys.left, right: !!msg.keys.right, dash: !!msg.keys.dash }
      });
      if (p.inputQueue.length > 10) p.inputQueue.shift(); // drop oldest under flood
    } else if (msg.t === 'cast') {
      if (round.state !== 'playing' || !p.alive || p.cooldown > 0) return;
      const len = Math.hypot(msg.dx, msg.dy);
      if (!isFinite(len) || len === 0) return;
      p.cooldown = TUNING.castCooldown;
      fireballs.push({
        id: nextFireballId++, owner: id,
        x: p.x, y: p.y, dx: msg.dx / len, dy: msg.dy / len, life: FIREBALL_LIFE
      });
    } else if (msg.t === 'name' && typeof msg.name === 'string') {
      p.name = msg.name.slice(0, 16).trim() || p.name;
    } else if (msg.t === 'tune' && TUNING_RANGE[msg.key] && Number.isFinite(msg.value)) {
      const [lo, hi] = TUNING_RANGE[msg.key];
      TUNING[msg.key] = Math.min(hi, Math.max(lo, msg.value));
      const out = JSON.stringify({ t: 'tuning', tuning: TUNING });
      for (const q of players.values()) sendTo(q, out);
    } else if (msg.t === 'ping') {
      sendTo(p, JSON.stringify({ t: 'pong', c: msg.c }));
    } else if (msg.t === 'diag' && msg.d && typeof msg.d === 'object') {
      p.diag = { at: Date.now(), ...msg.d };
    }
  };

  ws.on('message', !FAKE_LAG && !FAKE_JITTER ? handleMessage : (raw) => {
    p.recvAt = Math.max(Date.now() + netDelay(), p.recvAt || 0);
    setTimeout(() => handleMessage(raw), p.recvAt - Date.now());
  });

  ws.on('close', () => {
    players.delete(id);
    if (players.size === 0) resetToLobby();
  });
});

// Self-correcting tick loop: plain setInterval drifts (~39ms instead of 33ms
// on Windows), which made the whole sim run slower than real time.
let tickCount = 0;
let nextTickAt = Date.now();
function tickLoop() {
  const now = Date.now();
  if (tickStats.last) {
    const gap = now - tickStats.last;
    tickStats.n++; tickStats.sumGap += gap;
    tickStats.maxGap = Math.max(tickStats.maxGap, gap);
  }
  tickStats.last = now;
  tick();
  tickCount++;
  if (tickCount % SNAPSHOT_EVERY === 0) {
    const snap = snapshot();
    for (const p of players.values()) sendTo(p, snap);
  }
  nextTickAt += 1000 / TICK_RATE;
  if (nextTickAt < Date.now() - 250) nextTickAt = Date.now(); // fell badly behind
  setTimeout(tickLoop, Math.max(0, nextTickAt - Date.now()));
}
tickLoop();

server.listen(PORT, () => console.log(`Warlocks running at http://localhost:${PORT}`));
