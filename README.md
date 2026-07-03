# Warlocks (browser multiplayer)

A minimal online multiplayer version of the Warcraft 3 "Warlocks" custom game.
2D top-down, HTML5 canvas client, Node.js server with WebSockets.

## Run

```
npm install
npm start
```

Open http://localhost:3000 in multiple browser tabs (or from other machines on
your LAN via http://YOUR_IP:3000) to play together.

## Controls

- WASD / arrow keys: move
- Click: cast fireball toward cursor (0.6s cooldown)

## Rules

- The arena shrinks over time; standing in lava burns you.
- Stone pillars block both players and fireballs — use them as cover.
- Fireballs deal damage and knock you back. Knockback grows with the damage
  you've taken, so wounded warlocks fly further.
- Last warlock standing wins the round. Rounds restart automatically.

## Networking model

- The server is fully authoritative: it runs the simulation at 30 ticks/s and
  broadcasts state snapshots at 30/s.
- Clients only send inputs (key state, cast direction); they never report
  positions, so clients can't desync or cheat.
- Clients render ~70ms in the past and interpolate between the two nearest
  snapshots, giving smooth movement for all players regardless of jitter.
- Fireball hits are broadcast as instant events alongside snapshots, so
  explosions and knockback appear the moment your fireball connects instead
  of waiting for the interpolation delay.

## Diagnostics (for debugging feel, optimized for AI agents)

- `GET /diag` returns compact JSON: a `flags` array of detected problems
  first, then per-client aggregates. Each browser client measures, per hit,
  the ms gap between a fireball *visually* touching the victim and the
  explosion/knockback rendering (negative = early, positive = late, ~0 ideal),
  bucketed by perspective (shoot/self/spec), plus RTT, fps, prediction error
  peaks, and hard-snap counts. Clients report every 5s over the socket.
- `FAKE_LAG=80 FAKE_JITTER=30 npm start` simulates one-way latency/jitter
  (order-preserving) to reproduce internet conditions locally.
- `node bot.js [count]` connects headless bots that move and cast, so a
  single browser tab is enough to generate real hit data.
