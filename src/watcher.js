/**
 * Alert state machine. Turns noisy per-frame signals (pose count, motion
 * energy) into the small set of events the control center cares about:
 *
 *   person         someone appeared in frame            -> ALERT
 *   person+motion  someone appeared *and* is moving fast -> ALERT (priority)
 *   motion         something moved, no pose lock         -> ALERT (warn)
 *   presence-gone  the frame emptied again               -> CLEAR
 *
 * Entry is debounced over consecutive frames, exits need a longer streak, and a
 * per-camera cooldown re-alerts while someone stays in the frame.
 */

export const EV = {
  PERSON: 'person',
  PERSON_MOTION: 'person+motion',
  MOTION: 'motion',
  GONE: 'presence-gone',
  INFO: 'info',
};

export class Watcher {
  constructor(opts = {}) {
    this.sensitivity = num(opts.sensitivity, 0.45); // pose confidence gate
    this.motionThreshold = num(opts.motionThreshold, 0.014); // changed-pixel ratio gate
    this.cooldownMs = num(opts.cooldownSeconds, 25) * 1000;
    this.armed = opts.armed !== false;
    this.enterFrames = opts.enterFrames ?? 2;
    this.exitFrames = opts.exitFrames ?? 7;
    this.minBoxArea = opts.minBoxArea ?? 0.02;

    this.state = 'clear'; // clear | motion | person
    this.lastAlertAt = 0;
    this.since = { person: 0, motion: 0, none: 0 };
    this.personSince = null;
    this.personsMax = 0;
    this.stats = { frames: 0, poseHits: 0, motionHits: 0 };
  }

  configure(patch = {}) {
    if (patch.sensitivity != null) this.sensitivity = num(patch.sensitivity, this.sensitivity);
    if (patch.motionThreshold != null) this.motionThreshold = num(patch.motionThreshold, this.motionThreshold);
    if (patch.cooldownSeconds != null) this.cooldownMs = num(patch.cooldownSeconds, this.cooldownMs / 1000) * 1000;
    if (patch.armed != null) this.armed = !!patch.armed;
  }

  reset(t = 0) {
    this.state = 'clear';
    this.personSince = null;
    this.personsMax = 0;
    this.since = { person: 0, motion: 0, none: 0 };
    this.lastAlertAt = t;
  }

  /**
   * @param t            ms clock (performance.now())
   * @param signal       {personCount, confidence, box, motion, motionScore}
   * @returns {{alert:null|object, state:string}}
   */
  observe(t, signal = {}) {
    const confidence = Number(signal.confidence) || 0;
    const personCount = Number(signal.personCount) || 0;
    const box = signal.box || null;
    const area = box ? box.w * box.h : 1;
    const poseGood = personCount > 0 && confidence >= this.sensitivity && area >= this.minBoxArea;
    const motionHit = !!signal.motion;
    const motionScore = Number(signal.motionScore) || 0;

    this.stats.frames += 1;
    if (poseGood) this.stats.poseHits += 1;
    if (motionHit) this.stats.motionHits += 1;

    this.since.person = poseGood ? 0 : this.since.person + 1;
    this.since.motion = motionHit ? 0 : this.since.motion + 1;
    this.since.none = poseGood || motionHit ? 0 : this.since.none + 1;

    let alert = null;

    if (this.state === 'clear') {
      if (poseGood) {
        // A locked skeleton at gate confidence is strong enough on its own; a
        // confident *and* fast-moving body is the highest-priority event.
        this.#enter(t, motionHit && motionScore > this.motionThreshold * 4 ? EV.PERSON_MOTION : EV.PERSON, 'entry', {
          personCount,
          confidence,
          box,
          motionScore,
        });
        alert = this.#last;
      } else if (motionHit) {
        if (this.#count('motion') + 1 >= this.enterFrames) {
          this.#enter(t, EV.MOTION, 'motion', { personCount: 0, confidence, box, motionScore });
          alert = this.#last;
        } else this.#bump('motion');
      } else {
        this.#reset('motion');
        this.#reset('person');
      }
    } else if (this.state === 'person' || this.state === 'person+motion') {
      if (!poseGood && this.since.person >= this.exitFrames) {
        const dwellMs = this.personSince ? t - this.personSince : null;
        this.#leave(t, dwellMs, { motionStill: motionHit, motionScore });
        alert = this.#last;
      } else if (this.#due(t)) {
        // someone is still there: keep the control center informed
        this.#repeat(t, motionHit ? EV.PERSON_MOTION : EV.PERSON, 'still-present', {
          personCount,
          confidence,
          box,
          motionScore,
          dwellMs: this.personSince ? t - this.personSince : null,
        });
        alert = this.#last;
      }
    } else if (this.state === 'motion') {
      if (!motionHit && this.since.motion >= this.exitFrames) {
        this.state = 'clear';
        this.#reset('motion');
      } else if (poseGood) {
        this.#enter(t, EV.PERSON, 'escalated-from-motion', { personCount, confidence, box, motionScore });
        alert = this.#last;
      } else if (this.#due(t)) {
        this.#repeat(t, EV.MOTION, 'still-moving', { personCount: 0, confidence, box, motionScore });
        alert = this.#last;
      }
    }

    return { alert, state: this.state, armed: this.armed };
  }

  // ---------------------------------------------------------------- internals

  #counters = { person: 0, motion: 0 };

  #last = null;

  #count(k) {
    return this.#counters[k];
  }

  #bump(k) {
    this.#counters[k] += 1;
  }

  #reset(k) {
    this.#counters[k] = 0;
  }

  #due(t) {
    return this.armed && t - this.lastAlertAt >= this.cooldownMs;
  }

  #enter(t, type, reason, sig) {
    this.state = type === EV.MOTION ? 'motion' : type === EV.PERSON_MOTION ? 'person+motion' : 'person';
    this.#reset('person');
    this.#reset('motion');
    this.personSince = t;
    this.personsMax = Math.max(sig.personCount || 0, 1);
    this.lastAlertAt = t;
    this.#last = this.#payload(type, reason, sig, true);
  }

  #repeat(t, type, reason, sig) {
    this.lastAlertAt = t;
    this.personsMax = Math.max(sig.personCount || 0, this.personsMax);
    this.#last = this.#payload(type, reason, sig, true);
  }

  #leave(t, dwellMs, extra = {}) {
    const wasPerson = this.state !== 'motion';
    this.state = 'clear';
    this.#reset('person');
    this.#reset('motion');
    this.personSince = null;
    this.lastAlertAt = t;
    this.#last = wasPerson
      ? {
          event_type: EV.GONE,
          reason: 'frame cleared',
          person_count: 0,
          confidence: null,
          motion_score: round(extra.motionScore),
          bbox: null,
          skeleton: null,
          dwell_ms: dwellMs,
          is_alert: false,
        }
      : null;
  }

  #payload(type, reason, sig, isAlert) {
    return {
      event_type: type,
      reason,
      person_count: sig.personCount || (type === EV.MOTION ? 0 : 1),
      confidence: sig.confidence != null ? round(sig.confidence) : null,
      motion_score: round(sig.motionScore),
      bbox: sig.box
        ? { x: round(sig.box.x, 4), y: round(sig.box.y, 4), w: round(sig.box.w, 4), h: round(sig.box.h, 4) }
        : null,
      dwell_ms: sig.dwellMs || null,
      is_alert: isAlert && this.armed,
    };
  }
}

function round(v, d = 4) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const f = 10 ** d;
  return Math.round(Number(v) * f) / f;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
