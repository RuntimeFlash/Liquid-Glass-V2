// src/submenuAnimation.ts
//
// The floating submenu's open/close transition, written from scratch.
//
// What was wrong with the version this replaces
// ---------------------------------------------
// The old path drove the panel with two Clutter `ease()` calls on a single
// "transition root" (opacity 0->255 and scale 0.96->1.0 over 200ms) and hoped
// for the best. Measured on this machine, an open produced exactly *three*
// distinct geometry states, 1232ms apart:
//
//     t=5538ms  root 1216,41 360x390  scale 0.960  opacity 0
//     t=6770ms  root 1216,41 360x153  scale 1.000  opacity 255
//
// i.e. the panel was built at a placeholder height, and by the next frame that
// reached the screen the ease had already run to completion off-screen. Over
// the same window the frame interval was 33ms median (49ms p90, 533ms worst)
// against a 12.5ms budget. Two separate causes:
//
//   1. The panel's real height was only known after the content had been laid
//      out, so `syncHeight` resized the root *after* the open had started. Any
//      resize during the ease is a visible jump, and it also reallocated the
//      shader's render targets.
//   2. Everything was built synchronously on the open frame -- the glass
//      effect, a wallpaper clone, clones of every window, and the row widgets.
//      The compositor then stalled long enough to swallow the whole animation.
//
// What this module does instead
// -----------------------------
//   * It owns the transition. Nothing else may move the panel while it runs.
//   * The panel is sized *before* the animation begins (measure-then-animate),
//     so the rect is constant for every frame of the transition and there is no
//     resize to jump on. The host guarantees this by calling `prepare()` with a
//     fully laid out, already-correct geometry.
//   * Time is integrated in fixed steps with a bounded catch-up. A frame that
//     stalls (and on a software-rendered shell they do) makes the animation
//     take longer in wall-clock time; it can never teleport to the end state.
//     That teleport is precisely what the old ease did.
//   * Scale and opacity are applied to the panel, and the backdrop is synced
//     against that exact geometry, in that order, inside one function on one
//     frame. There is no window in which the panel has moved and the frost
//     behind it has not.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

/** Fixed simulation step: two steps per 60Hz frame, one per 120Hz frame. */
const STEP_MS = 1000 / 120;

/**
 * Most fixed steps one frame may pay for. Three steps is 25ms, so a 60Hz frame
 * uses two. A frame slower than that deliberately does not catch up: repaying
 * a stall is what makes an animation jump.
 */
const MAX_STEPS_PER_FRAME = 3;

/** Frame deltas beyond this are a stall, not elapsed animation time. */
const MAX_FRAME_MS = 50;

/**
 * Two ticks closer together than this belong to the same painted frame. At
 * 80Hz a real frame is 12.5ms, so 4ms is comfortably inside one frame while
 * still allowing a genuinely faster display to step every frame.
 */
const FRAME_DEDUPE_US = 4000;

/** Opening spring, matching the Quick Settings stamp's feel. */
const OPEN_STIFFNESS = 320;
const OPEN_DAMPING = 30;
const OPEN_MASS = 1;

/** Opening scale: the panel is born this much oversized and settles to 1. */
const OPEN_START_SCALE = 0.965;

/** Closing behaviour: plain exponential decay, no motion, no overshoot. */
const CLOSE_SETTLE_ALPHA = 0.02;
/**
 * The close fade is deliberately the same length as the Quick Settings return
 * entrance (QS_RETURN_DURATION_MS): the submenu fades out while Quick Settings
 * fades and rises in behind it, so the two surfaces crossfade on one timeline
 * instead of running back to back. The decay speed is derived from the duration
 * so the fade reaches CLOSE_SETTLE_ALPHA exactly at the end.
 */
const CLOSE_DURATION_MS = 160;
const CLOSE_DECAY_SPEED = -Math.log(CLOSE_SETTLE_ALPHA) / (CLOSE_DURATION_MS / 1000);

/** Snap onto exactly 1.0 once the bounce is imperceptible. */
const OPEN_SETTLE_EPSILON = 0.0015;
const OPEN_SETTLE_VELOCITY = 0.03;

