/* ════════════════════════════════════════════════════════════════
   HILL RACER — Physics driving game
   Single-file engine: terrain generation, vehicle physics (verlet
   wheels + spring suspension), rendering, input (keyboard + touch),
   coins/fuel/scoring, and game-state management.
════════════════════════════════════════════════════════════════ */

(() => {
'use strict';

/* ──────────────────────────────────────────────────────────────
   CANVAS SETUP
────────────────────────────────────────────────────────────── */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let DPR = Math.min(window.devicePixelRatio || 1, 2);
let W = 0, H = 0;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/* ──────────────────────────────────────────────────────────────
   UTILITIES
────────────────────────────────────────────────────────────── */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Simple seeded value-noise (smooth pseudo-random terrain)
function makeNoise(seed) {
  let s = seed;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const grid = {};
  function gradAt(i) {
    if (grid[i] === undefined) grid[i] = rand() * 2 - 1;
    return grid[i];
  }
  return function noise(x) {
    const i0 = Math.floor(x);
    const i1 = i0 + 1;
    const t = x - i0;
    const fade = t * t * (3 - 2 * t);
    return lerp(gradAt(i0), gradAt(i1), fade);
  };
}

/* ──────────────────────────────────────────────────────────────
   TERRAIN
   Height field built from layered noise octaves, with difficulty
   ramping (steeper, bumpier) as distance increases. Terrain is
   generated lazily in chunks ahead of the car.
────────────────────────────────────────────────────────────── */
const TERRAIN_STEP = 14;      // px between sampled terrain points
const noise1 = makeNoise(1337);
const noise2 = makeNoise(99);
const noise3 = makeNoise(54321);

function terrainHeightAt(x) {
  // progressive difficulty: amplitude & frequency grow with x
  const progress = clamp(x / 18000, 0, 1);
  const amp1 = 90 + progress * 110;
  const amp2 = 28 + progress * 40;
  const amp3 = 8 + progress * 14;

  const f1 = 0.0011 + progress * 0.0006;
  const f2 = 0.004;
  const f3 = 0.014;

  let h = 0;
  h += noise1(x * f1) * amp1;
  h += noise2(x * f2) * amp2;
  h += noise3(x * f3) * amp3;

  // flatten the very start so the car spawns on level ground
  const startFlat = clamp(1 - x / 700, 0, 1);
  h = lerp(h, -40, startFlat * 0.0) ; // keep gentle, no hard flat needed beyond gravity settle

  return h + 320; // baseline offset (canvas-space ground level reference)
}

const terrainCache = new Map();
function getTerrainY(x) {
  const key = Math.round(x / TERRAIN_STEP);
  let v = terrainCache.get(key);
  if (v === undefined) {
    v = terrainHeightAt(key * TERRAIN_STEP);
    terrainCache.set(key, v);
  }
  return v;
}
// Smooth interpolated height + slope at arbitrary x
function groundY(x) {
  const k = x / TERRAIN_STEP;
  const i0 = Math.floor(k);
  const t = k - i0;
  const y0 = getTerrainY(i0 * TERRAIN_STEP);
  const y1 = getTerrainY((i0 + 1) * TERRAIN_STEP);
  return lerp(y0, y1, t);
}
function groundNormal(x) {
  const d = 2;
  const y1 = groundY(x - d);
  const y2 = groundY(x + d);
  const dx = d * 2, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  return { x: -dy / len, y: dx / len, slope: Math.atan2(dy, dx) };
}

// Coin & decoration placement (deterministic from position)
function decorAt(chunkIndex) {
  // Returns whether a coin should appear near this chunk and its y offset
  const seedVal = Math.sin(chunkIndex * 12.9898) * 43758.5453;
  const frac = seedVal - Math.floor(seedVal);
  return frac;
}

/* ──────────────────────────────────────────────────────────────
   GAME STATE
────────────────────────────────────────────────────────────── */
const STORAGE_KEY = 'hillracer_best_distance';

const state = {
  status: 'menu',  // menu | playing | paused | over
  distance: 0,
  bestDistance: Number(localStorage.getItem(STORAGE_KEY) || 0),
  coins: 0,
  fuel: 100,
  cameraX: 0,
  cameraY: 0,
  collectedCoinKeys: new Set(),
  airTime: 0,
  rotationAccum: 0,
  bestFlip: 0,
  flipCounted: false,
  gameOverReason: '',
  shakeT: 0,
  particles: [],
};

/* ──────────────────────────────────────────────────────────────
   VEHICLE PHYSICS
   Two-wheel car body: a rigid chassis (point + angle) with two
   wheel contact points solved against terrain each frame using a
   spring/damper suspension model, plus simple torque-based engine.
────────────────────────────────────────────────────────────── */
const VEHICLE = {
  wheelBase: 86,
  wheelRadius: 21,
  chassisLength: 96,
  chassisHeight: 26,
  suspensionRest: 34,
  suspensionStiffness: 0.32,
  suspensionDamping: 0.62,
  mass: 1,
  enginePower: 0.62,
  brakePower: 0.45,
  maxSpeed: 13,
  gravity: 0.62,
  airRotationSpeed: 0.055,
  rollFriction: 0.015,
};

function createCar(startX) {
  const groundStartY = groundY(startX) - 60;
  return {
    x: startX,
    y: groundStartY,
    angle: 0,
    vx: 0,
    vy: 0,
    angVel: 0,
    wheelRotation: 0,
    onGround: false,
    frontOnGround: false,
    rearOnGround: false,
    grounded: false,
    flipped: false,
    crashed: false,
    suspensionFront: VEHICLE.suspensionRest,
    suspensionRear: VEHICLE.suspensionRest,
  };
}

let car = createCar(120);

const input = {
  gas: false,
  brake: false,
  leanLeft: false,
  leanRight: false,
};

function resetGame() {
  terrainCache.clear();
  car = createCar(120);
  state.distance = 0;
  state.coins = 0;
  state.fuel = 100;
  state.collectedCoinKeys = new Set();
  state.airTime = 0;
  state.rotationAccum = 0;
  state.bestFlip = 0;
  state.flipCounted = false;
  state.particles = [];
  state.shakeT = 0;
  state.cameraX = car.x;
  state.cameraY = car.y;
}

/* ──────────────────────────────────────────────────────────────
   PHYSICS STEP
────────────────────────────────────────────────────────────── */
function physicsStep(dt) {
  if (state.status !== 'playing') return;

  const wb = VEHICLE.wheelBase / 2;
  const cosA = Math.cos(car.angle);
  const sinA = Math.sin(car.angle);

  // Wheel world positions (before suspension correction)
  const rearX = car.x - cosA * wb;
  const rearTopY = car.y - sinA * wb;
  const frontX = car.x + cosA * wb;
  const frontTopY = car.y + sinA * wb;

  // Ground sampling
  const groundRear = groundY(rearX);
  const groundFront = groundY(frontX);

  // Gravity
  car.vy += VEHICLE.gravity;

  // Engine / brake torque (applies rotational + forward force only when grounded)
  const grounded = car.grounded;
  let throttle = 0;
  if (input.gas && state.fuel > 0) throttle = 1;
  if (input.brake) throttle = -0.7;

  if (grounded) {
    const dirX = cosA;
    const accel = throttle * VEHICLE.enginePower;
    car.vx += dirX * accel;
    car.vy += Math.sin(car.angle) * accel * 0.3;

    // rolling friction
    car.vx *= (1 - VEHICLE.rollFriction);

    // fuel consumption
    if (throttle > 0) {
      state.fuel = clamp(state.fuel - dt * 4.2, 0, 100);
    }
  } else {
    // Air control: lean left/right rotates the chassis
    if (input.leanRight) car.angVel += VEHICLE.airRotationSpeed * dt * 60 * 0.016;
    if (input.leanLeft) car.angVel -= VEHICLE.airRotationSpeed * dt * 60 * 0.016;
    car.angVel *= 0.985;
  }

  // speed cap
  const speed = Math.hypot(car.vx, car.vy);
  if (speed > VEHICLE.maxSpeed) {
    const s = VEHICLE.maxSpeed / speed;
    car.vx *= s; car.vy *= s;
  }

  // integrate position
  car.x += car.vx * dt * 60;
  car.y += car.vy * dt * 60;
  car.angle += car.angVel * dt * 60;

  // recompute wheel positions after integration
  const cosA2 = Math.cos(car.angle);
  const sinA2 = Math.sin(car.angle);
  const rearX2 = car.x - cosA2 * wb;
  const rearY2 = car.y - sinA2 * wb;
  const frontX2 = car.x + cosA2 * wb;
  const frontY2 = car.y + sinA2 * wb;

  const gR = groundY(rearX2) - VEHICLE.wheelRadius;
  const gF = groundY(frontX2) - VEHICLE.wheelRadius;

  const rearPenetration = gR - rearY2;
  const frontPenetration = gF - frontY2;

  car.rearOnGround = rearPenetration > -2;
  car.frontOnGround = frontPenetration > -2;
  car.grounded = car.rearOnGround || car.frontOnGround;

  // Suspension correction — push the chassis out of the ground and
  // apply an angular correction torque toward terrain slope.
  if (car.rearOnGround || car.frontOnGround) {
    const targetAngle = Math.atan2(frontY2 - rearY2, frontX2 - rearX2)
      - Math.atan2((gF) - (gR), frontX2 - rearX2) * 0; // placeholder kept simple below

    // Average penetration -> vertical correction
    let corrR = Math.max(0, rearPenetration);
    let corrF = Math.max(0, frontPenetration);

    const avgCorr = (corrR + corrF) / 2;
    car.y -= avgCorr;
    car.vy *= 0.4;

    // Angle correction toward slope between the two ground contact heights
    const slopeAngle = Math.atan2(gF - gR, frontX2 - rearX2);
    let angleDiff = slopeAngle - car.angle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    const correctionStrength = grounded ? 0.18 : 0.05;
    car.angVel += angleDiff * correctionStrength;
    car.angVel *= VEHICLE.suspensionDamping > 0 ? 0.82 : 1;

    if (!car.flipped && Math.abs(angleDiff) < 2) {
      // landed safely
    }
  }

  // Crash detection: landed upside-down-ish at speed, or excessive angle while grounded
  const normAngle = ((car.angle + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (car.grounded && Math.abs(normAngle) > 2.0 && speed > 1.2) {
    triggerCrash('Crashed!');
  }

  // off-track fall (fell behind terrain too far, shouldn't normally happen)
  if (car.y > groundY(car.x) + 400) {
    triggerCrash('Fell off track!');
  }

  // wheel spin visual
  car.wheelRotation += (car.vx * dt * 60) / VEHICLE.wheelRadius;

  // ── Flip tracking ──
  if (!car.grounded) {
    state.rotationAccum += car.angVel * dt * 60;
  } else {
    const flips = Math.abs(state.rotationAccum) / (Math.PI * 2);
    if (flips > state.bestFlip) state.bestFlip = flips;
    if (flips >= 0.92 && !state.flipCounted) {
      showFlipToast(flips >= 1.9 ? 'DOUBLE FLIP!' : 'FLIP!');
      state.flipCounted = true;
    }
    if (Math.abs(state.rotationAccum) < 0.3) state.flipCounted = false;
    state.rotationAccum *= 0.0; // reset once grounded & processed
  }

  // ── distance / fuel-out condition ──
  state.distance = Math.max(state.distance, Math.floor((car.x - 120) / 10));
  if (state.fuel <= 0 && grounded && speed < 0.05) {
    triggerCrash('Out of Fuel');
  }

  // ── coin collection ──
  collectCoins();

  // camera follow (smooth)
  const camTargetX = car.x;
  const camTargetY = car.y - 40;
  state.cameraX = lerp(state.cameraX, camTargetX, 0.12);
  state.cameraY = lerp(state.cameraY, camTargetY, 0.08);

  if (state.shakeT > 0) state.shakeT -= dt;
}

function triggerCrash(reason) {
  if (state.status !== 'playing') return;
  state.gameOverReason = reason;
  state.status = 'over';
  state.shakeT = 0.4;
  spawnCrashParticles();
  if (state.distance > state.bestDistance) {
    state.bestDistance = state.distance;
    localStorage.setItem(STORAGE_KEY, String(state.bestDistance));
  }
  showGameOver();
}

function spawnCrashParticles() {
  for (let i = 0; i < 18; i++) {
    state.particles.push({
      x: car.x, y: car.y,
      vx: (Math.random() - 0.5) * 8,
      vy: (Math.random() - 1.4) * 8,
      life: 1,
      color: Math.random() > 0.5 ? '#F4A24B' : '#8892A4',
      size: 2 + Math.random() * 3,
    });
  }
}

function updateParticles(dt) {
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.vy += 0.3;
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;
    p.life -= dt * 1.2;
    if (p.life <= 0) state.particles.splice(i, 1);
  }
}

/* ──────────────────────────────────────────────────────────────
   COINS
────────────────────────────────────────────────────────────── */
const COIN_SPACING = 320;
function coinAt(chunkIndex) {
  const frac = decorAt(chunkIndex);
  if (frac > 0.55) return null; // ~45% of chunks have a coin
  const x = chunkIndex * COIN_SPACING + frac * COIN_SPACING * 0.6 + 100;
  const y = groundY(x) - 70 - frac * 60;
  return { x, y, key: 'c' + chunkIndex };
}

function getVisibleCoins() {
  const startChunk = Math.floor((state.cameraX - W) / COIN_SPACING) - 1;
  const endChunk = Math.floor((state.cameraX + W) / COIN_SPACING) + 1;
  const coins = [];
  for (let c = Math.max(0, startChunk); c <= endChunk; c++) {
    const coin = coinAt(c);
    if (coin && !state.collectedCoinKeys.has(coin.key) && coin.x > 50) {
      coins.push(coin);
    }
  }
  return coins;
}

function collectCoins() {
  const coins = getVisibleCoins();
  for (const coin of coins) {
    const d = Math.hypot(coin.x - car.x, coin.y - car.y);
    if (d < 46) {
      state.collectedCoinKeys.add(coin.key);
      state.coins += 1;
      spawnCoinParticles(coin.x, coin.y);
    }
  }
}

function spawnCoinParticles(x, y) {
  for (let i = 0; i < 8; i++) {
    state.particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 4,
      vy: -Math.random() * 4 - 1,
      life: 0.6,
      color: '#F4A24B',
      size: 2 + Math.random() * 2,
    });
  }
}

/* ──────────────────────────────────────────────────────────────
   RENDERING
────────────────────────────────────────────────────────────── */
function draw() {
  ctx.clearRect(0, 0, W, H);

  // shake offset
  let shakeX = 0, shakeY = 0;
  if (state.shakeT > 0) {
    shakeX = (Math.random() - 0.5) * state.shakeT * 18;
    shakeY = (Math.random() - 0.5) * state.shakeT * 18;
  }

  drawSky();

  ctx.save();
  ctx.translate(W / 2 - state.cameraX + shakeX, H * 0.58 - state.cameraY + shakeY);

  drawBackgroundHills();
  drawTerrain();
  drawCoins();
  drawCar();
  drawParticles();

  ctx.restore();
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0A0F1E');
  g.addColorStop(0.55, '#131A2E');
  g.addColorStop(1, '#1A2138');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // stars (static parallax-ish, cheap)
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 60; i++) {
    const sx = (i * 137.5 - state.cameraX * 0.05) % W;
    const sy = (i * 53.7) % (H * 0.5);
    ctx.globalAlpha = 0.15 + (i % 5) * 0.08;
    ctx.fillRect(((sx % W) + W) % W, sy, 2, 2);
  }
  ctx.globalAlpha = 1;
}

