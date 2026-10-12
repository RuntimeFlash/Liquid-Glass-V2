import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { StageContrastSampler, AdaptiveContrastConfig, type AdaptiveColorPreference,
  type BackdropSource, type SampleRect } from './contrastSampler.js';
import { adaptiveColorTweener, hexToRgb, resolveCrossFade } from './animation/colors.js';
import { isActorValid } from './actors/lifecycle.js';
import type { Logger } from './logger.js';

const COLOR_TWEEN_MS = 380;

export interface AdaptiveTextOptions {
  // The roots take the colour themselves and their text inherits it, so that text added later shows in it at once.
  ownColor?: boolean;
  // Measurements wait while this holds, for a surface whose glass is still changing size.
  held?: () => boolean;
}

/**
 * Keeps the labels and icons under `roots` readable on their glass: every
 * `intervalMs` it measures what is behind them and colours them light or
 * dark. For surfaces that stay on screen (the top bar, desktop widgets,
 * the launcher); a measurement is skipped while nothing behind them was
 * repainted.
 */
export class AdaptiveTextColor {
  private _sampler = new StageContrastSampler();
  private _config = { ...AdaptiveContrastConfig, enabled: true, samplePerElement: false };
  private _timerId = 0;
  private _inFlight = false;
  private _first = true;
  // colorFor() calls still measuring; the periodic measurement waits for them.
  private _pending = 0;
  // Each coloured actor's own inline style, put back by clear().
  private _styled = new Map<St.Widget, { style: string, destroyId: number, color: string }>();

  constructor(private _roots: () => Clutter.Actor[], private _glasses: () => BackdropSource[],
    private _logger: Logger, private _label: string, private _options: AdaptiveTextOptions = {}) {}

  /**
   * @param preferredMinContrast When above 0, `preference` is kept while it
   *   reads at least this well; see AdaptiveContrastConfig.
   */
  start(intervalMs: number, preference: AdaptiveColorPreference, preferredMinContrast = 0): void {
    this._config.sampleIntervalMs = intervalMs;
    this._config.preference = preference;
    this._config.preferredMinContrast = preferredMinContrast;
    this.stop();
    this._first = true;
    this._sampler.reset();
    this.update();
    this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(100, intervalMs), () => {
      this.update();
      return GLib.SOURCE_CONTINUE;
    });
  }

  stop(): void {
    if (this._timerId) {
      GLib.Source.remove(this._timerId);
      this._timerId = 0;
    }
  }

  // Measures again at the next update, for a surface whose content changed.
  invalidate(): void {
    this._sampler.invalidate();
  }

  update(): void {
    if (this._inFlight || this._pending > 0 || this._options.held?.()) return;
    const targets: Clutter.Actor[] = [];
    for (const root of this._roots()) {
      if (!this._options.ownColor) collectText(root, targets);
      else if (root.visible) targets.push(root);
    }
    if (targets.length === 0) return;

    this._inFlight = true;
    const skip = this._first;
    this._first = false;
    const glasses = () => this._glasses().filter(g => g.mapped);
    this._sampler.chooseColorsForActors(targets, this._config, null,
      () => glasses().reduce((sum, g: any) => sum + (g.paintCount ?? NaN), 0), glasses)
      .then(colors => {
        const batch = GLib.get_monotonic_time();
        for (const [actor, color] of colors) this._apply(actor, color, skip, batch);
      })
      .catch(e => this._logger.error(`[Liquid Glass] ${this._label} text colour update failed: ${e}`))
      .finally(() => { this._inFlight = false; });
  }

  /**
   * Colours the roots at once, without a tween, for what is behind `rect` (stage coordinates): for a surface with
   * ownColor about to take that size, whose new part has no glass under it yet. Does nothing unless started.
   */
  colorFor(rect: SampleRect): void {
    if (!this._timerId) return;
    this._pending++;
    this._sampler.chooseColorFor(rect, this._config, this._glasses())
      .then(color => {
        if (!color) return;
        const batch = GLib.get_monotonic_time();
        for (const root of this._roots()) this._apply(root, color, true, batch);
      })
      .catch(e => this._logger.error(`[Liquid Glass] ${this._label} text colour update failed: ${e}`))
      .finally(() => { this._pending--; });
  }

  private _apply(actor: Clutter.Actor, color: string, skip: boolean, batch: number): void {
    if (!(actor instanceof St.Widget) || !isActorValid(actor)) return;
    let entry = this._styled.get(actor);
    if (!entry) {
      entry = { style: actor.get_style() ?? '', destroyId: 0, color: '' };
      entry.destroyId = actor.connect('destroy', () => {
        adaptiveColorTweener.cancel(actor);
        this._styled.delete(actor);
      });
      this._styled.set(actor, entry);
    }
    if (entry.color === color && !skip) return;
    entry.color = color;

    const own = entry.style.trim();
    const prefix = own ? `${own.replace(/;$/, '')}; ` : '';
    const apply = (r: number, g: number, b: number, a: number) => {
      const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
      actor.set_style(`${prefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`);
    };
    const target = hexToRgb(color);
    if (skip) {
      adaptiveColorTweener.cancel(actor);
      apply(target.r, target.g, target.b, 1);
      return;
    }
    const start = actor.get_theme_node().get_foreground_color();
    const startRgb = { r: start.red, g: start.green, b: start.blue };
    adaptiveColorTweener.add(actor, {
      startRgb, startAlpha: start.alpha / 255,
      targetRgb: target, targetAlpha: 1,
      crossFade: resolveCrossFade(startRgb, target),
      durationMs: COLOR_TWEEN_MS,
      apply,
      coalesce: true,
    }, batch);
  }

  /** Stops measuring and gives every actor its own style back. */
  clear(): void {
    this.stop();
    for (const [actor, entry] of this._styled) {
      adaptiveColorTweener.cancel(actor);
      actor.disconnect(entry.destroyId);
      actor.set_style(entry.style || null);
    }
    this._styled.clear();
  }
}

function collectText(actor: Clutter.Actor, out: Clutter.Actor[]): void {
  if (!actor.visible) return;
  if (actor instanceof St.Label || actor instanceof St.Icon) {
    out.push(actor);
    return;
  }
  for (const child of actor.get_children()) collectText(child, out);
}
