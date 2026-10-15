// Trigger-to-first-paint probe for the menu transitions
// (global._lgGlass.openLag).
//
// The frame-interval probe in this extension could not answer "how long does an
// open stall", because the first log line of a transition is the interval since
// the *previous painted frame*. On an idle screen that previous frame can be
// arbitrarily far back, so the interval silently absorbs the idle gap and reads
// as a giant stall that never happened. This measures from the trigger instead:
// the moment the open/close handler runs, up to the first frame painted after
// it. A still screen then reads as "trigger→paint 5ms", not "450ms".
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { diagnosticLog } from './logging.js';

/** Frame deltas logged after each trigger, so the whole opening can be seen. */
const TRAIL_FRAMES = 24;

let _enabled = false;
let _paintId = 0;
let _lastPaintUs = 0;
let _seq = 0;
let _pending: { label: string; us: number; eventMs: number } | null = null;
let _trail = 0;
let _trailLabel = '';
let _trailDeltas: number[] = [];
let _trailWork: string[] = [];
let _work: Map<string, number> = new Map();

export function isOpenLagEnabled(): boolean {
  return _enabled;
}

export function setOpenLagEnabled(on: boolean): boolean {
  if (on === _enabled) return _enabled;
  _enabled = on;
  if (on) {
    _seq = 0;
    _pending = null;
    _trail = 0;
    _trailDeltas = [];
    _trailWork = [];
    _work = new Map();
    _lastPaintUs = 0;
    _paintId = global.stage.connect('after-paint', _onPaint);
    return true;
  }
  if (_paintId) global.stage.disconnect(_paintId);
  _paintId = 0;
  diagnosticLog(`[Liquid Glass][open] stopped after ${_seq} triggers`);
  return false;
}

/**
 * Adds a duration (µs) to the frame currently being painted. Lets a slow frame
 * in the trail name the extension work that caused it instead of guessing.
 */
export function noteWork(label: string, us: number): void {
  if (!_enabled) return;
  _work.set(label, (_work.get(label) ?? 0) + us);
}

/** Times `fn` and attributes the duration to the current frame. */
export function timed<T>(label: string, fn: () => T): T {
  if (!_enabled) return fn();
  const start = GLib.get_monotonic_time();
  try {
    return fn();
  } finally {
    noteWork(label, GLib.get_monotonic_time() - start);
  }
}

function _workSnapshot(): string {
  if (_work.size === 0) return '';
  return [..._work]
    .sort((a, b) => b[1] - a[1])
    .map(([label, us]) => `${label}=${(us / 1000).toFixed(1)}ms`)
    .join(' ');
}

/**
 * Records the instant a transition starts. The next painted frame reports the
 * trigger-to-first-paint latency, and the frames after it report the cadence of
 * the animation itself.
 */
export function markOpenTrigger(label: string): void {
  if (!_enabled) return;
  let eventMs = 0;
  try { eventMs = Number((Clutter as any).get_current_event_time?.() ?? 0) || 0; } catch (e) {}
  _pending = { label, us: GLib.get_monotonic_time(), eventMs };
}

function _onPaint(): void {
  const now = GLib.get_monotonic_time();
  const sinceLast = _lastPaintUs ? (now - _lastPaintUs) / 1000 : 0;
  _lastPaintUs = now;

  const work = _workSnapshot();
  _work.clear();

  if (_pending) {
    _seq++;
    const p = _pending;
    _pending = null;
    const triggerMs = (now - p.us) / 1000;
    let input = '';
    // Clutter event time and GLib monotonic time share a clock (ms since boot),
    // so this is the real input-to-paint latency when the trigger came from a
    // pointer/key event.
    if (p.eventMs > 0) {
      const inputMs = now / 1000 - p.eventMs;
      if (inputMs >= 0 && inputMs < 5000) input = ` input→paint ${inputMs.toFixed(1)}ms`;
    }
    diagnosticLog(`[Liquid Glass][open] #${_seq} ${p.label} trigger→paint ` +
      `${triggerMs.toFixed(1)}ms${input}${work ? ` ${work}` : ''}`);
    _trail = TRAIL_FRAMES;
    _trailLabel = `#${_seq}`;
    _trailDeltas = [];
    _trailWork = [];
    return;
  }

  if (_trail > 0) {
    _trail--;
    _trailDeltas.push(sinceLast);
    _trailWork.push(work);
    if (_trail === 0) {
      const parts = _trailDeltas.map((d, i) => {
        const w = _trailWork[i];
        return w ? `${d.toFixed(0)}{${w}}` : d.toFixed(0);
      });
      diagnosticLog(`[Liquid Glass][open] ${_trailLabel} frames [${parts.join(' ')}]`);
    }
  }
}
