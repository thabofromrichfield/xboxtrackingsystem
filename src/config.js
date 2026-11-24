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

export function loadConfig() {
  const stored = readStored();
  const cfg = {
    url: qsp('sbUrl') || stored.url || DEFAULTS.url,
    key: qsp('sbKey') || stored.key || DEFAULTS.key,
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
  cfg.url = String(cfg.url || '').replace(/\/+$/, '');
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
