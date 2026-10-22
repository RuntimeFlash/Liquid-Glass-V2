// The longest frame the physics follows in full. It covers the 20fps cap the
// preferences offer, so a capped animation keeps its speed; longer gaps (a
// stall) are clamped instead of jumped over.
export const MAX_STEP_S = 0.066;
const SUB_STEP_S = 0.002;

// Damped spring (Hooke's law), integrated with semi-implicit Euler.
export class Spring {
  private stiffness: number;
  private damping: number;
  private mass: number;
  public value: number;
  public velocity: number;
  public target: number;

  constructor(stiffness: number, damping: number, mass: number) {
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;

    this.value = 0;
    this.velocity = 0;
    this.target = 0;
  }

  updateParams(stiffness: number, damping: number, mass: number) {
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
  }

  update(elapsedMs: number) {
    let dt = elapsedMs / 1000;
    if (dt > MAX_STEP_S) dt = MAX_STEP_S;

    // Sub-stepped: with the stiffness the preferences allow, a whole frame is
    // not a stable step for an explicit integrator.
    const mass = this.mass > 1e-3 ? this.mass : 1e-3;
    let remaining = dt;
    while (remaining > 1e-6) {
      const h = Math.min(remaining, SUB_STEP_S);
      const springForce = -this.stiffness * (this.value - this.target);
      const dampingForce = -this.damping * this.velocity;
      const acceleration = (springForce + dampingForce) / mass;

      this.velocity += acceleration * h;
      this.value += this.velocity * h;
      remaining -= h;
    }

    // Settled.
    return Math.abs(this.velocity) < 0.01 && Math.abs(this.value - this.target) < 0.001;
  }
}

// A spring described by response (period, seconds) and damping fraction, as
// SwiftUI does, solved analytically so it cannot diverge at any stiffness.
export class SwiftSpring {
  response = 0.4;
  dampingFraction = 0.7;
  mass = 1.0;

  value = 0;
  velocity = 0;
  target = 0;

  constructor(response: number, dampingFraction: number, mass: number = 1.0) {
    this.updateParams(response, dampingFraction, mass);
  }

  // Out-of-range values (including NaN) keep the previous parameter.
  updateParams(response: number, dampingFraction: number, mass: number = 1.0) {
    if (response > 0.01) this.response = response;
    if (dampingFraction >= 0) this.dampingFraction = dampingFraction;
    if (mass > 0.01) this.mass = mass;
  }

  update(elapsedMs: number): boolean {
    let dt = elapsedMs / 1000;

    if (!(dt > 0)) return false;
    if (dt > 0.1) dt = 0.1;

    if (!Number.isFinite(this.value) || !Number.isFinite(this.velocity)) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }

    const x0 = this.value - this.target;
    const v0 = this.velocity;

    if (Math.abs(x0) < 0.001 && Math.abs(v0) < 0.001) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }

    const omega0 = (2 * Math.PI) / this.response;
    const zeta = this.dampingFraction;

    let x_t = 0;
    let v_t = 0;

    if (zeta < 0.999) {
      // Underdamped
      const omegaD = omega0 * Math.sqrt(1.0 - zeta * zeta);
      const alpha = zeta * omega0;
      const exp = Math.exp(-alpha * dt);
      const cos = Math.cos(omegaD * dt);
      const sin = Math.sin(omegaD * dt);

      x_t = exp * (x0 * cos + ((v0 + alpha * x0) / omegaD) * sin);
      v_t = exp * (v0 * cos - ((alpha * v0 + omega0 * omega0 * x0) / omegaD) * sin);
    } else if (zeta > 1.001) {
      // Overdamped
      const beta = omega0 * Math.sqrt(zeta * zeta - 1.0);
      const gamma1 = -zeta * omega0 + beta;
      const gamma2 = -zeta * omega0 - beta;
      const exp1 = Math.exp(gamma1 * dt);
      const exp2 = Math.exp(gamma2 * dt);

      const c1 = (v0 - gamma2 * x0) / (gamma1 - gamma2);
      const c2 = x0 - c1;

      x_t = c1 * exp1 + c2 * exp2;
      v_t = c1 * gamma1 * exp1 + c2 * gamma2 * exp2;
    } else {
      // Critically damped
      const exp = Math.exp(-omega0 * dt);
      x_t = exp * (x0 + (v0 + omega0 * x0) * dt);
      v_t = exp * (v0 - omega0 * (v0 + omega0 * x0) * dt);
    }

    this.value = x_t + this.target;
    this.velocity = v_t;

    if (!Number.isFinite(this.value)) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    this.value = Math.max(-0.5, Math.min(2.5, this.value));

    if (Math.abs(this.value - this.target) < 0.001 && Math.abs(this.velocity) < 0.001) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }

    return false;
  }
}

/**
 * A rectangle carried to each new target by a spring, so it swings a little past it and settles, as liquid
 * does. `rect()` steps the spring to the time it is given.
 */
export class RectSpring {
  private _from: number[];
  private _to: number[];
  private _progress: SwiftSpring;
  private _lastUs = 0;

  constructor(rect: number[], response = 0.42, dampingFraction = 0.72) {
    this._from = [...rect];
    this._to = [...rect];
    this._progress = new SwiftSpring(response, dampingFraction);
    this._progress.value = 1;
    this._progress.target = 1;
  }

