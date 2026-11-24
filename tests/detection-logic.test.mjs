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
