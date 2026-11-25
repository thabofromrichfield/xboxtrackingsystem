/**
 * Tiny WebAudio cues — no audio files to ship.
 * Camera node: chirp on a confirmed alert. Control center: two-tone siren.
 */

let ctx = null;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function unlockAudio() {
  ac();
}

/** @param tones array of [freqHz, startOffset, duration, gain] */
export function playPattern(tones) {
  const a = ac();
  if (!a) return;
  const master = a.createGain();
  master.gain.value = 0.9;
  master.connect(a.destination);
  for (const [freq, at, dur, gain] of tones) {
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, a.currentTime + at);
    g.gain.setValueAtTime(0.0001, a.currentTime + at);
    g.gain.exponentialRampToValueAtTime(gain, a.currentTime + at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + at + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(a.currentTime + at);
    osc.stop(a.currentTime + at + dur + 0.03);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch {
        /* ignore */
      }
    };
  }
}

export const CUES = {
  person: () => playPattern([[880, 0, 0.16, 0.28], [1245, 0.17, 0.2, 0.3]]),
  motion: () => playPattern([[560, 0, 0.1, 0.18], [660, 0.11, 0.1, 0.16]]),
  clear: () => playPattern([[520, 0, 0.09, 0.1], [392, 0.1, 0.12, 0.09]]),
  alarm: () =>
    playPattern([
      [988, 0, 0.18, 0.3], [740, 0.2, 0.18, 0.3], [988, 0.4, 0.18, 0.32], [740, 0.6, 0.24, 0.3],
    ]),
  click: () => playPattern([[1320, 0, 0.05, 0.07]]),
};

export function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

/** Browser notification for the control center (optional, permission-gated). */
export async function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission === 'denied') return false;
  if (Notification.permission === 'default') {
    const res = await Notification.requestPermission().catch(() => 'denied');
    if (res !== 'granted') return false;
  }
  try {
    const n = new Notification(title, { body, tag, silent: true });
    setTimeout(() => {
      try {
        n.close();
      } catch {
        /* ignore */
      }
    }, 8000);
    return true;
  } catch {
    return false;
  }
}
