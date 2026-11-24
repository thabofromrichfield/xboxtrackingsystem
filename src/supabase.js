/**
 * Xbox Tracking System — Supabase client.
 *
 * Deliberately dependency-free: everything goes through PostgREST / Storage REST
 * with fetch(), so the whole app is a static, build-less bundle. Supabase Realtime
 * is an *optional* enhancement loaded from a CDN at runtime; when it is not
 * available the dashboards fall back to polling.
 */

export const T = {
  cameras: 'xbox_cameras',
  events: 'xbox_detection_events',
};

export class XboxApi {
  constructor({ url, key, bucket }) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.key = key || '';
    this.bucket = bucket || 'xbox-snapshots';
    this.lastError = null;
    this.online = null; // null = unknown, true/false after first successful/failed call
    this._rt = null;
  }

  get configured() {
    return /^https?:\/\//.test(this.url) && this.key.length > 20;
  }

  async req(path, opts = {}) {
    const { method = 'GET', params, body, headers = {}, raw = false, prefer } = opts;
    const u = new URL(this.url + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
      }
    }
    const init = {
      method,
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }),
        ...(prefer ? { prefer } : {}),
        ...headers,
      },
    };
    if (body !== undefined) init.body = raw ? body : JSON.stringify(body);

    let res;
    try {
      res = await fetch(u.toString(), init);
    } catch (err) {
      this.online = false;
      this.lastError = String(err && err.message ? err.message : err);
      throw err;
    }
    this.online = res.status < 500 || res.status === 503;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`${method} ${u.pathname} -> ${res.status} ${txt.slice(0, 240)}`);
      err.status = res.status;
      this.lastError = err.message;
      throw err;
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  /** Invoke a Postgres function. Unwrap single-value scalar results. */
  async rpc(fn, args = {}, { prefer = 'return=representation' } = {}) {
    const out = await this.req(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args, prefer });
    return XboxApi.unwrap(out, fn);
  }

  /**
   * PostgREST answers an RPC either as `[{"fn_name": value}]` (scalar return) or
   * as the row/json document itself, so normalise both shapes here once.
   */
  static unwrap(out, fnName) {
    if (Array.isArray(out)) {
      if (!out.length) return null;
      const first = out[0];
      if (out.length === 1 && first && typeof first === 'object' && !Array.isArray(first)) {
        const keys = Object.keys(first);
        if (keys.length === 1 && (keys[0] === fnName || keys[0].startsWith('xbox'))) return first[keys[0]];
        return first;
      }
      return out;
    }
    if (out && typeof out === 'object' && fnName && out[fnName] !== undefined) return out[fnName];
    return out;
  }

  // ----------------------------------------------------------------- cameras

  /** Create (or idempotently re-claim) a camera node. Returns id + access token. */
  async registerCamera(label, kind = 'mobile', location = null, notes = null) {
    const out = await this.rpc(
      'xbox_register_camera',
      { p_label: label, p_kind: kind, p_location: location, p_notes: notes },
      { prefer: '' }
    );
    if (typeof out === 'string') {
      try {
        return JSON.parse(out);
      } catch {
        throw new Error(`unexpected registration response: ${out.slice(0, 160)}`);
      }
    }
    if (!out || !out.id) throw new Error('registration returned no camera id');
    return out;
  }

  async listCameras() {
    return (
      (await this.req(`/rest/v1/${T.cameras}`, {
        params: { select: '*', order: 'created_at.asc' },
      })) || []
    );
  }

  async getCamera(id) {
    const rows = await this.req(`/rest/v1/${T.cameras}`, {
      params: { select: '*', id: `eq.${id}`, limit: 1 },
    });
    return rows && rows[0] ? rows[0] : null;
  }

  async updateCamera(id, patch) {
    return this.req(`/rest/v1/${T.cameras}`, {
      method: 'PATCH',
      params: { id: `eq.${id}` },
      body: patch,
      prefer: 'return=minimal',
    });
  }

  /** Lightweight liveness ping; also reports engine/fps/persons. */
  async heartbeat(cameraId, { status = 'online', engine = null, fps = null, persons = null } = {}) {
    return this.rpc(
      'xbox_heartbeat',
      {
        p_camera_id: cameraId,
        p_status: status,
        p_engine: engine,
        p_fps: fps,
        p_persons: persons,
      },
      { prefer: '' }
    );
  }

  async sweepStale() {
    return this.rpc('xbox_sweep_stale', {}, { prefer: '' });
  }

  // ------------------------------------------------------------------ events

  async insertEvent(row) {
    return this.req(`/rest/v1/${T.events}`, { method: 'POST', body: row, prefer: 'return=representation' });
  }

  async listEvents({ limit = 60, cameraId = null, after = null, severity = null } = {}) {
    const params = {
      select: '*',
      order: 'created_at.desc,id.desc',
      limit: Math.min(Math.max(Number(limit) || 60, 1), 500),
    };
    if (cameraId) params.camera_id = `eq.${cameraId}`;
    if (after) params.created_at = `gt.${after}`;
    if (severity) params.severity = `in.(${severity})`;
    return (await this.req(`/rest/v1/${T.events}`, { params })) || [];
  }

  async acknowledge(ids, by = 'control-center') {
    return this.rpc('xbox_mark_ack', { p_ids: ids.map(Number), p_by: by }, { prefer: '' });
  }

  async purge(keepDays = 14) {
    return this.rpc('xbox_purge_events', { p_keep_days: keepDays }, { prefer: '' });
  }

  // ---------------------------------------------------------------- storage

  snapshotObjectPath(cameraId, sessionId, ext = 'jpg') {
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(
      d.getUTCMinutes()
    )}${p2(d.getUTCSeconds())}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    return `xbox/${cameraId || 'anonymous'}/${sessionId || 'session'}/${stamp}.${ext}`;
  }

  publicUrl(objectPath) {
    return `${this.url}/storage/v1/object/public/${this.bucket}/${objectPath}`;
  }

  /** Upload an evidence frame. `blob` may be a Blob or a data-URL string. */
  async uploadSnapshot({ cameraId, sessionId, blob, qualityLabel }) {
    let body = blob;
    if (typeof body === 'string' && body.startsWith('data:')) body = dataUrlToBlob(body);
    if (!body || !body.size) throw new Error('empty snapshot');
    const objectPath = this.snapshotObjectPath(cameraId, sessionId);
    const url = `${this.url}/storage/v1/object/${this.bucket}/${objectPath}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        'content-type': body.type || 'image/jpeg',
        'x-upsert': 'false',
        'cache-control': 'max-age=2592000',
      },
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`snapshot upload -> ${res.status} ${txt.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return { path: objectPath, url: this.publicUrl(objectPath), label: qualityLabel || null };
  }

  // ------------------------------------------------------- optional realtime

  /**
   * Try to open a Realtime channel. Returns a handle, or null when the CDN
   * client cannot be loaded / the socket does not subscribe in time — callers
   * should then rely on polling.
   */
  async connectRealtime({ onEvent, onCamera, timeoutMs = 8000 } = {}) {
    if (this._rt) return this._rt;
    const createClient = await loadSupabaseFactory();
    if (!createClient) return null;

    const sb = createClient(this.url, this.key, {
      realtime: { params: { eventsPerSecond: 8 } },
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { apikey: this.key } },
    });
    const channel = sb
      .channel(`xbox-live-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: T.events }, (p) => onEvent && onEvent(p.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: T.cameras }, (p) => onCamera && onCamera(p.new))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: T.cameras }, (p) => onCamera && onCamera(p.new))
      .subscribe();

    const ok = await Promise.race([
      new Promise((resolve) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') resolve(true);
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') resolve(false);
        });
      }),
      sleep(timeoutMs).then(() => false),
    ]);

    if (!ok) {
      try {
        sb.removeChannel(channel);
        sb.dispose();
      } catch {
        /* ignore */
      }
      return null;
    }
    this._rt = { sb, channel, mode: 'realtime' };
    return this._rt;
  }

  async disconnectRealtime() {
    if (!this._rt) return;
    try {
      this._rt.sb.removeChannel(this._rt.channel);
      this._rt.sb.dispose();
    } catch {
      /* ignore */
    }
    this._rt = null;
  }
}

// ------------------------------------------------------------------- helpers

const SUPABASE_CDNS = [
  'https://esm.sh/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  'https://unpkg.com/@supabase/supabase-js@2?module',
];
let factoryPromise = null;

function loadSupabaseFactory() {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      for (const src of SUPABASE_CDNS) {
        try {
          const mod = await import(/* @vite-ignore */ src);
          if (mod && (mod.createClient || (mod.default && mod.default.createClient))) {
            return mod.createClient || mod.default.createClient;
          }
        } catch {
          /* try next CDN */
        }
      }
      return null;
    })().catch(() => null);
  }
  return factoryPromise;
}

export function p2(n) {
  return String(n).padStart(2, '0');
}

export function isoLocal(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(
    d.getSeconds()
  )}`;
}

export function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Human "3m ago" formatting used by both pages. */
export function timeAgo(input, nowTs = Date.now()) {
  if (!input) return 'never';
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((nowTs - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}
