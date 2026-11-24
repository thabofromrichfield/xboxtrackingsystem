/**
 * Xbox Tracking System — CAMERA NODE.
 *
 * Turns any device camera (phone, tablet, laptop webcam, spare Android left on
 * a shelf) into a person-detection sensor:
 *   getUserMedia -> MediaPipe PoseLandmarker (33-point skeleton)
 *                -> + frame-difference motion sensor (works with or without it)
 *                -> Watcher state machine -> Supabase insert + evidence snapshot
 * The control center picks that up live over Realtime and can re-tune or disarm
 * this node remotely, because the camera row is polled for config.
 */

import { loadConfig, saveConfig, clearConfig, deviceLabel, isSecureContextOk } from './config.js';
import { XboxApi, sleep, timeAgo } from './supabase.js';
import { PoseEngine } from './pose.js';
import { MotionDetector } from './motion.js';
import { Watcher, EV } from './watcher.js';
import { drawOverlay, sizeCanvas, grabFrame } from './overlay.js';
import { packSkeleton, coreConfidence } from './skeleton.js';
import { CUES, unlockAudio, vibrate } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const HEARTBEAT_MS = 9000;
const SYNC_MS = 12000;
const FLUSH_MS = 4000;
const MAX_QUEUE = 250;

class CameraNode {
  constructor() {
    this.cfg = loadConfig();
    this.api = new XboxApi(this.cfg);
    this.pose = new PoseEngine({ numPoses: 3, model: this.cfg.model, minConfidence: Math.min(0.55, this.cfg.sensitivity), onLog: (m) => this.log(m, 'warn') });
    this.motion = new MotionDetector();
    this.watcher = new Watcher(this.cfg);
    this.stream = null;
    this.devices = [];
    this.running = false;
    this.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.queue = [];
    this.camera = null;
    this.counters = { alerts: 0, events: 0, dropped: 0, snapshots: 0 };
    this.fps = 0;
    this.lastFrameAt = 0;
    this.frames = 0;
    this.fpsWindow = 0;
    this.poseMs = 0;
    this.wakeLock = null;
    this.timers = {};
    this.raf = 0;
    this.lastSignal = { personCount: 0, confidence: 0, motionScore: 0, box: null };
  }

  // --------------------------------------------------------------------- ui

  init() {
    this.bindControls();
    this.renderConfig();
    this.setStatus('uplink', this.api.configured ? 'ok' : 'off', 'not linked');
    this.log(`node ready — ${deviceLabel()}`);
    this.log(`backend: ${this.api.url || 'NOT CONFIGURED'} · ${this.api.configured ? 'key ' + this.api.key.slice(0, 15) + '…' : 'open the control center ⚙ to set it'}`);
    if (!isSecureContextOk()) {
      this.log('⚠ insecure origin: the camera API only works over HTTPS (or localhost). Deploy to Vercel or use the LAN https tunnel.', 'err');
      $('#banner').hidden = false;
      $('#banner').textContent =
        'Camera blocked: this page is not on a secure origin. Open it over HTTPS (https://xboxsystem.vercel.app/camera) to grant camera access.';
    }
    if (this.cfg.cameraId) this.setStatus('node', 'ok', this.cfg.cameraLabel || 'linked');
    else this.setStatus('node', 'off', 'unregistered');

    // Deep-link autostart (?camera=Back%20Yard&autostart=1) for wall-mounted phones.
    if (qsp('autostart') === '1' && this.cfg.cameraId) setTimeout(() => this.start(), 600);
  }

