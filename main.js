// ---------------------------------------------------------------------------
// LUMA — app controller.
// One pointer model (fed by the mouse or the tracked fingertip) drives one
// disturbance system, so hand and mouse use exactly the same liquid.
// ---------------------------------------------------------------------------
import { Liquid } from './liquid.js';
import { Hand, HAND_CONNECTIONS } from './hand.js';
import { Sound } from './sound.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

// ===========================================================================
// Materials
// Over the live camera, a material only styles the *disturbed* liquid:
//   camMat: refraction, iridescence, specular, chroma
//   tint:   milky body colour + opacity inside the ripples
//   irid:   iridescence colour bias + rainbow saturation
// Without a camera (landing page, mouse mode) they also style the abstract
// studio surface: colors (top, bottom, 3 light blobs, accent), mat, mat2.
// ===========================================================================
const MATERIALS = {
  pearl: {
    colors: ['#FBFAF7', '#EFEAF3', '#DCD6FF', '#F5D4E7', '#D6EEF8', '#FFFFFF'],
    mat: [0.05, 0.22, 0.95, 0.2], mat2: [0.9, 1.0, 0.018, 60],
    camMat: [0.075, 0.38, 0.85, 0.18], tint: [0.99, 0.97, 1.0, 0.2], irid: [1.0, 0.88, 1.0, 0.22],
  },
  lagoon: {
    colors: ['#EEF8FC', '#C9E8F6', '#A9DCEC', '#DCD6FF', '#C3F0E6', '#EAFBFF'],
    mat: [0.06, 0.24, 1.0, 0.36], mat2: [1.25, 1.0, 0.02, 60],
    camMat: [0.095, 0.36, 1.0, 0.26], tint: [0.66, 0.86, 1.0, 0.26], irid: [0.7, 0.93, 1.12, 0.2],
  },
  aurora: {
    colors: ['#F6F2FB', '#E6E0FA', '#F5D4E7', '#C9E8F6', '#FBE3D2', '#FFFFFF'],
    mat: [0.055, 0.58, 0.95, 0.55], mat2: [1.0, 1.0, 0.02, 60],
    camMat: [0.09, 0.5, 0.95, 0.5], tint: [1.0, 0.95, 1.0, 0.1], irid: [1.0, 0.97, 1.03, 0.62],
  },
};
const ABSTRACT_IRID = [1, 1, 1, 0.55];
const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
function materialArrays(name) {
  const m = MATERIALS[name];
  return {
    colors: new Float32Array(m.colors.flatMap(hexRGB)), mat: new Float32Array(m.mat), mat2: new Float32Array(m.mat2),
    camMat: new Float32Array(m.camMat), tint: new Float32Array(m.tint), irid: new Float32Array(m.irid),
  };
}

// ===========================================================================
// Preferences (sound always starts muted, as requested)
// ===========================================================================
const Prefs = {
  data: { material: 'pearl', volume: 0.6, cursor: true, camPreview: true },
  load() {
    try { Object.assign(this.data, JSON.parse(localStorage.getItem('luma.v1') || '{}')); } catch (e) { /* private mode */ }
    this.data.material = 'pearl'; // every visit starts on Pearl, the default material
    this.data.volume = clamp(+this.data.volume || 0, 0, 1);
  },
  save() { try { localStorage.setItem('luma.v1', JSON.stringify(this.data)); } catch (e) { /* ignore */ } },
};

// ===========================================================================
// State
// ===========================================================================
const App = { state: 'landing', input: 'mouse', reduced: motionQuery.matches };
const liquid = new Liquid($('#liquid'));
let liquidError = null;

/** The single interaction point (screen-normalised, y down), shared by mouse and hand. */
const P = {
  x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, px: 0.5, py: 0.5,
  active: false, wasActive: false, teleport: true,
  speed: 0, vx: 0, vy: 0, hist: [], moved: 0,
  press: false, pressSince: 0,
};
const mouse = { x: 0.5, y: 0.5, inside: false, down: false, shift: false, lastMove: 0 };
const contact = { depth: 0, radius: 0.07 };
const Pull = { active: false, ax: 0.5, ay: 0.5, fx: 0.5, fy: 0.5, amt: 0, vel: 0, target: 0 };
const Flick = { armed: false, peak: 0, dx: 0, dy: 0, last: -1e9 };
let glow = 0;
let simAcc = 0;
let camBlend = 0; // 0 = abstract surface, 1 = live camera under the liquid

