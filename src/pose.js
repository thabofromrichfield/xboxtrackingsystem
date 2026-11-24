/**
 * Person (skeleton) detection via MediaPipe Tasks Vision — PoseLandmarker.
 *
 * The library and the .task model are pulled from public CDNs at runtime, so the
 * app ships with no build step and no vendored weights. Every network step is
 * guarded: if nothing can be loaded, `PoseEngine.status` explains why and the
 * camera node keeps running on the motion-only engine.
 */

const VERSIONS = [
  {
    tag: '0.10.14',
    module: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  },
  {
    tag: '0.10.14',
    module: 'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    wasm: 'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm',
  },
  {
    tag: '0.10.33',
    module: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.33/vision_bundle.mjs',
    wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.33/wasm',
  },
];

const MODEL_ASSET = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
export const MODELS = {
  lite: `${MODEL_ASSET}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  full: `${MODEL_ASSET}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  heavy: `${MODEL_ASSET}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
};

export class PoseEngine {
  constructor({ numPoses = 3, model = 'lite', minConfidence = 0.4, onLog = () => {} } = {}) {
    this.numPoses = numPoses;
    this.model = MODELS[model] ? model : 'lite';
    this.minConfidence = minConfidence;
    this.onLog = onLog;
    this.landmarker = null;
    this.ready = false;
    this.status = 'idle'; // idle | loading | ready | unavailable
    this.detail = '';
    this.engineLabel = '—';
    this.lastTs = 0;
    this.initPromise = null;
  }

  static hasWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  /** Load library + model once. Safe to await repeatedly. */
  init() {
    if (!this.initPromise) this.initPromise = this.#boot().catch((err) => this.#fail(err));
    return this.initPromise;
  }

  async #boot() {
    if (!PoseEngine.hasWebGL()) {
      this.#fail(new Error('this browser has no WebGL — MediaPipe GPU/CPU inference is unavailable'));
      return null;
    }
    this.status = 'loading';
    this.detail = 'loading pose runtime…';
    let vision = null;
    let PoseLandmarker = null;
    let used = null;

    for (const v of VERSIONS) {
      try {
        this.detail = `loading tasks-vision ${v.tag} (${new URL(v.module).host})…`;
        const mod = await withTimeout(import(/* webpackIgnore: true */ v.module), 25000, 'module import');
        if (!mod || !mod.PoseLandmarker || !mod.FilesetResolver) throw new Error('unexpected module shape');
        PoseLandmarker = mod.PoseLandmarker;
        vision = await withTimeout(mod.FilesetResolver.forVisionTasks(v.wasm), 30000, 'wasm files');
        used = v;
        break;
      } catch (err) {
        this.onLog(`pose runtime ${v.tag}: ${short(err)}`);
      }
    }
    if (!vision || !PoseLandmarker || !used) throw new Error('could not load the MediaPipe pose runtime from any CDN');

    const modelUrl = MODELS[this.model];
    this.detail = `downloading ${this.model} pose model…`;
    let landmarker = null;
    for (const delegate of ['GPU', 'CPU']) {
      try {
        landmarker = await withTimeout(
          PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: modelUrl, delegate },
            runningMode: 'VIDEO',
            numPoses: this.numPoses,
            minPoseDetectionConfidence: this.minConfidence,
            minPosePresenceConfidence: this.minConfidence,
            minTrackingConfidence: Math.min(0.5, this.minConfidence),
          }),
          delegate === 'GPU' ? 60000 : 90000,
          `${delegate} landmarker`
        );
        this.engineLabel = `MediaPipe PoseLandmarker · ${this.model} · ${delegate}`;
        break;
      } catch (err) {
        this.onLog(`${delegate} delegate failed: ${short(err)}`);
      }
    }
    if (!landmarker) throw new Error('pose model failed to load (GPU and CPU delegates)');

    this.landmarker = landmarker;
    this.ready = true;
    this.status = 'ready';
    this.detail = `${this.model} model active · ${used.tag}`;
    this.onLog(`pose engine ready — ${this.engineLabel}`);
    return landmarker;
  }

  #fail(err) {
    this.ready = false;
    this.status = 'unavailable';
    this.detail = short(err);
    this.onLog(`pose engine unavailable: ${short(err)}`);
    return null;
  }

  /**
   * @returns {{poses: Array<{landmarks:object[], worldLandmarks:object[], box:object, score:number}>, ms:number}|null}
   */
  detect(video, opts = {}) {
    if (!this.ready || !this.landmarker) return null;
    if (!video.videoWidth || video.readyState < 2) return null;
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 1; // must strictly increase
    this.lastTs = ts;
    const t0 = performance.now();
    let result;
    try {
      result = this.landmarker.detectForVideo(video, ts);
    } catch (err) {
      this.onLog(`detect() failed: ${short(err)}`);
      this.ready = false;
      this.status = 'unavailable';
      this.detail = short(err);
      return null;
    }
    const ms = performance.now() - t0;
    const list = (result && result.landmarks) || [];
    const world = (result && result.worldLandmarks) || [];
    const poses = list.map((landmarks, i) => ({
      landmarks,
      worldLandmarks: world[i] || [],
      box: boxOf(landmarks),
      score: opts.score ? opts.score(landmarks) : 0.9,
    }));
    return { poses, ms };
  }

  close() {
    try {
      this.landmarker && this.landmarker.close();
    } catch {
      /* ignore */
    }
    this.landmarker = null;
    this.ready = false;
    this.status = 'idle';
    this.initPromise = null;
  }
}

function boxOf(landmarks) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let seen = 0;
  for (const p of landmarks || []) {
    if ((p.visibility ?? 1) < 0.4) continue;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    seen += 1;
  }
  if (seen < 4) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function short(err) {
  const m = String((err && err.message) || err || 'unknown error');
  return m.replace(/^Error:\s*/, '').slice(0, 180);
}