  bindControls() {
    $('#btnStart').addEventListener('click', () => {
      unlockAudio();
      this.start();
    });
    $('#btnStop').addEventListener('click', () => this.stop('stopped by operator'));
    $('#btnFlip').addEventListener('click', () => {
      this.cfg.frontCamera = !this.cfg.frontCamera;
      saveConfig({ frontCamera: this.cfg.frontCamera });
      $('#stage').classList.toggle('mirrored', this.cfg.frontCamera);
      this.log(`switched to ${this.cfg.frontCamera ? 'front' : 'rear'} camera`);
      if (this.running) this.restartStream();
    });
    $('#selDevice').addEventListener('change', (e) => {
      this.cfg.deviceId = e.target.value || null;
      saveConfig({ deviceId: this.cfg.deviceId });
      if (this.running) this.restartStream();
    });
    $('#selModel').addEventListener('change', (e) => {
      this.cfg.model = e.target.value;
      saveConfig({ model: this.cfg.model });
      this.pose.close();
      this.pose = new PoseEngine({ numPoses: 3, model: this.cfg.model, onLog: (m) => this.log(m, 'warn') });
      this.pose.init().then(() => this.setStatus('engine', 'ok', 'pose ready'));
      this.log(`model set to ${this.cfg.model} — reloading…`);
    });
    $('#chkOverlay').addEventListener('change', (e) => {
      this.cfg.showOverlay = e.target.checked;
      saveConfig({ showOverlay: e.target.checked });
    });
    $('#chkSnap').addEventListener('change', (e) => {
      this.cfg.captureSnapshots = e.target.checked;
      saveConfig({ captureSnapshots: e.target.checked });
      this.pushConfig({ capture_snapshots: e.target.checked });
    });
    $('#chkAwake').addEventListener('change', (e) => (e.target.checked ? this.requestWakeLock() : this.releaseWakeLock()));
    $('#btnTest').addEventListener('click', () => this.testAlert());
    $('#btnFull').addEventListener('click', () => {
      const el = $('#stage');
      if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => this.log('fullscreen refused', 'warn'));
      else document.exitFullscreen?.();
    });
    for (const [id, key, fmt] of [
      ['rngSensitivity', 'sensitivity', (v) => `${Math.round(v * 100)}%`],
      ['rngMotion', 'motionThreshold', (v) => (v * 1000).toFixed(1)],
      ['rngCooldown', 'cooldownSeconds', (v) => `${Math.round(v)}s`],
      ['rngFps', 'maxFps', (v) => `${Math.round(v)} fps`],
    ]) {
      const el = $(`#${id}`);
      el.addEventListener('input', () => {
        const v = Number(el.value);
        this.cfg[key] = key === 'cooldownSeconds' || key === 'maxFps' ? Math.round(v) : v;
        this.watcher.configure(this.cfg);
        $(`#${id}Out`).textContent = fmt(v);
        saveConfig({ [key]: this.cfg[key] });
        clearTimeout(this.timers.pushConfig);
        this.timers.pushConfig = setTimeout(() => {
          const payload =
            key === 'sensitivity'
              ? { sensitivity: v }
              : key === 'motionThreshold'
              ? { motion_threshold: v }
              : key === 'cooldownSeconds'
              ? { cooldown_seconds: Math.round(v) }
              : { max_fps: Math.round(v) };
          this.pushConfig(payload);
        }, 420);
      });
    }
    const save = () => {
      this.cfg.cameraLabel = $('#inpLabel').value.trim() || defaultLabel();
      this.cfg.cameraLocation = $('#inpLocation').value.trim();
      this.cfg.cameraKind = $('#selKind').value;
      saveConfig({ cameraLabel: this.cfg.cameraLabel, cameraLocation: this.cfg.cameraLocation, cameraKind: this.cfg.cameraKind });
      this.renderConfig();
    };
    ['#inpLabel', '#inpLocation', '#selKind'].forEach((sel) => $(sel).addEventListener('change', save));
    $('#btnLink').addEventListener('click', () => this.register(true));
    $('#btnResetLink').addEventListener('click', async () => {
      const before = this.api.url;
      clearConfig();
      this.cfg = loadConfig();
      this.api = new XboxApi(this.cfg);
      this.log(`cleared the locally saved backend (was ${before}) → now using ${this.api.url}`);
      this.setStatus('uplink', this.api.configured ? 'ok' : 'err', this.api.configured ? 'defaults restored' : 'not linked');
      if (this.running) await this.register(true);
    });

