/**
 * Canvas overlay shared by the camera node and the control center.
 * Coordinates are always normalised 0..1 in *unmirrored* video space, which is
 * exactly what we persist in Supabase, so an evidence frame and its skeleton
 * always line up no matter which device draws them.
 */

import { POSE_CONNECTIONS, STROKE, GROUPS } from './skeleton.js';

/**
 * Map a video frame that is painted with `object-fit: cover` onto its CSS box,
 * so the overlay lands on the visible pixels instead of the letterbox area.
 */
export function coverMap(videoW, videoH, cssW, cssH) {
  if (!videoW || !videoH) return { scale: 1, ox: 0, oy: 0, dw: cssW, dh: cssH };
  const scale = Math.max(cssW / videoW, cssH / videoH);
  const dw = videoW * scale;
  const dh = videoH * scale;
  return { scale, ox: (cssW - dw) / 2, oy: (cssH - dh) / 2, dw, dh };
}

export function sizeCanvas(canvas, cssW, cssH) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const PALETTE = {
  person: '#22ff88',
  motion: '#ffc531',
  clear: '#5eead4',
  danger: '#ff3b5c',
  ink: '#e8f1ff',
  dim: 'rgba(8,12,18,0.62)',
};

/**
 * @param ctx       sized 2d context in CSS pixels
 * @param geom      {videoW, videoH, cssW, cssH}
 * @param frame     {poses:[{pts|landmarks, box, score}], motion, state, armed, hud}
 */
export function drawOverlay(ctx, geom, frame) {
  const { cssW, cssH } = geom;
  ctx.clearRect(0, 0, cssW, cssH);
  const map = coverMap(geom.videoW, geom.videoH, cssW, cssH);
  const px = (x, y) => [map.ox + x * map.dw, map.oy + y * map.dh];

  const motion = frame.motion;
  if (motion && motion.box && motion.active) {
    const [bx, by] = px(motion.box.x, motion.box.y);
    const bw = motion.box.w * map.dw;
    const bh = motion.box.h * map.dh;
    ctx.save();
    ctx.strokeStyle = PALETTE.motion;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 6]);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,197,49,0.10)';
    ctx.fillRect(bx, by, bw, bh);
    label(ctx, bx, by - 20, `MOTION ${(motion.smoothedRatio ?? motion.changedRatio ?? 0).toFixed(3)}`, PALETTE.motion);
    ctx.restore();
  }

  const poses = frame.poses || [];
  poses.forEach((pose, idx) => {
    const pts = pose.pts || pose.landmarks || [];
    if (pose.box) {
      const [bx, by] = px(pose.box.x, pose.box.y);
      const bw = pose.box.w * map.dw;
      const bh = pose.box.h * map.dh;
      ctx.save();
      ctx.strokeStyle = PALETTE.person;
      ctx.lineWidth = 2;
      corners(ctx, bx, by, bw, bh, Math.min(26, Math.max(12, bw * 0.22)));
      ctx.restore();
      label(
        ctx,
        bx,
        by - 22,
        `PERSON ${idx + 1} · ${Math.round((pose.score ?? 0) * 100)}%`,
        PALETTE.person
      );
    }
    if (pts.length >= 11) drawSkeleton(ctx, pts, px, 1);
  });

  if (frame.hud && frame.hud.length) {
    drawHud(ctx, cssW, cssH, frame.hud);
  }
}

function drawSkeleton(ctx, pts, px, alpha = 1) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [a, b] of POSE_CONNECTIONS) {
    const pa = pts[a];
    const pb = pts[b];
    if (!pa || !pb) continue;
    const visA = pa.visibility ?? pa[2] ?? 1;
    const visB = pb.visibility ?? pb[2] ?? 1;
    if (Math.min(visA, visB) < 0.32) continue;
    const [x1, y1] = px(pa.x ?? pa[0], pa.y ?? pa[1]);
    const [x2, y2] = px(pb.x ?? pb[0], pb.y ?? pb[1]);
    const group = GROUPS.head.includes(a) ? 'head' : GROUPS.leftArm.includes(a) || GROUPS.rightArm.includes(a) ? 'arm' : GROUPS.torso.includes(a) ? 'torso' : 'leg';
    ctx.globalAlpha = alpha * Math.min(1, Math.max(visA, visB) + 0.15);
    ctx.strokeStyle = STROKE[group] || PALETTE.person;
    ctx.lineWidth = 2.6;
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    if (!p) continue;
    const v = p.visibility ?? p[2] ?? 1;
    if (v < 0.32) continue;
    const [x, y] = px(p.x ?? p[0], p.y ?? p[1]);
    ctx.globalAlpha = alpha * Math.min(1, v + 0.2);
    ctx.fillStyle = i < 11 ? '#ffffff' : PALETTE.person;
    ctx.beginPath();
    ctx.arc(x, y, i === 0 ? 4 : 2.7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Skeleton-only painter for evidence frames on the dashboard. */
export function drawEvidence(canvas, poses, { videoW = 1280, videoH = 720 } = {}) {
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  const ctx = sizeCanvas(canvas, cssW, cssH);
  ctx.clearRect(0, 0, cssW, cssH);
  const px = (x, y) => [x * cssW, y * cssH];
  (poses || []).forEach((pose) => {
    const pts = pose.pts || pose.landmarks || [];
    if (pts.length >= 11) drawSkeleton(ctx, pts, px, 0.95);
    if (pose.box) {
      ctx.strokeStyle = PALETTE.person;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(pose.box.x * cssW, pose.box.y * cssH, pose.box.w * cssW, pose.box.h * cssH);
    }
  });
}

function corners(ctx, x, y, w, h, len) {
  ctx.beginPath();
  ctx.moveTo(x, y + len);
  ctx.lineTo(x, y);
  ctx.lineTo(x + len, y);
  ctx.moveTo(x + w - len, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + len);
  ctx.moveTo(x + w, y + h - len);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w - len, y + h);
  ctx.moveTo(x + len, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + h - len);
  ctx.stroke();
}

function label(ctx, x, y, text, color) {
  ctx.save();
  ctx.font = '600 11px ui-monospace, "SF Mono", Menlo, monospace';
  const w = ctx.measureText(text).width + 12;
  const h = 17;
  const yy = y < 4 ? y + 26 : y;
  ctx.fillStyle = PALETTE.dim;
  roundRect(ctx, x, yy - h + 3, w, h, 3);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x, yy - h + 3, 3, h, 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.ink;
  ctx.fillText(text, x + 8, yy - 2);
  ctx.restore();
}

function drawHud(ctx, cssW, cssH, lines) {
  ctx.save();
  ctx.font = '600 10px ui-monospace, "SF Mono", Menlo, monospace';
  const w = Math.min(230, cssW - 16);
  const h = 14 * lines.length + 14;
  const x = 8;
  const y = cssH - h - 8;
  ctx.fillStyle = PALETTE.dim;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? PALETTE.ink : 'rgba(232,241,255,0.72)';
    ctx.fillText(String(line), x + 10, y + 17 + i * 14, w - 20);
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Frame grabber for evidence uploads — raw pixels, no overlay baked in. */
export async function grabFrame(video, { width = 720, quality = 0.62 } = {}) {
  if (!video.videoWidth) return null;
  const scale = Math.min(1, width / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) return null;
  return { blob, width: canvas.width, height: canvas.height, bytes: blob.size };
}

export { PALETTE };