const current = materialArrays(Prefs.data.material);
let target = materialArrays(Prefs.data.material);
const uniforms = {
  colors: current.colors, mat: new Float32Array(4), mat2: new Float32Array(4),
  contact: new Float32Array(4), pullAB: new Float32Array(4), pull: 0, glow: new Float32Array(3),
  cam: 0, tint: new Float32Array(4), irid: new Float32Array(4),
};

// ===========================================================================
// Init
// ===========================================================================
function initApp() {
  Prefs.load();
  Object.assign(current, materialArrays(Prefs.data.material));
  target = materialArrays(Prefs.data.material);
  uniforms.colors = current.colors;
  Sound.volume = Prefs.data.volume;
  $('#volume').value = Prefs.data.volume;

  const initError = liquid.init();
  if (initError) showLiquidError(initError);
  else resize();
  liquid.onLost = () => document.body.classList.add('no-webgl');
  liquid.onRestored = () => { document.body.classList.remove('no-webgl'); resize(); };

  Hand.init($('#cam'));
  Hand.on('status', onHandStatus);
  Hand.on('pinchstart', () => { if (handDriving()) beginPress(true); });
  Hand.on('pinchend', () => { if (handDriving() || Pull.active || P.press) endPress(); });
  Hand.on('palm', () => { if (handDriving()) palmRipple(P.x, P.y); });

  bindUI();
  Tip.init();
  syncUI();
  motionQuery.addEventListener?.('change', (e) => { App.reduced = e.matches; });
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => { Hand.stop(); liquid.dispose(); });
  requestAnimationFrame(frame);
}

function resize() {
  if (!liquid.ok) return;
  try {
    liquid.resize(innerWidth, innerHeight, window.devicePixelRatio || 1);
  } catch (e) {
    console.error(e);
    showLiquidError(e.message);
  }
}

function showLiquidError(msg) {
  liquidError = msg;
  document.body.classList.add('no-webgl');
  $('#webgl-error').textContent = msg + ' Try the latest Chrome, Edge, Safari or Firefox.';
  $('#webgl-error').hidden = false;
  $('[data-action="enter"]').disabled = true;
}

const handDriving = () => App.state === 'explore' && App.input === 'hand';

// ===========================================================================
// Screens
// ===========================================================================
function go(state) {
  const prev = App.state;
  App.state = state;
  document.body.dataset.state = state;
  document.body.dataset.input = App.input;
  $('#setup').hidden = state !== 'setup';

  if (state === 'landing') {
    Hand.stop();
    endPress(true);
    Hints.reset();
    Sound.quiet();
    setTimeout(() => $('#headline').focus({ preventScroll: true }), 50);
  }
  if (state === 'setup') {
    App.input = 'hand';
    document.body.dataset.input = 'hand';
    $('#setup-error').hidden = true;
    if (Hand.status === 'error') Hand.setStatus('idle');
    onHandStatus(Hand.status, Hand.errorCode);
    if (!Hand.running && !Hand.starting) Hand.start(() => App.state === 'setup' || handDriving());
    setTimeout(() => $('#setup-title').focus({ preventScroll: true }), 50);
  }
  if (state === 'explore') {
    if (App.input === 'mouse') Hand.stop();
    P.teleport = true;
    Hints.start();
    $('#instruction').classList.remove('gone');
  }
  placePreview();
  if (prev === 'explore' && state !== 'explore') $('#guide').open && $('#guide').close();
}

function placePreview() {
  const preview = $('#preview');
  const host = App.state === 'setup' ? $('#setup-preview-host')
    : handDriving() ? $('#mini-preview-host') : $('#preview-parking');
  if (preview.parentElement !== host) {
    host.appendChild(preview);
    if (Hand.video.srcObject) Hand.video.play().catch(() => {});
  }
}

// ===========================================================================
// Hand status → UI
// ===========================================================================
const STATUS = {
  idle: 'Camera is off',
  requesting: 'Waiting for camera permission',
  loading: 'Initialising hand tracking',
  searching: 'Looking for your hand',
  detected: 'Hand detected',
  error: 'Camera access unavailable',
};
const ERRORS = {
  denied: 'Camera access was blocked. Click the camera icon in your address bar, allow access, then try again — or continue with your mouse.',
  notfound: 'No camera was found. You can continue with your mouse.',
  inuse: 'Your camera is being used by another app. Close it there and try again, or continue with your mouse.',
  insecure: 'The camera only works on a secure (https) page. You can continue with your mouse.',
  model: 'Hand tracking couldn’t load. Check your connection and try again, or continue with your mouse.',
  unknown: 'The camera didn’t start. Try again, or continue with your mouse.',
};