    window.addEventListener('pagehide', () => this.stop('page hidden'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.log('backgrounded — iOS/Android suspend camera access here, come back to this tab to resume', 'warn');
        return;
      }
      const dead = !this.stream || this.stream.getVideoTracks().every((t) => t.readyState !== 'live');
      if (this.running && dead) {
        this.log('foregrounded — camera track was dropped, reopening…');
        this.restartStream().then(() => this.heartbeat());
      } else if (this.running) {
        this.log('foregrounded — still live');
        this.motion.reset();
      }
    });
  }

  renderConfig() {
    $('#inpLabel').value = this.cfg.cameraLabel || defaultLabel();
    $('#inpLocation').value = this.cfg.cameraLocation || '';
    $('#selKind').value = this.cfg.cameraKind || 'mobile';
    $('#selModel').value = this.cfg.model;
    $('#rngSensitivity').value = this.cfg.sensitivity;
    $('#rngSensitivityOut').textContent = `${Math.round(this.cfg.sensitivity * 100)}%`;
    $('#rngMotion').value = this.cfg.motionThreshold;
    $('#rngMotionOut').textContent = (this.cfg.motionThreshold * 1000).toFixed(1);
    $('#rngCooldown').value = this.cfg.cooldownSeconds;
    $('#rngCooldownOut').textContent = `${this.cfg.cooldownSeconds}s`;
    $('#rngFps').value = this.cfg.maxFps;
    $('#rngFpsOut').textContent = `${this.cfg.maxFps} fps`;
    $('#chkOverlay').checked = this.cfg.showOverlay !== false;
    $('#chkSnap').checked = this.cfg.captureSnapshots !== false;
    $('#stage').classList.toggle('mirrored', !!this.cfg.frontCamera);
  }

  log(msg, level = 'info') {
    const li = document.createElement('li');
    li.className = `l-${level}`;
    const t = new Date();
    li.innerHTML = `<span class="t">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(
      t.getSeconds()
    ).padStart(2, '0')}</span>${escapeHtml(String(msg))}`;
    const log = $('#log');
    log.prepend(li);
    while (log.children.length > 90) log.lastElementChild.remove();
    console[level === 'err' ? 'error' : 'log'](`[xbox-node] ${msg}`);
  }

  setStatus(id, cls, text) {
    const chip = $(`#st-${id}`);
    if (!chip) return;
    chip.className = `chip ${cls}`;
    chip.querySelector('.dot').nextElementSibling.textContent = text;
  }

  // ------------------------------------------------------------------ start

  async register(announce = false) {
    if (!this.api.configured) {
      this.log('Supabase is not configured — open Settings and paste your project URL + publishable key.', 'err');
      return null;
    }
    try {
      const out = await this.api.registerCamera(this.cfg.cameraLabel, this.cfg.cameraKind, this.cfg.cameraLocation || null, deviceLabel());
      this.cfg.cameraId = out.id;
      this.cfg.accessToken = out.access_token;
      saveConfig({ cameraId: out.id, accessToken: out.access_token, cameraLabel: out.label });
      this.camera = out;
      this.watcher.configure({ armed: out.armed });
      this.setStatus('node', 'ok', out.label);
      this.log(out.created ? `registered new node “${out.label}”` : `linked to existing node “${out.label}”`);
      if (announce) this.flash('#panelNode', 'ok');
      return out;
    } catch (err) {
      this.log(`registration failed: ${err.message}`, 'err');
      this.setStatus('node', 'err', 'link failed');
      return null;
    }
  }

  async listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter((d) => d.kind === 'videoinput');
      const sel = $('#selDevice');
      sel.innerHTML = '<option value="">auto (respect front/rear)</option>';
      this.devices.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Camera ${i + 1}`;
        sel.appendChild(o);
      });
      if (this.cfg.deviceId) sel.value = this.cfg.deviceId;
      this.log(`${this.devices.length} camera device(s) visible`);
    } catch (err) {
      this.log(`device enumeration failed: ${err.message}`, 'warn');
    }
  }

  async start() {
    if (this.running) return;
    $('#btnStart').disabled = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('this browser has no camera API (getUserMedia)');
      await this.openStream();
      await this.register();
      this.running = true;
      $('#app').dataset.running = '1';
      $('#btnStart').disabled = true;
      $('#btnStop').disabled = false;
      this.setStatus('capture', 'ok', 'live');
      this.log('camera streaming — analysing frames');
      this.pose.init().then(() => {
        if (this.pose.ready) {
          this.setStatus('engine', 'ok', 'skeleton ready');
          this.log(`pose engine online — ${this.pose.engineLabel}`);
        } else {
          this.setStatus('engine', 'warn', 'motion-only');
          this.log(`skeleton model unavailable (${this.pose.detail}) — motion engine still armed`, 'warn');
        }
      });
      await this.syncConfig(true);
      this.loop();
      this.timers.heartbeat = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
      this.timers.sync = setInterval(() => this.syncConfig(), SYNC_MS);
      this.timers.flush = setInterval(() => this.flushQueue(), FLUSH_MS);
      this.heartbeat();
    } catch (err) {
      this.running = false;
      $('#btnStart').disabled = false;
      $('#btnStop').disabled = true;
      this.setStatus('capture', 'err', 'failed');
      this.log(describeCamError(err), 'err');
      $('#banner').hidden = false;
      $('#banner').textContent = describeCamError(err);
    }
  }

  async openStream() {
    const want = {
      audio: false,
      video: this.cfg.deviceId
        ? { deviceId: { exact: this.cfg.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: this.cfg.frontCamera ? 'user' : 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    const video = $('#video');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(want);
    } catch (err) {
      if (this.cfg.deviceId) {
        delete want.video.deviceId;
        this.stream = await navigator.mediaDevices.getUserMedia(want);
      } else throw err;
    }
    video.srcObject = this.stream;
    await video.play().catch(() => {});
    await waitForVideo(video, 4000);
    video.classList.add('on');
    $('#videoWrap').classList.add('live');
    await this.listDevices();
  }

  async restartStream() {
    if (!this.running) return;
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.openStream();
      this.motion.reset();
    } catch (err) {
      this.log(`camera switch failed: ${err.message}`, 'err');
    }
  }

  stop(reason = 'stopped') {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timers.heartbeat);
    clearInterval(this.timers.sync);
    clearInterval(this.timers.flush);
    this.timers = {};
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.releaseWakeLock();
    $('#app').dataset.running = '';
    $('#btnStart').disabled = false;
    $('#btnStop').disabled = true;
    $('#videoWrap').classList.remove('live');
    this.setStatus('capture', 'off', 'idle');
    this.setStatus('engine', 'off', 'idle');
    this.log(`monitoring stopped (${reason})`);
    if (this.cfg.cameraId) {
      this.api
        .heartbeat(this.cfg.cameraId, { status: 'offline', engine: 'idle', persons: 0 })
        .then(() => this.api.insertEvent(this.baseRow({ event_type: 'info', meta: { note: `node stopped (${reason})` } })))
        .catch(() => {});
    }
  }

  // ------------------------------------------------------------------- loop

  loop() {
    const step = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(step);
      const now = performance.now();
      const minDt = 1000 / Math.max(1, this.cfg.maxFps || 8);
      if (now - this.lastFrameAt < minDt) return;
      const dt = now - (this.lastFrameAt || now);
      this.lastFrameAt = now;
      try {
        this.tick(now, dt);
      } catch (err) {
        this.log(`frame error: ${err.message}`, 'err');
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  tick(now, dt) {
    const video = $('#video');
    if (!video.videoWidth) return;

    // 1. motion sensor: always on, no model needed
    const m = this.motion.process(video, { threshold: this.cfg.motionThreshold });

    // 2. skeleton detection
    let poses = [];
    let best = { score: 0, box: null };
    const det = this.pose.detect(video, { score: coreConfidence });
    if (det) {
      this.poseMs = det.ms;
      poses = det.poses;
      for (const p of poses) {
        if ((p.score ?? 0) > best.score) best = { score: p.score, box: p.box, landmarks: p.landmarks };
      }
    }
    // Partial-body case: pose lost but the motion blob is human-sized and slow →
    // keep the person state alive so we do not spam "cleared" every few seconds.
    if (!poses.length && this.watcher.state !== 'clear' && m.box && m.box.w * m.box.h > 0.05) {
      best = { ...best, box: best.box || m.box };
    }

    // 3. state machine
    const { alert, state } = this.watcher.observe(now, {
      personCount: poses.length,
      confidence: best.score,
      box: best.box || m.box,
      motion: m.active,
      motionScore: m.smoothedRatio ?? m.changedRatio,
    });
    this.lastSignal = { personCount: poses.length, confidence: best.score, motionScore: m.smoothedRatio ?? m.changedRatio, box: best.box };

    // 4. paint
    if (this.cfg.showOverlay !== false) {
      const box = $('#videoWrap');
      const cssW = box.clientWidth || window.innerWidth;
      const cssH = box.clientHeight || Math.round((cssW * 9) / 16);
      const ctx = sizeCanvas($('#overlay'), cssW, cssH);
      drawOverlay(ctx, { cssW, cssH, videoW: video.videoWidth, videoH: video.videoHeight }, {
        poses: poses.map((p) => ({ pts: p.landmarks, box: p.box, score: p.score })),
        motion: m,
        state,
        hud: [
          state === 'clear' ? 'STATE CLEAR' : state.toUpperCase(),
          `pose ${poses.length} · ${Math.round(best.score * 100)}%   motion ${(m.smoothedRatio ?? 0).toFixed(3)}`,
          `fps ${this.fps.toFixed(1)} · infer ${this.poseMs.toFixed(0)}ms · ${this.pose.ready ? 'skeleton' : 'motion-only'}`,
          `uplink ${this.api.online === false ? 'DOWN' : 'ok'} · queue ${this.queue.length}`,
        ],
      });
    }

    // 5. meters
    $('#mPerson').style.setProperty('--v', Math.min(1, best.score));
    $('#mPersonVal').textContent = `${Math.round(best.score * 100)}%`;
    $('#mMotion').style.setProperty('--v', Math.min(1, (m.smoothedRatio ?? 0) / Math.max(0.001, this.cfg.motionThreshold * 8)));
    $('#mMotionVal').textContent = (m.smoothedRatio ?? 0).toFixed(3);
    $('#stateBadge').textContent = this.watcher.armed
      ? state === 'clear'
        ? 'CLEAR'
        : state === 'motion'
        ? 'MOTION'
        : 'PERSON'
      : 'DISARMED';
    $('#stateBadge').dataset.state = state === 'clear' ? 'clear' : state === 'motion' ? 'warn' : 'alert';
    $('#personsNow').textContent = String(poses.length);

    // 6. fps
    this.frames += 1;
    this.fpsWindow += dt;
    if (this.fpsWindow >= 1000) {
      this.fps = (this.frames * 1000) / this.fpsWindow;
      this.frames = 0;
      this.fpsWindow = 0;
      $('#fps').textContent = this.fps.toFixed(1);
    }

    if (alert) this.onAlert(alert, { poses, motion: m, video });
  }

  baseRow(extra = {}) {
    return {
      camera_id: this.cfg.cameraId,
      session_id: this.sessionId,
      engine: this.pose.ready ? 'mediapipe-pose' : 'motion-only',
      fps: Math.round(this.fps * 10) / 10,
      device: deviceLabel(),
      ...extra,
    };
  }

  async onAlert(alert, { poses, motion }) {
    const row = this.baseRow({
      event_type: alert.event_type,
      person_count: alert.person_count,
      confidence: alert.confidence,
      motion_score: alert.motion_score,
      bbox: alert.bbox,
      skeleton: poses && poses.length ? packSkeleton(poses.map((p) => ({ landmarks: p.landmarks, box: p.box, score: p.score }))) : null,
      meta: { reason: alert.reason, dwell_ms: alert.dwell_ms, blobs: motion?.blobs ?? 0, changed: motion?.changedRatio ?? 0 },
    });

    const isClear = alert.event_type === EV.GONE;
    this.flashAlert(isClear ? 'clear' : alert.event_type === EV.MOTION ? 'motion' : 'person');
    if (!isClear) {
      if (alert.event_type === EV.MOTION) CUES.motion();
      else CUES.person();
      vibrate(isClear ? [30] : [90, 60, 90]);
    }

    // evidence frame (best-effort, never blocks the alert)
    if (!isClear && this.cfg.captureSnapshots !== false && this.api.configured) {
      try {
        const snap = await withTimeout(grabFrame($('#video'), { width: 760, quality: 0.6 }), 6000, 'snapshot');
        if (snap && snap.blob) {
          const up = await withTimeout(
            this.api.uploadSnapshot({ cameraId: this.cfg.cameraId, sessionId: this.sessionId, blob: snap.blob }),
            9000,
            'upload'
          );
          row.snapshot_url = up.url;
          row.meta = { ...row.meta, snap: { w: snap.width, h: snap.height, kb: Math.round(snap.bytes / 1024) } };
          this.counters.snapshots += 1;
        }
      } catch (err) {
        this.log(`snapshot skipped: ${err.message}`, 'warn');
      }
    }

    await this.send(row, isClear);
  }

  async send(row, quiet = false) {
    if (!this.api.configured || !this.cfg.cameraId) {
      this.queue.push(row);
      this.log('not linked — event queued locally', 'warn');
      return;
    }
    try {
      await this.api.insertEvent(row);
      this.counters.events += 1;
      if (row.is_alert !== false && !quiet) this.counters.alerts += 1;
      this.log(
        `${row.event_type} → supabase (p${row.person_count}${row.confidence ? ` @${Math.round(row.confidence * 100)}%` : ''}${
          row.motion_score ? ` m${row.motion_score}` : ''
        })${row.snapshot_url ? ' +frame' : ''}`
      );
      $('#evCount').textContent = String(this.counters.events);
      $('#alertCount').textContent = String(this.counters.alerts);
      this.setStatus('uplink', 'ok', 'sending');
    } catch (err) {
      if (this.queue.length < MAX_QUEUE) this.queue.push(row);
      else {
        this.queue.shift();
        this.queue.push(row);
        this.counters.dropped += 1;
      }
      this.setStatus('uplink', 'err', `retry x${this.queue.length}`);
      this.log(`uplink failed: ${err.message}`, 'err');
    }
    $('#queueCount').textContent = String(this.queue.length);
  }

  async flushQueue() {
    if (!this.queue.length || !this.api.configured || !this.cfg.cameraId) return;
    let sent = 0;
    while (this.queue.length && sent < 6) {
      const row = this.queue[0];
      try {
        await this.api.insertEvent(row);
        this.queue.shift();
        sent += 1;
        this.counters.events += 1;
      } catch {
        break;
      }
    }
    if (sent) {
      this.log(`flushed ${sent} queued event(s)`);
      $('#queueCount').textContent = String(this.queue.length);
      this.setStatus('uplink', 'ok', 'sending');
    }
  }

  // ------------------------------------------------------- server is master

  async heartbeat() {
    if (!this.cfg.cameraId || !this.api.configured) return;
    try {
      await this.api.heartbeat(this.cfg.cameraId, {
        status: 'online',
        engine: this.pose.ready ? this.pose.engineLabel : 'motion-only',
        fps: Math.round(this.fps * 10) / 10,
        persons: this.lastSignal.personCount,
      });
      this.setStatus('uplink', 'ok', 'live');
      $('#lastHb').textContent = timeAgo(Date.now());
    } catch (err) {
      this.setStatus('uplink', 'err', 'heartbeat lost');
      this.log(`heartbeat failed: ${err.message}`, 'warn');
    }
  }

  async syncConfig(initial = false) {
    if (!this.cfg.cameraId || !this.api.configured) return;
    try {
      const cam = await this.api.getCamera(this.cfg.cameraId);
      if (!cam) {
        this.log('node no longer exists on the server — re-registering', 'warn');
        this.cfg.cameraId = null;
        saveConfig({ cameraId: null });
        await this.register();
        return;
      }
      if (cam.archived) {
        this.stop('archived from control center');
        return;
      }
      this.camera = cam;
      const patch = {
        armed: !!cam.armed,
        sensitivity: Number(cam.sensitivity ?? this.cfg.sensitivity),
        motionThreshold: Number(cam.motion_threshold ?? this.cfg.motionThreshold),
        cooldownSeconds: Number(cam.cooldown_seconds ?? this.cfg.cooldownSeconds),
        captureSnapshots: cam.capture_snapshots !== false,
        maxFps: Number(cam.max_fps ?? this.cfg.maxFps),
      };
      const changed = Object.entries(patch).some(([k, v]) => v !== this.cfg[k]);
      Object.assign(this.cfg, patch);
      saveConfig(patch);
      this.watcher.configure(patch);
      this.renderConfig();
      if (changed && !initial) this.log(`config pulled from control center: ${describePatch(patch)}`);
      $('#armState').textContent = cam.armed ? 'ARMED' : 'DISARMED';
      $('#armState').dataset.on = cam.armed ? '1' : '0';
    } catch (err) {
      this.log(`config sync failed: ${err.message}`, 'warn');
    }
  }

  async pushConfig(patch) {
    if (!this.cfg.cameraId || !this.api.configured) return;
    try {
      await this.api.updateCamera(this.cfg.cameraId, patch);
    } catch (err) {
      this.log(`could not save ${Object.keys(patch).join(',')} to server: ${err.message}`, 'warn');
    }
  }

  // ----------------------------------------------------------------- extras

  async testAlert() {
    this.log('sending manual test alert…');
    const row = this.baseRow({
      event_type: 'test',
      person_count: 0,
      confidence: 1,
      motion_score: 0,
      meta: { reason: 'manual test from camera node' },
    });
    row.is_alert = false;
    await this.send(row, true);
    this.flashAlert('person');
    CUES.person();
  }

  flashAlert(kind) {
    const el = $('#stage');
    el.dataset.alert = kind;
    clearTimeout(this.timers.flash);
    this.timers.flash = setTimeout(() => {
      delete el.dataset.alert;
    }, kind === 'clear' ? 900 : 1600);
  }

  flash(sel, cls) {
    const el = $(sel);
    if (!el) return;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 700);
  }

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.log('screen wake lock held');
      } else this.log('wake lock unsupported', 'warn');
    } catch (err) {
      this.log(`wake lock refused: ${err.message}`, 'warn');
    }
  }

  releaseWakeLock() {
    try {
      this.wakeLock?.release?.();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }
}

// -------------------------------------------------------------------- utils

function defaultLabel() {
  const h = (location.hostname || 'device').split('.')[0];
  return `${/vercel/.test(h) ? 'Xbox' : h} camera ${new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' })}`;
}

