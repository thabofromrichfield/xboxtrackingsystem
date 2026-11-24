/**
 * Xbox Tracking System — runtime configuration.
 *
 * Resolution order (first hit wins):
 *   1. URL query params   (?sbUrl=…&sbKey=…&camera=…&rear=1&autostart=1)
 *   2. localStorage       (saved from the in-app Settings panel)
 *   3. Built-in defaults  (the "xbox system" Supabase project)
 *
 * The publishable (anon) key is safe to ship in a static bundle: it only grants
 * what the Row-Level-Security policies below allow (read + node inserts).
 */

export const DEFAULTS = {
  url: 'https://gfshxhqzsexpsahnuwkw.supabase.co',
  key: 'sb_publishable_v8sZMpSpydpjPuZycL1hDg_X5I0klCh',
  bucket: 'xbox-snapshots',
};

const LS_KEY = 'xbox.config.v2';

export function qsp(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

export function readStored() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

/**
 * Accept whatever a human pastes from the Supabase dashboard and turn it into a
 * bare origin: "REF.supabase.co", "https://ref.supabase.co/rest/v1/", a quoted
 * string, or the 20-char project ref on its own. Returns '' when unusable so
 * callers can show a real error instead of silently failing.
 */
export function normalizeUrl(raw) {
  let s = String(raw ?? '').trim().replace(/^["'<]+|["'>]+$/g, '').replace(/\/+$/, '');
  if (!s) return '';
  if (/^[a-z0-9]{18,24}$/i.test(s)) s = `${s}.supabase.co`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(s);
    const localHost = /^(localhost|127\.)/.test(u.hostname);
    if (!u.hostname.includes('.') && !localHost) return '';
    if (u.protocol === 'https:') return u.origin;
    return localHost ? u.origin : ''; // plain http is only sane for localhost
  } catch {
    return '';
  }
}

/** Keys get whitespace/quote stripped — pasting a JWT often adds both. */
export function normalizeKey(raw) {
  return String(raw ?? '').replace(/^["']+|["']+$/g, '').replace(/\s+/g, '').trim();
}

/** Never let a service_role / sb_secret key end up in a browser bundle. */
export function looksLikeSecretKey(key) {
  const s = normalizeKey(key);
  if (!s) return false;
  if (/^sb_secret_/i.test(s)) return true;
  if (!/^eyJ/i.test(s)) return false;
  try {
    const payload = s.split('.')[1] || '';
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return json && json.role === 'service_role';
  } catch {
    return false;
  }
}

export function loadConfig() {
  const stored = readStored();
  const rawUrl = qsp('sbUrl') || stored.url || DEFAULTS.url;
  const rawKey = qsp('sbKey') || stored.key || DEFAULTS.key;
  const url = normalizeUrl(rawUrl);
  const key = normalizeKey(rawKey);
  const cfg = {
    // An unusable saved value must never brick the app: fall back to the
    // built-in project and say so (dashboard surfaces this as a toast).
    url: url || normalizeUrl(DEFAULTS.url),
    key: key || normalizeKey(DEFAULTS.key),
    urlFallback: !url && rawUrl !== DEFAULTS.url,
    keyFallback: !key && rawKey !== DEFAULTS.key,
    bucket: stored.bucket || DEFAULTS.bucket,
    // node identity
    cameraLabel: qsp('camera') || stored.cameraLabel || '',
    cameraKind: stored.cameraKind || 'mobile',
    cameraLocation: stored.cameraLocation || '',
    cameraId: stored.cameraId || null,
    accessToken: stored.accessToken || null,
    // detection tuning (server values win once synced)
    sensitivity: num(stored.sensitivity, 0.45),
    motionThreshold: num(stored.motionThreshold, 0.014),
    cooldownSeconds: Math.round(num(stored.cooldownSeconds, 25)),
    captureSnapshots: stored.captureSnapshots !== false,
    maxFps: Math.round(num(stored.maxFps, 8)),
    model: stored.model || 'lite',
    showOverlay: stored.showOverlay !== false,
    frontCamera: stored.frontCamera === true,
  };
  return cfg;
}

export function saveConfig(patch) {
  const next = { ...readStored(), ...patch };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — ignore, in-memory config still applies */
  }
  return next;
}

/**
 * Resolve the two Backend-link fields into a decision the UI can act on.
 *
 * Pure (no DOM) so the panel's rules are unit-testable and identical wherever
 * they are used: an empty field means "keep the built-in default for it", a
 * non-empty one must normalise or the panel refuses it, and a secret key is
 * never accepted in a browser.
 */
export function resolveBackendSettings(rawUrl, rawKey, defaults = DEFAULTS) {
  const u = String(rawUrl ?? '').trim();
  const k = String(rawKey ?? '').trim();
  const url = u ? normalizeUrl(u) : defaults.url;
  const key = k ? normalizeKey(k) : defaults.key;
  return {
    url,
    key,
    urlInvalid: Boolean(u) && !url,
    secret: looksLikeSecretKey(k) || looksLikeSecretKey(key),
    usingDefaults: !u && !k,
  };
}

export function clearConfig() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Detect a human-readable device label from the UA, for the alert feed. */
export function deviceLabel() {
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const kind = iOS ? 'iOS' : android ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) && !/Edg\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'web';
  return `${browser}/${kind}`;
}

export function isSecureContextOk() {
  return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}
