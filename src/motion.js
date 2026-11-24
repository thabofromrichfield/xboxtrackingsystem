/**
 * Motion analysis — a dependency-free, always-available presence sensor.
 *
 * Runs on a tiny 96x72 grayscale proxy frame: an exponential-moving-average
 * background model absorbs slow lighting changes, and per-pixel residual
 * energy gives us (a) a change ratio, (b) a coarse blob list and (c) a
 * bounding box around the moving region. This is what still flags someone
 * "even if it's just detection by camera" when the pose model cannot load
 * (old phone, no WebGL, offline CDN) or the person is only partially in frame.
 */

export class MotionDetector {
  constructor({ cols = 96, rows = 72, diffFloor = 22, alpha = 0.045 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.diffFloor = diffFloor;
    this.alpha = alpha;
    this.canvas = document.createElement('canvas');
    this.canvas.width = cols;
    this.canvas.height = rows;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null; // previous frame (Uint8ClampedArray grayscale)
    this.bg = null; // background model
    this.history = [];
    this.last = this.empty();
  }

  empty(extra = {}) {
    return {
      score: 0,
      changedRatio: 0,
      energy: 0,
      blobs: 0,
      box: null,
      centroid: null,
      motionMass: 0,
      active: false,
      ts: 0,
      ...extra,
    };
  }

  reset() {
    this.prev = null;
    this.bg = null;
    this.history = [];
    this.last = this.empty();
  }

  /**
   * @param {HTMLVideoElement} video  live frame source
   * @param {{threshold:number}} opts motion_threshold from the camera record
   */
  process(video, opts = { threshold: 0.014 }) {
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if (!vw || !vh || video.readyState < 2) return this.last;

    let gray;
    try {
      this.ctx.drawImage(video, 0, 0, this.cols, this.rows);
      const img = this.ctx.getImageData(0, 0, this.cols, this.rows);
      gray = luma(img.data);
    } catch {
      return this.last; // tainted canvas / decode hiccup
    }

    const n = this.cols * this.rows;
    if (!this.bg) {
      this.bg = gray.slice();
      this.prev = gray;
      return this.last;
    }

    const mask = new Uint8Array(n);
    let changed = 0;
    let energy = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = this.cols;
    let minY = this.rows;
    let maxX = -1;
    let maxY = -1;

    for (let i = 0; i < n; i += 1) {
      const bgv = this.bg[i];
      const d = Math.abs(gray[i] - bgv);
      // absorb slow change into the background, faster where motion lives
      this.bg[i] = mask[i] ? bgv * 0.5 + gray[i] * 0.5 : bgv * (1 - this.alpha) + gray[i] * this.alpha;
      if (d > this.diffFloor) {
        // also require frame-to-frame change so static clutter never trips it
        const dd = Math.abs(gray[i] - this.prev[i]);
        if (dd > this.diffFloor * 0.55) {
          mask[i] = 1;
          changed += 1;
          energy += d;
          const x = i % this.cols;
          const y = (i / this.cols) | 0;
          sumX += x;
          sumY += y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    // second pass: background adaptation for flagged cells
    for (let i = 0; i < n; i += 1) {
      if (mask[i]) this.bg[i] = this.bg[i] * 0.5 + gray[i] * 0.5;
    }
    this.prev = gray;

    const changedRatio = changed / n;
    const score = Math.max(0, Math.min(1, changedRatio / 0.16));
    const blobs = changed > 6 ? countBlobs(mask, this.cols, this.rows) : 0;
    const box =
      changed > 4
        ? {
            x: minX / this.cols,
            y: minY / this.rows,
            w: (maxX - minX + 1) / this.cols,
            h: (maxY - minY + 1) / this.rows,
          }
        : null;

    const state = this.empty({
      changedRatio,
      score,
      energy: energy / Math.max(1, changed),
      blobs,
      box,
      centroid: changed ? { x: sumX / changed / this.cols, y: sumY / changed / this.rows } : null,
      motionMass: changed,
      ts: performance.now(),
    });

    // temporal smoothing: median of the last 5 samples kills single-frame noise
    this.history.push(state);
    if (this.history.length > 5) this.history.shift();
    const sorted = this.history.map((s) => s.changedRatio).sort((a, b) => a - b);
    const med = sorted[(sorted.length / 2) | 0] ?? 0;
    state.smoothedRatio = med;
    state.active = med > (opts.threshold ?? 0.014);
    this.last = state;
    return state;
  }
}

function luma(rgba) {
  const out = new Uint8Array(rgba.length >> 2);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
    out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return out;
}

/** Flood fill on the coarse grid to count separate moving regions. */
function countBlobs(mask, cols, rows) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let blobs = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const idx = stack[--top];
      size += 1;
      const x = idx % cols;
      const y = (idx / cols) | 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack[top++] = ni;
          }
        }
      }
    }
    if (size >= 5) blobs += 1; // ignore specks
  }
  return blobs;
}
