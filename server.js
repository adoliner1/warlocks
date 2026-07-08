const express = require('express');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
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

// --- terrain: everything is built from square blocks (half = half side
// length) so the collision code (players, fireballs, lightning, LOS) stays
// uniform. The arena layout is regenerated randomly every round and
// broadcast to clients.
const WALL_HALF = 28;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function angNorm(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Random arena: open plaza ring in the center (the big circle), broken
// corridor arcs around it, big/small rooms in the outer band, plus a few
// straight walls and scattered pillars. Lots of gaps stay open so the
// shrinking lava keeps mattering.
function generateArena(seed) {
  const rnd = mulberry32(seed >>> 0);
  const blocks = [];
  const rooms = []; // {x, y, hw, hh} interiors, used as keep-out zones

  const nearRoom = (x, y, m) =>
    rooms.some(r => Math.abs(x - r.x) < r.hw + m && Math.abs(y - r.y) < r.hh + m);
  const nearBlock = (x, y, m) =>
    blocks.some(b => Math.hypot(x - b.x, y - b.y) < b.half + m);

  const addBlock = (x, y, half) => {
    if (Math.hypot(x - CENTER.x, y - CENTER.y) > ARENA_START_R - half - 30) return;
    blocks.push({ x: Math.round(x), y: Math.round(y), half });
  };

  // center pillar + plaza ring with 3-5 gates
  addBlock(CENTER.x, CENTER.y, 60);
  const plazaR = 300;
  {
    const gates = 3 + Math.floor(rnd() * 3);
    const gateW = (180 + rnd() * 60) / plazaR;
    const off = rnd() * Math.PI * 2;
    const centers = [];
    for (let i = 0; i < gates; i++) centers.push(off + (i / gates) * Math.PI * 2 + (rnd() - 0.5) * 0.4);
    const step = (WALL_HALF * 2 - 8) / plazaR;
    for (let a = 0; a < Math.PI * 2; a += step) {
      if (centers.some(c => Math.abs(angNorm(a - c)) < gateW / 2)) continue;
      addBlock(CENTER.x + Math.cos(a) * plazaR, CENTER.y + Math.sin(a) * plazaR, WALL_HALF);
    }
  }

  function lineWall(x0, y0, x1, y1, doors) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / (WALL_HALF * 2 - 8)));
    for (let i = 0; i <= n; i++) {
      const d = (i / n) * len;
      if (doors.some(dr => Math.abs(d - dr.at) < dr.w / 2)) continue;
      addBlock(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, WALL_HALF);
    }
  }

  function addRoom(cx, cy, w, h) {
    rooms.push({ x: cx, y: cy, hw: w / 2, hh: h / 2 });
    const x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
    const walls = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
    const doorWalls = new Set();
    while (doorWalls.size < 2 + Math.floor(rnd() * 2)) doorWalls.add(Math.floor(rnd() * 4));
    walls.forEach((wl, i) => {
      const doors = [];
      const len = Math.hypot(wl[2] - wl[0], wl[3] - wl[1]);
      if (doorWalls.has(i)) doors.push({ at: len * (0.3 + rnd() * 0.4), w: 140 + rnd() * 60 });
      lineWall(wl[0], wl[1], wl[2], wl[3], doors);
    });
  }

  function placeRooms(count, wMin, wMax, hMin, hMax, rMin, rMax) {
    for (let i = 0; i < count; i++) {
      for (let t = 0; t < 60; t++) {
        const w = wMin + rnd() * (wMax - wMin), h = hMin + rnd() * (hMax - hMin);
        const halfDiag = Math.hypot(w, h) / 2;
        const rr = rMin + rnd() * (rMax - rMin);
        if (rr + halfDiag > ARENA_START_R - 70) continue;
        if (rr - halfDiag < plazaR + 130) continue;
        const aa = rnd() * Math.PI * 2;
        const cx = CENTER.x + Math.cos(aa) * rr, cy = CENTER.y + Math.sin(aa) * rr;
        if (rooms.some(r => Math.hypot(r.x - cx, r.y - cy) < Math.hypot(r.hw, r.hh) + halfDiag + 150)) continue;
        addRoom(cx, cy, w, h);
        break;
      }
    }
  }
  placeRooms(2 + Math.floor(rnd() * 2), 360, 460, 280, 360, 720, 930);  // big rooms
  placeRooms(3 + Math.floor(rnd() * 2), 190, 260, 170, 230, 700, 1080); // small rooms

  // broken corridor arcs around the plaza, skipping room zones
  {
    const midR = 540 + rnd() * 50;
    let a = rnd() * Math.PI * 2;
    const a0 = a;
    while (a - a0 < Math.PI * 2 - 1.0) {
      const span = 0.7 + rnd() * 0.9;
      const r = midR + (rnd() - 0.5) * 40;
      const step = (WALL_HALF * 2 - 8) / r;
      for (let q = a; q < a + span && q - a0 < Math.PI * 2 - 0.4; q += step) {
        const x = CENTER.x + Math.cos(q) * r, y = CENTER.y + Math.sin(q) * r;
        if (nearRoom(x, y, 140)) continue;
        addBlock(x, y, WALL_HALF);
      }
      a += span + 0.5 + rnd() * 0.8;
    }
  }

  // a few straight standalone walls in open space
  for (let i = 0, n = 2 + Math.floor(rnd() * 3); i < n; i++) {
    for (let t = 0; t < 40; t++) {
      const rr = 430 + rnd() * 650;
      const aa = rnd() * Math.PI * 2;
      const cx = CENTER.x + Math.cos(aa) * rr, cy = CENTER.y + Math.sin(aa) * rr;
      if (nearRoom(cx, cy, 200) || nearBlock(cx, cy, 220)) continue;
      const len = 200 + rnd() * 140;
      const dx = rnd() < 0.5 ? len / 2 : 0, dy = dx ? 0 : len / 2;
      lineWall(cx - dx, cy - dy, cx + dx, cy + dy, []);
      break;
    }
  }

  // scattered pillars
  for (let i = 0, n = 4 + Math.floor(rnd() * 4); i < n; i++) {
    for (let t = 0; t < 40; t++) {
      const rr = 380 + rnd() * 760;
      const aa = rnd() * Math.PI * 2;
      const x = CENTER.x + Math.cos(aa) * rr, y = CENTER.y + Math.sin(aa) * rr;
      if (nearRoom(x, y, 120) || nearBlock(x, y, 170)) continue;
      addBlock(x, y, 30 + rnd() * 25);
      break;
    }
  }

  return blocks;
}

let arenaSeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
let PILLARS = generateArena(arenaSeed);

// --- fog of war ---
const VISION_R = 650;

// vision sources for a viewer; later, team vision = all teammates
function visionSources(viewer) {
  return [viewer];
}

function losBlocked(x0, y0, x1, y1) {
  let dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return false;
  dx /= dist; dy /= dist;
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  for (const pl of PILLARS) {
    if (pl.x + pl.half < minX || pl.x - pl.half > maxX ||
        pl.y + pl.half < minY || pl.y - pl.half > maxY) continue;
    if (rayAABBHitDist(x0, y0, dx, dy, pl.x, pl.y, pl.half, dist) !== null) return true;
  }
  return false;
}

function canSee(viewer, x, y) {
  if (!viewer.alive || round.state !== 'playing') return true; // spectators see everything
  for (const src of visionSources(viewer)) {
    if (Math.hypot(x - src.x, y - src.y) > VISION_R) continue;
    if (!losBlocked(src.x, src.y, x, y)) return true;
  }
  return false;
}

const PLAYER_R = 16;
const MAX_HP = 100;
const LAVA_DPS = 16;
const FIREBALL_R = 14;
const FIREBALL_LIFE = 2.2;
const CHARGE_MAX = 1.5;
const CHARGE_MIN_SPEED = 0.5;   // tap-release
const CHARGE_MAX_SPEED = 2.0;   // full hold
const CHARGE_WALK_MIN = 0.35;   // walk speed multiplier at full charge

const LIGHTNING_HIT_R = 12;    // small strike radius at the cursor endpoint
const LIGHTNING_DMG = 4;
const LIGHTNING_KB = 450;
const LIGHTNING_CD = 1.0;

const DEFLECT_CD = 0.55;
const DEFLECT_DURATION = 0.16;
const DEFLECT_ARC = Math.PI * 0.7;   // arc in front of the player
const DEFLECT_REACH = 52;

const TURRET_R = 14;
const TURRET_FIRE_INTERVAL = 1.4;
const TURRET_SPAWN_CD = 3.0;
const TURRET_MAX_PER_PLAYER = 3;
const TURRET_RANGE = 950;

const DUMMY_R = 16;
const DUMMY_HP = 100;
const DUMMY_SPAWN_CD = 1.0;
const DUMMY_MAX_PER_PLAYER = 3;
const DUMMY_RESPAWN = 2.5;

const SHIELD_ARC = Math.PI * 2 / 3;
const SHIELD_LOCK = 0.25;
const SHIELD_KB_MULT = 0.4;

function spawnFireball(ownerId, x, y, dx, dy, speedMult, hostile) {
  const fr = fireballHitRadius(speedMult);
  const spawnClip = new Set(PILLARS.filter(pl => pillarOverlap(x, y, pl, fr)));
  fireballs.push({
    id: nextFireballId++, owner: ownerId,
    x, y, dx, dy, life: FIREBALL_LIFE, speedMult,
    spawnClip: spawnClip.size ? spawnClip : null,
    hostile: !!hostile
  });
}

function validTurretSpot(x, y, placer) {
  x = Math.min(WORLD - TURRET_R, Math.max(TURRET_R, x));
  y = Math.min(WORLD - TURRET_R, Math.max(TURRET_R, y));
  for (const pl of PILLARS) {
    if (pillarOverlap(x, y, pl, TURRET_R)) return null;
  }
  if (Math.hypot(x - CENTER.x, y - CENTER.y) > round.arenaR - TURRET_R) return null;
  if (Math.hypot(x - placer.x, y - placer.y) < PLAYER_R + TURRET_R + 8) return null;
  for (const t of turrets) {
    if (Math.hypot(x - t.x, y - t.y) < TURRET_R * 2.2) return null;
  }
  return { x, y };
}

