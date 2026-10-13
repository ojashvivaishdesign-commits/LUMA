// ---------------------------------------------------------------------------
// LUMA liquid engine (WebGL2).
//
// A GPU height-field wave simulation (ping-pong float textures) carries the
// ripples: every step each texel is pulled toward the average of its
// neighbours, which makes disturbances travel outward, interfere and slowly
// damp away. A second shader turns that height field (plus a few analytic
// layers: idle swell, press dimple and pinch-pull) into a glossy liquid-glass
// surface: refraction of what lies beneath (the live, mirrored camera, or a
// soft studio environment when there is no camera), restrained chromatic
// split, thin-film iridescence, specular highlights and fresnel-like edges.
// Over the camera, material colour appears only where the liquid is disturbed.
// It's an artistic wave model, not a physically accurate fluid solver.
// ---------------------------------------------------------------------------

export const MAX_DROPS = 32;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// --- simulation step: wave propagation + disturbance splats ----------------
const SIM_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uState;   // r = height, g = velocity
uniform vec2 uTexel;
uniform float uAspect;
uniform float uDamping;     // velocity damping per step
uniform float uRestore;     // pulls height back to rest per step
uniform int uDropCount;
uniform vec4 uDrops[${MAX_DROPS}];   // xy = uv, z = radius (height units), w = strength
uniform vec4 uDirs[${MAX_DROPS}];    // xy = direction, z = stretch along direction