  setTarget(target: number[], nowUs: number): void {
    if (target.every((v, i) => Math.abs(v - this._to[i]) < 0.5)) return;
    this._from = this.rect(nowUs);
    this._to = [...target];
    this._progress.value = 0;
    this._progress.velocity = 0;
  }

  rect(nowUs: number): number[] {
    if (this._lastUs) this._progress.update((nowUs - this._lastUs) / 1000);
    this._lastUs = nowUs;
    const p = this._progress.value;
    return this._from.map((v, i) => v + (this._to[i] - v) * p);
  }

  settled(): boolean {
    return this._progress.value === this._progress.target && this._progress.velocity === 0;
  }
}

const CLOSE_SPEED = 15.0;
const CLOSED_BELOW = 0.005;
const OPEN_SNAP_DISTANCE = 0.002;
const OPEN_SNAP_VELOCITY = 0.03;

export interface MenuSpring {
  value: number;
  velocity: number;
  target: number;
  update(elapsedMs: number): boolean;
}

export interface MenuFrame {
  closing: boolean;
  stopped: boolean;
  scale: number;
  opacity: number;
}

function clampOpacity(v: number): number {
  return Math.min(255, Math.max(0, v));
}

// Closing uses exponential decay: faster than the spring and never bounces.
function stepClosing(scale: MenuSpring, elapsedMs: number): { s: number, stopped: boolean } {
  const dt = Math.min(elapsedMs / 1000, MAX_STEP_S);
  const k = 1.0 - Math.exp(-CLOSE_SPEED * dt);
  scale.value += (0 - scale.value) * k;
  if (scale.value < CLOSED_BELOW) return { s: 0, stopped: true };
  return { s: scale.value, stopped: false };
}

// Opening uses the spring, which gives the bounce.
function stepOpening(scale: MenuSpring, elapsedMs: number): { s: number, stopped: boolean } {
  const settled = scale.update(elapsedMs);
  const s = scale.value;
  // Snap to 1.0 once the bounce has almost settled, instead of micro-stepping forever.
  if (Math.abs(1.0 - s) < OPEN_SNAP_DISTANCE && Math.abs(scale.velocity) < OPEN_SNAP_VELOCITY)
    return { s: 1.0, stopped: true };
  return { s, stopped: settled };
}

export function stepMenuSpring(scale: MenuSpring, elapsedMs: number): MenuFrame {
  const closing = scale.target === 0;
  const { s, stopped } = closing ? stepClosing(scale, elapsedMs) : stepOpening(scale, elapsedMs);
  // Scale 0 crashes Cogl, hence the 0.001 floor. Opacity fades out between
  // scale 1.0 and 0.3, ahead of the shrink.
  if (closing)
    return { closing, stopped, scale: Math.max(0.001, s), opacity: clampOpacity((s - 0.3) / 0.7 * 255) };
  return { closing, stopped, scale: 0.2 + s * 0.8, opacity: clampOpacity((s / 0.3) * 255) };
}

export function applyMenuFrame(frame: MenuFrame, animActor: any, glass: any, menuActor: any, sync: () => void): void {
  animActor.set_scale(frame.scale, frame.scale);
  glass.opacity = frame.opacity;
  animActor.opacity = frame.opacity;
  sync();
  if (!frame.stopped) return;
  if (frame.closing) {
    if (!menuActor) return;
    menuActor.hide();
    glass.opacity = 0;
    animActor.opacity = 0;
    return;
  }
  animActor.set_scale(1.0, 1.0);
  animActor.opacity = 255;
  glass.opacity = 255;
  sync();
}

export function showMenuAtRest(glass: any, animActor: any): void {
  if (!glass) return;
  glass.remove_all_transitions();
  glass.opacity = 255;
  glass.set_scale(1.0, 1.0);
  if (!animActor) return;
  animActor.set_scale(1.0, 1.0);
  animActor.opacity = 255;
}

// A rectangle that eases to each new target in a fixed time, without the
// overshoot of a spring.

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export class RectTween {
  private _from: number[] = [0, 0, 1, 1];
  private _to: number[] = [0, 0, 1, 1];
  private _startUs = 0;

  constructor(private _durationMs: number) {}

  /** Puts it at `rect` [x, y, w, h] and eases from there to `target`. */
  start(rect: number[], target: number[], nowUs: number): void {
    this._from = [...rect];
    this._to = [...target];
    this._startUs = nowUs;
  }

  /** Eases from where it is now to `target`, unless it is already heading there. */
  setTarget(target: number[], nowUs: number): void {
    if (target.every((v, i) => Math.abs(v - this._to[i]) < 0.5)) return;
    this.start(this.rect(nowUs), target, nowUs);
  }

  /** Milliseconds until it lands, 0 once it has. */
  remaining(nowUs: number): number {
    return Math.max(this._durationMs - (nowUs - this._startUs) / 1000, 0);
  }

  rect(nowUs: number): number[] {
    const t = Math.min(Math.max((nowUs - this._startUs) / (this._durationMs * 1000), 0), 1);
    const k = easeOutCubic(t);
    return this._from.map((v, i) => v + (this._to[i] - v) * k);
  }
}