function onHandStatus(status, code) {
  const el = $('#status');
  el.dataset.status = status;
  el.querySelector('.txt').textContent = status === 'error' && code === 'model' ? 'Hand tracking unavailable' : STATUS[status];
  const err = $('#setup-error');
  err.hidden = status !== 'error';
  if (status === 'error') err.textContent = ERRORS[code] || ERRORS.unknown;
  $('#btn-retry').hidden = status !== 'error';
  $('#btn-start').disabled = !(Hand.everDetected && Hand.running);
  const preview = $('#preview');
  preview.classList.toggle('live', Hand.running);
  preview.classList.toggle('found', status === 'detected');
  preview.style.aspectRatio = String(Hand.aspect);
}

// ===========================================================================
// Main loop — the only animation loop
// ===========================================================================
let lastT = performance.now();
let slowFrames = 0;
let frameEMA = 1 / 60;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000));
  lastT = now;
  adaptQuality(dt);

  if (Hand.running) Hand.update(now);
  updatePointer(dt, now);
  updateInteraction(dt, now);
  updateMaterial(dt);
  updateCursor();
  Hints.update(dt);
  if (Hand.running) drawCamOverlay();

  if (!liquid.ok) return;
  if (!liquid.simW) { resize(); if (!liquid.simW) return; }
  // the live camera becomes the image under the glass whenever it's running
  const camLive = Hand.running && liquid.updateVideo(Hand.video) && liquid.videoW > 0;
  camBlend += ((camLive ? 1 : 0) - camBlend) * (1 - Math.exp(-dt * 3));
  if (camBlend < 0.002 && !camLive) camBlend = 0;
  const camShown = camBlend > 0.5;
  if (document.body.classList.contains('cam-bg') !== camShown) document.body.classList.toggle('cam-bg', camShown);
  // fixed-rate wave simulation (≈120 steps/s), independent of display refresh
  simAcc = Math.min(simAcc + dt, 0.05);
  let steps = Math.floor(simAcc * 120);
  simAcc -= steps / 120;
  steps = Math.min(steps, 5);
  const damping = App.reduced ? 0.985 : 0.9955;
  if (steps > 0) liquid.step(steps, damping, 0.9985); // queued drops wait for the next step otherwise
  blendMaterial();
  liquid.render(now / 1000, uniforms);
}

/** Lower the render resolution if the device is struggling. */
function adaptQuality(dt) {
  frameEMA += (dt - frameEMA) * 0.05;
  if (frameEMA > 1 / 40 && liquid.renderScale > 0.55) {
    if (++slowFrames > 90) {
      liquid.renderScale = Math.max(0.55, liquid.renderScale - 0.15);
      slowFrames = 0;
      frameEMA = 1 / 60;
      resize();
    }
  } else slowFrames = 0;
}

// ===========================================================================
// Pointer: mouse or fingertip → one smoothed interaction point
// ===========================================================================
/**
 * Fingertip → screen, through the exact cover-crop the shader uses for the
 * mirrored camera, so the ripple lands on the fingertip you see on screen.
 * (Hand.tip is already mirrored and normalised to the full camera frame.)
 */
function mapHand(t) {
  const { kx, ky } = liquid.coverScale(liquid.videoW ? liquid.videoAspect : Hand.aspect);
  return { x: 0.5 + (t.x - 0.5) / kx, y: 0.5 + (t.y - 0.5) / ky };
}
const onScreen = (m) => m.x > -0.02 && m.x < 1.02 && m.y > -0.02 && m.y < 1.02;

