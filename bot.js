// Headless bot: avoids lava, kites enemies, casts when safe.
// Usage: node bot.js [count] [port]
const WS = require('ws');
const COUNT = Number(process.argv[2] || 1);
const PORT = Number(process.argv[3] || 3000);
const CHARGE_MAX = 1.5;
const RECONNECT_MS = 2000;
const LAVA_BUFFER = 90;   // start steering inward this far from the edge
const PANIC_BUFFER = 35;  // full retreat toward center

function keysFromVec(mx, my) {
  return {
    up: my < -0.2,
    down: my > 0.2,
    left: mx < -0.2,
    right: mx > 0.2
  };
}

function towardCenter(me, center) {
  const dx = center.x - me.x, dy = center.y - me.y;
  const len = Math.hypot(dx, dy) || 1;
  return { mx: dx / len, my: dy / len };
}

function pickMove(me, center, arenaR, target) {
  const ox = me.x - center.x, oy = me.y - center.y;
  const dist = Math.hypot(ox, oy);
  const edgeDist = arenaR - dist; // positive = inside safe zone

  // lava is outside the circle — always prioritize getting back in
  if (edgeDist < PANIC_BUFFER) {
    const w = edgeDist < 0 ? 1.4 : 1.0;
    const c = towardCenter(me, center);
    return keysFromVec(c.mx * w, c.my * w);
  }
  if (edgeDist < LAVA_BUFFER) {
    const c = towardCenter(me, center);
    const urgency = 1 - edgeDist / LAVA_BUFFER;
    let mx = c.mx * (0.6 + urgency * 0.8);
    let my = c.my * (0.6 + urgency * 0.8);
    if (target) {
      const tx = target.x - me.x, ty = target.y - me.y;
      const tlen = Math.hypot(tx, ty) || 1;
      mx += (-ty / tlen) * 0.25 * (1 - urgency);
      my += (tx / tlen) * 0.25 * (1 - urgency);
    }
    const len = Math.hypot(mx, my) || 1;
    return keysFromVec(mx / len, my / len);
  }

  if (!target) {
    const c = towardCenter(me, center);
    return keysFromVec(c.mx * 0.15, c.my * 0.15);
  }

  const tx = target.x - me.x, ty = target.y - me.y;
  const tlen = Math.hypot(tx, ty) || 1;
  const nx = tx / tlen, ny = ty / tlen;
  let mx = 0, my = 0;
  const preferRange = 260;

  if (tlen > preferRange + 60) {
    mx = nx * 0.7; my = ny * 0.7;
  } else if (tlen < preferRange - 40) {
    mx = -nx * 0.55; my = -ny * 0.55;
  } else {
    mx = -ny * 0.65; my = nx * 0.65;
    if (Math.random() < 0.02) { mx = ny * 0.65; my = -nx * 0.65; }
  }

  // never drift toward lava while fighting
  if (dist > arenaR * 0.55) {
    const c = towardCenter(me, center);
    const pull = (dist - arenaR * 0.55) / (arenaR * 0.45);
    mx += c.mx * pull * 0.9;
    my += c.my * pull * 0.9;
  }

  const len = Math.hypot(mx, my) || 1;
  return keysFromVec(mx / len, my / len);
}

function spawnBot(n) {
  let ws = null, myId = null, seq = 0, last = null;
  let center = { x: 1600, y: 1600 };
  let charging = false, chargeStart = 0, chargeAim = { dx: 1, dy: 0 };

  function connect() {
    myId = null; seq = 0; last = null; charging = false;
    ws = new WS(`ws://localhost:${PORT}`);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'name', name: `Bot${n}` })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { myId = m.id; center = m.center; }
      if (m.t === 's') last = m;
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      console.log(`Bot${n} disconnected, retrying in ${RECONNECT_MS / 1000}s`);
      setTimeout(connect, RECONNECT_MS);
    });
  }
  connect();

  setInterval(() => {
    if (!ws || ws.readyState !== 1 || !last) return;
    const me = last.players.find(p => p.id === myId);
    const arenaR = last.round.arenaR;
    const playing = last.round.state === 'playing';

    if (!me || !me.a || !playing) {
      charging = false;
      seq++;
      ws.send(JSON.stringify({ t: 'input', seq, keys: { up: false, down: false, left: false, right: false } }));
      return;
    }

    const target = last.players
      .filter(p => p.id !== myId && p.a)
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];

    const inLava = Math.hypot(me.x - center.x, me.y - center.y) > arenaR - 10;
    const dir = pickMove(me, center, arenaR, inLava ? null : target);

    if (!charging && target && !inLava && (me.cd || 0) === 0 && Math.random() < 0.045) {
      charging = true;
      chargeStart = Date.now();
      chargeAim = { dx: target.x - me.x, dy: target.y - me.y };
    }

    if (charging) {
      if (target && !inLava) chargeAim = { dx: target.x - me.x, dy: target.y - me.y };
      const held = (Date.now() - chargeStart) / 1000;
      if (inLava || held >= 0.2 + Math.random() * 1.0) {
        if (!inLava) {
          ws.send(JSON.stringify({
            t: 'cast', dx: chargeAim.dx, dy: chargeAim.dy,
            charge: Math.min(CHARGE_MAX, held)
          }));
        }
        charging = false;
      }
    } else if (target && !inLava && (me.lcd || 0) === 0 && Math.random() < 0.028) {
      ws.send(JSON.stringify({ t: 'lightning', tx: target.x, ty: target.y }));
    }

    seq++;
    ws.send(JSON.stringify({
      t: 'input', seq,
      keys: { ...dir, charge: charging && !inLava, cdx: chargeAim.dx, cdy: chargeAim.dy }
    }));
  }, 1000 / 30);
}

for (let i = 1; i <= COUNT; i++) spawnBot(i);
console.log(`${COUNT} bot(s) connecting to :${PORT}`);