function drawBackgroundHills() {
  // far parallax silhouette layer
  ctx.fillStyle = 'rgba(91,79,232,0.10)';
  ctx.beginPath();
  const startX = state.cameraX - W;
  const endX = state.cameraX + W * 2;
  ctx.moveTo(startX, H * 2);
  for (let x = startX; x <= endX; x += 40) {
    const y = groundY(x * 0.55 + 4000) * 0.6 + 80;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(endX, H * 2);
  ctx.closePath();
  ctx.fill();
}

function drawTerrain() {
  const startX = state.cameraX - W / 2 - 80;
  const endX = state.cameraX + W / 2 + 80;

  ctx.beginPath();
  ctx.moveTo(startX, groundY(startX));
  for (let x = startX; x <= endX; x += TERRAIN_STEP) {
    ctx.lineTo(x, groundY(x));
  }
  ctx.lineTo(endX, H * 3);
  ctx.lineTo(startX, H * 3);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, groundY(state.cameraX) - 20, 0, groundY(state.cameraX) + 300);
  g.addColorStop(0, '#1C2440');
  g.addColorStop(0.08, '#161D33');
  g.addColorStop(1, '#0D1222');
  ctx.fillStyle = g;
  ctx.fill();

  // top edge highlight line
  ctx.beginPath();
  ctx.moveTo(startX, groundY(startX));
  for (let x = startX; x <= endX; x += TERRAIN_STEP) {
    ctx.lineTo(x, groundY(x));
  }
  ctx.strokeStyle = 'rgba(91,79,232,0.45)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // sparse grass ticks
  ctx.strokeStyle = 'rgba(46,196,182,0.25)';
  ctx.lineWidth = 1.5;
  for (let x = startX; x <= endX; x += TERRAIN_STEP * 3) {
    const y = groundY(x);
    const n = groundNormal(x);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + n.x * 8, y + n.y * 8 - 8);
    ctx.stroke();
  }
}

