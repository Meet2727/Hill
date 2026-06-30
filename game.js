/* ════════════════════════════════════════════════════════════════
   ADVANCED HILL RACER ENGINE — JavaScript (game.js)
════════════════════════════════════════════════════════════════ */

(() => {
'use strict';

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

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

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

const TERRAIN_STEP = 12;
const noise1 = makeNoise(2026);
const noise2 = makeNoise(888);

function terrainHeightAt(x) {
  const progress = clamp(x / 25000, 0, 1);
  const amp1 = 80 + progress * 140;
  const amp2 = 25 + progress * 50;
  
  let h = noise1(x * (0.001 + progress * 0.0005)) * amp1;
  h += noise2(x * 0.005) * amp2;

  const startFlat = clamp(1 - x / 600, 0, 1);
  return lerp(h, 0, startFlat) + 340;
}

function groundY(x) {
  return terrainHeightAt(x);
}

// Creative: Procedural Boost Pads and Collectibles
function getFeatureAtChunk(chunkIndex) {
  const v = Math.sin(chunkIndex * 456.789) * 1000;
  const frac = v - Math.floor(v);
  if (chunkIndex > 2 && frac < 0.08) return 'BOOST';
  if (frac > 0.15 && frac < 0.45) return 'COIN';
  return null;
}

const STORAGE_KEY = 'hillracer_best_distance';
const state = {
  status: 'menu',
  distance: 0,
  bestDistance: Number(localStorage.getItem(STORAGE_KEY) || 0),
  coins: 0,
  fuel: 100,
  cameraX: 0,
  cameraY: 0,
  collectedKeys: new Set(),
  rotationAccum: 0,
  bestFlip: 0,
  flipCounted: false,
  gameOverReason: '',
  shakeT: 0,
  particles: [],
  boostActive: 0
};

const VEHICLE = {
  wheelBase: 84,
  wheelRadius: 20,
  mass: 1.0,
  enginePower: 0.68,
  brakePower: 0.50,
  maxSpeed: 15,
  gravity: 0.58,
  airRotationSpeed: 0.06,
  suspensionStiffness: 0.25,
};

function createCar(startX) {
  return {
    x: startX,
    y: groundY(startX) - 50,
    angle: 0,
    vx: 0,
    vy: 0,
    angVel: 0,
    wheelRotation: 0,
    rearGrounded: false,
    frontGrounded: false,
    grounded: false
  };
}

let car = createCar(150);
const input = { gas: false, brake: false, leanLeft: false, leanRight: false };

function resetGame() {
  car = createCar(150);
  state.distance = 0;
  state.coins = 0;
  state.fuel = 100;
  state.collectedKeys.clear();
  state.rotationAccum = 0;
  state.bestFlip = 0;
  state.flipCounted = false;
  state.particles = [];
  state.shakeT = 0;
  state.boostActive = 0;
  state.cameraX = car.x;
  state.cameraY = car.y;
}

function physicsStep(dt) {
  if (state.status !== 'playing') return;

  if (state.boostActive > 0) {
    state.boostActive -= dt;
    car.vx += Math.cos(car.angle) * 0.8;
    state.fuel = Math.min(100, state.fuel + 0.5);
    // Rocket Booster Flame Particles
    state.particles.push({
      x: car.x - Math.cos(car.angle) * 40,
      y: car.y - Math.sin(car.angle) * 10,
      vx: -Math.cos(car.angle) * 8 + (Math.random() - 0.5) * 3,
      vy: -Math.sin(car.angle) * 8 + (Math.random() - 0.5) * 3,
      life: 0.5, color: '#2EC4B6', size: 4 + Math.random() * 4
    });
  }

  car.vy += VEHICLE.gravity;

  const wb = VEHICLE.wheelBase / 2;
  const rX = car.x - Math.cos(car.angle) * wb;
  const rY = car.y - Math.sin(car.angle) * wb;
  const fX = car.x + Math.cos(car.angle) * wb;
  const fY = car.y + Math.sin(car.angle) * wb;

  const gR = groundY(rX) - VEHICLE.wheelRadius;
  const gF = groundY(fX) - VEHICLE.wheelRadius;

  car.rearGrounded = rY >= gR;
  car.frontGrounded = fY >= gF;
  car.grounded = car.rearGrounded || car.frontGrounded;

  // Process Controls
  if (input.gas && state.fuel > 0) {
    if (car.grounded) {
      const force = VEHICLE.enginePower * (state.boostActive > 0 ? 1.8 : 1.0);
      car.vx += Math.cos(car.angle) * force;
      car.vy += Math.sin(car.angle) * force * 0.2;
    }
    state.fuel = clamp(state.fuel - dt * 5, 0, 100);
  }
  
  if (input.brake) {
    if (car.grounded) {
      car.vx -= Math.cos(car.angle) * VEHICLE.brakePower;
    }
  }

  if (!car.grounded) {
    if (input.leanRight || input.gas) car.angVel += VEHICLE.airRotationSpeed;
    if (input.leanLeft || input.brake) car.angVel -= VEHICLE.airRotationSpeed;
    state.rotationAccum += car.angVel;
  } else {
    // Advanced Suspension Alignment Torque
    const slope = Math.atan2(gF - gR, VEHICLE.wheelBase);
    let diff = slope - car.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    car.angVel += diff * VEHICLE.suspensionStiffness;
    state.rotationAccum = 0;
  }

  // Position Integrations
  car.vx *= 0.985;
  car.vy *= 0.985;
  car.angVel *= 0.90;

  car.x += car.vx;
  car.y += car.vy;
  car.angle += car.angVel;

  // Real Ground Hard Collisions
  const postRX = car.x - Math.cos(car.angle) * wb;
  const postRY = car.y - Math.sin(car.angle) * wb;
  const postGroundR = groundY(postRX) - VEHICLE.wheelRadius;
  if (postRY > postGroundR) {
    car.y -= (postRY - postGroundR) * 0.5;
    car.vy *= -0.1;
  }

  const postFX = car.x + Math.cos(car.angle) * wb;
  const postFY = car.y + Math.sin(car.angle) * wb;
  const postGroundF = groundY(postFX) - VEHICLE.wheelRadius;
  if (postFY > postGroundF) {
    car.y -= (postFY - postGroundF) * 0.5;
    car.vy *= -0.1;
  }

  // Crash Loop Check
  const normAngle = ((car.angle + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (car.grounded && Math.abs(normAngle) > 1.95) {
    triggerCrash('Chassis Flipped!');
  }

  state.distance = Math.max(state.distance, Math.floor((car.x - 150) / 10));
  car.wheelRotation += car.vx / VEHICLE.wheelRadius;

  // Elements Trigger Check
  checkFeatures();

  // Camera Follow
  state.cameraX = lerp(state.cameraX, car.x + 120, 0.1);
  state.cameraY = lerp(state.cameraY, car.y, 0.05);
}

function checkFeatures() {
  const currentChunk = Math.floor(car.x / 200);
  for (let i = currentChunk - 2; i <= currentChunk + 2; i++) {
    const feat = getFeatureAtChunk(i);
    if (!feat) continue;
    const featX = i * 200 + 100;
    const featY = groundY(featX) - 30;
    const key = feat + '_' + i;

    if (!state.collectedKeys.has(key)) {
      const dist = Math.hypot(car.x - featX, car.y - featY);
      if (dist < 45) {
        if (feat === 'BOOST') {
          state.boostActive = 2.0; // 2 seconds intense boost
          state.shakeT = 0.5;
          showFlipToast("NITRO BOOST!");
        } else if (feat === 'COIN') {
          state.coins += 1;
          for (let p=0; p<6; p++) {
            state.particles.push({
              x: featX, y: featY, vx: (Math.random()-0.5)*4, vy: -Math.random()*4,
              life: 0.6, color: '#F4A24B', size: 3
            });
          }
        }
        state.collectedKeys.add(key);
      }
    }
  }
}

function triggerCrash(reason) {
  if (state.status !== 'playing') return;
  state.gameOverReason = reason;
  state.status = 'over';
  state.shakeT = 0.5;
  if (state.distance > state.bestDistance) {
    state.bestDistance = state.distance;
    localStorage.setItem(STORAGE_KEY, String(state.bestDistance));
  }
  showGameOver();
}

function updateParticles(dt) {
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.x += p.vx; p.y += p.vy;
    p.life -= dt;
    if (p.life <= 0) state.particles.splice(i, 1);
  }
}

/* ──────────────────────────────────────────────────────────────
   RENDER GRAPHICS
────────────────────────────────────────────────────────────── */
function draw() {
  ctx.clearRect(0, 0, W, H);
  
  // Creative Aspect: Progressive Sky Color Transitions based on distance
  const shift = clamp(state.distance / 1200, 0, 1);
  const r1 = Math.floor(lerp(10, 24, shift)), g1 = Math.floor(lerp(15, 12, shift)), b1 = Math.floor(lerp(30, 48, shift));
  ctx.fillStyle = `rgb(${r1}, ${g1}, ${b1})`;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  // Camera translation handling matrix adjustments safely
  ctx.translate(W * 0.25, H * 0.60);
  ctx.translate(-state.cameraX, -state.cameraY);

  // Draw Boost Pads
  const startChunk = Math.floor((state.cameraX - W) / 200);
  const endChunk = Math.floor((state.cameraX + W * 2) / 200);
  
  for (let i = Math.max(0, startChunk); i <= endChunk; i++) {
    const feat = getFeatureAtChunk(i);
    const fx = i * 200 + 100;
    const fy = groundY(fx);
    if (feat === 'BOOST') {
      ctx.fillStyle = '#2EC4B6';
      ctx.beginPath();
      ctx.moveTo(fx - 25, fy); ctx.lineTo(fx, fy - 15); ctx.lineTo(fx + 25, fy); ctx.closePath();
      ctx.fill();
    } else if (feat === 'COIN' && !state.collectedKeys.has('COIN_' + i)) {
      ctx.fillStyle = '#F4A24B';
      ctx.beginPath(); ctx.arc(fx, fy - 25, 12, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Draw Hills Surface Line
  ctx.beginPath();
  ctx.moveTo(state.cameraX - W, groundY(state.cameraX - W));
  for (let x = state.cameraX - W; x <= state.cameraX + W * 1.5; x += TERRAIN_STEP) {
    ctx.lineTo(x, groundY(x));
  }
  ctx.lineTo(state.cameraX + W * 1.5, H * 2);
  ctx.lineTo(state.cameraX - W, H * 2);
  ctx.fillStyle = '#1C2440';
  ctx.fill();

  // Rendering Car Chassis & Suspensions
  const wb = VEHICLE.wheelBase / 2;
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);
  
  ctx.fillStyle = '#5B4FE8';
  ctx.fillRect(-50, -22, 100, 20); // body
  ctx.fillStyle = '#7B70FF';
  ctx.fillRect(-20, -36, 45, 15); // cabin
  ctx.restore();

  // Draw Spinning Wheels
  drawWheel(car.x - Math.cos(car.angle) * wb, car.y - Math.sin(car.angle) * wb, car.wheelRotation);
  drawWheel(car.x + Math.cos(car.angle) * wb, car.y + Math.sin(car.angle) * wb, car.wheelRotation);

  // Render particles
  for (const p of state.particles) {
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }
  ctx.restore();
}

function drawWheel(x, y, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = '#0D1117';
  ctx.beginPath(); ctx.arc(0, 0, VEHICLE.wheelRadius, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#F4A24B';
  ctx.fillRect(-3, -VEHICLE.wheelRadius, 6, VEHICLE.wheelRadius * 2);
  ctx.restore();
}

/* ──────────────────────────────────────────────────────────────
   INPUT HANDLING (CRITICAL MOBILE TOUCH FIX OVERRIDES)
────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const distVal = $('distVal'), coinVal = $('coinVal'), fuelBar = $('fuelBar'), flipToast = $('flipToast'), startScreen = $('startScreen'), pauseScreen = $('pauseScreen'), gameOverScreen = $('gameOverScreen'), bestDistStart = $('bestDistStart'), finalDist = $('finalDist'), finalCoins = $('finalCoins'), finalFlips = $('finalFlips'), newBestTag = $('newBestTag'), gameOverReasonEl = $('gameOverReason'), hud = $('hud'), touchControls = $('touchControls');

function updateHUD() {
  distVal.textContent = state.distance + ' m';
  coinVal.textContent = state.coins;
  fuelBar.style.width = state.fuel + '%';
  fuelBar.classList.toggle('low', state.fuel < 25);
}

function showFlipToast(text) {
  flipToast.textContent = text;
  flipToast.classList.add('show');
  setTimeout(() => flipToast.classList.remove('show'), 1200);
}

function showGameOver() {
  finalDist.textContent = state.distance + ' m';
  finalCoins.textContent = state.coins;
  finalFlips.textContent = Math.floor(state.bestFlip);
  gameOverReasonEl.textContent = state.gameOverReason;
  gameOverScreen.classList.remove('hidden');
  hud.style.display = 'none';
}

function startGame() {
  resetGame();
  state.status = 'playing';
  startScreen.classList.add('hidden');
  pauseScreen.classList.add('hidden');
  gameOverScreen.classList.add('hidden');
  hud.style.display = 'block';
  touchControls.classList.add('active');
  updateHUD();
}

bestDistStart.textContent = state.bestDistance + ' m';
$('startBtn').addEventListener('click', startGame);
$('retryBtn').addEventListener('click', startGame);

// Explicit Device Native Touch Pointer Controls Overriding 
function setupMobileButton(id, actionOn, actionOff) {
  const btn = $(id);
  if (!btn) return;
  
  const pressDown = (e) => {
    e.preventDefault(); 
    actionOn();
    btn.classList.add('pressed');
  };
  
  const pressUp = (e) => {
    e.preventDefault();
    actionOff();
    btn.classList.remove('pressed');
  };

  btn.addEventListener('touchstart', pressDown, { passive: false });
  btn.addEventListener('touchend', pressUp, { passive: false });
  btn.addEventListener('touchcancel', pressUp, { passive: false });
  btn.addEventListener('mousedown', pressDown);
  btn.addEventListener('mouseup', pressUp);
  btn.addEventListener('mouseleave', pressUp);
}

setupMobileButton('btnGas', () => { input.gas = true; }, () => { input.gas = false; });
setupMobileButton('btnBrake', () => { input.brake = true; }, () => { input.brake = false; });
setupMobileButton('btnLeft', () => { input.leanLeft = true; }, () => { input.leanLeft = false; });
setupMobileButton('btnRight', () => { input.leanRight = true; }, () => { input.leanRight = false; });

// Desktop Listeners
window.addEventListener('keydown', e => {
  if (e.code === 'ArrowRight' || e.code === 'KeyD') input.gas = true;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.brake = true;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') input.leanLeft = true;
  if (e.code === 'ArrowDown' || e.code === 'KeyS') input.leanRight = true;
});
window.addEventListener('keyup', e => {
  if (e.code === 'ArrowRight' || e.code === 'KeyD') input.gas = false;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.brake = false;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') input.leanLeft = false;
  if (e.code === 'ArrowDown' || e.code === 'KeyS') input.leanRight = false;
});

// Engine Frame loop
let lastTime = performance.now();
function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  physicsStep(1);
  updateParticles(dt);
  
  if (state.status === 'playing') updateHUD();
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

})();