function updatePointer(dt, now) {
  P.px = P.x; P.py = P.y;
  P.wasActive = P.active;
  if (handDriving()) {
    const m = Hand.present ? mapHand(Hand.tip) : null;
    if (m && onScreen(m)) { // a fingertip outside the visible crop doesn't touch the liquid
      P.tx = clamp(m.x, 0, 1); P.ty = clamp(m.y, 0, 1);
      if (!P.active) { P.x = P.tx; P.y = P.ty; P.px = P.x; P.py = P.y; P.teleport = true; } // re-acquired: no streak
      P.active = true;
    } else P.active = false;
    const k = 1 - Math.exp(-dt * 30);
    P.x += (P.tx - P.x) * k;
    P.y += (P.ty - P.y) * k;
  } else {
    const live = mouse.inside && (App.state === 'explore' || now - mouse.lastMove < 1500);
    if (live && !P.active) { P.x = P.px = mouse.x; P.y = P.py = mouse.y; P.teleport = true; }
    P.active = live && App.state !== 'setup';
    P.x = mouse.x; P.y = mouse.y;
  }
  // velocity over the last ~90 ms, in screen-height units per second
  const a = innerWidth / innerHeight;
  P.hist.push({ t: now, x: P.x * a, y: P.y });
  while (P.hist.length > 2 && now - P.hist[0].t > 90) P.hist.shift();
  const h0 = P.hist[0], h1 = P.hist[P.hist.length - 1];
  const span = Math.max(0.016, (h1.t - h0.t) / 1000);
  const vx = (h1.x - h0.x) / span, vy = (h1.y - h0.y) / span;
  P.vx = vx; P.vy = vy;
  P.speed = P.active ? Math.hypot(vx, vy) : 0;
}

// ===========================================================================
// Interaction → disturbances
// ===========================================================================
function updateInteraction(dt, now) {
  const a = innerWidth / innerHeight;
  const exploring = App.state === 'explore';
  const pinching = Pull.active;

  // --- drag & flow: a continuous wake along the path -----------------------
  if (P.active && !P.teleport) {
    const dx = (P.x - P.px) * a, dy = P.y - P.py;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.0006) {
      P.moved += dist;
      let intensity = App.state === 'landing' ? 0.32
        : App.input === 'hand' ? 1 : mouse.down ? 1.35 : 0.55;
      if (pinching) intensity *= 0.25;
      if (App.reduced) intensity *= 0.6;
      const sp = Math.min(P.speed, 5);
      const n = clamp(Math.ceil(dist / 0.014), 1, 6);
      const strength = -(0.0028 + sp * 0.0048) * intensity / Math.sqrt(n);
      const radius = clamp(0.085 - sp * 0.013, 0.034, 0.085); // slow = broad, fast = tighter
      const stretch = Math.min(sp * 0.45, 2.2);
      const ux = dx / dist, uy = -dy / dist; // uv space has y up
      for (let k = 1; k <= n; k++) {
        const f = k / n;
        liquid.addDrop(P.px + (P.x - P.px) * f, 1 - (P.py + (P.y - P.py) * f), radius, strength, ux, uy, stretch);
      }
    }
  }
  P.teleport = false;

  // --- flick & release: a fast stroke that decelerates sends out a wave ----
  if (exploring && P.active && !pinching) {
    const thresh = App.input === 'hand' ? 1.5 : 2.6;
    if (P.speed > thresh) {
      if (P.speed > Flick.peak) { Flick.peak = P.speed; Flick.dx = P.vx / P.speed; Flick.dy = P.vy / P.speed; }
      Flick.armed = true;
    } else if (Flick.armed) {
      if (now - Flick.last > 600) fireFlick((Flick.peak - thresh) / 2.5);
      Flick.armed = false;
      Flick.peak = 0;
    }
  } else { Flick.armed = false; Flick.peak = 0; }

  // --- touch & press: an elastic dimple that deepens while held -----------
  let depthTarget = 0;
  if (exploring && P.active) depthTarget = App.input === 'hand' ? 0.01 : 0.006;
  if (P.press) {
    const held = (now - P.pressSince) / 1000;
    depthTarget = 0.04 + Math.min(held, 1.5) * 0.025;
    if (Pull.active) depthTarget *= 1 - smooth(0.015, 0.08, pullDistance());
  }
  if (!P.active && !P.press) depthTarget = 0;
  contact.depth += (depthTarget - contact.depth) * (1 - Math.exp(-dt * (depthTarget > contact.depth ? 7 : 4)));
  contact.radius += ((P.press ? 0.085 : 0.065) - contact.radius) * (1 - Math.exp(-dt * 6));
  uniforms.contact[0] = P.x; uniforms.contact[1] = 1 - P.y;
  uniforms.contact[2] = App.reduced ? contact.depth * 0.6 : contact.depth;
  uniforms.contact[3] = contact.radius;

  // --- pinch & pull: stretch a droplet toward the fingertip, recoil on release
  if (Pull.active) {
    Pull.fx = P.x; Pull.fy = P.y;
    let ddx = (Pull.fx - Pull.ax) * a, ddy = Pull.fy - Pull.ay;
    const d = Math.hypot(ddx, ddy);
    if (d > 0.32) { // drag the anchor along so the neck never over-stretches
      const k = (d - 0.32) / d;
      Pull.ax += (ddx * k) / a; Pull.ay += ddy * k;
    }
    Pull.target = 0.11 * smooth(0.01, 0.15, Math.min(d, 0.32));
  } else {
    Pull.target = 0;
    const k = 1 - Math.exp(-dt * 9);
    Pull.fx += (Pull.ax - Pull.fx) * k;
    Pull.fy += (Pull.ay - Pull.fy) * k;
  }
  const stiff = Pull.active ? 70 : 150, damp = Pull.active ? 12 : 6.5; // under-damped release = elastic recoil
  Pull.vel += (stiff * (Pull.target - Pull.amt) - damp * Pull.vel) * dt;
  Pull.amt += Pull.vel * dt;
  if (!Pull.active && Math.abs(Pull.amt) < 1e-4 && Math.abs(Pull.vel) < 1e-3) Pull.amt = Pull.vel = 0;
  uniforms.pull = App.reduced ? Pull.amt * 0.6 : Pull.amt;
  uniforms.pullAB[0] = Pull.ax; uniforms.pullAB[1] = 1 - Pull.ay;
  uniforms.pullAB[2] = Pull.fx; uniforms.pullAB[3] = 1 - Pull.fy;

  // --- soft light under the contact point --------------------------------
  glow = Math.max(0, glow - dt * 1.6);
  uniforms.glow[0] = P.x; uniforms.glow[1] = 1 - P.y;
  uniforms.glow[2] = Math.max(glow, P.press ? 0.35 : 0) * (exploring ? 1 : 0);

  // --- sound follows the gesture ------------------------------------------
  if (exploring) {
    Sound.drag(P.active && !Pull.active ? P.speed : 0, P.x);
    Sound.pull(Pull.active ? Pull.amt / 0.11 : 0);
  }
}