function drawCoins() {
  const coins = getVisibleCoins();
  const t = performance.now() / 500;
  for (const coin of coins) {
    const bob = Math.sin(t + coin.x * 0.01) * 4;
    ctx.save();
    ctx.translate(coin.x, coin.y + bob);
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#F4A24B';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FFD9A0';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(-3, -3, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of state.particles) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawCar() {
  const wb = VEHICLE.wheelBase / 2;
  const cosA = Math.cos(car.angle);
  const sinA = Math.sin(car.angle);
  const rearX = car.x - cosA * wb;
  const rearY = car.y - sinA * wb;
  const frontX = car.x + cosA * wb;
  const frontY = car.y + sinA * wb;

  // wheels
  drawWheel(rearX, rearY, car.wheelRotation);
  drawWheel(frontX, frontY, car.wheelRotation);

  // chassis
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);

  const len = VEHICLE.chassisLength;
  const hgt = VEHICLE.chassisHeight;

  // body shadow
  ctx.fillStyle = '#0A0F1E';
  ctx.beginPath();
  ctx.roundRect(-len / 2, -hgt - 18, len, hgt, 8);
  ctx.fill();

  // body main
  const bodyGrad = ctx.createLinearGradient(0, -hgt - 18, 0, -18);
  bodyGrad.addColorStop(0, '#7B70FF');
  bodyGrad.addColorStop(1, '#5B4FE8');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.roundRect(-len / 2, -hgt - 16, len, hgt, 8);
  ctx.fill();

  // cabin
  ctx.fillStyle = '#0A0F1E';
  ctx.beginPath();
  ctx.moveTo(-len * 0.12, -hgt - 16);
  ctx.lineTo(len * 0.02, -hgt - 34);
  ctx.lineTo(len * 0.32, -hgt - 34);
  ctx.lineTo(len * 0.38, -hgt - 16);
  ctx.closePath();
  ctx.fill();

  // window
  ctx.fillStyle = 'rgba(240,237,232,0.85)';
  ctx.beginPath();
  ctx.moveTo(-len * 0.08, -hgt - 17);
  ctx.lineTo(len * 0.04, -hgt - 30);
  ctx.lineTo(len * 0.26, -hgt - 30);
  ctx.lineTo(len * 0.3, -hgt - 17);
  ctx.closePath();
  ctx.fill();

  // accent stripe
  ctx.fillStyle = '#F4A24B';
  ctx.fillRect(-len / 2, -hgt - 4, len, 4);

  ctx.restore();
}

