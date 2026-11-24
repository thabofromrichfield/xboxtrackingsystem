/**
 * POST /api/event — universal ingest for the Xbox Tracking System.
 *
 * The browser camera node talks to Supabase directly. This endpoint exists for
 * every *other* kind of camera or device: an IP cam + Raspberry Pi, an NVR
 * export, an ESP32-CAM, Home Assistant, a curl one-liner, or the bundled
 * Python bridge. It writes with the service-role key, so the caller only needs
 * the shared ingest token — never a database key.
 *
 *   POST /api/event
 *   x-xbox-token: <XBOX_INGEST_TOKEN or a camera access_token>
 *   { "camera_label": "Back yard", "event_type": "person", "person_count": 1,
 *     "confidence": 0.88, "motion_score": 0.031, "snapshot": "data:image/jpeg;base64,…",
 *     "skeleton": { "poses": [ { "pts": [[x,y,v],…] } ] }, "device": "pi-opencv" }
 *
 * GET /api/event → health probe (used to verify env wiring).
 */

const SB_URL = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const BUCKET = process.env.XBOX_SNAPSHOT_BUCKET || 'xbox-snapshots';
const INGEST_TOKEN = process.env.XBOX_INGEST_TOKEN || '';
const AUTO_REGISTER = String(process.env.XBOX_AUTO_REGISTER ?? 'true') !== 'false';

const EVENT_TYPES = new Set(['person', 'person+motion', 'motion', 'presence-gone', 'info', 'test']);

module.exports = async function handler(req, res) {
  const cors = {
    'access-control-allow-origin': req.headers.origin || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, x-xbox-token, authorization, apikey',
    'access-control-max-age': '600',
  };
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const project = SB_URL.replace(/^https?:\/\//, '').split('.')[0] || null;
  if (req.method === 'GET') {
    res.status(200).json({
      ok: Boolean(SB_URL && SB_KEY),
      service: 'xbox-tracking-ingest',
      project,
      bucket: BUCKET,
      auto_register: AUTO_REGISTER,
      token_required: Boolean(INGEST_TOKEN),
      time: new Date().toISOString(),
    });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'use POST' });
    return;
  }
  if (!SB_URL || !SB_KEY) {
    res.status(500).json({ error: 'ingest not configured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing on Vercel' });
    return;
  }

  let body = req.body;
  if (!body || typeof body !== 'object') {
    const raw = await readRaw(req);
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      res.status(400).json({ error: `invalid JSON body: ${err.message}` });
      return;
    }
  }

  // ---- auth ---------------------------------------------------------------
  const provided = String(req.headers['x-xbox-token'] || body.token || '').trim();
  let camera = null;
  if (INGEST_TOKEN && provided === INGEST_TOKEN) {
    camera = await findCamera(body);
  } else if (provided) {
    camera = await findCameraByToken(provided, body);
    if (!camera) {
      res.status(401).json({ error: 'unknown access token' });
      return;
    }
  } else {
    res.status(401).json({ error: 'missing x-xbox-token' });
    return;
  }

  if (!camera) {
    if (!AUTO_REGISTER) {
      res.status(409).json({ error: 'unknown camera node — register it in the control center first' });
      return;
    }
    const label = String(body.camera_label || body.label || 'unnamed node').slice(0, 80);
    const created = await sb(`/rest/v1/xbox_cameras`, 'POST', {
      label,
      kind: pickKind(body.kind),
      location: str(body.location, 120) || null,
      notes: str(body.device || 'api ingest', 200),
    });
    if (!created.length) {
      res.status(502).json({ error: 'could not register camera node' });
      return;
    }
    camera = created[0];
  }

  // ---- normalize the event ------------------------------------------------
  const type = EVENT_TYPES.has(body.event_type) ? body.event_type : 'person';
  const snapshot = str(body.snapshot, 0);
  let snapshotUrl = str(body.snapshot_url, 500) || null;
  if (!snapshotUrl && snapshot.startsWith('data:image/')) {
    try {
      snapshotUrl = await uploadSnapshot(camera.id, snapshot);
    } catch (err) {
      snapshotUrl = null;
      console.warn('[xbox-ingest] snapshot upload failed:', err.message);
    }
  }

  const row = {
    camera_id: camera.id,
    camera_label: camera.label,
    session_id: str(body.session_id, 64) || 'api',
    event_type: type,
    person_count: clampInt(body.person_count, 0, 32, type === 'motion' ? 0 : 1),
    confidence: clampNum(body.confidence, 0, 1),
    motion_score: clampNum(body.motion_score, 0, 1),
    bbox: jsonOrNull(body.bbox, 4),
    skeleton: jsonOrNull(body.skeleton, 512 * 1024),
    snapshot_url: snapshotUrl,
    engine: str(body.engine, 60) || 'api-ingest',
    fps: clampNum(body.fps, 0, 240),
    device: str(body.device, 200) || `api@${req.headers['user-agent'] || 'unknown'}`.slice(0, 200),
    meta: jsonOrNull(body.meta, 8192) || { via: 'api/event' },
  };

  const inserted = await sb('/rest/v1/xbox_detection_events?select=id,event_type,severity,is_alert,created_at', 'POST', row);
  if (!inserted.length) {
    res.status(502).json({ error: 'event insert failed — see function logs', camera_id: camera.id });
    return;
  }
  res.status(201).json({ ok: true, camera_id: camera.id, event: inserted[0] });
};