function pullDistance() {
  const a = innerWidth / innerHeight;
  return Math.hypot((Pull.fx - Pull.ax) * a, Pull.fy - Pull.ay);
}

function fireFlick(s) {
  s = clamp(s, 0, 1);
  Flick.last = performance.now();
  const r = App.reduced ? 0.6 : 1;
  const ux = Flick.dx, uy = -Flick.dy;
  liquid.addDrop(P.x, 1 - P.y, 0.05 + 0.05 * s, -(0.05 + 0.13 * s) * r, ux, uy, 1.2);
  liquid.addDrop(P.x + Flick.dx * 0.03 / (innerWidth / innerHeight), 1 - P.y - Flick.dy * 0.03, 0.035, -(0.02 + 0.05 * s) * r);
  glow = Math.max(glow, 0.5 + 0.5 * s);
  pulseCursor();
  Sound.ripple(0.3 + 0.7 * s, P.x);
  Hints.done('flick');
}

/** Open palm / right-click: one broad wave across the whole surface. */
function palmRipple(x, y) {
  const r = App.reduced ? 0.55 : 1;
  liquid.addDrop(x, 1 - y, 0.3, -0.16 * r);
  liquid.addDrop(x, 1 - y, 0.12, 0.06 * r);
  glow = 1;
  pulseCursor();
  Sound.wave(x);
  Hints.done('palm');
}

function beginPress(fromPinch) {
  if (App.state !== 'explore') return;
  P.press = true;
  P.pressSince = performance.now();
  // pinch (hand) or Shift+drag (mouse) also starts a pull from this point
  if (fromPinch || mouse.shift) {
    Pull.active = true;
    Pull.ax = Pull.fx = P.x;
    Pull.ay = Pull.fy = P.y;
  }
  Sound.drop(P.x);
  Hints.done('press');
}

