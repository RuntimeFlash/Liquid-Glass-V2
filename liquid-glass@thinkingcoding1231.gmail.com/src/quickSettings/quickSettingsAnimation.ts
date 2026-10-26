//
// The Quick Settings open/close transition, written from scratch to behave
// exactly like the panel (clock) menu's stamp animation.
//
// What a "stamp" is here:
//   * On open, the popup is born slightly oversized (openScale, default 1.08),
//     pivoted at its top-centre so it looks like it presses down out of the
//     panel button, and springs down to exactly 1.0 while its content fades in
//     from transparent.
//   * On close the scale is left alone and the popup decays to transparent.
//
// This module owns the *whole* transition: the springs, the frame loop, and the
// single ordered place where scale and opacity are handed to whoever renders the
// glass. Nothing else in the extension is allowed to move the popup or the
// content while a transition is running, which is what makes the liquid glass
// impossible to desynchronise from the content it sits behind.
//
// Two deliberate differences from the older hand-rolled tick:
//
//   1. Fixed-step integration with a *bounded* catch-up. The previous tick fed
//      the real frame delta into the spring (capped at 100 ms, split into up to
//      three 33 ms substeps). When the compositor stalled for ~130 ms on the
//      open frame -- which it did, every single open, while 14 glass backings
//      were rebuilt from scratch -- the spring integrated ~100 ms in one frame
//      and landed on the end state. That teleport is the "flash" that was
//      visible on every open. Here a frame may advance the simulation by at most
//      MAX_STEPS_PER_FRAME fixed steps; any backlog beyond that is dropped
//      rather than repaid, so a stalled frame makes the animation take longer in
//      wall-clock time instead of jumping.
//
//   2. Scale and opacity are applied, then the glass is synced, in that order,
//      inside the same function, on the same frame. There is no window in which
//      the content has moved and the glass has not.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { addFrameTicker, removeFrameTicker, normalizeAnimationIntervalMs, frameStepBudget } from '../animation.js';

/** Fixed simulation step. Two steps make up a 60 Hz frame. */
const STEP_MS = 1000 / 120;

/**
 * Most fixed steps a single frame may pay for. Three steps is 25 ms, so a
 * normal 60 Hz frame (16.7 ms) uses two and a 120 Hz frame uses one; anything
 * slower is deliberately not caught up.
 */
const MAX_STEPS_PER_FRAME = 3;

/** Frame deltas longer than this are treated as a stall and truncated. */
const MAX_FRAME_MS = 50;

/** Closing decay rate (1/s), matching the clock menu's exponential fade-out. */
const CLOSE_DECAY_SPEED = 15.0;

/**
 * The stamp presses down with an ease-out on the way open, and the close leaves
 * with an ease-in. The curves shape the springs' timing rather than replace it,
 * so stiffness, damping and mass keep meaning what they did. Quadratic, not
 * cubic: the springs are already quick off the mark, and a cubic on top of that
 * spent most of the motion in its first handful of frames.
 */
export const easeOutQuad = (t: number) => 1 - (1 - t) ** 2;
export const easeInQuad = (t: number) => t * t;

/** The stamp never shrinks past this, so the shader always has a real size. */
const MIN_OPEN_SCALE = 0.9;

/** Opening fade stops as soon as the spring is this close to rest. */
const OPEN_SETTLE_EPSILON = 0.002;
const OPEN_SETTLE_VELOCITY = 0.03;

/** Closing fade stops once it is this transparent (1 = fully opaque). */
const CLOSE_SETTLE_ALPHA = 0.02;

/**
 * Semi-implicit (symplectic) Euler spring, the same integrator the panel menu
 * uses. Kept local to this module so the animation has no hidden dependencies.
 */
export class Spring {
  private _stiffness: number;
  private _damping: number;
  private _mass: number;

  public value = 0;
  public velocity = 0;
  public target = 0;

