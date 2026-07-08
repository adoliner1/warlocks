# Warlocks (browser multiplayer)

A minimal online multiplayer version of the Warcraft 3 "Warlocks" custom game.
2D top-down, HTML5 canvas client, Node.js server with WebSockets.

## Run

```
npm install
npm start
```

Spawns 2 bots automatically. Set `BOT_COUNT=0` or `SPAWN_BOTS=0` to disable.
Or run `node bot.js [count]` manually.

Open http://localhost:3000 in multiple browser tabs (or from other machines on
your LAN via http://YOUR_IP:3000) to play together.

## Controls

- WASD / arrow keys: move
- Hold LMB: charge fireball toward cursor (up to 1.5s), release to cast
  — longer charge = faster fireball, but slows your walking while charging
- RMB: lightning strike at cursor — bolt is visual only, small hitbox at the click point

## Rules

- The arena shrinks over time; standing in lava burns you.
- The arena layout is randomly generated each round: a walled plaza around
  the center, corridor arcs, big and small rooms, plus scattered walls and
  pillars — with plenty of open walkways exposed to the lava.
- Walls and pillars block players, fireballs, and line of sight.
- Fog of war: you only see within your vision radius and line of sight
  (per-player for now; team-shared vision planned). The server filters
  snapshots, so hidden enemies are never sent to your client.
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