function endPress(silent = false) {
  if (Pull.active) {
    Pull.active = false;
    if (!silent && Pull.amt > 0.025) {
      // the stretched droplet snaps back and sheds a small ripple
      const s = Pull.amt;
      liquid.addDrop(Pull.fx, 1 - Pull.fy, 0.06, -s * 1.3);
      liquid.addDrop(Pull.ax, 1 - Pull.ay, 0.05, -s * 0.6);
      Sound.ripple(Math.min(1, s * 8), Pull.fx);
      pulseCursor();
      Hints.done('pull');
    }
  }
  if (P.press && !silent && contact.depth > 0.03) {
    liquid.addDrop(P.x, 1 - P.y, 0.08, -contact.depth * 0.7); // the dimple releases as a ring
  }
  P.press = false;
  if (silent) { Pull.amt = Pull.vel = 0; contact.depth = 0; }
}

function resetSurface() {
  if (liquid.ok) liquid.clear();
  Pull.active = false; Pull.amt = Pull.vel = 0;
  contact.depth = 0;
  P.press = false;
  glow = 0;
  P.teleport = true;
}

// ===========================================================================
// Materials
// ===========================================================================
function switchMaterial(name) {
  if (!MATERIALS[name]) return;
  Prefs.data.material = name;
  Prefs.save();
  target = materialArrays(name);
  syncUI();
}
/** Mix the abstract and camera variants of the current material by camBlend. */
function blendMaterial() {
  const c = camBlend;
  for (let i = 0; i < 4; i++) {
    uniforms.mat[i] = current.mat[i] + (current.camMat[i] - current.mat[i]) * c;
    uniforms.mat2[i] = current.mat2[i];
    uniforms.tint[i] = current.tint[i];
    uniforms.irid[i] = ABSTRACT_IRID[i] + (current.irid[i] - ABSTRACT_IRID[i]) * c;
  }
  // no idle swell over the camera: at rest the image must look untouched
  uniforms.mat2[2] = App.reduced ? 0 : current.mat2[2] * (1 - c);
  uniforms.cam = c;
}

function updateMaterial(dt) {
  const k = 1 - Math.exp(-dt * 3.5);
  for (const key of ['colors', 'mat', 'mat2', 'camMat', 'tint', 'irid']) {
    const c = current[key], t = target[key];
    for (let i = 0; i < c.length; i++) c[i] += (t[i] - c[i]) * k;
  }
}

// ===========================================================================
// Cursor indicator + camera overlay
// ===========================================================================
const cursorEl = $('#cursor');
let cursorState = '';
function updateCursor() {
  const exploring = App.state === 'explore';
  const show = exploring && Prefs.data.cursor && (P.active || (App.input === 'hand' && Hand.everDetected));
  const cls = !show ? '' : P.active ? (P.press ? 'on press' : 'on') : 'dim';
  if (cls !== cursorState) {
    cursorEl.classList.remove('on', 'press', 'dim');
    if (cls) cls.split(' ').forEach((c) => cursorEl.classList.add(c));
    cursorState = cls;
  }
  if (show) cursorEl.style.transform = `translate3d(${P.x * innerWidth}px, ${P.y * innerHeight}px, 0)`;

  // "looking for your hand" pill
  const lost = handDriving() && (Hand.status === 'error' || (Hand.running && !Hand.present && performance.now() - Hand.lastSeen > 1200));
  const pill = $('#lost');
  if (pill.hidden !== !lost) {
    pill.hidden = !lost;
    pill.querySelector('.txt').textContent = Hand.status === 'error' ? 'Camera unavailable.' : 'Looking for your hand…';
    pill.querySelector('[data-action="mouse"]').hidden = Hand.status !== 'error';
  }
}
function pulseCursor() {
  cursorEl.classList.remove('pulse');
  void cursorEl.offsetWidth;
  cursorEl.classList.add('pulse');
}

let camCtx = null;
function drawCamOverlay() {
  const c = $('#cam-overlay');
  if (!c.offsetWidth) return;
  const w = c.offsetWidth, h = c.offsetHeight, dpr = Math.min(2, devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  camCtx = camCtx || c.getContext('2d');
  const g = camCtx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const l = Hand.landmarks;
  if (!l) return;
  const pt = (i) => [(1 - l[i].x) * w, l[i].y * h];
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 1.2;
  g.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) { const pa = pt(a), pb = pt(b); g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]); }
  g.stroke();
  const [x, y] = pt(8);
  const pinched = Hand.pinchState === 'closed';
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.shadowColor = '#fff';
  g.shadowBlur = 10;
  g.beginPath(); g.arc(x, y, pinched ? 5 : 8, 0, Math.PI * 2); g.stroke();
  g.shadowBlur = 0;
}

