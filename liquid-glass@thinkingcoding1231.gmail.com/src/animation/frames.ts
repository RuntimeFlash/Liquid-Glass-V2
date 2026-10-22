import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { reportFrameLoopError } from '../logger.js';

export const SAME_FRAME_WINDOW_US = 4000;

// Diagnostic switch (global._lgGlass.freezeSync): every per-frame sync tick
// keeps rescheduling but does no work, so the cost of the sync itself can be
// measured. The glass stops following anything that moves while it is on.
let _frameSyncFrozen = false;

export function setFrameSyncFrozen(frozen: boolean): void {
  _frameSyncFrozen = !!frozen;
}

export function isFrameSyncFrozen(): boolean {
  return _frameSyncFrozen;
}

export type IdSlot = { get(): number; set(id: number): void };

export function addBeforeRedraw(callback: GLib.SourceFunc): number {
  return global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, callback);
}

export function removeBeforeRedraw(id: number): void {
  if (!id) return;
  global.compositor.get_laters().remove(id);
}

export type LaterLoop = {
  alive: () => boolean;
  step: () => void;
  errorTag: string;
  honourFreeze?: boolean;
};

// A self-rescheduling BEFORE_REDRAW chain. The next tick is scheduled before
// step() runs, so an exception in step() is reported (rate-limited) instead of
// silently ending the chain and freezing the glass.
export function startLaterLoop(slot: IdSlot, loop: LaterLoop): boolean {
  if (slot.get() !== 0) return false;
  const tick = (): boolean => {
    slot.set(0);
    if (!loop.alive()) return GLib.SOURCE_REMOVE;
    slot.set(addBeforeRedraw(tick));
    if (loop.honourFreeze && isFrameSyncFrozen()) return GLib.SOURCE_REMOVE;
    try {
      loop.step();
    } catch (e) {
      reportFrameLoopError(loop.errorTag, e);
    }
    return GLib.SOURCE_REMOVE;
  };
  slot.set(addBeforeRedraw(tick));
  return true;
}

export function stopLaterLoop(slot: IdSlot): void {
  const id = slot.get();
  slot.set(0);
  removeBeforeRedraw(id);
}

// Follows the stage's own frames instead of requesting them, so an idle
// desktop does not keep the frame clock running. `first` covers the frame in
// which the loop starts.
export function startStageLoop(signal: IdSlot, first: IdSlot, tick: () => void): boolean {
  if (signal.get() !== 0) return false;
  signal.set(global.stage.connect('before-update', tick));
  first.set(addBeforeRedraw(() => {
    first.set(0);
    tick();
    return GLib.SOURCE_REMOVE;
  }));
  return true;
}

export function stopStageLoop(signal: IdSlot, first: IdSlot): void {
  const signalId = signal.get();
  signal.set(0);
  if (signalId) global.stage.disconnect(signalId);
  stopLaterLoop(first);
}

/**
 * startStageLoop() for a manager's per-frame sync, taking the same loop as
 * startLaterLoop(). `step` runs at most once per frame (several stage views
 * update in the same one), and the loop stops itself once `alive()` is false.
 * Exceptions are reported rate-limited, and the loop keeps running.
 */
export function startSyncLoop(signal: IdSlot, first: IdSlot, loop: LaterLoop): boolean {
  let lastUs = 0;
  return startStageLoop(signal, first, () => {
    if (!loop.alive()) {
      stopStageLoop(signal, first);
      return;
    }
    if (loop.honourFreeze && isFrameSyncFrozen()) return;
    const nowUs = GLib.get_monotonic_time();
    if (nowUs - lastUs < SAME_FRAME_WINDOW_US) return;
    lastUs = nowUs;
    try {
      loop.step();
    } catch (e) {
      reportFrameLoopError(loop.errorTag, e);
    }
  });
}

const MAX_INTERVAL_MS = 50;

type Ticker = { laterId: number, cb: () => boolean, minUs: number, last: number };

let _nextId = 0;
const _tickers: Map<number, Ticker> = new Map();

// Steps an animation at most once per frame from a BEFORE_REDRAW later, which
// also keeps the frame clock running while the animation lives. A GLib timer
// would beat against the frame; smoothness comes from sub-stepping the physics
// (Spring.update()), not from writing the actors more often. `cb` returns true
// to keep going; the returned id stays valid across the reschedules.
export function addFrameTicker(cb: () => boolean, minIntervalMs: number = 0): number {
  const id = ++_nextId;
  const ticker: Ticker = { laterId: 0, cb, minUs: Math.max(0, minIntervalMs || 0) * 1000, last: 0 };
  _tickers.set(id, ticker);
  const schedule = () => {
    ticker.laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      ticker.laterId = 0;
      if (_tickers.get(id) !== ticker) return GLib.SOURCE_REMOVE;
      let keep = true;
      const now = GLib.get_monotonic_time();
      // At most once per frame even when several stage views update in the
      // same one (SAME_FRAME_WINDOW_US), and a little slack so a 16ms minimum
      // does not drop a frame whose interval happened to measure 15.9ms.
      const due = ticker.last === 0 ||
        now - ticker.last >= Math.max(SAME_FRAME_WINDOW_US, ticker.minUs - SAME_FRAME_WINDOW_US);
      if (due) {
        ticker.last = now;
        try {
          keep = !!ticker.cb();
        } catch (e) {
          keep = false;
          reportFrameLoopError('frameTicker', e);
        }
      }
      if (_tickers.get(id) !== ticker) return GLib.SOURCE_REMOVE;
      if (keep) schedule();
      else _tickers.delete(id);
      return GLib.SOURCE_REMOVE;
    });
  };
  schedule();
  return id;
}

export function removeFrameTicker(id: number): void {
  const ticker = _tickers.get(id);
  if (!ticker) return;
  _tickers.delete(id);
  if (!ticker.laterId) return;
  global.compositor.get_laters().remove(ticker.laterId);
  ticker.laterId = 0;
}

/**
 * Maps animation-interval-ms onto what a frame-driven animation can do:
 * anything up to one 60Hz frame means every frame (0); larger values cap the
 * frame rate, bounded to what the preferences offer.
 */
export function normalizeAnimationIntervalMs(v: number): number {
  if (!Number.isFinite(v) || v <= 16) return 0;
  return Math.min(Math.round(v), MAX_INTERVAL_MS);
}
