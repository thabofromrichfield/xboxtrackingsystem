/**
 * BlazePose / MediaPipe 33-landmark skeleton topology used for the overlay and
 * for the vector data stored in `xbox_detection_events.skeleton`.
 */

export const LANDMARK_NAMES = [
  'nose', 'left eye inner', 'left eye', 'left eye outer', 'right eye inner', 'right eye', 'right eye outer',
  'left ear', 'right ear', 'mouth left', 'mouth right', 'left shoulder', 'right shoulder', 'left elbow',
  'right elbow', 'left wrist', 'right wrist', 'left pinky', 'right pinky', 'left index', 'right index',
  'left thumb', 'right thumb', 'left hip', 'right hip', 'left knee', 'right knee', 'left ankle', 'right ankle',
  'left heel', 'right heel', 'left foot index', 'right foot index',
];

/** Pairs of landmark indices that form the visible skeleton. */
export const POSE_CONNECTIONS = [
  // head
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  // torso
  [11, 12], [11, 23], [12, 24], [23, 24],
  // left arm
  [11, 13], [13, 15], [15, 17], [17, 19], [15, 19],
  // right arm
  [12, 14], [14, 16], [16, 18], [18, 20], [16, 20],
  // left leg
  [23, 25], [25, 27], [27, 29], [29, 31], [31, 27],
  // right leg
  [24, 26], [26, 28], [28, 30], [30, 32], [32, 28],
  // pelvis/shoulder girdle tie-ins
  [27, 28],
];

/** Landmarks that matter for "is there a person" confidence (upper body). */
export const CORE_LANDMARKS = [0, 5, 6, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26];

/** Limb groups get their own colour so the skeleton reads clearly on video. */
export const GROUPS = {
  head: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  leftArm: [11, 13, 15, 17, 19],
  rightArm: [12, 14, 16, 18, 20],
  torso: [11, 12, 23, 24],
  leftLeg: [23, 25, 27, 29, 31],
  rightLeg: [24, 26, 28, 30, 32],
};

export function groupOf(i) {
  if (GROUPS.head.includes(i)) return 'head';
  if (GROUPS.leftArm.includes(i) || GROUPS.rightArm.includes(i)) return 'arm';
  if (GROUPS.torso.includes(i)) return 'torso';
  return 'leg';
}

export const STROKE = {
  head: '#7dd3ff',
  arm: '#22ff88',
  torso: '#c8ff2e',
  leg: '#22ff88',
};

/** Landmarks from MediaPipe ({x,y,z,visibility}) -> compact [x, y, vis] triples. */
export function packLandmarks(landmarks, digits = 4) {
  const f = 10 ** digits;
  return (landmarks || []).map((p) => [
    Math.round(clamp01(p.x) * f) / f,
    Math.round(clamp01(p.y) * f) / f,
    Math.round(clamp01(p.visibility ?? p.score ?? 1) * f) / f,
  ]);
}

export function unpackPose(packedPts) {
  return (packedPts || []).map((t) => ({ x: t[0], y: t[1], visibility: t[2] }));
}

export function boxFromLandmarks(landmarks) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let seen = 0;
  for (const p of landmarks || []) {
    if ((p.visibility ?? 1) < 0.35) continue;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    seen += 1;
  }
  if (seen < 3) return null;
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/** Mean visibility over the core landmarks -> a usable 0..1 confidence proxy. */
export function coreConfidence(landmarks) {
  const vals = CORE_LANDMARKS.map((i) => landmarks && landmarks[i]).filter(Boolean);
  if (!vals.length) return 0;
  const good = vals.filter((p) => (p.visibility ?? 1) > 0.5);
  if (!good.length) return 0;
  const spread = boxFromLandmarks(landmarks);
  const sizeBias = spread ? clamp01(Math.sqrt(spread.w * spread.h) / 0.32) : 0;
  const vis = good.reduce((a, p) => a + (p.visibility ?? 1), 0) / good.length;
  return clamp01(vis * (0.55 + 0.45 * Math.max(sizeBias, 0.35)));
}

/** Serialise detections into the jsonb shape stored in Supabase. */
export function packSkeleton(poses) {
  return {
    v: 1,
    model: 'blazepose33',
    poses: (poses || []).map((p) => ({
      score: round(p.score, 3),
      box: p.box ? { x: round(p.box.x, 4), y: round(p.box.y, 4), w: round(p.box.w, 4), h: round(p.box.h, 4) } : null,
      pts: packLandmarks(p.landmarks),
    })),
  };
}

export function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

export function round(v, digits = 3) {
  const f = 10 ** digits;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * f) / f : null;
}