/** The panel never scales below this, so the shader always has a real size. */
const MIN_SCALE = 0.85;

/**
 * Semi-implicit (symplectic) Euler spring -- the same integrator the shell's
 * own panel menus use. Local so the transition has no hidden dependencies.
 */
class Spring {
  private _k: number;
  private _c: number;
  private _m: number;

  value = 0;
  velocity = 0;
  target = 0;

  constructor(k: number, c: number, m: number) {
    this._k = k;
    this._c = c;
    this._m = m;
  }

  setTarget(target: number): void {
    this.target = target;
  }

  snapTo(value: number): void {
    this.value = value;
    this.velocity = 0;
  }

  /** Advances one fixed step; returns true once at rest on the target. */
  step(stepMs: number): boolean {
    let dt = Math.min(stepMs / 1000, 0.033);
    const force = -this._k * (this.value - this.target) - this._c * this.velocity;
    this.velocity += (force / this._m) * dt;
    this.value += this.velocity * dt;
    return Math.abs(this.velocity) < 0.01 && Math.abs(this.value - this.target) < 0.001;
  }
}

/** Everything the transition needs from the panel that owns it. */
export interface SubmenuAnimationHost {
  /** The actor whose scale carries the transition. Set to null when gone. */
  getRoot(): Clutter.Actor | null;
  /** The content whose opacity carries the fade (the panel's inner box). */
  getContent(): Clutter.Actor | null;
  /** The glass backing; fades in lockstep with the content. */
  getGlass?(): Clutter.Actor | null;
  /** The scrim, faded independently of the panel. */
  getScrim(): Clutter.Actor | null;
  /**
   * Called once per animated frame, after scale and opacity have been applied,
   * so the frosted backdrop can be re-synced against the geometry that will
   * actually be painted.
   */
  onFrame(scale: number, opacity: number, opening: boolean): void;
  /** Called on the frame the transition begins, before anything is drawn. */
  onStart(opening: boolean): void;
  /** Called after the end state is applied and the loop has stopped. */
  onSettled(opening: boolean): void;
  /** False when the panel has been torn down; frames must then stop. */
  isAlive(): boolean;
}

export class SubmenuAnimation {
  private _host: SubmenuAnimationHost;
  private _scale: Spring;
  private _opacity = 0;

  private _tickId = 0;
  // Serial of the compositor frame the last step ran in. BEFORE_REDRAW laters
  // can be drained more than once per redraw, so without this the loop burns
  // several iterations on a single frame -- advancing the simulation in bursts
  // (several steps back to back) instead of once per painted frame.
  private _lastTickFrameUs = 0;
  private _running = false;
  private _opening = true;
  private _finished = false;
  private _accumulatorMs = 0;
  private _lastTickUs = 0;

  constructor(host: SubmenuAnimationHost) {
    this._host = host;
    this._scale = new Spring(OPEN_STIFFNESS, OPEN_DAMPING, OPEN_MASS);
  }

  get isRunning(): boolean { return this._running; }
  get isOpening(): boolean { return this._opening; }

  /**
   * Puts the panel into its pre-open state *before* it is shown: scaled down,
   * fully transparent, scrim dark but invisible. The host calls this after the
   * panel has its final geometry, so the first frame that reaches the screen is
   * already correct and there is nothing left to resize.
   */
  prepare(): boolean {
    const root = this._host.getRoot();
    if (!root) return false;

    this._cancelTick();
    this._running = false;
    this._finished = false;
    this._accumulatorMs = 0;

    root.remove_all_transitions?.();
    root.set_pivot_point(0.5, 0.0);
    root.set_scale(OPEN_START_SCALE, OPEN_START_SCALE);
    root.opacity = 255;

    const content = this._host.getContent();
    if (content) {
      content.remove_all_transitions?.();
      content.opacity = 0;
    }
    const glass = this._host.getGlass?.();
    if (glass) {
      glass.remove_all_transitions?.();
      glass.opacity = 0;
    }
    const scrim = this._host.getScrim();
    if (scrim) {
      scrim.remove_all_transitions?.();
      scrim.opacity = 0;
    }
    return true;
  }