  constructor(stiffness: number, damping: number, mass: number) {
    this._stiffness = stiffness;
    this._damping = damping;
    this._mass = mass;
  }

  setParams(stiffness: number, damping: number, mass: number): void {
    this._stiffness = stiffness;
    this._damping = damping;
    this._mass = mass;
  }

  /**
   * Advances the spring by a fixed step.
   *
   * @returns true once the spring is at rest on its target.
   */
  step(stepMs: number): boolean {
    let dt = stepMs / 1000;
    if (dt > 0.033) dt = 0.033;

    const springForce = -this._stiffness * (this.value - this.target);
    const dampingForce = -this._damping * this.velocity;
    const acceleration = (springForce + dampingForce) / this._mass;

    this.velocity += acceleration * dt;
    this.value += this.velocity * dt;

    return Math.abs(this.velocity) < 0.01 &&
      Math.abs(this.value - this.target) < 0.001;
  }
}

/** Everything the animation needs from the manager it drives. */
export interface StampAnimationHost {
  /** The real popup bubble. Its scale carries the stamp. */
  getPopup(): Clutter.Actor | null;
  /** The menu's inner content box. Its opacity carries the fade. */
  getContent(): Clutter.Actor | null;
  /**
   * Called once per animated frame, after scale and opacity have been applied,
   * so the glass can be re-synced against the geometry that will be painted.
   */
  onFrame(scale: number, opacity: number, opening: boolean): void;
  /** Called on the frame the transition begins, before any frame is drawn. */
  onStart(opening: boolean): void;
  /** Called after the end state has been applied and the loop has stopped. */
  onSettled(opening: boolean): void;
  /** False when the manager has been torn down and frames must not continue. */
  isAlive(): boolean;
}

export interface StampAnimationOptions {
  springStiffness: number;
  springDamping: number;
  springMass: number;
  /** Scale the popup is born at on open, settling to 1.0. */
  openScale: number;
  /** Pivot the stamp scales about, in actor-relative (0..1) coordinates. */
  pivotX: number;
  pivotY: number;
}

export class QuickSettingsStampAnimation {
  private _host: StampAnimationHost;
  private _scale: Spring;
  private _opacity: Spring;
  private _openScale: number;
  private _pivotX: number;
  private _pivotY: number;

  private _tickId = 0;
  // The frame interval the animation was asked for, already normalized.
  private _intervalMs = 0;
  private _running = false;
  private _opening = true;
  private _finished = false;
  private _accumulatorMs = 0;
  private _lastTickUs = 0;
  // The opacity the current close started from, so its ease-in can be shaped
  // against it even when the close interrupted an open.
  private _closeFrom = 1;

  constructor(host: StampAnimationHost, options: StampAnimationOptions) {
    this._host = host;
    this._scale = new Spring(
      options.springStiffness, options.springDamping, options.springMass);
    this._opacity = new Spring(
      options.springStiffness, options.springDamping, options.springMass);
    this._openScale = Math.max(1.0, options.openScale);
    this._pivotX = options.pivotX;
    this._pivotY = options.pivotY;
  }

  get isRunning(): boolean { return this._running; }
  get isOpening(): boolean { return this._opening; }
  get openScale(): number { return this._openScale; }

  setSpringParams(stiffness: number, damping: number, mass: number): void {
    this._scale.setParams(stiffness, damping, mass);
    this._opacity.setParams(stiffness, damping, mass);
  }

  setOpenScale(openScale: number): void {
    this._openScale = Math.max(1.0, openScale);
  }

  /**
   * Caps how often the animation is stepped, in the same units as the menus'
   * animation-interval setting. A running animation picks the new rate up at
   * once, so the preference applies without a restart.
   */
  setIntervalMs(intervalMs: number): void {
    const normalized = normalizeAnimationIntervalMs(intervalMs);
    if (normalized === this._intervalMs) return;
    this._intervalMs = normalized;
    if (this._running) this._armTick();
  }

