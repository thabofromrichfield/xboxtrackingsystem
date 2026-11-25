/**
 * Xbox Tracking System — CONTROL CENTER.
 *
 * The single place that receives alerts from every camera node: live skeleton
 * evidence, arm/disarm + sensitivity control per node, acknowledge flow,
 * 24h activity and onboarding links for new phone/tablet/webcam nodes.
 *
 * Feed = Supabase Realtime when the socket connects, polling otherwise.
 */

import { loadConfig, saveConfig, clearConfig, resolveBackendSettings, projectRef, DEFAULTS } from './config.js';
import { XboxApi, timeAgo, isoLocal } from './supabase.js';
import { drawEvidence } from './overlay.js';
import { CUES, unlockAudio, notify } from './sound.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const DEFAULTS_URL = DEFAULTS.url; // the built-in "xbox system" project
const ONLINE_WINDOW_MS = 45_000;
const POLL_EVENTS_MS = 2500;
const POLL_CAMERAS_MS = 8000;

class ControlCenter {
  constructor() {
    this.cfg = loadConfig();
    this.api = new XboxApi(this.cfg);
    this.cameras = new Map(); // id -> row
    this.events = new Map(); // id -> row (capped)
    this.order = [];
    this.filter = 'all';
    this.soundOn = this.cfg.dashSound !== false;
    this.snoozeUntil = 0;
    this.mode = 'polling';
    this.lastSync = 0;
    this.openPanel = null;
    // link is the single source of truth for "is this dashboard talking to
    // Supabase, and to which project" — always visible in the topbar chip.
    this.link = { kind: 'init', msg: 'checking the backend…', at: Date.now() };
    this.errorsSeen = 0;
  }

  async init() {
    this.bind();
    this.watchErrors();
    this.tickClock();
    this.renderLinkChip();
    setInterval(() => this.tickClock(), 1000);
    if (this.cfg.resetApplied) {
      this.log('local overrides cleared by ?reset=1 — using the built-in xbox system project');
      this.toast('stored backend settings cleared, using the built-in xbox system project', 'ok', 'reset');
    }
    if (this.cfg.urlFallback || this.cfg.keyFallback) {
      this.toast('your saved backend URL/key was not usable, so the built-in xbox system project is in use — open ⚙ Backend link to correct it', 'warn', 'config recovered');
      this.log('a stored, unusable backend override was ignored in favour of the built-in defaults');
    }
    if (!this.api.configured) {
      this.diagnostics('Supabase is not configured — fill in the Backend link panel.', true);
      this.openSettings();
      this.toast('Paste your project URL + publishable key (or leave both empty to use the built-in xbox system project).', 'warn', 'not linked');
    }
    await this.refreshCameras(true);
    await this.refreshEvents(true);
    this.startFeed();
    this.renderAll();
    const wall = $('#wall');
    wall.addEventListener('pointerdown', () => (this.wallLock = true));
    wall.addEventListener('focusin', () => (this.wallLock = true));
    wall.addEventListener('focusout', (e) => {
      if (!wall.contains(e.relatedTarget)) this.wallLock = false;
    });
    window.addEventListener('pointerup', () => setTimeout(() => (this.wallLock = false), 60));
    setInterval(() => this.refreshEvents().catch((e) => this.diagnostics(String(e.message || e))), POLL_EVENTS_MS);
    setInterval(() => this.refreshCameras().catch(() => {}), POLL_CAMERAS_MS);
    setInterval(() => this.sweep(), 25000);
    setInterval(() => {
      // relative-time refresh only: never rebuild the feed on a timer (scroll!)
      this.renderKpis();
      this.renderWall();
      this.renderBanner();
    }, 5000);
  }