  /** Starts (or restarts) the transition in the given direction. */
  start(opening: boolean): void {
    this._cancelTick();
    this._opening = opening;
    this._finished = false;
    this._accumulatorMs = 0;

    if (opening) {
      this._scale.snapTo(OPEN_START_SCALE);
      this._scale.setTarget(1);
      this._opacity = 0;
    } else {
      // Fade out from wherever the open left things; no motion on close.
      this._scale.snapTo(1);
      this._scale.setTarget(1);
      this._opacity = this._currentOpacity();
    }

    this._running = true;
    this._lastTickFrameUs = 0;
    this._host.onStart(opening);

    // Frame zero, applied immediately. The panel is already on screen (or is
    // about to be shown this same frame), so this removes any one-frame window
    // where it would be painted at the wrong size or opacity.
    this._applyFrame();
    if (!this._running) return;

    this._lastTickUs = GLib.get_monotonic_time();
    this._armTick();
  }

  /** Applies the end state immediately, without animating. */
  finish(endStateOpen: boolean): void {
    this._cancelTick();
    this._running = false;
    this._finished = true;
    this._opening = endStateOpen;
    this._accumulatorMs = 0;

    this._scale.snapTo(1);
    this._scale.setTarget(1);
    this._opacity = endStateOpen ? 1 : 0;

    const root = this._host.getRoot();
    if (root) {
      root.remove_all_transitions?.();
      root.set_scale(1, 1);
      root.opacity = 255;
    }
    const content = this._host.getContent();
    if (content) content.opacity = endStateOpen ? 255 : 0;
    const glass = this._host.getGlass?.();
    if (glass) glass.opacity = endStateOpen ? 255 : 0;
    const scrim = this._host.getScrim();
    if (scrim) scrim.opacity = endStateOpen ? SCRIM_TARGET_OPACITY : 0;

    try { this._host.onFrame(1, endStateOpen ? 255 : 0, endStateOpen); } catch (e) {}
  }

  /** Stops the loop without touching any actor. */
  stop(): void {
    this._cancelTick();
    this._running = false;
    this._accumulatorMs = 0;
  }

  destroy(): void {
    this.stop();
  }

  // ---- frame loop -------------------------------------------------------

