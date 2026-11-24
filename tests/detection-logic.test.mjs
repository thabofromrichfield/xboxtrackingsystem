/**
 * Logic tests for the parts of the detection pipeline that are DOM-free:
 * the alert state machine (src/watcher.js) and skeleton serialisation
 * (src/skeleton.js).
 *
 * The app ships as build-less ES modules, so these files have no package.json
 * "type" to lean on — we therefore load them as data: URLs. `node --test` runs
 * this with zero dependencies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

async function loadSrc(name) {
  const code = await readFile(join(here, '..', 'src', name), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const { Watcher, EV } = await loadSrc('watcher.js');
const { XboxApi } = await loadSrc('supabase.js');
const { packLandmarks, packSkeleton, boxFromLandmarks, coreConfidence, POSE_CONNECTIONS } = await loadSrc('skeleton.js');

const sig = (over = {}) => ({
  personCount: 0,
  confidence: 0,
  box: null,
  motion: false,
  motionScore: 0,
  ...over,
});

function figure() {
  return Array.from({ length: 33 }, (_, i) => ({ x: 0.4 + (i % 5) * 0.02, y: 0.2 + (i % 11) * 0.05, z: 0, visibility: 0.95 }));
}

test('motion alone escalates to a motion alert after the debounce window', () => {
  const w = new Watcher({ cooldownSeconds: 25 });
  let out = w.observe(0, sig({ motion: true, motionScore: 0.03 }));
  assert.equal(out.alert, null, 'first motion frame must not alert yet');
  out = w.observe(100, sig({ motion: true, motionScore: 0.031 }));
  assert.equal(out.alert.event_type, EV.MOTION);
  assert.equal(out.state, 'motion');
  assert.equal(out.alert.is_alert, true);
});

test('a confident skeleton immediately alerts as a person', () => {
  const w = new Watcher({ sensitivity: 0.45 });
  const r = w.observe(0, sig({ personCount: 1, confidence: 0.9, box: { x: 0.3, y: 0.1, w: 0.4, h: 0.8 } }));
  assert.equal(r.alert.event_type, EV.PERSON);
  assert.equal(r.state, 'person');
  assert.equal(r.alert.person_count, 1);
});

test('person plus strong motion is reported as the priority event type', () => {
  const w = new Watcher({ sensitivity: 0.45, motionThreshold: 0.01 });
  const r = w.observe(0, sig({ personCount: 2, confidence: 0.91, motion: true, motionScore: 0.09, box: { x: 0.2, y: 0.1, w: 0.5, h: 0.8 } }));
  assert.equal(r.alert.event_type, EV.PERSON_MOTION);
});

test('low-confidence blobs below the gate are ignored', () => {
  const w = new Watcher({ sensitivity: 0.6 });
  for (let t = 0; t < 500; t += 100) {
    const r = w.observe(t, sig({ personCount: 1, confidence: 0.3, box: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } }));
    assert.equal(r.alert, null);
  }
  assert.equal(w.state, 'clear');
});

test('a person staying in frame re-alerts once per cooldown, then clears on exit', () => {
  const w = new Watcher({ sensitivity: 0.4, cooldownSeconds: 10 });
  const present = sig({ personCount: 1, confidence: 0.8, box: { x: 0.3, y: 0.1, w: 0.4, h: 0.8 } });
  assert.equal(w.observe(0, present).alert.event_type, EV.PERSON, 'entry');
  assert.equal(w.observe(5000, present).alert, null, 'cooldown suppresses duplicate');
  assert.equal(w.observe(11000, present).alert.event_type, EV.PERSON, 're-alert after cooldown');
  assert.equal(w.observe(11500, present).alert, null, 'still cooling down');

  let out = null;
  for (let i = 1; i <= 10 && !out; i += 1) out = w.observe(12000 + i * 50, sig()).alert;
  assert.ok(out, 'leaving the frame must emit an event');
  assert.equal(out.event_type, EV.GONE);
  assert.equal(w.state, 'clear');
});

test('disarmed nodes detect but never alert', () => {
  const w = new Watcher({ sensitivity: 0.4, armed: false });
  const r = w.observe(0, sig({ personCount: 1, confidence: 0.95, box: { x: 0.3, y: 0.1, w: 0.4, h: 0.8 } }));
  assert.equal(w.state, 'person', 'detection still tracked while disarmed');
  assert.equal(r.alert.is_alert, false, 'but not flagged as an alert');
});

test('configure() lets the control center retune a live node', () => {
  const w = new Watcher({ sensitivity: 0.4 });
  w.configure({ sensitivity: 0.95, cooldownSeconds: 0 });
  const r = w.observe(0, sig({ personCount: 1, confidence: 0.6, box: { x: 0.1, y: 0.1, w: 0.6, h: 0.7 } }));
  assert.equal(r.alert, null, 'now above the 0.95 gate requirement... should not alert');
  w.configure({ sensitivity: 0.2 });
  assert.equal(w.observe(10, sig({ personCount: 1, confidence: 0.6, box: { x: 0.1, y: 0.1, w: 0.6, h: 0.7 } })).alert.event_type, EV.PERSON);
});

test('transient single-frame noise never enters an alert state', () => {
  const w = new Watcher({ motionThreshold: 0.01 });
  const quiet = sig();
  assert.equal(w.observe(0, sig({ motion: true, motionScore: 0.4 })).alert, null);
  for (let t = 100; t < 1000; t += 100) assert.equal(w.observe(t, quiet).alert, null);
  assert.equal(w.state, 'clear');
});

test('skeleton packing round-trips into the compact jsonb shape', () => {
  const pts = figure();
  const packed = packLandmarks(pts);
  assert.equal(packed.length, 33);
  assert.equal(packed[0].length, 3);
  assert.ok(packed[0][0] >= 0 && packed[0][0] <= 1);
  const json = JSON.stringify(packSkeleton([{ landmarks: pts, box: boxFromLandmarks(pts), score: 0.88 }]));
  assert.ok(json.length < 4000, `payload must stay small, was ${json.length} bytes`);
  const parsed = JSON.parse(json);
  assert.equal(parsed.poses[0].pts.length, 33);
  assert.equal(parsed.model, 'blazepose33');
});

test('bbox + confidence derived from landmarks behave on partial bodies', () => {
  const full = figure();
  const box = boxFromLandmarks(full);
  assert.ok(box.w > 0 && box.h > 0);
  assert.ok(coreConfidence(full) > 0.4);
  const blind = full.map((p) => ({ ...p, visibility: 0.1 }));
  assert.equal(coreConfidence(blind), 0, 'all landmarks invisible -> no confidence');
  assert.equal(boxFromLandmarks(blind), null, 'no box from sub-threshold landmarks');
});

test('skeleton topology indices stay inside the 33-landmark range', () => {
  for (const [a, b] of POSE_CONNECTIONS) {
    assert.ok(a >= 0 && a < 33 && b >= 0 && b < 33, `bad connection ${a}-${b}`);
    assert.notEqual(a, b);
  }
  assert.ok(POSE_CONNECTIONS.length >= 30);
});

test('PostgREST RPC response shapes all normalise to the same object', () => {
  const doc = { id: 'abc', label: 'Yard', access_token: 'tok', created: true };
  assert.deepEqual(XboxApi.unwrap([{ xbox_register_camera: doc }], 'xbox_register_camera'), doc, 'scalar-wrapped');
  assert.deepEqual(XboxApi.unwrap([doc], 'xbox_register_camera'), doc, 'row array');
  assert.deepEqual(XboxApi.unwrap(doc, 'xbox_register_camera'), doc, 'bare jsonb');
  assert.deepEqual(XboxApi.unwrap({ xbox_register_camera: doc }, 'xbox_register_camera'), doc, 'bare wrapper');
  assert.equal(XboxApi.unwrap([], 'xbox_heartbeat'), null, 'void rpc');
  assert.equal(XboxApi.unwrap(3, 'xbox_mark_ack'), 3, 'integer rpc passthrough');
});

test('api client builds correct rest/storage urls for this project', () => {
  const api = new XboxApi({ url: 'https://ref.supabase.co/', key: 'sb_publishable_x'.padEnd(24, 'y') });
  assert.equal(api.configured, true);
  assert.equal(api.url, 'https://ref.supabase.co');
  const path = api.snapshotObjectPath('cam-1', 'sess-9');
  assert.match(path, /^xbox\/cam-1\/sess-9\/\d{8}-\d{6}-[0-9a-z]+\.jpg$/);
  assert.equal(
    api.publicUrl(path),
    `https://ref.supabase.co/storage/v1/object/public/xbox-snapshots/${path}`
  );
  const unconfigured = new XboxApi({ url: '', key: '' });
  assert.equal(unconfigured.configured, false);
});

const cfg = await loadSrc('config.js');

test('project URL field accepts everything a human pastes into it', () => {
  const { normalizeUrl, normalizeKey, looksLikeSecretKey } = cfg;
  const want = 'https://gfshxhqzsexpsahnuwkw.supabase.co';
  assert.equal(normalizeUrl(want), want);
  assert.equal(normalizeUrl(want + '/'), want);
  assert.equal(normalizeUrl(want + '/rest/v1/xbox_cameras?select=id'), want);
  assert.equal(normalizeUrl('gfshxhqzsexpsahnuwkw.supabase.co'), want, 'missing scheme');
  assert.equal(normalizeUrl('gfshxhqzsexpsahnuwkw'), want, 'bare project ref');
  assert.equal(normalizeUrl(` "${want}" `), want, 'quotes and padding');
  assert.equal(normalizeUrl('not a url at all'), '', 'junk is rejected, not guessed');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeKey('  eyJabc. def \n'), 'eyJabc.def', 'keys lose padding/whitespace but keep dots');
});

test('a secret key typed into the browser panel is refused', () => {
  const { looksLikeSecretKey } = cfg;
  assert.equal(looksLikeSecretKey('sb_secret_mv7uZabcdefghij'), true);
  const svcJwt = 'eyJhbGciOiJIUzI1NiJ9.' + btoa(JSON.stringify({ role: 'service_role' })).replace(/=+$/, '') + '.sig';
  const anonJwt = 'eyJhbGciOiJIUzI1NiJ9.' + btoa(JSON.stringify({ role: 'anon' })).replace(/=+$/, '') + '.sig';
  assert.equal(looksLikeSecretKey(svcJwt), true, 'service_role JWT detected');
  assert.equal(looksLikeSecretKey(anonJwt), false, 'anon JWT allowed');
  assert.equal(looksLikeSecretKey('sb_publishable_v8sZMpSpydpj'), false);
});

test('backend panel: two blank fields mean the built-in project, not a rejection', () => {
  const { resolveBackendSettings, DEFAULTS } = cfg;
  const r = resolveBackendSettings('', '');
  assert.equal(r.url, DEFAULTS.url);
  assert.equal(r.key, DEFAULTS.key);
  assert.equal(r.usingDefaults, true, 'the panel can say "using defaults" honestly');
  assert.equal(r.urlInvalid, false);
  assert.equal(r.secret, false);
  // whitespace-only pasting behaves exactly like leaving it empty
  assert.deepEqual(resolveBackendSettings('   ', '\n  '), r);
});

test('backend panel: partial or messy input still resolves to a usable link', () => {
  const { resolveBackendSettings, DEFAULTS } = cfg;
  const byRef = resolveBackendSettings('gfshxhqzsexpsahnuwkw', '  sb_publishable_abc123  ');
  assert.equal(byRef.url, DEFAULTS.url, 'bare ref normalises to the canonical origin');
  assert.equal(byRef.key, 'sb_publishable_abc123');
  assert.equal(byRef.usingDefaults, false);
  assert.equal(byRef.urlInvalid, false);
  // only the URL filled in keeps the default key: a half-finished edit is not a dead end
  const restPath = resolveBackendSettings('https://gfshxhqzsexpsahnuwkw.supabase.co/rest/v1/xbox_cameras?select=id', '');
  assert.equal(restPath.url, DEFAULTS.url);
  assert.equal(restPath.key, DEFAULTS.key);
  // another project is accepted, so the panel works for a second/staging backend
  const staging = resolveBackendSettings('https://abcdefghijklmnopqrst.supabase.co', 'sb_publishable_x');
  assert.equal(staging.url, 'https://abcdefghijklmnopqrst.supabase.co');
  assert.equal(staging.urlInvalid, false);
});

test('backend panel: unusable URL and secret key are loud refusals, never silence', () => {
  const { resolveBackendSettings, DEFAULTS } = cfg;
  assert.equal(resolveBackendSettings('my wifi camera', '').urlInvalid, true);
  assert.equal(resolveBackendSettings('not a url at all', 'k').urlInvalid, true, 'no guessing');
  const secret = resolveBackendSettings(DEFAULTS.url, 'sb_secret_mv7uZabcdefghij');
  assert.equal(secret.secret, true);
  assert.equal(secret.urlInvalid, false, 'the secret-key complaint is the clearer one');
});