function drawWheel(x, y, rotation) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);

  ctx.beginPath();
  ctx.arc(0, 0, VEHICLE.wheelRadius, 0, Math.PI * 2);
  ctx.fillStyle = '#0D1117';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#2A3145';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, VEHICLE.wheelRadius * 0.5, 0, Math.PI * 2);
  ctx.fillStyle = '#F4A24B';
  ctx.fill();

  // spokes
  ctx.strokeStyle = '#0D1117';
  ctx.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * VEHICLE.wheelRadius * 0.5, Math.sin(a) * VEHICLE.wheelRadius * 0.5);
    ctx.stroke();
  }

  ctx.restore();
}

/* ──────────────────────────────────────────────────────────────
   UI BINDINGS
────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const distVal = $('distVal');
const coinVal = $('coinVal');
const fuelBar = $('fuelBar');
const flipToast = $('flipToast');
const startScreen = $('startScreen');
const pauseScreen = $('pauseScreen');
const gameOverScreen = $('gameOverScreen');
const bestDistStart = $('bestDistStart');
const finalDist = $('finalDist');
const finalCoins = $('finalCoins');
const finalFlips = $('finalFlips');
const newBestTag = $('newBestTag');
const gameOverReasonEl = $('gameOverReason');
const hud = $('hud');
const touchControls = $('touchControls');

function updateHUD() {
  distVal.textContent = state.distance + ' m';
  coinVal.textContent = state.coins;
  fuelBar.style.width = state.fuel + '%';
  fuelBar.classList.toggle('low', state.fuel < 25);
}

let flipToastTimer = null;
function showFlipToast(text) {
  flipToast.textContent = text;
  flipToast.classList.add('show');
  clearTimeout(flipToastTimer);
  flipToastTimer = setTimeout(() => flipToast.classList.remove('show'), 900);
}

function showGameOver() {
  finalDist.textContent = state.distance + ' m';
  finalCoins.textContent = state.coins;
  finalFlips.textContent = Math.floor(state.bestFlip);
  gameOverReasonEl.textContent = state.gameOverReason;
  const isNewBest = state.distance >= state.bestDistance && state.distance > 0;
  newBestTag.classList.toggle('hidden', !isNewBest);
  gameOverScreen.classList.remove('hidden');
  hud.style.display = 'none';
  touchControls.classList.remove('active');
}

function startGame() {
  resetGame();
  state.status = 'playing';
  startScreen.classList.add('hidden');
  pauseScreen.classList.add('hidden');
  gameOverScreen.classList.add('hidden');
  hud.style.display = 'block';
  if (isTouchDevice()) touchControls.classList.add('active');
  updateHUD();
}

function isTouchDevice() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

function pauseGame() {
  if (state.status !== 'playing') return;
  state.status = 'paused';
  pauseScreen.classList.remove('hidden');
}
function resumeGame() {
  if (state.status !== 'paused') return;
  state.status = 'playing';
  pauseScreen.classList.add('hidden');
}

bestDistStart.textContent = state.bestDistance + ' m';

$('startBtn').addEventListener('click', startGame);
$('retryBtn').addEventListener('click', startGame);
$('pauseBtn').addEventListener('click', () => {
  if (state.status === 'playing') pauseGame();
  else if (state.status === 'paused') resumeGame();
});
$('resumeBtn').addEventListener('click', resumeGame);
$('restartFromPauseBtn').addEventListener('click', startGame);

/* ──────────────────────────────────────────────────────────────
   INPUT — KEYBOARD
────────────────────────────────────────────────────────────── */
window.addEventListener('keydown', e => {
  switch (e.code) {
    case 'ArrowRight': case 'KeyD': input.gas = true; break;
    case 'ArrowLeft': case 'KeyA': input.brake = true; break;
    case 'ArrowUp': case 'KeyW': input.leanLeft = true; break;
    case 'ArrowDown': case 'KeyS': input.leanRight = true; break;
    case 'KeyP':
      if (state.status === 'playing') pauseGame();
      else if (state.status === 'paused') resumeGame();
      break;
  }
});
window.addEventListener('keyup', e => {
  switch (e.code) {
    case 'ArrowRight': case 'KeyD': input.gas = false; break;
    case 'ArrowLeft': case 'KeyA': input.brake = false; break;
    case 'ArrowUp': case 'KeyW': input.leanLeft = false; break;
    case 'ArrowDown': case 'KeyS': input.leanRight = false; break;
  }
});