void main() {
  vec4 s = texture(uState, vUv);
  float h = s.r, v = s.g;
  float avg = 0.25 * (
    texture(uState, vUv + vec2(uTexel.x, 0.0)).r + texture(uState, vUv - vec2(uTexel.x, 0.0)).r +
    texture(uState, vUv + vec2(0.0, uTexel.y)).r + texture(uState, vUv - vec2(0.0, uTexel.y)).r);
  // A factor of exactly 2 sits on the stability edge for pixel-sized
  // (checkerboard) waves and lets them creep up into specks; 1.6 is stable.
  v += (avg - h) * 1.6;
  v *= uDamping;
  h += v;
  h += (avg - h) * 0.015; // a whisper of smoothing soaks up pixel-level noise
  h *= uRestore;
  if (isnan(h) || isinf(h) || isnan(v) || isinf(v)) { h = 0.0; v = 0.0; }

  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= uDropCount) break;
    vec4 d = uDrops[i];
    vec4 dir = uDirs[i];
    vec2 p = (vUv - d.xy) * vec2(uAspect, 1.0);
    // anisotropic splat: stretched along the motion direction for fast strokes
    float along = dot(p, dir.xy);
    vec2 perp = p - along * dir.xy;
    float r = length(perp + (along / (1.0 + dir.z)) * dir.xy) / d.z;
    if (r < 1.0) h += d.w * (0.5 + 0.5 * cos(3.14159265 * r));
  }
  o = vec4(clamp(h, -2.0, 2.0), clamp(v, -2.0, 2.0), 0.0, 1.0);
}`;

// --- surface rendering ------------------------------------------------------
const RENDER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uState;
uniform vec2 uSimTexel;
uniform float uAspect;
uniform float uTime;
uniform vec3 uCol[6];   // 0 top, 1 bottom, 2-4 drifting light blobs, 5 accent
uniform vec4 uMat;      // refraction, iridescence, specular, chroma
uniform vec4 uMat2;     // depth tint, sheen, idle swell, normal strength
uniform vec4 uContact;  // xy uv, z dimple depth, w radius
uniform vec4 uPullAB;   // xy anchor uv, zw fingertip uv
uniform float uPull;    // pull height (springs, can overshoot negative)
uniform vec3 uGlow;     // xy uv, z amount
uniform sampler2D uVideo;
uniform float uCam;     // 0 = abstract studio surface, 1 = live camera underneath
uniform vec4 uVideoMap; // cover-crop + mirror: videoUV = uv * xy + zw
uniform vec4 uTint;     // milky tint inside disturbed liquid: rgb, opacity
uniform vec4 uIrid;     // iridescence colour bias rgb, rainbow saturation

vec2 asp(vec2 uv) { return vec2(uv.x * uAspect, uv.y); }

float contactH(vec2 uv) {
  vec2 p = asp(uv);
  float h = 0.0;
  if (uContact.z != 0.0) {
    vec2 d = p - asp(uContact.xy);
    h -= uContact.z * exp(-dot(d, d) / (uContact.w * uContact.w));
  }
  if (abs(uPull) > 1e-4) {
    vec2 a = asp(uPullAB.xy), b = asp(uPullAB.zw);
    vec2 ab = b - a;
    float L2 = max(dot(ab, ab), 1e-6);
    float t = clamp(dot(p - a, ab) / L2, 0.0, 1.0);
    // a neck that thickens into a rounded droplet at the fingertip
    float r = mix(0.04, 0.065, t) * (1.0 - 0.32 * sin(3.14159265 * t));
    vec2 q = p - (a + ab * t);
    h += uPull * (0.55 + 0.45 * t) * exp(-dot(q, q) / (r * r));
  }
  return h;
}

float idleH(vec2 uv) {
  vec2 p = asp(uv);
  float t = uTime;
  return uMat2.z * (
    sin(p.x * 2.1 + t * 0.29 + sin(p.y * 1.6 + t * 0.11) * 1.5) * 0.6 +
    sin(p.y * 2.9 - t * 0.21 + p.x * 0.9) * 0.4);
}

float heightAt(vec2 uv) { return texture(uState, uv).r + contactH(uv) + idleH(uv); }

// The soft "studio" behind the glass. Its bands and blobs are what you see bend.
vec3 env(vec2 uv) {
  vec2 p = asp(uv);
  float t = uTime * 0.05;
  vec3 c = mix(uCol[1], uCol[0], smoothstep(0.0, 1.0, uv.y));
  vec2 c1 = vec2(0.26 * uAspect + 0.05 * sin(t * 1.3), 0.30 + 0.04 * cos(t));
  vec2 c2 = vec2(0.80 * uAspect + 0.06 * cos(t * 0.9), 0.72 + 0.05 * sin(t * 1.1));
  vec2 c3 = vec2(0.56 * uAspect + 0.08 * sin(t * 0.7), 0.08 + 0.03 * cos(t * 1.7));
  c = mix(c, uCol[2], 0.85 * exp(-dot(p - c1, p - c1) / 0.10));
  c = mix(c, uCol[3], 0.85 * exp(-dot(p - c2, p - c2) / 0.08));
  c = mix(c, uCol[4], 0.75 * exp(-dot(p - c3, p - c3) / 0.06));
  float s = (p.x * 0.8 - p.y * 0.55) * 2.6 + 0.25 * sin(p.y * 2.0 + t * 2.0);
  float band = pow(max(0.5 + 0.5 * cos(s * 6.2831853), 0.0), 8.0); // max(): pow of a tiny negative is NaN (black pixels)
  c = mix(c, vec3(1.0), band * 0.30);
  float fine = pow(max(0.5 + 0.5 * cos((p.x * 0.35 + p.y) * 34.0 + sin(p.x * 3.0 + t) * 2.0), 0.0), 40.0);
  c = mix(c, uCol[5], fine * 0.04);
  return c;
}

// The live camera, cover-cropped and mirrored (same transform as the fingertip mapping).
vec3 cam(vec2 uv) { return texture(uVideo, uv * uVideoMap.xy + uVideoMap.zw).rgb; }

vec3 scene(vec2 uv) {
  if (uCam >= 0.999) return cam(uv);
  if (uCam <= 0.001) return env(uv);
  return mix(env(uv), cam(uv), uCam);
}

void main() {
  vec2 uv = vUv;
  vec2 ex = vec2(uSimTexel.x, 0.0), ey = vec2(0.0, uSimTexel.y);
  float h = heightAt(uv);
  float dx = heightAt(uv + ex) - heightAt(uv - ex);
  float dy = heightAt(uv + ey) - heightAt(uv - ey);
  vec3 n = normalize(vec3(-dx * uMat2.w, -dy * uMat2.w, 1.0));
  float slope = length(n.xy);

  // Disturbance mask: ~0 where the liquid is at rest, rising smoothly where it
  // moves. Over the camera, every material effect is weighted by it, so the
  // membrane is invisible until touched and fades back without hard edges.
  // (a small dead zone keeps faint leftover ripples fully invisible at rest)
  float mask = smoothstep(0.08, 0.9, clamp(slope * 7.0 + abs(h) * 10.0, 0.0, 1.0));
  float w = mix(1.0, mask, uCam);

  // refraction, with a gentle chromatic split only where the surface bends hard
  vec2 off = n.xy * uMat.x;
  float ca = uMat.w * smoothstep(0.04, 0.45, slope);
  vec3 col;
  if (ca > 0.01) {
    col.r = scene(uv + off * (1.0 + ca)).r;
    col.g = scene(uv + off).g;
    col.b = scene(uv + off * (1.0 - ca)).b;
  } else {
    col = scene(uv + off);
  }

  // translucent depth: dimples read slightly deeper and cooler
  col = mix(col, col * vec3(0.86, 0.87, 0.97), clamp(-h * uMat2.x * 5.0, 0.0, 0.35) * w);

  // milky body of the material (only inside the disturbed liquid over the camera)
  col = mix(col, uTint.rgb, uTint.a * mask * uCam);

  // thin-film iridescence, biased toward each material's colours
  float film = h * 12.0 + dot(n.xy, vec2(0.8, 0.5)) * 3.5 + (uv.x + uv.y) * 0.7 + uTime * 0.015;
  vec3 irid = 0.5 + 0.5 * cos(6.2831853 * (film + vec3(0.0, 0.33, 0.67)));
  irid = mix(vec3(1.0), irid, uIrid.w);
  irid = mix(irid, irid * uIrid.rgb * 1.12, 0.6);
  // over the camera the film is laid on translucently (screen-like) so the image stays readable
  vec3 filmCol = mix(col * irid * 1.08, mix(col, irid, 0.45), uCam);
  col = mix(col, filmCol, uMat.y * clamp(0.2 + slope * 2.5, 0.0, 1.0) * w);

  // lights: a crisp key highlight, a softer fill and a broad sheen
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H1 = normalize(normalize(vec3(-0.45, 0.55, 0.75)) + V);
  vec3 H2 = normalize(normalize(vec3(0.6, -0.35, 0.8)) + V);
  float k1 = max(dot(n, H1), 0.0);
  col += uMat.z * (pow(k1, 220.0) * 0.95 + pow(max(dot(n, H2), 0.0), 70.0) * 0.22);
  col += uMat2.y * (pow(k1, 16.0) - 0.45) * 0.10 * w;
  // fresnel-like brightening on steep edges
  col += mix(vec3(0.92, 0.96, 1.0), uTint.rgb, 0.5 * uCam) * pow(slope, 1.4) * 0.32;

  // soft light under the point of contact
  if (uGlow.z > 0.001) {
    vec2 d = asp(uv) - asp(uGlow.xy);
    col += uCol[5] * uGlow.z * 0.22 * exp(-dot(d, d) / 0.006);
  }

  vec2 q = uv - 0.5;
  col *= 1.0 - dot(q, q) * mix(0.16, 0.08, uCam);
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

function program(gl, fragSrc) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

export class Liquid {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.ok = false;
    this.lost = false;
    this.simW = 0;
    this.simH = 0;
    this.cur = 0;
    this.drops = new Float32Array(MAX_DROPS * 4);
    this.dirs = new Float32Array(MAX_DROPS * 4);
    this.dropCount = 0;
    this.renderScale = 1;
    this.aspect = 1;
    this.videoTex = null;
    this.videoW = 0;
    this.videoH = 0;
    this.videoAspect = 4 / 3;
    this.lastVideoTime = -1;
    this.onLost = null;
    this.onRestored = null;
  }

  /** Returns null on success, or a human-readable error string. */
  init() {
    const gl = this.canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) return 'Your browser can’t run WebGL 2, which LUMA needs for the liquid.';
    this.gl = gl;
    if (!this.canvas.__lumaListeners) {
      this.canvas.__lumaListeners = true;
      this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.ok = false; this.onLost?.(); });
      this.canvas.addEventListener('webglcontextrestored', () => { this.lost = false; const err = this.setup(); if (!err) this.onRestored?.(); });
    }
    return this.setup();
  }

  setup() {
    const gl = this.gl;
    try {
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
        return 'Your graphics driver can’t render the liquid simulation (no float render targets).';
      }
      this.sim = program(gl, SIM_FRAG);
      this.draw = program(gl, RENDER_FRAG);
    } catch (err) {
      console.error(err);
      return 'The liquid shader failed to start on this device.';
    }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.textures = [];
    this.fbos = [];
    this.simW = this.simH = 0;
    // one reusable texture for the live camera (1×1 placeholder until frames arrive)
    this.videoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([235, 232, 240, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.videoW = this.videoH = 0;
    this.lastVideoTime = -1;
    this.ok = true;
    return null;
  }

  /** Size the canvas to the window; reallocate the simulation if the aspect changed. */
  resize(cssW, cssH, dpr) {
    if (!this.ok) return;
    if (!(cssW >= 2 && cssH >= 2)) return; // window not laid out yet (e.g. hidden); try again on the next resize
    const scale = Math.min(dpr, 1.5) * this.renderScale;
    const w = Math.max(1, Math.round(cssW * scale));
    const h = Math.max(1, Math.round(cssH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.aspect = cssW / cssH;
    const base = 320;
    const sw = this.aspect >= 1 ? base : Math.max(96, Math.round(base * this.aspect));
    const sh = this.aspect >= 1 ? Math.max(96, Math.round(base / this.aspect)) : base;
    if (sw !== this.simW || sh !== this.simH) this.allocate(sw, sh);
  }

  allocate(w, h) {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    for (const f of this.fbos) gl.deleteFramebuffer(f);
    this.textures = [];
    this.fbos = [];
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.textures.push(t);
      this.fbos.push(f);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this.ok = false;
      throw new Error('Liquid simulation buffer is not supported on this device.');
    }
    this.simW = w;
    this.simH = h;
    this.cur = 0;
    this.clear();
  }

  /** Flatten the surface instantly (used by Reset). */
  clear() {
    const gl = this.gl;
    for (const f of this.fbos) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.dropCount = 0;
  }

  /**
   * Queue a disturbance for the next simulation step.
   * x, y: uv (0..1, y up) · radius: in screen-height units · strength: height
   * (negative pushes the surface in) · dir/stretch: elongate along motion.
   */
  addDrop(x, y, radius, strength, dx = 0, dy = 0, stretch = 0) {
    if (this.dropCount >= MAX_DROPS) return;
    const i = this.dropCount++ * 4;
    this.drops[i] = x; this.drops[i + 1] = y; this.drops[i + 2] = radius; this.drops[i + 3] = strength;
    this.dirs[i] = dx; this.dirs[i + 1] = dy; this.dirs[i + 2] = stretch; this.dirs[i + 3] = 0;
  }

  /** Advance the wave simulation `steps` times; queued drops apply on the first step. */
  step(steps, damping, restore) {
    if (!this.ok || !this.simW) return;
    const gl = this.gl;
    const { p, u } = this.sim;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.simW, this.simH);
    gl.uniform2f(u.uTexel, 1 / this.simW, 1 / this.simH);
    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniform1f(u.uDamping, damping);
    gl.uniform1f(u.uRestore, restore);
    gl.uniform4fv(u.uDrops, this.drops);
    gl.uniform4fv(u.uDirs, this.dirs);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.uState, 0);
    for (let s = 0; s < steps; s++) {
      gl.uniform1i(u.uDropCount, s === 0 ? this.dropCount : 0);
      const next = 1 - this.cur;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[next]);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[this.cur]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.cur = next;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.dropCount = 0;
  }

  /**
   * Copy the newest camera frame into the reusable video texture. Allocates
   * only when the camera resolution changes; otherwise updates in place.
   */
  updateVideo(video) {
    if (!this.ok || !video || video.readyState < 2 || !video.videoWidth) return false;
    if (video.currentTime === this.lastVideoTime) return true;
    this.lastVideoTime = video.currentTime;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try {
      if (video.videoWidth !== this.videoW || video.videoHeight !== this.videoH) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        this.videoW = video.videoWidth;
        this.videoH = video.videoHeight;
        this.videoAspect = this.videoW / this.videoH;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
      }
    } catch (e) {
      return false;
    }
    return true;
  }

  /**
   * Cover-crop scale for the camera on this canvas: the fraction of the video
   * visible horizontally (kx) and vertically (ky). Shared with fingertip mapping.
   */
  coverScale(videoAspect = this.videoAspect) {
    const A = this.aspect, V = videoAspect || 4 / 3;
    return V > A ? { kx: A / V, ky: 1 } : { kx: 1, ky: V / A };
  }

  /** Draw the surface. `m` holds the material + interaction uniforms. */
  render(time, m) {
    if (!this.ok || !this.simW) return;
    const gl = this.gl;
    const { p, u } = this.draw;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[this.cur]);
    gl.uniform1i(u.uState, 0);
    gl.uniform2f(u.uSimTexel, 1 / this.simW, 1 / this.simH);
    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniform1f(u.uTime, time);
    gl.uniform3fv(u.uCol, m.colors);
    gl.uniform4fv(u.uMat, m.mat);
    gl.uniform4fv(u.uMat2, m.mat2);
    gl.uniform4fv(u.uContact, m.contact);
    gl.uniform4fv(u.uPullAB, m.pullAB);
    gl.uniform1f(u.uPull, m.pull);
    gl.uniform3fv(u.uGlow, m.glow);
    // live camera: mirrored, y-flipped and cover-cropped into texture space
    const { kx, ky } = this.coverScale();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(u.uVideo, 1);
    gl.uniform4f(u.uVideoMap, -kx, -ky, 0.5 + 0.5 * kx, 0.5 + 0.5 * ky);
    gl.uniform1f(u.uCam, m.cam);
    gl.uniform4fv(u.uTint, m.tint);
    gl.uniform4fv(u.uIrid, m.irid);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    for (const t of this.textures) gl.deleteTexture(t);
    for (const f of this.fbos) gl.deleteFramebuffer(f);
    if (this.sim) gl.deleteProgram(this.sim.p);
    if (this.draw) gl.deleteProgram(this.draw.p);
    if (this.quad) gl.deleteBuffer(this.quad);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.videoTex) gl.deleteTexture(this.videoTex);
    this.videoTex = null;
    this.textures = [];
    this.fbos = [];
    this.ok = false;
  }
}
