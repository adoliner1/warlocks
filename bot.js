// Headless bot for driving test matches: moves randomly, casts at the
// nearest enemy. Usage: node bot.js [count] [port]
const WS = require('ws');
const COUNT = Number(process.argv[2] || 1);
const PORT = Number(process.argv[3] || 3000);

function spawnBot(n) {
  const ws = new WS(`ws://localhost:${PORT}`);
  let myId = null, seq = 0, last = null, castAt = 0;
  let dir = { up: false, down: false, left: false, right: false };

  ws.on('open', () => ws.send(JSON.stringify({ t: 'name', name: `Bot${n}` })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'welcome') myId = m.id;
    if (m.t === 's') last = m;
  });
  ws.on('close', () => process.exit(0));

  setInterval(() => {
    const keys = ['up', 'down', 'left', 'right'];
    dir = {};
    dir[keys[Math.floor(Math.random() * 4)]] = true;
    if (Math.random() < 0.5) dir[keys[Math.floor(Math.random() * 4)]] = true;
  }, 600 + Math.random() * 600);

  setInterval(() => {
    if (ws.readyState !== 1 || !last) return;
    seq++;
    ws.send(JSON.stringify({ t: 'input', seq, keys: dir }));
    const me = last.players.find(p => p.id === myId);
    if (!me || !me.a || last.round.state !== 'playing') return;
    if (Date.now() - castAt > 700 + Math.random() * 500) {
      const target = last.players.find(p => p.id !== myId && p.a);
      if (target) {
        castAt = Date.now();
        // small lead + spread so shots sometimes hit, sometimes miss
        const jx = (Math.random() - 0.5) * 60, jy = (Math.random() - 0.5) * 60;
        ws.send(JSON.stringify({ t: 'cast', dx: target.x - me.x + jx, dy: target.y - me.y + jy }));
      }
    }
  }, 1000 / 30);
}

for (let i = 1; i <= COUNT; i++) spawnBot(i);
console.log(`${COUNT} bot(s) connecting to :${PORT}`);