function validDummySpot(x, y, placer) {
  x = Math.min(WORLD - DUMMY_R, Math.max(DUMMY_R, x));
  y = Math.min(WORLD - DUMMY_R, Math.max(DUMMY_R, y));
  for (const pl of PILLARS) {
    if (pillarOverlap(x, y, pl, DUMMY_R)) return null;
  }
  if (Math.hypot(x - CENTER.x, y - CENTER.y) > round.arenaR - DUMMY_R) return null;
  if (Math.hypot(x - placer.x, y - placer.y) < PLAYER_R + DUMMY_R + 4) return null;
  for (const t of turrets) {
    if (Math.hypot(x - t.x, y - t.y) < TURRET_R + DUMMY_R + 4) return null;
  }
  for (const d of dummies) {
    if (Math.hypot(x - d.x, y - d.y) < DUMMY_R * 2.4) return null;
  }
  return { x, y };
}

function tickDummies() {
  for (const d of dummies) {
    if (d.alive) continue;
    d.respawnIn = (d.respawnIn || 0) - DT;
    if (d.respawnIn <= 0) {
      d.alive = true;
      d.hp = DUMMY_HP;
    }
  }
}

function tickTurrets() {
  for (const t of turrets) {
    t.timer = (t.timer || 0) - DT;
    if (t.timer > 0) continue;

    let dx, dy;
    let best = null, bestD = TURRET_RANGE;
    for (const p of players.values()) {
      if (!p.alive || p.id === t.owner) continue;
      const d = Math.hypot(p.x - t.x, p.y - t.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) {
      dx = best.x - t.x;
      dy = best.y - t.y;
    } else {
      const owner = players.get(t.owner);
      if (owner?.alive) {
        dx = owner.x - t.x;
        dy = owner.y - t.y;
      } else {
        dx = Math.cos(t.angle || 0);
        dy = Math.sin(t.angle || 0);
      }
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    t.angle = Math.atan2(dy, dx);
    const spd = 1;
    const muzzle = TURRET_R + fireballHitRadius(spd) + 2;
    spawnFireball(t.owner, t.x + dx * muzzle, t.y + dy * muzzle, dx, dy, spd, true);
    t.timer = TURRET_FIRE_INTERVAL;
  }
}

function attackInShieldArc(p, ax, ay) {
  if (!p.shieldUp) return false;
  const dx = ax - p.x, dy = ay - p.y;
  if (Math.hypot(dx, dy) < 1e-6) return true;
  return Math.abs(angleDiff(Math.atan2(dy, dx), p.shieldAngle)) <= SHIELD_ARC / 2;
}

function applyKnockback(p, kx, ky, kb) {
  const len = Math.hypot(kx, ky) || 1;
  p.vx += (kx / len) * kb;
  p.vy += (ky / len) * kb;
}

function blockShieldHit(p, kx, ky, kb) {
  p.shieldLock = SHIELD_LOCK;
  applyKnockback(p, kx, ky, kb * SHIELD_KB_MULT);
}

function applyShield(p, keys) {
  const locked = (p.shieldLock || 0) > 0;
  const active = !!keys.shield || locked;
  if (active) {
    const cl = Math.hypot(keys.sdx, keys.sdy);
    if (cl > 0) p.shieldAngle = Math.atan2(keys.sdy / cl, keys.sdx / cl);
    p.shieldUp = true;
  } else {
    p.shieldUp = false;
  }
}

function chargeSpeedMult(t) {
  const r = Math.min(1, Math.max(0, t / CHARGE_MAX));
  return CHARGE_MIN_SPEED + (CHARGE_MAX_SPEED - CHARGE_MIN_SPEED) * r;
}
function chargeWalkMult(t) {
  const r = Math.min(1, Math.max(0, t / CHARGE_MAX));
  return 1 + (CHARGE_WALK_MIN - 1) * r;
}

// match client drawFireball scale — bigger charge = bigger hit radius
function fireballHitRadius(speedMult) {
  const scale = 1 + ((speedMult || 1) - 1) * 0.3;
  return FIREBALL_R * scale;
}

function pillarOverlap(x, y, pl, r) {
  const e = pl.half + r;
  return Math.abs(x - pl.x) < e && Math.abs(y - pl.y) < e;
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function fireballInDeflectArc(p, fx, fy, fr) {
  if ((p.deflectTime || 0) <= 0) return false;
  const dx = fx - p.x, dy = fy - p.y;
  const dist = Math.hypot(dx, dy);
  const reach = PLAYER_R + DEFLECT_REACH + fr;
  if (dist > reach) return false;
  return Math.abs(angleDiff(Math.atan2(dy, dx), p.deflectAngle)) <= DEFLECT_ARC / 2;
}

function deflectFireball(p, f) {
  const fr = fireballHitRadius(f.speedMult);
  f.owner = p.id;
  f.dx = Math.cos(p.deflectAngle);
  f.dy = Math.sin(p.deflectAngle);
  f.spawnClip = null;
  const push = PLAYER_R + fr + 4;
  f.x = p.x + f.dx * push;
  f.y = p.y + f.dy * push;
  f.hostile = false;
  deflectEvents.push({
    o: p.id,
    x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10,
    a: Math.round(p.deflectAngle * 1000) / 1000
  });
}

function segmentHitsCircle(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(cx - x0, cy - y0) < r;
  let t = ((cx - x0) * dx + (cy - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x0 + t * dx, py = y0 + t * dy;
  return Math.hypot(cx - px, cy - py) < r;
}

function rayAABBHitDist(ox, oy, dx, dy, cx, cy, half, maxDist) {
  const minX = cx - half, maxX = cx + half, minY = cy - half, maxY = cy + half;
  let tmin = 0, tmax = maxDist;
  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return null;
  } else {
    const t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < minY || oy > maxY) return null;
  } else {
    const t1 = (minY - oy) / dy, t2 = (maxY - oy) / dy;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  if (tmin > tmax || tmax < 0) return null;
  const hit = tmin >= 0 ? tmin : tmax;
  return hit <= maxDist ? hit : null;
}

function lightningEndpoint(sx, sy, tx, ty) {
  let dx = tx - sx, dy = ty - sy;
  const maxDist = Math.hypot(dx, dy);
  if (maxDist < 1e-6) return { ex: sx, ey: sy, dx: 0, dy: -1 };
  dx /= maxDist; dy /= maxDist;
  let endDist = maxDist;
  for (const pl of PILLARS) {
    const t = rayAABBHitDist(sx, sy, dx, dy, pl.x, pl.y, pl.half, endDist);
    if (t !== null && t < endDist) endDist = t;
  }
  return { ex: sx + dx * endDist, ey: sy + dy * endDist, dx, dy };
}

// substep + swept checks so fast fireballs don't tunnel through targets
function stepFireball(f, dt) {
  const spd = f.speedMult || 1;
  const total = TUNING.fireballSpeed * spd * dt;
  const fr = fireballHitRadius(spd);
  const maxStep = Math.max(8, PLAYER_R * 0.75);
  const steps = Math.max(1, Math.ceil(total / maxStep));
  const step = total / steps;
  let hit = null;

  for (let i = 0; i < steps && f.life > 0; i++) {
    const ox = f.x, oy = f.y;
    f.x += f.dx * step;
    f.y += f.dy * step;

    for (const pl of PILLARS) {
      // a fully charged ball has a bigger hit radius than the player, so it can
      // spawn already overlapping a pillar the shooter is hugging. While it's
      // still inside that spawn overlap, collide with the pillar's actual body
      // (center inside) instead of the expanded bounds, so point-blank shots
      // along the face survive but shots into the pillar still detonate.
      if (f.spawnClip && f.spawnClip.has(pl)) {
        if (pillarOverlap(f.x, f.y, pl, 0)) { f.life = 0; return null; }
        if (!pillarOverlap(f.x, f.y, pl, fr)) f.spawnClip.delete(pl);
        continue;
      }
      if (pillarOverlap(f.x, f.y, pl, fr)) { f.life = 0; return null; }
    }

    for (const p of players.values()) {
      if (!p.alive) continue;
      const hitR = PLAYER_R + fr;
      const touching = segmentHitsCircle(ox, oy, f.x, f.y, p.x, p.y, hitR) ||
          Math.hypot(p.x - f.x, p.y - f.y) < hitR;
      if (!touching) continue;
      if (fireballInDeflectArc(p, f.x, f.y, fr)) {
        deflectFireball(p, f);
        return null;
      }
      if (attackInShieldArc(p, f.x, f.y)) {
        blockShieldHit(p, f.dx, f.dy, TUNING.kbBase);
        f.life = 0;
        shieldBlockEvents.push({
          o: p.id,
          x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10
        });
        return null;
      }
      if (p.id === f.owner && !f.hostile) continue;
      hit = { p, x: f.x, y: f.y };
      f.life = 0;
      return hit;
    }

    for (const d of dummies) {
      if (!d.alive) continue;
      const hitR = DUMMY_R + fr;
      const touching = segmentHitsCircle(ox, oy, f.x, f.y, d.x, d.y, hitR) ||
          Math.hypot(d.x - f.x, d.y - f.y) < hitR;
      if (!touching) continue;
      hit = { dummy: d, x: f.x, y: f.y };
      f.life = 0;
      return hit;
    }
  }
  return hit;
}

function strike(p, amount, kx, ky, kb) {
  if (!p.alive) return;
  p.hp -= amount;
  p.dmgTaken += amount;
  const len = Math.hypot(kx, ky) || 1;
  p.vx += (kx / len) * kb;
  p.vy += (ky / len) * kb;
  if (p.hp <= 0) { p.hp = 0; p.alive = false; }
}

function castLightning(caster, tx, ty) {
  const clamp = (v) => Math.round(Math.min(WORLD - 1, Math.max(1, v)) * 10) / 10;
  const end = lightningEndpoint(caster.x, caster.y, tx, ty);
  const ex = clamp(end.ex), ey = clamp(end.ey);
  const dx = end.dx, dy = end.dy;

  let hitV = null;
  let bestD = LIGHTNING_HIT_R + PLAYER_R;
  for (const p of players.values()) {
    if (!p.alive || p.id === caster.id) continue;
    const d = Math.hypot(p.x - ex, p.y - ey);
    if (d < bestD) { bestD = d; hitV = p; }
  }
  if (hitV) {
    if (attackInShieldArc(hitV, ex, ey)) {
      blockShieldHit(hitV, dx, dy, LIGHTNING_KB);
      shieldBlockEvents.push({ o: hitV.id, x: ex, y: ey });
      hitV = null;
    } else {
      strike(hitV, LIGHTNING_DMG, dx, dy, LIGHTNING_KB);
    }
  }

  return {
    o: caster.id, v: hitV ? hitV.id : null,
    sx: Math.round(caster.x * 10) / 10, sy: Math.round(caster.y * 10) / 10,
    ex, ey, dx, dy, kb: LIGHTNING_KB
  };
}

// live-tunable gameplay values (slider panel in the client, T key).
// Synced to all clients on change: prediction physics must match exactly.
const TUNING = {
  moveSpeed: 190,
  friction: 3.2,          // knockback velocity decay per second
  dashSpeed: 700,
  dashCooldown: 0,
  castCooldown: 0.6,
  fireballSpeed: 1050,
  fireballDmg: 10,
  kbBase: 260,            // knockback grows with damage taken (classic Warlocks)
  kbPerDmg: 4.5,
  pillarBounce: 0.3,      // fraction of impact speed reflected off pillars
  pillarSlide: 0.15       // fraction of along-face momentum kept on impact
};
const TUNING_RANGE = {
  moveSpeed: [50, 500], friction: [0.5, 10], dashSpeed: [0, 1500], dashCooldown: [0, 10],
  castCooldown: [0.05, 3], fireballSpeed: [100, 3000], fireballDmg: [0, 50],
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
let lightningEvents = [];
let deflectEvents = [];
let shieldBlockEvents = [];
let turrets = [];
let nextTurretId = 1;
let dummies = [];
let nextDummyId = 1;

// round state: 'lobby' | 'countdown' | 'playing' | 'ended'
let round = { state: 'lobby', timer: 0, arenaR: ARENA_START_R, winner: null, participants: 0 };

function clearOfPillars(x, y, r) {
  return !PILLARS.some(pl => pillarOverlap(x, y, pl, r));
}

function spawnPositions(n) {
  const out = [];
  const r = ARENA_START_R * 0.6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    let x = CENTER.x + Math.cos(a) * r, y = CENTER.y + Math.sin(a) * r;
    // nudge along the ring until the spot isn't inside a wall
    for (let da = 0; da < Math.PI; da += 0.05) {
      const a1 = a + da, a2 = a - da;
      let fx = CENTER.x + Math.cos(a1) * r, fy = CENTER.y + Math.sin(a1) * r;
      if (clearOfPillars(fx, fy, PLAYER_R + 6)) { x = fx; y = fy; break; }
      fx = CENTER.x + Math.cos(a2) * r; fy = CENTER.y + Math.sin(a2) * r;
      if (clearOfPillars(fx, fy, PLAYER_R + 6)) { x = fx; y = fy; break; }
    }
    out.push({ x, y });
  }
  return out;
}

function startCountdown() {
  const alive = [...players.values()];
  arenaSeed = (arenaSeed * 1664525 + 1013904223) >>> 0;
  PILLARS = generateArena(arenaSeed);
  const arenaMsg = JSON.stringify({ t: 'arena', pillars: PILLARS });
  for (const q of players.values()) sendTo(q, arenaMsg);
  round = {
    state: 'playing', timer: 0, arenaR: ARENA_START_R, winner: null,
    participants: alive.filter(p => p.alive).length
  };
  const spots = spawnPositions(alive.length);
  alive.forEach((p, i) => {
    p.x = spots[i].x; p.y = spots[i].y;
    p.vx = 0; p.vy = 0;
    p.hp = MAX_HP; p.dmgTaken = 0; p.alive = true; p.cooldown = 0; p.dashCd = 0; p.lightningCd = 0;
    p.deflectCd = 0; p.deflectTime = 0; p.deflectAngle = 0;
    p.turretCd = 0;
    p.dummyCd = 0;
    p.shieldUp = false; p.shieldAngle = 0; p.shieldLock = 0;
    p.charging = false; p.chargeTime = 0; p.chargeDx = 1; p.chargeDy = 0;
  });
  fireballs = [];
  turrets = [];
  dummies = [];
  hitEvents = [];
  lightningEvents = [];
  deflectEvents = [];
  shieldBlockEvents = [];
  for (const p of alive) p.inputQueue.length = 0;
}

function resetToLobby() {
  round = { state: 'lobby', timer: 0, arenaR: ARENA_START_R, winner: null, participants: 0 };
}

// One physics step for a player. Mirrored exactly on the client for prediction.
function stepPlayer(p, keys, dt) {
  let mx = 0, my = 0;
  if (!p.shieldUp) {
    if (keys.up) my -= 1;
    if (keys.down) my += 1;
    if (keys.left) mx -= 1;
    if (keys.right) mx += 1;
  }
  const len = Math.hypot(mx, my);
  if (len > 0) { mx /= len; my /= len; }
  p.dashCd = Math.max(0, (p.dashCd || 0) - dt);
  if (!p.shieldUp && keys.dash && p.dashCd === 0 && len > 0) {
    p.vx += mx * TUNING.dashSpeed;
    p.vy += my * TUNING.dashSpeed;
    p.dashCd = TUNING.dashCooldown;
  }
  const walkMult = p.charging ? chargeWalkMult(p.chargeTime) : 1;
  p.x += (mx * TUNING.moveSpeed * walkMult + p.vx) * dt;
  p.y += (my * TUNING.moveSpeed * walkMult + p.vy) * dt;
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
    let kb = TUNING.kbBase + TUNING.kbPerDmg * p.dmgTaken;
    if (p.shieldUp) kb *= SHIELD_KB_MULT;
    applyKnockback(p, kx, ky, kb);
  }
  if (p.hp <= 0) { p.hp = 0; p.alive = false; }
}

function tick() {
  // round management
  if (round.state === 'lobby') {
    if (players.size >= 1) startCountdown();
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
      p.charging = false;
      p.chargeTime = 0;
      if (p.inputQueue.length > 0) p.lastSeq = p.inputQueue[p.inputQueue.length - 1].seq;
      p.inputQueue.length = 0;
      continue;
    }
    p.cooldown = Math.max(0, p.cooldown - DT);
    p.lightningCd = Math.max(0, p.lightningCd - DT);
    p.deflectCd = Math.max(0, (p.deflectCd || 0) - DT);
    p.deflectTime = Math.max(0, (p.deflectTime || 0) - DT);
    p.turretCd = Math.max(0, (p.turretCd || 0) - DT);
    p.dummyCd = Math.max(0, (p.dummyCd || 0) - DT);
    p.shieldLock = Math.max(0, (p.shieldLock || 0) - DT);

    // Consume queued sequenced inputs, one tick's worth of movement each.
    // Cap per tick so a client can't move faster by flooding inputs.
    const canMove = true;
    let steps = 0;
    while (p.inputQueue.length > 0 && steps < 3) {
      const inp = p.inputQueue.shift();
      const k = canMove ? inp.keys : {};
      if (k.charge && p.cooldown <= 0) {
        if (!p.charging) { p.charging = true; p.chargeTime = 0; }
        const cl = Math.hypot(k.cdx, k.cdy);
        if (cl > 0) { p.chargeDx = k.cdx / cl; p.chargeDy = k.cdy / cl; }
        p.chargeTime = Math.min(CHARGE_MAX, p.chargeTime + DT);
      } else if (p.charging && !k.charge) {
        p.charging = false;
        p.chargeTime = 0;
      }
      applyShield(p, k);
      stepPlayer(p, k, DT);
      p.lastSeq = inp.seq;
      steps++;
    }
    if (steps === 0) {
      applyShield(p, {});
      stepPlayer(p, {}, DT);
    }

    // lava
    if (playing) {
      const d = Math.hypot(p.x - CENTER.x, p.y - CENTER.y);
      if (d > round.arenaR) damage(p, LAVA_DPS * DT, 0, 0);
    }
  }

  // fireballs
  if (playing) {
    tickDummies();
    tickTurrets();
    for (const f of fireballs) {
      f.life -= DT;
      if (f.life <= 0) continue;
      const hit = stepFireball(f, DT);
      if (!hit) continue;
      if (hit.p) {
        damage(hit.p, TUNING.fireballDmg, f.dx, f.dy);
        hitEvents.push({
          fid: f.id, o: f.owner, v: hit.p.id,
          x: Math.round(hit.x * 10) / 10, y: Math.round(hit.y * 10) / 10,
          dx: f.dx, dy: f.dy,
          kb: Math.round(TUNING.kbBase + TUNING.kbPerDmg * hit.p.dmgTaken)
        });
      } else if (hit.dummy) {
        const d = hit.dummy;
        d.hp -= TUNING.fireballDmg;
        if (d.hp <= 0) {
          d.hp = 0;
          d.alive = false;
          d.respawnIn = DUMMY_RESPAWN;
        }
        hitEvents.push({
          fid: f.id, o: f.owner, d: d.id,
          x: Math.round(hit.x * 10) / 10, y: Math.round(hit.y * 10) / 10,
          dx: f.dx, dy: f.dy
        });
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

// Build one full snapshot per tick, then filter it per viewer so each
// client only receives what its warlock can see (fog of war). Own units
// and self are always included; spectators/dead see everything.
function snapshotFor(viewer, base) {
  const seesAll = !viewer || !viewer.alive || round.state !== 'playing';
  const vis = (x, y, ownerId) => {
    if (seesAll) return true;
    if (ownerId !== undefined && ownerId === viewer.id) return true;
    return canSee(viewer, x, y);
  };
  return JSON.stringify({
    ...base,
    hits: base.hits.filter(h => seesAll || h.o === viewer.id || h.v === viewer.id || canSee(viewer, h.x, h.y)),
    bolts: base.bolts.filter(b => seesAll || b.o === viewer.id || b.v === viewer.id ||
      canSee(viewer, b.sx, b.sy) || canSee(viewer, b.ex, b.ey)),
    deflects: base.deflects.filter(d => vis(d.x, d.y, d.o)),
    sblocks: base.sblocks.filter(s => seesAll || canSee(viewer, s.x, s.y)),
    players: base.players.filter(p => seesAll || p.id === viewer.id || (p.a && canSee(viewer, p.x, p.y))),
    turrets: base.turrets.filter(t => vis(t.x, t.y, t.o)),
    dummies: base.dummies.filter(d => vis(d.x, d.y, d.o)),
    fireballs: base.fireballs.filter(f => vis(f.x, f.y, f.o))
  });
}

function baseSnapshot() {
  const hits = hitEvents;
  hitEvents = [];
  const bolts = lightningEvents;
  lightningEvents = [];
  const deflects = deflectEvents;
  deflectEvents = [];
  const sblocks = shieldBlockEvents;
  shieldBlockEvents = [];
  return {
    t: 's',
    now: Date.now(),
    hits,
    bolts,
    deflects,
    sblocks,
    round: { state: round.state, timer: Math.max(0, round.timer), arenaR: round.arenaR, winner: round.winner },
    players: [...players.values()].map(p => ({
      id: p.id, n: p.name, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
      vx: Math.round(p.vx * 10) / 10, vy: Math.round(p.vy * 10) / 10,
      hp: Math.round(p.hp), a: p.alive ? 1 : 0, w: p.wins, seq: p.lastSeq,
      cd: Math.round(p.cooldown * 100) / 100, dcd: Math.round(p.dashCd * 100) / 100,
      lcd: Math.round(p.lightningCd * 100) / 100,
      dfcd: Math.round((p.deflectCd || 0) * 100) / 100,
      dft: Math.round((p.deflectTime || 0) * 1000) / 1000,
      dfa: Math.round((p.deflectAngle || 0) * 1000) / 1000,
      tcd: Math.round((p.turretCd || 0) * 100) / 100,
      ycd: Math.round((p.dummyCd || 0) * 100) / 100,
      shu: p.shieldUp ? 1 : 0,
      sha: Math.round((p.shieldAngle || 0) * 1000) / 1000,
      shl: Math.round((p.shieldLock || 0) * 1000) / 1000,
      chg: p.charging ? Math.round(p.chargeTime * 1000) / 1000 : 0
    })),
    turrets: turrets.map(t => ({
      id: t.id, o: t.owner,
      x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10,
      a: Math.round((t.angle || 0) * 1000) / 1000
    })),
    dummies: dummies.map(d => ({
      id: d.id, o: d.owner,
      x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10,
      hp: Math.round(d.hp), a: d.alive ? 1 : 0
    })),
    fireballs: fireballs.map(f => ({
      id: f.id, o: f.owner, x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10,
      dx: Math.round(f.dx * 1000) / 1000, dy: Math.round(f.dy * 1000) / 1000,
      spd: Math.round((f.speedMult || 1) * 100) / 100
    }))
  };
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
    hp: MAX_HP, dmgTaken: 0, alive: true, cooldown: 0, dashCd: 0, lightningCd: 0,
    deflectCd: 0, deflectTime: 0, deflectAngle: 0, turretCd: 0, dummyCd: 0,
    shieldUp: false, shieldAngle: 0, shieldLock: 0, wins: 0,
    charging: false, chargeTime: 0, chargeDx: 1, chargeDy: 0,
    inputQueue: [], lastSeq: 0
  };
  players.set(id, p);

  // joining mid-round: spectate as dead until next round
  if (round.state === 'playing') { p.alive = false; p.hp = 0; }

  sendTo(p, JSON.stringify({
    t: 'welcome', id,
    world: WORLD, center: CENTER, playerR: PLAYER_R, fireballR: FIREBALL_R,
    pillars: PILLARS, tuning: TUNING,
    visionR: VISION_R,
    lightning: { cd: LIGHTNING_CD },
    deflect: { cd: DEFLECT_CD, dur: DEFLECT_DURATION, arc: DEFLECT_ARC, reach: DEFLECT_REACH },
    turret: { cd: TURRET_SPAWN_CD, interval: TURRET_FIRE_INTERVAL, max: TURRET_MAX_PER_PLAYER, r: TURRET_R },
    dummy: { cd: DUMMY_SPAWN_CD, max: DUMMY_MAX_PER_PLAYER, hp: DUMMY_HP, r: DUMMY_R },
    shield: { arc: SHIELD_ARC, lock: SHIELD_LOCK, kb: SHIELD_KB_MULT }
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
        keys: {
          up: !!msg.keys.up, down: !!msg.keys.down, left: !!msg.keys.left, right: !!msg.keys.right,
          dash: !!msg.keys.dash, charge: !!msg.keys.charge,
          cdx: Number(msg.keys.cdx) || 0, cdy: Number(msg.keys.cdy) || 0,
          shield: !!msg.keys.shield,
          sdx: Number(msg.keys.sdx) || 0, sdy: Number(msg.keys.sdy) || 0
        }
      });
      if (p.inputQueue.length > 10) p.inputQueue.shift(); // drop oldest under flood
    } else if (msg.t === 'cast') {
      if (round.state !== 'playing' || !p.alive || p.cooldown > 0) return;
      const len = Math.hypot(msg.dx, msg.dy);
      if (!isFinite(len) || len === 0) return;
      const charge = p.charging
        ? p.chargeTime
        : Math.min(CHARGE_MAX, Math.max(0, Number(msg.charge) || 0));
      p.charging = false;
      p.chargeTime = 0;
      p.cooldown = TUNING.castCooldown;
      const speedMult = chargeSpeedMult(charge);
      spawnFireball(id, p.x, p.y, msg.dx / len, msg.dy / len, speedMult);
    } else if (msg.t === 'lightning') {
      if (round.state !== 'playing' || !p.alive || p.lightningCd > 0) return;
      const tx = Number(msg.tx), ty = Number(msg.ty);
      if (!isFinite(tx) || !isFinite(ty)) return;
      p.lightningCd = LIGHTNING_CD;
      const bolt = castLightning(p, tx, ty);
      if (bolt) lightningEvents.push(bolt);
    } else if (msg.t === 'deflect') {
      if (round.state !== 'playing' || !p.alive || (p.deflectCd || 0) > 0) return;
      const len = Math.hypot(msg.dx, msg.dy);
      if (!isFinite(len) || len === 0) return;
      p.deflectCd = DEFLECT_CD;
      p.deflectTime = DEFLECT_DURATION;
      p.deflectAngle = Math.atan2(msg.dy / len, msg.dx / len);
    } else if (msg.t === 'turret') {
      if (round.state !== 'playing' || !p.alive || (p.turretCd || 0) > 0) return;
      const tx = Number(msg.tx), ty = Number(msg.ty);
      if (!isFinite(tx) || !isFinite(ty)) return;
      if (turrets.filter(t => t.owner === id).length >= TURRET_MAX_PER_PLAYER) return;
      const spot = validTurretSpot(tx, ty, p);
      if (!spot) return;
      p.turretCd = TURRET_SPAWN_CD;
      turrets.push({
        id: nextTurretId++, owner: id,
        x: spot.x, y: spot.y,
        angle: Math.atan2(ty - spot.y, tx - spot.x),
        timer: TURRET_FIRE_INTERVAL * 0.4
      });
    } else if (msg.t === 'dummy') {
      if (round.state !== 'playing' || !p.alive || (p.dummyCd || 0) > 0) return;
      const tx = Number(msg.tx), ty = Number(msg.ty);
      if (!isFinite(tx) || !isFinite(ty)) return;
      if (dummies.filter(d => d.owner === id).length >= DUMMY_MAX_PER_PLAYER) return;
      const spot = validDummySpot(tx, ty, p);
      if (!spot) return;
      p.dummyCd = DUMMY_SPAWN_CD;
      dummies.push({
        id: nextDummyId++, owner: id,
        x: spot.x, y: spot.y,
        hp: DUMMY_HP, alive: true
      });
    } else if (msg.t === 'restart') {
      if (players.size >= 1) startCountdown();
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
    const base = baseSnapshot();
    for (const p of players.values()) sendTo(p, snapshotFor(p, base));
  }
  nextTickAt += 1000 / TICK_RATE;
  if (nextTickAt < Date.now() - 250) nextTickAt = Date.now(); // fell badly behind
  setTimeout(tickLoop, Math.max(0, nextTickAt - Date.now()));
}
tickLoop();

let botProc = null;
function stopBots() {
  if (botProc) { botProc.kill(); botProc = null; }
}

server.listen(PORT, () => {
  console.log(`Warlocks running at http://localhost:${PORT}`);
  const n = Number(process.env.BOT_COUNT ?? 0);
  if (n > 0 && process.env.SPAWN_BOTS !== '0') {
    botProc = spawn(process.execPath, [path.join(__dirname, 'bot.js'), String(n)], {
      stdio: 'inherit', cwd: __dirname
    });
    botProc.on('exit', () => { botProc = null; });
    console.log(`Spawned ${n} bot(s)`);
  }
});
process.on('SIGINT', () => { stopBots(); process.exit(0); });
process.on('SIGTERM', () => { stopBots(); process.exit(0); });