  private _armTick(): void {
    const laters = (global as any).compositor?.get_laters?.();
    if (laters) {
      this._tickId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
        this._onTick();
        return GLib.SOURCE_REMOVE;
      });
      return;
    }
    this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8, () => {
      this._onTick();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _cancelTick(): void {
    if (this._tickId === 0) return;
    const id = this._tickId;
    this._tickId = 0;
    try {
      const laters = (global as any).compositor?.get_laters?.();
      if (laters) laters.remove(id);
      else GLib.source_remove(id);
    } catch (e) {}
  }

  private _onTick(): void {
    if (!this._running) return;

    const now = GLib.get_monotonic_time();
    // DEV-PROBE-START
    try {
      const g = global as any;
      if (g.__LGAnim) g.__LGAnim.ticks.push(now);
    } catch (e) {}
    // DEV-PROBE-END
    // One step per compositor frame. The laters list can be drained again
    // within the same redraw; running the integrator for those repeats is what
    // produced bursts of 0.1ms-spaced ticks.
    if (now - this._lastTickFrameUs < FRAME_DEDUPE_US) {
      this._armTick();
      return;
    }
    this._lastTickFrameUs = now;
    let elapsedMs = (now - this._lastTickUs) / 1000;
    this._lastTickUs = now;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) elapsedMs = STEP_MS;
    // A stall contributes at most one frame's worth. This is the whole point:
    // the old code fed the full delta to the ease, so a 500ms stall finished a
    // 200ms animation instantly and the panel appeared already at rest.
    if (elapsedMs > MAX_FRAME_MS) elapsedMs = MAX_FRAME_MS;

    this._accumulatorMs += elapsedMs;
    let steps = 0;
    while (this._accumulatorMs >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      this._step(STEP_MS);
      this._accumulatorMs -= STEP_MS;
      steps++;
    }
    // Anything still owed beyond this frame's budget is dropped, not repaid.
    if (this._accumulatorMs > STEP_MS) this._accumulatorMs = 0;

    this._applyFrame();
    if (!this._running) return;

    this._armTick();
  }

  private _step(stepMs: number): void {
    if (this._opening) {
      const atRest = this._scale.step(stepMs);
      // Opacity rides a plain decay toward 1, fast enough to be done with the
      // spring but slow enough to read as a fade rather than a cut.
      const decay = 1 - Math.exp(-18.0 * (stepMs / 1000));
      this._opacity += (1 - this._opacity) * decay;

      if (Math.abs(1 - this._scale.value) < OPEN_SETTLE_EPSILON &&
          Math.abs(this._scale.velocity) < OPEN_SETTLE_VELOCITY) {
        this._scale.snapTo(1);
        this._opacity = 1;
        this._finished = true;
        return;
      }
      if (atRest && this._opacity > 1 - OPEN_SETTLE_EPSILON) {
        this._scale.snapTo(1);
        this._opacity = 1;
        this._finished = true;
      }
      return;
    }

    // Closing: exponential decay only.
    const decay = 1 - Math.exp(-CLOSE_DECAY_SPEED * (stepMs / 1000));
    this._opacity += (0 - this._opacity) * decay;
    this._scale.snapTo(1);
    if (this._opacity < CLOSE_SETTLE_ALPHA) {
      this._opacity = 0;
      this._finished = true;
    }
  }

  /** Writes the current state onto the actors, then syncs the backdrop. */
  private _applyFrame(): void {
    const host = this._host;
    const root = host.getRoot();
    const content = host.getContent();
    if (!root || !host.isAlive()) {
      this._cancelTick();
      this._running = false;
      return;
    }

    let scale: number;
    let opacity: number;

    if (this._opening) {
      scale = Math.max(MIN_SCALE, finiteOr(this._scale.value, OPEN_START_SCALE));
      opacity = clamp01(this._opacity);
    } else {
      scale = 1;
      opacity = clamp01(this._opacity);
    }

    if (this._finished) {
      scale = 1;
      opacity = this._opening ? 1 : 0;
    }

    root.set_scale(scale, scale);
    if (content) content.opacity = Math.round(opacity * 255);
    const glass = host.getGlass?.();
    if (glass) glass.opacity = Math.round(opacity * 255);

    // The scrim follows the panel's fade but stops short of full black, so the
    // desktop stays legible behind the frost.
    const scrim = host.getScrim();
    if (scrim) scrim.opacity = Math.round(opacity * SCRIM_TARGET_OPACITY);

    // DEV-PROBE-START
    try {
      const g = global as any;
      if (g.__LGAnim) {
        g.__LGAnim.frames.push({
          us: GLib.get_monotonic_time(), scale: +scale.toFixed(4),
          opacity: Math.round(opacity * 255), opening: this._opening,
          finished: this._finished,
        });
      }
    } catch (e) {}
    // DEV-PROBE-END

    try {
      host.onFrame(scale, Math.round(opacity * 255), this._opening);
    } catch (e) {}

    if (!this._finished) return;

    this._running = false;
    this._cancelTick();
    this._accumulatorMs = 0;

    root.set_scale(1, 1);
    if (content) content.opacity = this._opening ? 255 : 0;
    if (glass) glass.opacity = this._opening ? 255 : 0;
    if (scrim) scrim.opacity = this._opening ? SCRIM_TARGET_OPACITY : 0;

    try {
      host.onSettled(this._opening);
    } catch (e) {}
  }

  private _currentOpacity(): number {
    const content = this._host.getContent();
    if (!content) return 1;
    const value = content.opacity / 255;
    return Number.isFinite(value) ? clamp01(value) : 1;
  }
}

/** Scrim strength at full open: dark enough to lift the panel off the desktop. */
export const SCRIM_TARGET_OPACITY = 140;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}