  bind() {
    $('#btnSound').addEventListener('click', () => {
      this.soundOn = !this.soundOn;
      saveConfig({ dashSound: this.soundOn });
      $('#btnSound').dataset.on = this.soundOn ? '1' : '0';
      $('#btnSound').querySelector('span').textContent = this.soundOn ? 'Alert sound on' : 'Alert sound muted';
      unlockAudio();
      if (this.soundOn) CUES.click();
    });
    $('#btnNotif').addEventListener('click', async () => {
      unlockAudio();
      const ok = await notify('Xbox Tracking', 'Browser notifications enabled for this control center.', 'xbox-test');
      $('#btnNotif').querySelector('span').textContent = ok ? 'Notifications granted' : 'Notifications blocked/unsupported';
    });
    $('#btnArmAll').addEventListener('click', () => this.armAll(true));
    $('#btnDisarmAll').addEventListener('click', () => this.armAll(false));
    $('#btnAckAll').addEventListener('click', () => this.ackAll());
    $('#btnSnooze').addEventListener('click', () => {
      this.snoozeUntil = Date.now() + 10 * 60_000;
      this.log('audio snoozed for 10 minutes');
      this.renderBanner();
    });
    for (const chip of $$('#filters .chip')) {
      chip.addEventListener('click', () => {
        this.filter = chip.dataset.f;
        $$('#filters .chip').forEach((c) => c.classList.toggle('on', c === chip));
        this.renderFeed();
      });
    }
    $('#btnLink').addEventListener('click', () => {
      this.openModal('#linkPanel');
      $('#linkLabel').focus();
      if (!$('#linkOut').value) this.buildLink();
    });
    $('#btnLinkClose').addEventListener('click', () => this.closeModal('#linkPanel'));
    for (const sel of ['#linkPanel', '#settingsPanel']) {
      const modal = $(sel);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeModal(sel); // click the dim backdrop to dismiss
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeModal('#settingsPanel');
        this.closeModal('#linkPanel');
      }
    });
    $('#btnLinkCreate').addEventListener('click', () => this.createNode());
    $('#btnCopyLink').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('#linkOut').value);
        $('#btnCopyLink').textContent = 'Copied';
        setTimeout(() => ($('#btnCopyLink').textContent = 'Copy link'), 1400);
      } catch {
        $('#linkOut').select();
      }
    });
    $('#btnSettings').addEventListener('click', () => this.openSettings());
    $('#btnSettingsClose').addEventListener('click', () => this.closeModal('#settingsPanel'));
    $('#btnSettingsSave').addEventListener('click', () => this.saveSettings(true));
    $('#btnSettingsTest').addEventListener('click', () => this.saveSettings(false));
    $('#btnSettingsReset').addEventListener('click', () => this.applyDefaultsAndRelink());
    $('#btnSysDefaults').addEventListener('click', () => this.applyDefaultsAndRelink());
    $('#btnSysLink').addEventListener('click', () => this.openSettings());
    $('#btnSysRetry').addEventListener('click', async () => {
      this.setLink('init', 're-reading the backend…');
      await this.refreshCameras(true);
      await this.refreshEvents(true);
      this.toast(`backend answered: ${this.cameras.size} node(s), ${this.events.size} event(s)`, this.link.kind === 'live' ? 'ok' : 'err', 'retry');
    });
    $('#btnSysClose').addEventListener('click', () => {
      const el = $('#sysNote');
      el.hidden = true;
      el.dataset.pinned = 'off'; // stay dismissed until the next real state change
      this.log('system notice dismissed — the topbar chip still shows the backend state');
    });
    for (const sel of ['#stFeed', '#stArm']) {
      const chip = $(sel);
      if (!chip) continue;
      chip.addEventListener('click', () => this.openSettings());
      chip.tabIndex = 0;
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openSettings();
        }
      });
    }
    for (const sel of ['#setUrl', '#setKey']) {
      $(sel).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.saveSettings(true);
        }
      });
    }
    for (const sel of ['#setUrl', '#setKey']) {
      $(sel).addEventListener('input', () => this.previewSettings());
    }
    $('#btnPurge').addEventListener('click', async () => {
      try {
        const n = await this.api.purge(0);
        this.log(`purged events (${n} removed)`);
        this.events.clear();
        this.order = [];
        this.renderFeed();
      } catch (err) {
        this.diagnostics(`purge failed: ${err.message}`, true);
      }
    });
    $('#btnTestEvent').addEventListener('click', () => this.injectTest());
    $('#search').addEventListener('input', (e) => {
      this.search = e.target.value.trim().toLowerCase();
      this.renderFeed();
    });
  }

  // ------------------------------------------------------------- modals / toasts

  openModal(sel) {
    const el = $(sel);
    if (el) el.hidden = false;
  }

  closeModal(sel) {
    const el = $(sel);
    if (el) el.hidden = true;
  }

  setMsg(text, kind = '') {
    const el = $('#setMsg');
    if (!el) return;
    el.textContent = text;
    el.className = `fieldnote ${kind}`.trim();
  }

  toast(msg, kind = 'ok', title = '') {
    let host = $('#toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      host.className = 'toasts';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.innerHTML = `${title ? `<b>${esc(title)}</b>` : ''}${esc(msg)}`;
    host.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 420);
    }, 5200);
  }

  openSettings() {
    $('#setUrl').value = this.api.url || '';
    $('#setKey').value = this.api.key || '';
    this.previewSettings();
    this.openModal('#settingsPanel');
    setTimeout(() => $('#setUrl').focus(), 40);
  }

  /**
   * What the two fields mean, resolved once:
   * blank field = "use the built-in xbox system default for it"; a pasted ref,
   * a missing scheme or a full REST path all normalise to an origin.
   */
  resolveSettings() {
    return resolveBackendSettings($('#setUrl').value, $('#setKey').value);
  }

  previewSettings() {
    const r = this.resolveSettings();
    if (r.urlInvalid) {
      this.setMsg(`✗ “${$('#setUrl').value.trim().slice(0, 44)}” is not a usable project URL — paste e.g. https://abcdefghij.supabase.co, or just the 20-char ref`, 'bad');
      return r;
    }
    if (r.secret) {
      this.setMsg('✗ that is the service_role / sb_secret key. A browser may only use the publishable (anon) key — copy it from API Keys → Publishable key.', 'bad');
      return r;
    }
    this.setMsg(
      `will link to: ${r.url} · key ${r.key.slice(0, 15)}…${r.key.slice(-4)}${r.usingDefaults ? ' (built-in defaults)' : ''}`,
      'ok'
    );
    return r;
  }

  /**
   * Validate → (optionally persist) → probe the project → relink. Everything the
   * user needs to know lands in the panel itself, not in the diagnostics strip.
   */
  async saveSettings(persist) {
    const r = this.previewSettings();
    if (r.urlInvalid || r.secret) {
      this.toast('Fix the highlighted problem first — nothing was changed.', 'err', 'backend');
      return;
    }
    const { url, key } = r;
    const btn = $('#btnSettingsSave');
    const testBtn = $('#btnSettingsTest');
    const prev = btn.textContent;
    btn.disabled = testBtn.disabled = true;
    btn.dataset.busy = '1';
    btn.textContent = 'probing project…';
    this.setMsg(`probing ${url} …`);

    const probe = new XboxApi({ url, key, bucket: this.cfg.bucket });
    try {
      const cams = await probe.listCameras();
      const evs = await probe.listEvents({ limit: 5 });
      const persons = cams.filter((c) => c.armed).length;
      this.setMsg(
        `✓ reachable · ${cams.length} node(s), ${persons} armed · ${evs.length} event(s) readable${evs.length ? '' : ' · no alerts stored yet'}`,
        'ok'
      );
      if (persist) {
        saveConfig({ url, key });
        await this.api.disconnectRealtime().catch(() => {});
        this.cfg = loadConfig();
        this.api = new XboxApi(this.cfg);
        await this.refreshCameras(true);
        await this.refreshEvents(true);
        this.startFeed();
        this.renderAll();
        this.closeModal('#settingsPanel');
        this.toast(
          `linked to ${this.api.url}${r.usingDefaults ? ' (built-in defaults, nothing stored)' : ''} — ${cams.length} node(s), feed is ${this.mode}`,
          'ok',
          'backend relinked'
        );
      } else {
        this.toast('connection works (tested only, nothing changed)', 'ok', 'backend test');
      }
    } catch (err) {
      const hint = /Failed to fetch|NetworkError|ERR_/.test(String(err.message))
        ? ' — the project is unreachable from this browser (offline, wrong URL, or blocked). URL tried: ' + url
        : ` — ${err.message}`;
      this.setMsg(`✗ could not use that project${hint}`, 'bad');
      this.toast('that URL/key could not load the project — see the panel for the exact error', 'err', 'relink failed');
    } finally {
      btn.disabled = testBtn.disabled = false;
      delete btn.dataset.busy;
      btn.textContent = prev;
    }
  }

  /** One-tap repair: drop stored overrides, rewire, and read the working project. */
  async applyDefaultsAndRelink() {
    clearConfig();
    this.cfg = loadConfig();
    this.api = new XboxApi(this.cfg);
    await this.api.disconnectRealtime().catch(() => {});
    $('#setUrl').value = this.cfg.url;
    $('#setKey').value = this.cfg.key;
    delete $('#sysNote').dataset.pinned;
    this.setMsg('cleared local overrides — using the built-in xbox system project', 'ok');
    this.setLink('init', 'relinking to the built-in project');
    this.toast('local override cleared, using the built-in xbox system project', 'ok', 'backend');
    await this.refreshCameras(true);
    await this.refreshEvents(true);
    this.startFeed();
    this.renderQuietly('all', () => this.renderAll());
  }

  // ------------------------------------------------------- link status / safety

  /** The project this dashboard is actually talking to, as a glanceable label. */
  linkLabel() {
    const ref = projectRef(this.api.url);
    const who = ref ? ref : 'not linked';
    return this.cfg.hasOverride ? `${who} (saved)` : who;
  }

  setLink(kind, msg = '') {
    this.link = { kind, msg, at: Date.now() };
    this.renderLinkChip();
    this.renderSysNote();
  }

  /** Any render error is reported as itself — never mislabelled as a fetch failure. */
  renderQuietly(what, fn) {
    try {
      fn();
    } catch (err) {
      this.setLink('render', `${what} render threw: ${(err && err.message) || err}`);
      this.log(`render error while painting ${what}: ${(err && err.stack) || err}`);
    }
  }

  reportReadFailure(what, err) {
    const kind = XboxApi.classifyError(err);
    const detail = String((err && err.message) || err).slice(0, 220);
    this.diagnostics(`${what} fetch failed (${kind}): ${detail}`, true);
    this.log(`${what} read failed [${kind}]: ${detail}`);
    this.noteUlink(false, err);
    this.setLink(kind, detail);
    this.renderLinkChip();
  }

  renderLinkChip() {
    const chip = $('#stFeed');
    if (!chip) return;
    const bad = ['unreachable', 'denied', 'no-tables', 'not-found', 'server', 'unconfigured', 'render', 'fatal'];
    const warn = ['init', 'empty'].includes(this.link.kind) || this.link.kind.startsWith('http-');
    chip.className = `chip link ${bad.includes(this.link.kind) ? 'err' : warn ? 'warn' : 'ok'}`;
    const label =
      this.link.kind === 'live' ? `${this.linkLabel()} · ${this.mode === 'polling' ? 'polling' : 'realtime'}` :
      this.link.kind === 'init' ? `${this.linkLabel()} · checking…` :
      this.link.kind === 'empty' ? `${this.linkLabel()} · no nodes yet` :
      `${this.linkLabel()} · ${this.link.kind}`;
    const span = chip.querySelector('.dot')?.nextElementSibling;
    if (span) span.textContent = label;
    chip.title = `${this.api.url}\n${this.link.msg || 'reading ok'}`;
  }

  /**
   * The strip above the wall: the one place that says out loud whether the
   * dashboard is connected, what to do when it is not, and does it with a button
   * instead of instructions.
   */
  renderSysNote() {
    const el = $('#sysNote');
    if (!el) return;
    if (el.dataset.pinned === 'off' && ['live', 'empty'].includes(this.link.kind)) return;
    if (['unreachable', 'denied', 'no-tables', 'not-found', 'fatal', 'server', 'unconfigured'].includes(this.link.kind)) delete el.dataset.pinned;
    const healthy = this.link.kind === 'live';
    const copy = {
      unconfigured: ['not linked to Supabase', 'this dashboard has no usable project URL/key, so the wall and feed cannot fill in. One tap uses the built-in xbox system project — which your camera nodes are already writing to.'],
      unreachable: ['cannot reach the backend', 'the browser could not load the project at all — offline, wrong URL, or blocked by the network. Check the address below; if it came from the browser cache of an old paste, one tap restores the working project.'],
      'no-tables': ['wrong Supabase project', 'the project this page is linked to exists, but it has no xbox_cameras / xbox_detection_events — your nodes are writing to a different project. Point this page back at the xbox system project.'],
      denied: ['key rejected', 'the project answered but refused the publishable key (401/403). Copy API Keys → Publishable key again; a secret key is refused in a browser on purpose.'],
      'not-found': ['backend path missing', 'the project answered but not on /rest/v1 — that URL is not a Supabase API endpoint. Paste the project URL (or just its ref) instead of a dashboard page.'],
      empty: ['linked, but no nodes registered', 'the project is reachable and readable, yet no camera node has registered in it. Open a camera node page (or the link below) and start it once; it registers itself and events start landing here.'],
      render: ['the dashboard failed to paint', 'data arrived but rendering threw — the message below is the exact JS error, and the page keeps polling so it will recover on the next update.'],
      fatal: ['the control centre crashed', 'startup threw before the dashboard could attach. The message below is the exact error; reloading is safe and nothing was lost.'],
      init: ['checking the backend…', 'reading the linked project now — if this line stays, the network request is still pending or blocked.'],
    };
    const known = copy[this.link.kind];
    const isHttp = this.link.kind.startsWith('http-');
    const title = known ? known[0] : isHttp ? `backend answered ${this.link.kind.slice(5)}` : `backend problem (${this.link.kind})`;
    const body = known ? known[1] : this.link.msg || 'the backend returned an unexpected error.';
    if (healthy && !el.dataset.pinned) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.dataset.kind = this.link.kind;
    $('#sysNoteTitle').textContent = title;
    $('#sysNoteText').textContent = `${body}${this.link.msg && known ? ` — ${this.link.msg}` : ''}${this.cfg.hasOverride ? ' · using a value saved in this browser' : ''}`;
    const defBtn = $('#btnSysDefaults');
    if (defBtn) defBtn.hidden = this.api.url === DEFAULTS_URL || this.link.kind === 'render';
  }

  /** Startup/render/window failures must be visible, never a quietly dead page. */
  fatal(err) {
    const msg = String((err && err.message) || err || 'unknown error');
    console.error('[xbox-control] fatal', err);
    this.link = { kind: 'fatal', msg, at: Date.now() };
    this.diagnostics(`fatal: ${msg}`, true);
    this.renderLinkChip();
    this.renderSysNote();
    this.toast(msg, 'err', 'dashboard error');
  }

  watchErrors() {
    window.addEventListener('error', (e) => {
      if (this.errorsSeen++ > 2) return;
      const msg = e.message || 'script failed to load';
      this.diagnostics(`page error: ${msg}`, true);
      this.setLink('render', msg);
    });
    window.addEventListener('unhandledrejection', (e) => {
      if (this.errorsSeen++ > 2) return;
      const msg = String((e.reason && e.reason.message) || e.reason || 'promise rejected');
      this.diagnostics(`unhandled: ${msg}`, true);
      this.setLink('render', msg);
    });
  }

  noteUlink(ok, err) {
    if (this.uplinkOk === ok) return;
    this.uplinkOk = ok;
    if (!ok) {
      this.toast(
        `uplink to ${this.api.url} failed: ${(err && err.message) || 'unreachable'} — open ⚙ Backend link to fix it`,
        'err',
        'uplink down'
      );
    } else if (this.uplinkWasDown) {
      this.toast('uplink restored', 'ok', 'uplink');
      this.log('uplink to supabase recovered');
    }
    this.uplinkWasDown = !ok;
  }

  log(msg) {
    console.log('[xbox-control]', msg);
    const li = document.createElement('li');
    li.className = 'l-info';
    li.innerHTML = `<span class="t">${new Date().toLocaleTimeString('en-GB')}</span>${esc(msg)}`;
    const box = $('#diagLog');
    box?.prepend(li);
    while (box && box.children.length > 40) box.lastElementChild.remove();
  }

  diagnostics(text, bad = false) {
    const el = $('#diagMsg');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
  }

  // ------------------------------------------------------------------ data

  async refreshCameras(first = false) {
    let rows;
    try {
      rows = await this.api.listCameras();
    } catch (err) {
      this.reportReadFailure('nodes', err);
      return;
    }
    this.cameras = new Map(rows.map((r) => [r.id, r]));
    this.noteUlink(true);
    // A linked-but-empty project and a linked project with nodes must not look
    // the same: the first is the "is anything connected?" question itself.
    if (!rows.length && this.api.configured) {
      this.setLink('empty', this.api.url === DEFAULTS_URL ? 'no camera nodes have registered here yet' : 'this project has no camera nodes registered — the nodes are writing somewhere else');
    } else {
      this.setLink('live', `${rows.length} node(s) · ${this.mode}`);
    }
    this.diagnostics(`${rows.length} node(s) · ${this.mode}`);
    if (first) this.log(`loaded ${rows.length} camera node(s)`);
    this.renderQuietly('wall', () => {
      this.renderWall();
      this.renderKpis();
    });
  }

  async refreshEvents(first = false) {
    let rows;
    try {
      rows = await this.api.listEvents({ limit: 80 });
    } catch (err) {
      this.reportReadFailure('events', err);
      return;
    }
    let fresh = 0;
    for (const e of rows) {
      if (!this.events.has(e.id)) {
        this.events.set(e.id, e);
        this.order.unshift(e.id);
        fresh += 1;
        if (!first && isHotAlert(e) && Date.now() - Date.parse(e.created_at) < 20_000) this.raise(e);
      } else this.events.set(e.id, { ...this.events.get(e.id), ...e });
    }
    while (this.order.length > 500) {
      const dead = this.order.pop();
      this.events.delete(dead);
    }
    this.lastSync = Date.now();
    $('#lastSync').textContent = isoLocal();
    if (this.link.kind === 'live') this.setLink('live', `${this.cameras.size} node(s) · ${this.mode} · ${this.events.size} events`);
    if (first) this.log(`loaded ${rows.length} historical event(s)`);
    if (fresh) {
      this.renderQuietly('feed', () => {
        this.renderFeed();
        this.renderBanner();
        this.renderKpis();
        this.renderActivity();
        this.renderWall();
      });
    }
  }

  startFeed() {
    this.api
      .connectRealtime({
        onEvent: (row) => {
          if (!row || this.events.has(row.id)) return;
          this.events.set(row.id, row);
          this.order.unshift(row.id);
          if (isHotAlert(row)) this.raise(row);
          this.renderFeed();
          this.renderBanner();
          this.renderKpis();
          this.renderActivity();
          this.renderWall();
        },
        onCamera: (row) => {
          if (!row) return;
          this.cameras.set(row.id, { ...(this.cameras.get(row.id) || {}), ...row });
          this.renderWall();
          this.renderKpis();
        },
      })
      .then((handle) => {
        this.mode = handle ? 'realtime + polling' : 'polling (2.5s)';
        $('#feedMode').textContent = this.mode;
        // never overwrite an error line with a status line
        if (this.link.kind === 'live' || this.link.kind === 'init') this.diagnostics(`feed mode: ${this.mode}`);
        this.renderLinkChip();
      })
      .catch(() => {
        this.mode = 'polling (2.5s)';
        $('#feedMode').textContent = this.mode;
        this.renderLinkChip();
      });
  }

  async sweep() {
    try {
      await this.api.sweepStale();
      const rows = await this.api.listCameras();
      let changed = false;
      for (const r of rows) {
        const prev = this.cameras.get(r.id);
        if (!prev || prev.status !== r.status || prev.last_heartbeat_at !== r.last_heartbeat_at) changed = true;
        this.cameras.set(r.id, r);
      }
      if (changed) this.renderWall();
    } catch {
      /* offline is fine */
    }
  }

  // ------------------------------------------------------------- alerting

  raise(e) {
    const cam = this.cameras.get(e.camera_id);
    const title = e.severity === 'person' ? 'PERSON DETECTED' : e.severity === 'motion' ? 'MOTION DETECTED' : 'DETECTION';
    const body = `${e.camera_label || 'node'} · ${e.person_count || 0} person(s)${e.confidence ? ` · ${Math.round(e.confidence * 100)}%` : ''}`;
    $('#banner').dataset.level = e.severity || 'info';
    if (this.soundOn && Date.now() > this.snoozeUntil) {
      if (e.severity === 'person') CUES.alarm();
      else if (e.severity === 'motion') CUES.motion();
    }
    document.title = `🔴 ${title} · Xbox Control`;
    setTimeout(() => (document.title = 'Xbox Tracking · Control Center'), 12000);
    notify(`${title} — ${e.camera_label || 'node'}`, body, `xbox-${e.id}`);
    const stage = $('#flash');
    stage.dataset.on = '1';
    setTimeout(() => (stage.dataset.on = '0'), 1200);
    this.log(`ALERT ${title} from ${body}`);
  }

  activeAlerts() {
    const cut = Date.now() - 15 * 60_000;
    return this.order
      .map((id) => this.events.get(id))
      .filter((e) => e && e.is_alert && !e.acknowledged_at && Date.parse(e.created_at) > cut);
  }

  renderBanner() {
    const list = this.activeAlerts();
    const banner = $('#banner');
    if (!list.length) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    const top = list[0];
    banner.dataset.level = top.severity || 'info';
    $('#bannerCount').textContent = String(list.length);
    $('#bannerText').innerHTML = `<b>${top.severity === 'person' ? 'Person detected' : top.severity === 'motion' ? 'Motion detected' : 'Alert'}</b> on ${esc(
      top.camera_label || 'node'
    )} — ${esc(isoLocal(new Date(Date.parse(top.created_at))))}${top.confidence ? ` · confidence ${Math.round(top.confidence * 100)}%` : ''}${
      this.snoozeUntil > Date.now() ? ' <em>(audio snoozed)</em>' : ''
    }`;
    $('#bannerIds').value = list.map((e) => e.id).join(',');
  }

  async ackAll() {
    const ids = this.activeAlerts().map((e) => e.id);
    if (!ids.length) return this.log('nothing to acknowledge');
    try {
      const n = await this.api.acknowledge(ids, 'control-center');
      this.log(`acknowledged ${n ?? ids.length} alert(s)`);
      await this.refreshEvents();
      this.renderBanner();
    } catch (err) {
      this.diagnostics(`acknowledge failed: ${err.message}`, true);
    }
  }

  async ackOne(id) {
    try {
      await this.api.acknowledge([Number(id)], 'control-center');
      const e = this.events.get(id);
      if (e) this.events.set(id, { ...e, acknowledged_at: new Date().toISOString() });
      this.renderFeed();
      this.renderBanner();
    } catch (err) {
      this.diagnostics(`ack failed: ${err.message}`, true);
    }
  }

  async armAll(armed) {
    const ids = [...this.cameras.keys()];
    if (!ids.length) return this.log('no nodes registered yet');
    $('#armAllState').textContent = armed ? 'ARMED' : 'DISARMED';
    $('#armAllState').dataset.on = armed ? '1' : '0';
    let ok = 0;
    for (const id of ids) {
      try {
        await this.api.updateCamera(id, { armed });
        ok += 1;
        this.cameras.set(id, { ...this.cameras.get(id), armed });
      } catch {
        /* keep going */
      }
    }
    this.log(`${armed ? 'armed' : 'disarmed'} ${ok}/${ids.length} node(s) — nodes pick it up within ~12s`);
    this.renderWall();
  }

  async updateCamera(id, patch, note) {
    try {
      await this.api.updateCamera(id, patch);
      this.cameras.set(id, { ...this.cameras.get(id), ...patch });
      this.renderWall();
      this.diagnostics(note || `node updated: ${Object.keys(patch).join(', ')}`);
    } catch (err) {
      this.diagnostics(`update failed: ${err.message}`, true);
    }
  }

  async createNode() {
    const label = $('#linkLabel').value.trim();
    if (!label) return this.log('enter a node name first');
    try {
      const out = await this.api.registerCamera(label, $('#linkKind').value, $('#linkLocation').value.trim() || null, 'created from control center');
      this.log(`node “${out.label}” registered`);
      await this.refreshCameras();
      this.buildLink();
      $('#linkOut').value = this.nodeUrl(out.label);
      $('#linkToken').value = out.access_token || '';
      $('#linkQr').src = qrFor(this.nodeUrl(out.label));
      $('#linkQr').hidden = false;
    } catch (err) {
      this.diagnostics(`node creation failed: ${err.message}`, true);
    }
  }

  nodeUrl(label) {
    return `${location.origin}/camera?camera=${encodeURIComponent(label)}&autostart=1`;
  }

  buildLink() {
    const label = $('#linkLabel').value.trim() || 'Living room';
    $('#linkOut').value = this.nodeUrl(label);
    $('#linkQr').src = qrFor(this.nodeUrl(label));
  }

  // --------------------------------------------------------------- rendering

  renderAll() {
    this.renderKpis();
    this.renderWall();
    this.renderFeed();
    this.renderBanner();
    this.renderActivity();
  }

  renderKpis() {
    const now = Date.now();
    const cams = [...this.cameras.values()];
    const online = cams.filter((c) => c.last_heartbeat_at && now - Date.parse(c.last_heartbeat_at) < ONLINE_WINDOW_MS);
    const events = [...this.events.values()];
    const hour = events.filter((e) => now - Date.parse(e.created_at) < 3600_000);
    const day = events.filter((e) => now - Date.parse(e.created_at) < 86400_000);
    const persons = online.reduce((a, c) => a + (c.status === 'online' ? c.persons_last || 0 : 0), 0);
    $('#kpiOnline').textContent = `${online.length}/${cams.length}`;
    $('#kpiPersons').textContent = String(persons);
    $('#kpiPersons').dataset.hot = persons > 0 ? '1' : '0';
    $('#kpiAlerts').textContent = String(hour.filter((e) => e.is_alert).length);
    $('#kpiEvents').textContent = String(day.length);
    const conf = day.filter((e) => e.confidence).map((e) => Number(e.confidence));
    $('#kpiConf').textContent = conf.length ? `${Math.round((conf.reduce((a, b) => a + b, 0) / conf.length) * 100)}%` : '—';
    $('#stFeed').className = `chip ${this.api.online === false ? 'err' : 'ok'}`;
    $('#stFeed').querySelector('.dot').nextElementSibling.textContent =
      this.api.online === false ? 'uplink down' : this.mode.startsWith('realtime') ? 'realtime live' : 'polling live';
    $('#stArm').className = 'chip ok';
    $('#stArm').querySelector('.dot').nextElementSibling.textContent = `${cams.filter((c) => c.armed).length} armed / ${cams.length} nodes`;
  }

  renderWall() {
    const wall = $('#wall');
    // Never rebuild the wall while someone is dragging a slider or has focus in
    // a node card — that would fight their input. Retry shortly after.
    if (this.wallLock) {
      clearTimeout(this._wallRetry);
      this._wallRetry = setTimeout(() => this.renderWall(), 600);
      return;
    }
    const cams = [...this.cameras.values()];
    if (!cams.length) {
      wall.innerHTML = `<div class="empty">No camera nodes yet. Press <b>＋ Add camera node</b>, then open the generated link on your phone and tap <b>Start monitoring</b>.</div>`;
      return;
    }
    const now = Date.now();
    wall.innerHTML = cams
      .map((c) => {
        const age = c.last_heartbeat_at ? now - Date.parse(c.last_heartbeat_at) : Infinity;
        const live = age < ONLINE_WINDOW_MS;
        const last = this.latestFor(c.id);
        const persons = live ? c.persons_last || 0 : 0;
        return `
      <article class="card cam ${persons ? 'occupied' : ''}" data-cam="${c.id}">
        <header>
          <div>
            <h3>${esc(c.label)}</h3>
            <p class="sub">${esc(c.location || 'no location')} · ${esc(c.kind)} · ${esc(c.engine || 'engine idle')}</p>
          </div>
          <div class="stack">
            <span class="led ${live ? 'on' : 'off'}" title="${live ? 'online' : 'offline'}"></span>
            <span class="pill ${persons ? 'hot' : ''}">${persons ? `${persons} person${persons > 1 ? 's' : ''}` : 'clear'}</span>
          </div>
        </header>
        <div class="evidence" data-ev-for="${c.id}">
          ${
            last && last.snapshot_url
              ? `<img src="${esc(last.snapshot_url)}" alt="latest detection frame" loading="lazy"><canvas data-skel="${c.id}"></canvas>`
              : `<div class="noev">${live ? (persons ? 'no frame uploaded' : 'waiting for a detection') : 'node offline'}</div>${
                  last ? `<canvas data-skel="${c.id}"></canvas>` : ''
                }`
          }
          ${last ? `<span class="stamp">${timeAgo(last.created_at, now)}</span>` : ''}
        </div>
        <div class="meter">
          <div class="m"><i style="--v:${Math.min(1, (last?.confidence || 0) * 1)}"></i></div>
          <div class="mtxt">
            <span>confidence <b>${last && last.confidence ? Math.round(last.confidence * 100) + '%' : '—'}</b></span>
            <span>motion <b>${last && last.motion_score ? Number(last.motion_score).toFixed(3) : '—'}</b></span>
            <span>${c.fps_reported ? `${Number(c.fps_reported).toFixed(1)} fps` : '—'} · hb ${timeAgo(c.last_heartbeat_at, now)}</span>
          </div>
        </div>
        <div class="crow">
          <label class="sw"><input type="checkbox" data-act="armed" ${c.armed ? 'checked' : ''}><span>armed</span></label>
          <label class="sw"><input type="checkbox" data-act="capture_snapshots" ${c.capture_snapshots !== false ? 'checked' : ''}><span>snapshots</span></label>
          <a class="mini" href="${esc(this.nodeUrl(c.label))}" target="_blank" rel="noopener">open node ↗</a>
          <button class="mini danger" data-act="archive">remove</button>
        </div>
        <div class="tune">
          <label>gate <input type="range" min="0.15" max="0.9" step="0.05" value="${Number(c.sensitivity || 0.45)}" data-act="sensitivity"><b>${Math.round(
          Number(c.sensitivity || 0.45) * 100
        )}%</b></label>
          <label>cooldown <input type="range" min="0" max="180" step="5" value="${Number(c.cooldown_seconds ?? 25)}" data-act="cooldown_seconds"><b>${Number(
          c.cooldown_seconds ?? 25
        )}s</b></label>
          <label>motion <input type="range" min="0.002" max="0.08" step="0.002" value="${Number(c.motion_threshold || 0.014)}" data-act="motion_threshold"><b>${(
          Number(c.motion_threshold || 0.014) * 1000
        ).toFixed(1)}</b></label>
        </div>
      </article>`;
      })
      .join('');

    // wire controls + skeleton overlays
    for (const card of $$('#wall .cam')) {
      const id = card.dataset.cam;
      for (const box of card.querySelectorAll('[data-act]')) {
        const act = box.dataset.act;
        if (act === 'archive') {
          box.addEventListener('click', async () => {
            if (!confirm('Archive this camera node? Its history stays in Supabase.')) return;
            await this.updateCamera(id, { archived: true, armed: false }, 'node archived');
            this.cameras.delete(id);
            this.renderWall();
          });
          continue;
        }
        if (box.type === 'checkbox') {
          box.addEventListener('change', () => this.updateCamera(id, { [act]: box.checked }, `${act} → ${box.checked}`));
        } else {
          let t;
          box.addEventListener('input', () => {
            const out = box.parentElement.querySelector('b');
            const v = Number(box.value);
            if (out)
              out.textContent =
                act === 'sensitivity' ? `${Math.round(v * 100)}%` : act === 'cooldown_seconds' ? `${v}s` : (v * 1000).toFixed(1);
            clearTimeout(t);
            t = setTimeout(() => this.updateCamera(id, { [act]: v }, `${act} → ${v}`), 420);
          });
        }
      }
      const cv = card.querySelector('canvas[data-skel]');
      if (cv) this.paintEvidence(cv, id);
    }
  }

  latestFor(cameraId) {
    for (const id of this.order) {
      const e = this.events.get(id);
      if (e && e.camera_id === cameraId && (e.snapshot_url || e.severity === 'person' || e.severity === 'motion')) return e;
    }
    return null;
  }

  paintEvidence(canvas, cameraId) {
    const e = this.latestFor(cameraId);
    if (!e) return;
    const draw = () => {
      const poses = (e.skeleton && e.skeleton.poses) || [];
      if (!poses.length) return;
      drawEvidence(canvas, poses, { videoW: 1280, videoH: 720 });
    };
    const img = canvas.parentElement.querySelector('img');
    if (img && !img.complete) img.addEventListener('load', () => requestAnimationFrame(draw), { once: true });
    requestAnimationFrame(draw);
  }

  renderFeed() {
    const box = $('#feed');
    const keepScroll = box.scrollTop;
    const now = Date.now();
    let list = this.order.map((id) => this.events.get(id)).filter(Boolean);
    if (this.filter === 'alerts') list = list.filter((e) => e.is_alert);
    else if (this.filter === 'person') list = list.filter((e) => e.severity === 'person');
    else if (this.filter === 'motion') list = list.filter((e) => e.severity === 'motion');
    else if (this.filter === 'clear') list = list.filter((e) => e.severity === 'clear');
    else if (this.filter === 'unack') list = list.filter((e) => e.is_alert && !e.acknowledged_at);
    if (this.search)
      list = list.filter((e) =>
        `${e.camera_label || ''} ${e.event_type} ${e.engine || ''} ${e.device || ''}`.toLowerCase().includes(this.search)
      );
    const rows = list.slice(0, 120);
    if (!rows.length) {
      box.innerHTML = `<div class="empty">No events yet. Start a camera node and walk in front of it — alerts land here in about a second.</div>`;
      $('#feedCount').textContent = '0';
      return;
    }
    $('#feedCount').textContent = String(list.length);
    box.innerHTML = rows
      .map((e) => {
        const sev = e.severity || 'info';
        const hot = now - Date.parse(e.created_at) < 60_000;
        return `<li class="ev s-${sev} ${hot ? 'fresh' : ''} ${e.acknowledged_at ? 'acked' : ''}" data-id="${e.id}">
        <span class="sev"></span>
        <div class="evmain">
          <p class="evl1">
            <b>${esc(e.camera_label || 'node')}</b>
            <em>${labelFor(e)}</em>
            ${e.is_alert && !e.acknowledged_at ? '<i class="tag hot">alert</i>' : e.acknowledged_at ? '<i class="tag">acked</i>' : ''}
            ${e.meta?.reason ? `<i class="tag">${esc(String(e.meta.reason))}</i>` : ''}
          </p>
          <p class="evl2">
            <span>${esc(isoLocal(new Date(Date.parse(e.created_at))))}</span>
            ${e.person_count ? `<span>${e.person_count} person${e.person_count > 1 ? 's' : ''}</span>` : ''}
            ${e.confidence ? `<span>conf ${Math.round(e.confidence * 100)}%</span>` : ''}
            ${e.motion_score ? `<span>motion ${Number(e.motion_score).toFixed(3)}</span>` : ''}
            ${e.fps ? `<span>${Number(e.fps).toFixed(1)} fps</span>` : ''}
            <span>${esc(e.engine || '—')}</span>
          </p>
        </div>
        ${e.snapshot_url ? `<img class="thumb" src="${esc(e.snapshot_url)}" alt="" loading="lazy">` : ''}
        ${e.is_alert && !e.acknowledged_at ? `<button class="mini" data-ack="${e.id}">ack</button>` : ''}
      </li>`;
      })
      .join('');
    box.scrollTop = keepScroll;
    for (const btn of box.querySelectorAll('[data-ack]')) btn.addEventListener('click', () => this.ackOne(btn.dataset.ack));
    for (const li of box.querySelectorAll('.ev')) {
      li.addEventListener('click', () => {
        const e = this.events.get(Number(li.dataset.id));
        if (!e) return;
        $('#insight').hidden = false;
        $('#insightTitle').textContent = `${e.camera_label || 'node'} · ${e.event_type}`;
        $('#insightBody').innerHTML = insightHtml(e);
        const cv = $('#insightCanvas');
        cv.parentElement.dataset.ev = e.snapshot_url || '';
        const img = $('#insightImg');
        if (e.snapshot_url) {
          img.hidden = false;
          img.src = e.snapshot_url;
          img.onload = () => drawEvidence(cv, (e.skeleton && e.skeleton.poses) || []);
        } else {
          img.hidden = true;
          img.removeAttribute('src');
          drawEvidence(cv, (e.skeleton && e.skeleton.poses) || []);
        }
      });
    }
  }

  renderActivity() {
    const canvas = $('#activity');
    if (!canvas) return;
    const cssW = canvas.clientWidth || 640;
    const cssH = canvas.clientHeight || 90;
    const ctx = sizeCanvasLocal(canvas, cssW, cssH);
    const buckets = new Array(24).fill(0).map(() => ({ person: 0, motion: 0 }));
    const now = new Date();
    const startHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 23, 0, 0, 0);
    for (const e of this.events.values()) {
      const t = Date.parse(e.created_at);
      const idx = Math.floor((t - startHour.getTime()) / 3600_000);
      if (idx < 0 || idx > 23) continue;
      if (e.severity === 'person') buckets[idx].person += 1;
      else if (e.severity === 'motion') buckets[idx].motion += 1;
    }
    const max = Math.max(3, ...buckets.map((b) => b.person + b.motion));
    const bw = cssW / 24;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    for (let i = 0; i < 24; i += 1) ctx.fillRect(i * bw, 0, 0.5, cssH);
    buckets.forEach((b, i) => {
      const total = b.person + b.motion;
      const h = (total / max) * (cssH - 18);
      const hp = b.person ? (b.person / total) * h : 0;
      const x = i * bw + 2;
      const w = Math.max(3, bw - 5);
      ctx.fillStyle = '#ffc531';
      roundTop(ctx, x, cssH - 14 - (h - hp), w, h - hp, 2);
      ctx.fillStyle = '#22ff88';
      roundTop(ctx, x, cssH - 14 - h, w, hp, 2);
    });
    ctx.fillStyle = 'rgba(232,241,255,0.5)';
    ctx.font = '9px ui-monospace, monospace';
    buckets.forEach((_, i) => {
      const d = new Date(startHour.getTime() + i * 3600_000);
      if (i % 4 === 0) ctx.fillText(String(d.getHours()).padStart(2, '0'), i * bw + 1, cssH - 3);
    });
    $('#activityMax').textContent = `${max} / h peak`;
  }

  async injectTest() {
    let cam = [...this.cameras.values()][0];
    if (!cam) {
      const out = await this.api.registerCamera('Control center test', 'other', null, 'dashboard');
      await this.refreshCameras();
      cam = this.cameras.get(out.id);
    }
    const skeleton = {
      v: 1,
      model: 'blazepose33',
      poses: [
        {
          score: 0.93,
          box: { x: 0.3, y: 0.18, w: 0.4, h: 0.74 },
          pts: standFigure(),
        },
      ],
    };
    await this.api.insertEvent({
      camera_id: cam.id,
      session_id: 'dashboard-test',
      event_type: 'person',
      person_count: 1,
      confidence: 0.93,
      motion_score: 0.031,
      bbox: skeleton.poses[0].box,
      skeleton,
      engine: 'manual-test',
      device: 'control-center',
      meta: { reason: 'control-center test' },
    });
    this.log('test alert injected');
    await this.refreshEvents();
  }

  tickClock() {
    const d = new Date();
    $('#clock').textContent = isoLocal(d);
    $('#uptime').textContent = `session ${Math.round((performance.now() - 0) / 1000)}s`;
  }
}