// ===========================================================================
// Hints — one short line at a time, only when useful
// ===========================================================================
const Hints = {
  queue: ['flick', 'pull', 'palm'],
  doneSet: new Set(),
  showing: null,
  shownFor: 0,
  wait: 0,
  started: false,
  text(key) {
    const hand = App.input === 'hand';
    return {
      move: hand ? 'Move your hand to move the liquid.' : 'Move or drag to move the liquid.',
      flick: hand ? 'Try a quick flick.' : 'Try a quick swipe.',
      pull: hand ? 'Pinch and pull.' : 'Hold Shift, then drag to pull.',
      palm: hand ? 'Close your hand, then open your palm.' : 'Right-click for a broad ripple.',
    }[key];
  },
  reset() { this.started = false; this.showing = null; this.doneSet.clear(); this.hide(); },
  start() {
    this.doneSet.clear();
    this.started = true;
    this.wait = 0.8;
    this.showing = null;
    P.moved = 0;
    this.next = 'move';
  },
  done(key) {
    this.doneSet.add(key);
    if (this.showing === key) { this.hide(); this.wait = 4; }
  },
  show(key) {
    this.showing = key;
    this.shownFor = 0;
    const el = $('#hint');
    el.textContent = this.text(key);
    el.classList.add('show');
  },
  hide() {
    this.showing = null;
    $('#hint').classList.remove('show');
  },
  update(dt) {
    if (!this.started || App.state !== 'explore') return;
    if (!this.doneSet.has('move') && P.moved > 0.6) {
      this.done('move');
      $('#instruction').classList.add('gone');
    }
    if (this.showing) {
      this.shownFor += dt;
      if (this.showing !== 'move' && this.shownFor > 10) { this.hide(); this.wait = 6; }
      return;
    }
    this.wait -= dt;
    if (this.wait > 0) return;
    if (!this.doneSet.has('move')) { this.show('move'); return; }
    const next = this.queue.find((k) => !this.doneSet.has(k) && !this.doneSet.has(k + ':shown'));
    if (next) { this.doneSet.add(next + ':shown'); this.show(next); }
    else this.started = false;
  },
};

