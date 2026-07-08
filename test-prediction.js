// Smoke test: sequenced inputs are acked and the local prediction physics
// matches the server's authoritative result exactly.
const WS = require('ws');
const DT = 1 / 30, PLAYER_R = 16;
let MOVE_SPEED = 190, FRICTION = 3.2, PILLAR_BOUNCE = 0.3, PILLAR_SLIDE = 0.15;
let WORLD = 1600, PILLARS = [];

function stepPlayer(p, k, dt) {
  let mx = 0, my = 0;
  if (k.up) my -= 1; if (k.down) my += 1;
  if (k.left) mx -= 1; if (k.right) mx += 1;
  const len = Math.hypot(mx, my);
  if (len > 0) { mx /= len; my /= len; }
  p.x += (mx * MOVE_SPEED + p.vx) * dt;
  p.y += (my * MOVE_SPEED + p.vy) * dt;
  const d = Math.exp(-FRICTION * dt);
  p.vx *= d; p.vy *= d;
  for (const pl of PILLARS) {
    const e = pl.half + PLAYER_R;
    const dx = p.x - pl.x, dy = p.y - pl.y;
    if (Math.abs(dx) < e && Math.abs(dy) < e) {
      const ox = e - Math.abs(dx), oy = e - Math.abs(dy);
      if (ox <= oy) {
        p.x = pl.x + (dx < 0 ? -e : e);
        p.vx = -p.vx * PILLAR_BOUNCE;
        p.vy *= PILLAR_SLIDE;
      } else {
        p.y = pl.y + (dy < 0 ? -e : e);
        p.vy = -p.vy * PILLAR_BOUNCE;
        p.vx *= PILLAR_SLIDE;
      }
    }
  }
  p.x = Math.min(WORLD - PLAYER_R, Math.max(PLAYER_R, p.x));
  p.y = Math.min(WORLD - PLAYER_R, Math.max(PLAYER_R, p.y));
}

const ws = new WS('ws://localhost:3000');
let myId = null, seq = 0, sent = [], startPos = null, playing = false;

ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'welcome') {
    myId = m.id; WORLD = m.world; PILLARS = m.pillars || [];
    const t = m.tuning;
    MOVE_SPEED = t.moveSpeed; FRICTION = t.friction;
    PILLAR_BOUNCE = t.pillarBounce; PILLAR_SLIDE = t.pillarSlide;
    return;
  }
  if (m.t === 'arena') { PILLARS = m.pillars || []; return; }
  if (m.t !== 's') return;
  const me = m.players.find(p => p.id === myId);
  if (!me) return;
  if (m.round.state === 'playing' && me.a === 1 && !playing) {
    playing = true;
    startPos = { x: me.x, y: me.y };
    const iv = setInterval(() => {
      seq++;
      const k = { right: true, down: seq % 2 === 0 };
      ws.send(JSON.stringify({ t: 'input', seq, keys: k }));
      sent.push({ seq, keys: k, at: { x: me.x } });
      if (seq >= 45) {
        clearInterval(iv);
        setTimeout(() => finish(), 400);
      }
    }, 1000 / 30);
  }
  if (playing) lastSnap = { me };
});
let lastSnap = null;

function finish() {
  const me = lastSnap.me;
  console.log('start:', startPos, '\nend:  ', { x: me.x, y: me.y }, '\nacked seq:', me.seq, 'of', seq);

  // replay the same inputs locally from the start position
  const sim = { x: startPos.x, y: startPos.y, vx: 0, vy: 0 };
  for (const i of sent.filter(i => i.seq <= me.seq)) stepPlayer(sim, i.keys, DT);
  const err = Math.hypot(sim.x - me.x, sim.y - me.y);
  console.log('replayed prediction:', { x: sim.x.toFixed(1), y: sim.y.toFixed(1) }, 'error vs server:', err.toFixed(3));

  const moved = me.x > startPos.x + 100;
  const acked = me.seq > 0 && me.seq <= seq;
  const ok = moved && acked && err < 1;
  console.log(ok ? 'PASS' : 'FAIL', { moved, acked, predictionMatch: err < 1 });
  process.exit(ok ? 0 : 1);
}
setTimeout(() => { console.log('timeout FAIL'); process.exit(1); }, 15000);