function qsp(k) {
  try {
    return new URLSearchParams(location.search).get(k);
  } catch {
    return null;
  }
}

function waitForVideo(video, ms) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('canplay', done);
      resolve();
    };
    video.addEventListener('loadedmetadata', done, { once: true });
    video.addEventListener('canplay', done, { once: true });
    setTimeout(done, ms);
  });
}

function describeCamError(err) {
  const n = String(err && err.name);
  if (n === 'NotAllowedError' || n === 'SecurityError')
    return 'Camera permission denied. On iPhone: Settings → Safari → Camera → Allow, or tap “aA” in the address bar → allow camera. On Android: padlock icon → site settings → camera → allow. Then press Start again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError')
    return 'No camera matched those constraints. Try the flip button, pick a different device, or unplug the webcam and reconnect it.';
  if (n === 'NotReadableError' || n === 'AbortError')
    return 'The camera is busy in another app (Zoom/Teams/Camera close it) or the stream was interrupted. Close it and retry.';
  return `Camera start failed: ${n || ''} ${err?.message || err}`.trim();
}

function describePatch(patch) {
  return Object.entries(patch)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise),
    sleep(ms).then(() => {
      throw new Error(`${label} timed out (${ms}ms)`);
    }),
  ]);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const node = new CameraNode();
node.init();
window.xboxNode = node; // handy for console debugging on the device