// ------------------------------------------------------------------ helpers

async function findCamera(body) {
  if (body.camera_id) {
    const rows = await sb(`/rest/v1/xbox_cameras?select=*&id=eq.${encodeURIComponent(body.camera_id)}&limit=1`, 'GET');
    if (rows[0]) return rows[0];
  }
  const label = str(body.camera_label || body.label, 80);
  if (label) {
    const rows = await sb(
      `/rest/v1/xbox_cameras?select=*&label=eq.${encodeURIComponent(label)}&archived=is.false&order=created_at.asc&limit=1`,
      'GET'
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

async function findCameraByToken(token, body) {
  const rows = await sb(
    `/rest/v1/xbox_cameras?select=*&access_token=eq.${encodeURIComponent(token)}&archived=is.false&limit=1`,
    'GET'
  );
  if (rows[0]) return rows[0];
  const byLabel = await findCamera(body);
  return byLabel && byLabel.access_token === token ? byLabel : null;
}

async function uploadSnapshot(cameraId, dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s/g, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('empty image');
  if (buf.length > 4 * 1024 * 1024) throw new Error('snapshot larger than 4MB');
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const path = `xbox/${cameraId}/api/${stamp}-${Math.random().toString(36).slice(2, 7)}.jpg`;
  const url = `${SB_URL}/storage/v1/object/${BUCKET}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SB_KEY}`,
      apikey: SB_KEY,
      'content-type': 'image/jpeg',
      'x-upsert': 'false',
      'cache-control': 'max-age=2592000',
    },
    body: new Uint8Array(buf),
  });
  if (!res.ok) throw new Error(`storage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

async function sb(path, method, payload) {
  const res = await fetch(SB_URL + path, {
    method,
    headers: {
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json',
      prefer: method === 'POST' ? 'return=representation' : '',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`supabase ${method} ${path.split('?')[0]} -> ${res.status} ${txt.slice(0, 300)}`);
  }
  if (res.status === 204) return [];
  const json = await res.json().catch(() => []);
  return Array.isArray(json) ? json : [json];
}

function readRaw(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return resolve(null);
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 6 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

const KINDS = new Set(['mobile', 'webcam', 'ip-cam', 'rtsp', 'bridge', 'other']);
function pickKind(v) {
  const k = String(v || '').toLowerCase();
  return KINDS.has(k) ? k : 'bridge';
}
function str(v, max) {
  if (v == null) return '';
  const s = String(v);
  return max ? s.slice(0, max) : s;
}
function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(min, Math.min(max, n)) * 1000) / 1000;
}
function jsonOrNull(v, maxChars) {
  if (v == null) return null;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (!s || s === 'null') return null;
    if (maxChars && s.length > maxChars) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    return null;
  }
}