// ===========================================================================
// UI wiring
// ===========================================================================
function syncUI() {
  $$('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.material === Prefs.data.material)));
  const on = Sound.enabled;
  const sb = $('#btn-sound');
  sb.setAttribute('aria-pressed', String(on));
  sb.setAttribute('aria-label', on ? 'Sound on — turn off' : 'Sound off — turn on');
  $('.sound-pill').classList.toggle('on', on);
  const cb = $('#btn-cursor');
  cb.setAttribute('aria-pressed', String(Prefs.data.cursor));
  cb.setAttribute('aria-label', Prefs.data.cursor ? 'Hide fingertip indicator' : 'Show fingertip indicator');
  sb.dataset.tip = on ? 'Water sounds are on — click to mute' : 'Turn on soothing water sounds';
  cb.dataset.tip = Prefs.data.cursor
    ? 'Fingertip indicator — the small glowing ring that shows where you touch. Click to hide it'
    : 'Fingertip indicator is hidden — click to show the ring that marks where you touch';
  $('#btn-cam').dataset.tip = Prefs.data.camPreview ? 'Hide the small camera preview' : 'Show the small camera preview';
  Tip.refresh();
  $('#mini-cam').classList.toggle('collapsed', !Prefs.data.camPreview);
  $('#btn-cam').setAttribute('aria-pressed', String(Prefs.data.camPreview));
  $('#btn-cam').setAttribute('aria-label', Prefs.data.camPreview ? 'Hide camera preview' : 'Show camera preview');
}

function bindUI() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const act = el.dataset.action;
    if (act === 'enter' && !liquidError) go('setup');
    if (act === 'start') { App.input = 'hand'; go('explore'); }
    if (act === 'mouse') { App.input = 'mouse'; Hand.stop(); go('explore'); }
    if (act === 'retry') { Hand.stop(true); Hand.setStatus('idle'); Hand.start(() => App.state === 'setup' || handDriving()); }
    if (act === 'exit' && App.state !== 'landing') go('landing');
  });
  $$('.swatch').forEach((b) => b.addEventListener('click', () => switchMaterial(b.dataset.material)));
  $('#btn-sound').addEventListener('click', () => { Sound.setEnabled(!Sound.enabled); syncUI(); });
  $('#volume').addEventListener('input', (e) => {
    Prefs.data.volume = +e.target.value;
    Prefs.save();
    Sound.setVolume(Prefs.data.volume);
  });
  $('#btn-reset').addEventListener('click', resetSurface);
  $('#btn-guide').addEventListener('click', () => {
    $$('#guide [data-mouse]').forEach((s) => (s.hidden = App.input !== 'mouse'));
    $('#guide').showModal();
  });
  $('#btn-cursor').addEventListener('click', () => { Prefs.data.cursor = !Prefs.data.cursor; Prefs.save(); syncUI(); });
  $('#btn-cam').addEventListener('click', () => { Prefs.data.camPreview = !Prefs.data.camPreview; Prefs.save(); syncUI(); });

  // mouse / touch — feeds the same pointer as the hand
  const canvas = $('#liquid');
  window.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX / innerWidth;
    mouse.y = e.clientY / innerHeight;
    mouse.inside = true;
    mouse.shift = e.shiftKey;
    mouse.lastMove = performance.now();
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { mouse.inside = false; });
  window.addEventListener('blur', () => { mouse.inside = false; if (mouse.down) { mouse.down = false; endPress(); } });
  canvas.addEventListener('pointerdown', (e) => {
    if (App.state !== 'explore' || App.input !== 'mouse' || e.button !== 0) return;
    mouse.x = e.clientX / innerWidth; mouse.y = e.clientY / innerHeight;
    mouse.inside = true; mouse.shift = e.shiftKey; mouse.down = true;
    P.x = mouse.x; P.y = mouse.y;
    canvas.setPointerCapture?.(e.pointerId);
    beginPress(false);
  });
  window.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !mouse.down) return;
    mouse.down = false;
    endPress();
    if (e.pointerType !== 'mouse') mouse.inside = false;
  });
  canvas.addEventListener('contextmenu', (e) => {
    if (App.state !== 'explore') return;
    e.preventDefault();
    if (App.input === 'mouse') palmRipple(e.clientX / innerWidth, e.clientY / innerHeight);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey) resetSurface();
  });
}

// ===========================================================================
// Button popups: a short explanation on hover or keyboard focus
// ===========================================================================
const Tip = {
  el: null, target: null, timer: 0,
  init() {
    this.el = $('#tip');
    const show = (e) => {
      const t = e.target.closest?.('[data-tip]');
      if (!t || t === this.target) return;
      clearTimeout(this.timer);
      this.target = t;
      // a short delay on hover so tips don't flicker while the mouse passes by
      this.timer = setTimeout(() => this.show(t), e.type === 'focusin' ? 0 : 350);
    };
    const hide = (e) => {
      const t = e.target.closest?.('[data-tip]');
      if (t && t === this.target && !t.contains(e.relatedTarget)) this.hide();
    };
    document.addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse') show(e); });
    document.addEventListener('pointerout', hide);
    document.addEventListener('focusin', (e) => { if (e.target.matches(':focus-visible')) show(e); });
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', () => this.hide(), true);
    window.addEventListener('scroll', () => this.hide(), true);
  },
  show(t) {
    if (!t.isConnected || !t.getClientRects().length) return; // skip hidden controls
    const el = this.el;
    el.textContent = t.dataset.tip;
    el.hidden = false;
    const r = t.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(10, Math.min(innerWidth - w - 10, x));
    const above = r.bottom + h + 14 > innerHeight;
    const y = above ? r.top - h - 10 : r.bottom + 10;
    el.classList.toggle('above', above);
    el.style.setProperty('--arrow', `${r.left + r.width / 2 - x}px`);
    el.style.transform = '';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    requestAnimationFrame(() => el.classList.add('show'));
  },
  hide() {
    clearTimeout(this.timer);
    this.target = null;
    this.el.classList.remove('show');
    this.el.hidden = true;
  },
  refresh() { if (this.target) this.show(this.target); },
};

function onVisibility() {
  if (document.hidden) {
    Sound.suspend();
    if (mouse.down) { mouse.down = false; endPress(true); }
  } else {
    lastT = performance.now();
    Sound.resume();
  }
}

initApp();