  /**
   * Puts the popup into its "about to open" state *before* it is shown, so the
   * very first frame that reaches the screen is already stamped and already has
   * glass over it. Returns false when there is nothing to stamp.
   *
   * Must be called after the popup has been positioned for this open.
   */
  prepareOpen(): boolean {
    const popup = this._host.getPopup();
    if (!popup) return false;

    this._cancelTick();
    this._running = false;
    this._finished = false;
    this._accumulatorMs = 0;

    popup.set_pivot_point(this._pivotX, this._pivotY);
    popup.set_scale(this._openScale, this._openScale);

    const content = this._host.getContent();
    if (content) content.opacity = 0;

    return true;
  }

  /** Starts (or restarts) the transition in the given direction. */
  start(opening: boolean): void {
    this._cancelTick();
    this._opening = opening;
    this._finished = false;
    this._accumulatorMs = 0;

    if (opening) {
      this._scale.value = this._openScale;
      this._scale.velocity = 0;
      this._scale.target = 1;
      this._opacity.value = 0;
      this._opacity.velocity = 0;
      this._opacity.target = 1;
    } else {
      // Fade out from wherever the open left things; the scale stays at 1.
      this._scale.value = 1;
      this._scale.velocity = 0;
      this._scale.target = 1;
      this._opacity.value = this._currentOpacity();
      this._closeFrom = Math.max(CLOSE_SETTLE_ALPHA, this._opacity.value);
      this._opacity.velocity = 0;
      this._opacity.target = 0;
    }

    this._running = true;
    this._host.onStart(opening);

    // Apply frame zero immediately. The popup is about to be shown (open) or is
    // still on screen (close); giving it its start state here removes any
    // one-frame window where it is painted at the wrong size or opacity.
    this._applyFrame();
    if (!this._running) return;

    this._lastTickUs = GLib.get_monotonic_time();
    this._armTick();
  }

  /**
   * Ends the transition immediately, applying the end state without animating.
   * Used when the manager takes over a hand-off (submenu transitions) and by
   * teardown paths.
   */
  finish(endStateOpen: boolean): void {
    this._cancelTick();
    this._running = false;
    this._finished = true;
    this._opening = endStateOpen;
    this._accumulatorMs = 0;

    this._scale.value = 1;
    this._scale.velocity = 0;
    this._scale.target = 1;
    this._opacity.value = endStateOpen ? 1 : 0;
    this._opacity.velocity = 0;
    this._opacity.target = endStateOpen ? 1 : 0;

    const popup = this._host.getPopup();
    if (popup) {
      popup.set_scale(1, 1);
      if (endStateOpen) popup.set_pivot_point(this._pivotX, this._pivotY);
    }
    const content = this._host.getContent();
    if (content) content.opacity = endStateOpen ? 255 : 0;
    try { this._host.onFrame(1, endStateOpen ? 255 : 0, endStateOpen); } catch (e) {}
  }