/* ──────────────────────────────────────────────────────────────
   INPUT — TOUCH
────────────────────────────────────────────────────────────── */
function bindHold(el, onDown, onUp) {
  const down = e => { e.preventDefault(); onDown(); el.classList.add('pressed'); };
  const up = e => { e.preventDefault(); onUp(); el.classList.remove('pressed'); };
  el.addEventListener('touchstart', down, { passive: false });
  el.addEventListener('touchend', up, { passive: false });
  el.addEventListener('touchcancel', up, { passive: false });
  el.addEventListener('mousedown', down);
  el.addEventListener('mouseup', up);
  el.addEventListener('mouseleave', up);
}

bindHold($('btnGas'), () => input.gas = true, () => input.gas = false);
bindHold($('btnBrake'), () => input.brake = true, () => input.brake = false);
bindHold($('btnLeft'), () => input.leanLeft = true, () => input.leanLeft = false);
bindHold($('btnRight'), () => input.leanRight = true, () => input.leanRight = false);

if (isTouchDevice()) touchControls.classList.add('active');

/* ──────────────────────────────────────────────────────────────
   MAIN LOOP
────────────────────────────────────────────────────────────── */
let lastTime = performance.now();
const FIXED_DT = 1 / 60;
let accumulator = 0;

function loop(now) {
  let frameDt = (now - lastTime) / 1000;
  lastTime = now;
  frameDt = Math.min(frameDt, 0.05); // avoid spiral of death on tab-switch

  accumulator += frameDt;
  while (accumulator >= FIXED_DT) {
    physicsStep(FIXED_DT);
    updateParticles(FIXED_DT);
    accumulator -= FIXED_DT;
  }

  if (state.status === 'playing') updateHUD();
  draw();

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);

})();
