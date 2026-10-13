// ---------------------------------------------------------------------------
// Water sound layer (Web Audio, all synthesised — no audio files).
// Muted until the user turns it on. Soothing rather than musical:
//   • a very quiet bed of slowly breathing, flowing water
//   • water drops ("bloops": a short tone that slides quickly upward in pitch)
//   • a soft swish that follows the speed of a drag
//   • rippling drops for flicks, a washing wave for the open palm
//   • a low, submerged hum while pinching and pulling
// Continuous sounds are single persistent voices whose levels follow the
// gesture, so nothing re-triggers on every tracking frame.
// ---------------------------------------------------------------------------

export const Sound = {
  ctx: null,
  master: null,
  wet: null,
  enabled: false,
  volume: 0.6,
  noise: null,
  swish: null,
  hum: null,
  bed: null,
  lastDrop: 0,
  lastRipple: 0,
  lastBubble: 0,
  voices: 0,
  dripTimer: 0,

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        const ctx = (this.ctx = new AC());
        this.master = ctx.createGain();
        this.master.gain.value = 0;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -22;
        comp.ratio.value = 3;
        // a short, soft "room" so drops sound like they land in water, not in a void
        this.wet = this.makeEcho();
        this.master.connect(comp).connect(ctx.destination);
        this.wet.out.connect(comp);
        this.noise = this.makeNoise();
        this.buildSwish();
        this.buildHum();
        this.buildBed();
      } catch (e) {
        console.warn('Audio unavailable', e);
        this.ctx = null;
        return null;
      }
    }
    if (this.ctx.state === 'suspended' && this.enabled) this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  setEnabled(on) {
    this.enabled = on;
    if (on && !this.ensure()) { this.enabled = false; return false; }
    if (!this.ctx) return on;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(on ? this.volume * 0.8 : 0, t, 0.15);
    this.wet.in.gain.setTargetAtTime(on ? 1 : 0, t, 0.15);
    this.bed.g.gain.setTargetAtTime(on ? 0.05 : 0, t, 1.2); // the water bed fades in slowly
    if (on) { this.ctx.resume().catch(() => {}); this.scheduleDrip(); }
    else { this.quiet(); clearTimeout(this.dripTimer); }
    return on;
  },

  setVolume(v) {
    this.volume = v;
    if (this.ctx && this.enabled) this.master.gain.setTargetAtTime(v * 0.8, this.ctx.currentTime, 0.05);
  },

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); },
  resume() { if (this.ctx && this.enabled) this.ctx.resume().catch(() => {}); },
  live() { return this.enabled && this.ctx && this.ctx.state === 'running'; },

  // --- building blocks -----------------------------------------------------
  makeNoise() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // brown-ish noise: soft, watery, no hiss
      last = last * 0.985 + (Math.random() * 2 - 1) * 0.015;
      d[i] = last * 9;
    }
    return buf;
  },

  loopNoise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random() * 2;
    src.start(0, Math.random() * 3);
    return src;
  },

  makeEcho() {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const out = ctx.createGain();
    out.gain.value = 0.28;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    const d1 = ctx.createDelay(1); d1.delayTime.value = 0.083;
    const d2 = ctx.createDelay(1); d2.delayTime.value = 0.131;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    input.connect(lp);
    lp.connect(d1); lp.connect(d2);
    d1.connect(fb); d2.connect(fb);
    fb.connect(lp);
    d1.connect(out); d2.connect(out);
    return { in: input, out };
  },

  panner(x) {
    if (!this.ctx.createStereoPanner) return null;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-0.7, Math.min(0.7, (x - 0.5) * 1.4));
    return p;
  },

  /** Continuous swish that follows drag speed (filtered noise, gently wobbling). */
  buildSwish() {
    const ctx = this.ctx;
    const src = this.loopNoise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 380;
    bp.Q.value = 0.9;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.value = 0;
    const wob = ctx.createOscillator();
    const wobAmt = ctx.createGain();
    wob.frequency.value = 3.1;
    wobAmt.gain.value = 70;
    wob.connect(wobAmt).connect(bp.frequency);
    wob.start();
    src.connect(bp).connect(lp).connect(g);
    g.connect(this.master);
    g.connect(this.wet.in);
    this.swish = { g, bp };
  },

  /** Low submerged hum for a sustained pinch-and-pull. */
  buildHum() {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    lp.Q.value = 4;
    const src = this.loopNoise();
    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.value = 98;
    const sineG = ctx.createGain();
    sineG.gain.value = 0.35;
    sine.connect(sineG).connect(lp);
    sine.start();
    src.connect(lp);
    lp.connect(g).connect(this.master);
    this.hum = { g, lp, sine };
  },

  /** The ambient bed: quiet flowing water that slowly breathes. */
  buildBed() {
    const ctx = this.ctx;
    const src = this.loopNoise();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    lp.Q.value = 0.4;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    const breathe = ctx.createGain();
    breathe.gain.value = 0.75;
    const lfo = ctx.createOscillator();
    const lfoAmt = ctx.createGain();
    lfo.frequency.value = 0.08; // one slow swell every ~12 s
    lfoAmt.gain.value = 0.25;
    lfo.connect(lfoAmt).connect(breathe.gain);
    const lfo2 = ctx.createOscillator();
    const lfo2Amt = ctx.createGain();
    lfo2.frequency.value = 0.05;
    lfo2Amt.gain.value = 160;
    lfo2.connect(lfo2Amt).connect(lp.frequency);
    lfo.start(); lfo2.start();
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(hp).connect(lp).connect(breathe).connect(g).connect(this.master);
    this.bed = { g };
  },

  /** Occasional distant drips while sound is on — soothing, never rhythmic. */
  scheduleDrip() {
    clearTimeout(this.dripTimer);
    this.dripTimer = setTimeout(() => {
      if (!this.enabled) return;
      if (this.live() && !document.hidden) this.bloop(0.2 + Math.random() * 0.6, 0.012 + Math.random() * 0.01, 520 + Math.random() * 500);
      this.scheduleDrip();
    }, 4500 + Math.random() * 7000);
  },

  /**
   * One water drop: a sine whose pitch slides quickly upward (the bubble
   * resonance of a drop hitting water), with a fast, soft envelope.
   */
  bloop(x = 0.5, gain = 0.06, f0 = 500, rise = 2.2, dur = 0.16) {
    if (this.voices > 20) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * rise, t + dur * 0.45);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const pan = this.panner(x);
    o.connect(g);
    if (pan) { g.connect(pan); pan.connect(this.master); pan.connect(this.wet.in); }
    else { g.connect(this.master); g.connect(this.wet.in); }
    o.start(t);
    o.stop(t + dur + 0.05);
    this.voices++;
    o.onended = () => { this.voices--; g.disconnect(); };
  },

  /** A short filtered-noise wash (splash / wave body). */
  wash(x, gain, attack, dur, fFrom, fTo) {
    if (this.voices > 20) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(fFrom, t);
    lp.frequency.exponentialRampToValueAtTime(fTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const pan = this.panner(x);
    src.connect(lp).connect(g);
    if (pan) { g.connect(pan); pan.connect(this.master); pan.connect(this.wet.in); }
    else { g.connect(this.master); g.connect(this.wet.in); }
    src.start(t, Math.random() * 3);
    src.stop(t + dur + 0.05);
    this.voices++;
    src.onended = () => { this.voices--; g.disconnect(); };
  },

  // --- gesture sounds (called by the interaction code) -----------------------

  /** Continuous: drag speed (screen heights / s) → soft swish + the odd bubble. */
  drag(speed, x = 0.5) {
    if (!this.live()) return;
    const t = this.ctx.currentTime;
    const level = Math.min(0.11, Math.max(0, (speed - 0.35) * 0.045));
    this.swish.g.gain.setTargetAtTime(level, t, 0.15);
    this.swish.bp.frequency.setTargetAtTime(260 + Math.min(speed, 4) * 160, t, 0.2);
    // faster strokes stir up a few tiny bubbles
    const now = performance.now();
    if (speed > 1.2 && now - this.lastBubble > 140 && Math.random() < Math.min(0.5, speed * 0.12)) {
      this.lastBubble = now;
      this.bloop(x, 0.018 + Math.random() * 0.015, 700 + Math.random() * 600, 1.8, 0.09);
    }
  },

  /** Continuous: pinch/pull amount 0..1 → submerged hum. */
  pull(amount) {
    if (!this.live()) return;
    const t = this.ctx.currentTime;
    this.hum.g.gain.setTargetAtTime(amount > 0.01 ? 0.05 + amount * 0.07 : 0, t, 0.12);
    this.hum.lp.frequency.setTargetAtTime(200 + amount * 380, t, 0.12);
    this.hum.sine.frequency.setTargetAtTime(92 + amount * 30, t, 0.2);
  },

  quiet() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.swish?.g.gain.setTargetAtTime(0, t, 0.08);
    this.hum?.g.gain.setTargetAtTime(0, t, 0.08);
  },

  /** Press: a single soft drop where the finger touches. */
  drop(x = 0.5) {
    if (!this.live()) return;
    const now = performance.now();
    if (now - this.lastDrop < 120) return;
    this.lastDrop = now;
    this.bloop(x, 0.07, 380 + Math.random() * 120, 2.4, 0.18);
  },

  /** Flick / pull release: a drop, a small splash and a couple of ripples spreading out. */
  ripple(strength = 0.5, x = 0.5) {
    if (!this.live()) return;
    const now = performance.now();
    if (now - this.lastRipple < 200) return;
    this.lastRipple = now;
    const s = Math.max(0.2, Math.min(1, strength));
    this.bloop(x, 0.05 + s * 0.04, 300 + Math.random() * 120, 2.6, 0.2);
    this.wash(x, 0.03 + s * 0.05, 0.02, 0.35 + s * 0.3, 1800, 300);
    const extra = s > 0.6 ? 2 : 1;
    for (let i = 0; i < extra; i++) {
      setTimeout(() => this.live() && this.bloop(x + (Math.random() - 0.5) * 0.2, 0.02 + s * 0.02, 600 + Math.random() * 400, 1.9, 0.12), 90 + i * 110 + Math.random() * 60);
    }
  },

  /** Open palm: a slow wave washing across, with a few drops settling after it. */
  wave(x = 0.5) {
    if (!this.live()) return;
    this.wash(x, 0.12, 0.45, 2.4, 900, 160);
    this.wash(1 - x, 0.05, 0.7, 2.0, 600, 140);
    [450, 800, 1250].forEach((ms, i) => setTimeout(() => this.live() && this.bloop(0.3 + Math.random() * 0.4, 0.025 - i * 0.005, 420 + Math.random() * 300, 2, 0.16), ms + Math.random() * 150));
  },
};