  /** Stops the loop without touching the actors. */
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
    this._cancelTick();
    // The shared frame ticker keeps the frame clock running while the
    // animation lives and steps it at most once per frame, skipping the frames
    // the interval says it may: writing the popup less often is what keeps the
    // glass under it from re-rendering on every frame of a slow CPU.
    this._tickId = addFrameTicker(() => {
      this._onTick();
      return this._running;
    }, this._intervalMs);
  }

  private _cancelTick(): void {
    if (this._tickId === 0) return;
    const id = this._tickId;
    this._tickId = 0;
    removeFrameTicker(id);
  }

  private _onTick(): void {
    if (!this._running) return;

    const now = GLib.get_monotonic_time();
    let elapsedMs = (now - this._lastTickUs) / 1000;
    this._lastTickUs = now;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) elapsedMs = STEP_MS;
    if (elapsedMs > MAX_FRAME_MS) elapsedMs = MAX_FRAME_MS;

    // Fixed-step integration. The backlog beyond what this frame is allowed to
    // pay for is dropped: repaying it is what used to make a stalled frame jump
    // straight to the end of the spring.
    this._accumulatorMs += elapsedMs;
    const maxSteps = frameStepBudget(this._intervalMs, STEP_MS, MAX_FRAME_MS, MAX_STEPS_PER_FRAME);
    let steps = 0;
    while (this._accumulatorMs >= STEP_MS && steps < maxSteps) {
      this._step(STEP_MS);
      this._accumulatorMs -= STEP_MS;
      steps++;
    }
    if (this._accumulatorMs > STEP_MS) this._accumulatorMs = 0;

    this._applyFrame();
  }

  /** Advances the springs by one fixed step and decides whether we are done. */
  private _step(stepMs: number): void {
    if (this._opening) {
      const scaleAtRest = this._scale.step(stepMs);
      const opacityAtRest = this._opacity.step(stepMs);

      // Magnet: snap onto exactly 1.0 once the bounce is imperceptible, so the
      // menu never settles on 0.9987 and leaves text slightly resampled.
      if (Math.abs(1 - this._scale.value) < OPEN_SETTLE_EPSILON &&
          Math.abs(this._scale.velocity) < OPEN_SETTLE_VELOCITY) {
        this._scale.value = 1;
        this._scale.velocity = 0;
        this._opacity.value = 1;
        this._opacity.velocity = 0;
        this._finished = true;
        return;
      }

      if (scaleAtRest && opacityAtRest) {
        this._scale.value = 1;
        this._opacity.value = 1;
        this._finished = true;
      }
      return;
    }

    // Closing: plain exponential decay, no bounce, no motion.
    const decay = 1 - Math.exp(-CLOSE_DECAY_SPEED * (stepMs / 1000));
    this._opacity.value += (0 - this._opacity.value) * decay;
    this._scale.value = 1;

    if (this._opacity.value < CLOSE_SETTLE_ALPHA) {
      this._opacity.value = 0;
      this._finished = true;
    }
  }

  /** Writes the current spring state onto the actors, then syncs the glass. */
  private _applyFrame(): void {
    const host = this._host;
    const popup = host.getPopup();
    const content = host.getContent();
    if (!popup || !content || !host.isAlive()) {
      this._cancelTick();
      this._running = false;
      return;
    }

    let scale: number;
    let opacity: number;

    if (this._opening) {
      // NOTE: the scale spring deliberately runs above 1.0 -- it starts at
      // openScale and settles down. Clamping it to [0, 1] here would pin the
      // whole stamp at 1.0 and the menu would simply appear at full size.
      const span = 1 - this._openScale;
      const spring = finiteOr(this._scale.value, this._openScale);
      const progress = Math.abs(span) > 0.0001 ? clamp01((spring - this._openScale) / span) : 1;
      scale = Math.max(MIN_OPEN_SCALE, this._openScale + span * easeOutQuad(progress));
      opacity = Math.round(easeOutQuad(clamp01(this._opacity.value)) * 255);
    } else {
      scale = 1;
      const from = Math.max(CLOSE_SETTLE_ALPHA, this._closeFrom);
      const progress = clamp01(1 - finiteOr(this._opacity.value, 0) / from);
      opacity = Math.round(clamp01(from * (1 - easeInQuad(progress))) * 255);
    }

    if (this._finished) {
      if (this._opening) { scale = 1; opacity = 255; }
      else { scale = 1; opacity = 0; }
    }

    popup.set_scale(scale, scale);
    content.opacity = opacity;

    try {
      host.onFrame(scale, opacity, this._opening);
    } catch (e) {}

    if (!this._finished) return;

    // Settled. Apply the exact end state, then hand control back once.
    this._running = false;
    this._cancelTick();
    this._accumulatorMs = 0;

    if (this._opening) {
      popup.set_scale(1, 1);
      content.opacity = 255;
    } else {
      popup.set_scale(1, 1);
      content.opacity = 0;
    }

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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