// -------------------------------------------------------------------- utils

function labelFor(e) {
  if (e.severity === 'person') return e.event_type === 'person+motion' ? 'person + motion' : 'person';
  if (e.severity === 'motion') return 'motion';
  if (e.severity === 'clear') return 'frame cleared';
  return e.event_type || 'info';
}

function isHotAlert(e) {
  return !!e && e.is_alert && !e.acknowledged_at && (e.severity === 'person' || e.severity === 'motion');
}

function insightHtml(e) {
  const pts = (e.skeleton?.poses?.[0]?.pts || []).length;
  const rows = [
    ['event', e.event_type],
    ['severity', e.severity],
    ['camera', e.camera_label],
    ['created', isoLocal(new Date(Date.parse(e.created_at)))],
    ['session', e.session_id],
    ['persons', e.person_count],
    ['confidence', e.confidence != null ? `${Math.round(e.confidence * 100)}%` : null],
    ['motion score', e.motion_score],
    ['bbox', e.bbox ? `x ${e.bbox.x} y ${e.bbox.y} w ${e.bbox.w} h ${e.bbox.h}` : null],
    ['skeleton', pts ? `${pts} landmarks (33-pt BlazePose)` : null],
    ['engine', e.engine],
    ['fps', e.fps],
    ['device', e.device],
    ['meta', e.meta ? JSON.stringify(e.meta) : null],
    ['ack', e.acknowledged_at ? `${isoLocal(new Date(Date.parse(e.acknowledged_at)))} by ${e.acknowledged_by || '—'}` : 'not acknowledged'],
  ];
  return `<dl>${rows
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`)
    .join('')}</dl>`;
}

/** A synthetic 33-point standing figure so the test alert renders a real skeleton. */
function standFigure() {
  const P = (x, y, v = 1) => [x, y, v];
  return [
    P(0.5, 0.16), P(0.485, 0.15), P(0.475, 0.15), P(0.465, 0.152), P(0.515, 0.15), P(0.525, 0.15), P(0.535, 0.152),
    P(0.46, 0.165), P(0.54, 0.165), P(0.478, 0.185), P(0.522, 0.185), P(0.44, 0.27), P(0.56, 0.27), P(0.41, 0.38),
    P(0.59, 0.38), P(0.39, 0.49), P(0.61, 0.49), P(0.385, 0.51), P(0.615, 0.51), P(0.38, 0.5), P(0.62, 0.5),
    P(0.375, 0.505), P(0.625, 0.505), P(0.45, 0.55), P(0.55, 0.55), P(0.445, 0.7), P(0.555, 0.7), P(0.44, 0.86),
    P(0.56, 0.86), P(0.435, 0.88), P(0.565, 0.88), P(0.425, 0.9), P(0.575, 0.9),
  ];
}

function qrFor(text) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=6&data=${encodeURIComponent(text)}`;
}

function roundTop(ctx, x, y, w, h, r) {
  if (h <= 0) return;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

function sizeCanvasLocal(canvas, cssW, cssH) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const control = new ControlCenter();
window.xboxControl = control;
control.init().catch((err) => control.fatal(err));
