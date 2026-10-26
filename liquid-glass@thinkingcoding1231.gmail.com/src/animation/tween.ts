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
