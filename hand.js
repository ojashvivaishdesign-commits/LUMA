// ---------------------------------------------------------------------------
// Webcam + MediaPipe Hand Landmarker, plus LUMA's gesture recognition.
// Tracks one hand: smoothed index fingertip, pinch (thumb↔index) with
// hysteresis, and an "open your palm" transition (closed/pointing → open).
// ---------------------------------------------------------------------------

const MP = {
  bundle: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

export const GESTURE = {
  pinchClose: 0.42,     // thumb–index gap / palm length
  pinchOpen: 0.58,
  pinchFrames: 2,
  palmHoldMs: 140,      // open palm must be held this long…
  palmAfterClosedMs: 1300, // …within this long of the hand being closed / pointing
  palmCooldownMs: 2500,
};

/** One Euro filter — low lag when moving fast, low jitter when still. */
class OneEuro {
  constructor(minCutoff = 1.6, beta = 7, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  a(dt, c) { const tau = 1 / (2 * Math.PI * c); return 1 / (1 + tau / dt); }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    this.dx += this.a(dt, this.dCutoff) * ((x - this.x) / dt - this.dx);
    this.x += this.a(dt, this.minCutoff + this.beta * Math.abs(this.dx)) * (x - this.x);
    return this.x;
  }
}

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export const Hand = {
  video: null,
  stream: null,
  landmarker: null,
  modelPromise: null,
  token: 0,
  starting: false,
  status: 'idle',          // idle | requesting | loading | searching | detected | error
  errorCode: null,         // denied | notfound | inuse | insecure | model | unknown
  aspect: 4 / 3,

  present: false,
  everDetected: false,
  lastSeen: -1e9,
  landmarks: null,
  tip: { x: 0.5, y: 0.5 },  // smoothed, mirrored, normalised (y down)
  pinchRatio: 1,
  pinchState: 'unknown',    // unknown | open | closed
  closeFrames: 0,
  palm: { open: false, openSince: 0, lastClosed: -1e9, lastFired: -1e9 },
  lastVideoTime: -1,
  lastTs: 0,
  failStreak: 0,
  rebuilding: false,
  fx: new OneEuro(),
  fy: new OneEuro(),

  listeners: { status: new Set(), pinchstart: new Set(), pinchend: new Set(), palm: new Set() },
  on(evt, fn) { this.listeners[evt].add(fn); },
  emit(evt, ...a) { this.listeners[evt].forEach((fn) => fn(...a)); },
  setStatus(s, code = null) {
    if (this.status === s && this.errorCode === code) return;
    this.status = s;
    this.errorCode = code;
    this.emit('status', s, code);
  },

  init(video) { this.video = video; },
  get running() { return !!this.stream; },

  loadModel() {
    if (this.landmarker) return Promise.resolve(this.landmarker);
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const vision = await import(MP.bundle);
        const files = await vision.FilesetResolver.forVisionTasks(MP.wasm);
        const opts = (delegate) => ({
          baseOptions: { modelAssetPath: MP.model, delegate },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        try {
          this.landmarker = await vision.HandLandmarker.createFromOptions(files, opts('GPU'));
        } catch (e) {
          console.warn('GPU delegate unavailable, using CPU.', e);
          this.landmarker = await vision.HandLandmarker.createFromOptions(files, opts('CPU'));
        }
        this.emit('status', this.status, this.errorCode);
        return this.landmarker;
      })().catch((err) => { this.modelPromise = null; throw err; });
    }
    return this.modelPromise;
  },

  /** Start the webcam — only after the user chose to enter the experience. */
  async start(stillNeeded = () => true) {
    if (this.stream || this.starting) return;
    const token = ++this.token;
    this.starting = true;
    this.setStatus('requesting');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.starting = false;
      this.setStatus('error', 'insecure');
      return;
    }
    const modelP = this.loadModel();
    modelP.catch(() => {});
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
    } catch (err) {
      if (token !== this.token) return;
      this.starting = false;
      const n = err && err.name;
      this.setStatus('error', n === 'NotAllowedError' || n === 'SecurityError' ? 'denied'
        : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'notfound'
        : n === 'NotReadableError' || n === 'AbortError' ? 'inuse' : 'unknown');
      return;
    }
    if (token !== this.token || !stillNeeded()) {
      stream.getTracks().forEach((t) => t.stop());
      if (token === this.token) { this.starting = false; this.setStatus('idle'); }
      return;
    }
    this.stream = stream;
    const v = this.video;
    v.srcObject = stream;
    await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
    v.play().catch(() => {});
    if (v.videoWidth && v.videoHeight) this.aspect = v.videoWidth / v.videoHeight;
    this.emit('status', this.status, null);
    if (!this.landmarker) this.setStatus('loading');
    try {
      await modelP;
    } catch (err) {
      console.error('Hand tracking failed to load', err);
      if (token !== this.token) return;
      this.starting = false;
      this.stop(true);
      this.setStatus('error', 'model');
      return;
    }
    if (token !== this.token) return;
    this.starting = false;
    this.resetTracking();
    this.setStatus('searching');
  },

  stop(keepStatus = false) {
    this.token++;
    this.starting = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.resetTracking();
    if (!keepStatus) this.setStatus('idle');
  },

  resetTracking() {
    if (this.pinchState === 'closed') this.emit('pinchend', performance.now());
    this.present = false;
    this.landmarks = null;
    this.pinchState = 'unknown';
    this.closeFrames = 0;
    this.lastVideoTime = -1;
    this.palm.open = false;
    this.fx.reset();
    this.fy.reset();
  },

  /** If MediaPipe's graph gets stuck in an error state, recreate it. */
  rebuild() {
    if (this.rebuilding) return;
    this.rebuilding = true;
    const old = this.landmarker;
    this.landmarker = null;
    this.modelPromise = null;
    try { old && old.close(); } catch (e) { /* ignore */ }
    this.loadModel()
      .then(() => { this.failStreak = 0; this.lastTs = 0; this.resetTracking(); })
      .catch(() => this.setStatus('error', 'model'))
      .finally(() => { this.rebuilding = false; });
  },

  /** Run detection on the newest video frame (called from the app's single loop). */
  update(now) {
    const v = this.video;
    if (!this.stream || !this.landmarker || v.readyState < 2) return;
    if (v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const ts = Math.max(Math.floor(now), this.lastTs + 1); // must strictly increase
    this.lastTs = ts;
    let res;
    try {
      res = this.landmarker.detectForVideo(v, ts);
      this.failStreak = 0;
    } catch (err) {
      if (++this.failStreak === 1) console.warn('Hand tracking frame failed', err);
      if (this.failStreak >= 8) this.rebuild();
      return;
    }
    const lms = res && res.landmarks && res.landmarks[0];
    if (lms) {
      if (!this.present && now - this.lastSeen > 300) { this.fx.reset(); this.fy.reset(); }
      this.present = true;
      this.everDetected = true;
      this.lastSeen = now;
      this.landmarks = lms;
      const t = now / 1000;
      this.tip = { x: this.fx.filter(1 - lms[8].x, t), y: this.fy.filter(lms[8].y, t) };
      this.detectPinch(lms, now);
      this.detectOpenPalm(lms, now);
      if (this.status !== 'detected') this.setStatus('detected');
    } else {
      this.present = false;
      this.landmarks = null;
      if (now - this.lastSeen > 250 && this.pinchState !== 'unknown') {
        if (this.pinchState === 'closed') this.emit('pinchend', now);
        this.pinchState = 'unknown';
        this.closeFrames = 0;
      }
      this.palm.open = false;
      if (this.status === 'detected' && now - this.lastSeen > 400) this.setStatus('searching');
    }
  },

  dist(a, b) { return Math.hypot((a.x - b.x) * this.aspect, a.y - b.y); },
  palmLength(l) { return Math.max(1e-3, this.dist(l[0], l[9])); },

  /** Pinch with hysteresis; emits pinchstart / pinchend transitions only. */
  detectPinch(l, now) {
    const ratio = Math.min(this.dist(l[4], l[8]), this.dist(l[4], l[7]) * 1.15) / this.palmLength(l);
    this.pinchRatio = ratio;
    if (this.pinchState === 'unknown') {
      this.pinchState = ratio < GESTURE.pinchClose ? 'closed' : 'open';
      if (this.pinchState === 'closed') this.emit('pinchstart', now);
    } else if (this.pinchState === 'open') {
      if (ratio < GESTURE.pinchClose) {
        if (++this.closeFrames >= GESTURE.pinchFrames) {
          this.pinchState = 'closed';
          this.closeFrames = 0;
          this.emit('pinchstart', now);
        }
      } else this.closeFrames = 0;
    } else if (ratio > GESTURE.pinchOpen) {
      this.pinchState = 'open';
      this.emit('pinchend', now);
    }
  },

  /** How many of the four fingers are straightened (tip well beyond its PIP joint). */
  extendedFingers(l) {
    let n = 0;
    for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
      if (this.dist(l[0], l[tip]) > this.dist(l[0], l[pip]) * 1.18) n++;
    }
    return n;
  },

  /**
   * Open palm = all fingers + thumb out and spread. It only fires when the
   * hand *opens* (from closed or pointing), so simply holding an open hand up
   * to move the liquid doesn't keep re-triggering it.
   */
  detectOpenPalm(l, now) {
    const palmLen = this.palmLength(l);
    const ext = this.extendedFingers(l);
    const thumbOut = this.dist(l[4], l[5]) > palmLen * 0.55;
    const spread = this.dist(l[8], l[20]) > palmLen * 0.85;
    const open = ext === 4 && thumbOut && spread;
    const P = this.palm;
    if (ext <= 2) P.lastClosed = now;
    if (open && !P.open) P.openSince = now;
    P.open = open;
    if (open && now - P.openSince >= GESTURE.palmHoldMs && P.openSince - P.lastClosed < GESTURE.palmAfterClosedMs &&
        now - P.lastFired > GESTURE.palmCooldownMs) {
      P.lastFired = now;
      P.lastClosed = -1e9; // require closing again before the next one
      this.emit('palm', now);
    }
  },

  pinchAmount() { return Math.max(0, Math.min(1, (1 - this.pinchRatio) / (1 - GESTURE.pinchClose))); },
};
