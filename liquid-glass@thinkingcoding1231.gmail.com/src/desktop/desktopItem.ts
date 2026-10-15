import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { BackdropGlass } from '../rendering/backdropGlass.js';
import { WallpaperGlass } from '../rendering/wallpaperGlass.js';
import { ensureGlassAllocated } from '../actors/allocation.js';
import { isActorValid } from '../actors/lifecycle.js';
import { hexToColorArray } from '../animation/colors.js';
import { AdaptiveTextColor } from '../adaptiveText.js';
import { sanitizeColorPreference } from '../contrastSampler.js';
import type { Logger } from '../logger.js';
import { verticalBoxParams } from '../shellVersion.js';

// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
// Room around a card for its shadow.
const SHADOW_MARGIN = 40;
// A press that moves further than this (px) before it is let go is no click.
const CLICK_SLOP = 6;
// The text on the desktop stays in the preferred colour down to this contrast
// ratio (WCAG's for large text), so a busy wallpaper does not keep flipping it.
export const PREFERRED_MIN_CONTRAST = 3;

export interface ItemEnv {
  path: string;
  settings: Gio.Settings;
  logger: Logger;
  // A right click on the item at (x, y), in stage coordinates.
  menu: (item: DesktopItem, x: number, y: number) => void;
  // The item changed size or was shown or hidden: lay the items out on the
  // next frame, and make sure there is one.
  relayout: () => void;
}

/** Something the desktop layer places and stacks, and the user can move. */
export interface DesktopItem {
  readonly id: string;
  readonly actor: St.Widget;
  // Whether it has anything to show; a hidden item leaves its place in the stack.
  readonly shown: boolean;
  // [width, height] as placed.
  size(): [number, number];
  // The part of the actor that shows, [x, y, width, height] in its own
  // coordinates: the edit frame goes round it.
  bounds(): [number, number, number, number];
  // Every frame. `exposed` is false when an opaque application window covers
  // the whole item, in which case it must not be painted behind that window.
  // True when the size or `shown` changed, so the stack is laid out again.
  sync(exposed?: boolean): boolean;
  destroy(): void;
}

/**
 * A left click on `actor` calls `onClick` and a right click opens its menu.
 * Items move only in the menu's edit mode, so a stray drag does nothing.
 */
export function connectClicks(actor: St.Widget, onClick: () => void, onMenu: (x: number, y: number) => void): void {
  let start: [number, number] | null = null;
  actor.connect('button-press-event', (_a: Clutter.Actor, event: Clutter.Event) => {
    const button = event.get_button();
    if (button === Clutter.BUTTON_SECONDARY) {
      onMenu(...(event.get_coords() as [number, number]));
      return Clutter.EVENT_STOP;
    }
    if (button !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
    // A button inside gets the press: stopping it here would also cancel the
    // button's click gesture.
    if (global.stage.get_event_actor(event) !== actor) return Clutter.EVENT_PROPAGATE;
    start = event.get_coords() as [number, number];
    return Clutter.EVENT_STOP;
  });
  actor.connect('button-release-event', (_a: Clutter.Actor, event: Clutter.Event) => {
    if (!start || event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
    const [x, y] = event.get_coords();
    const moved = Math.hypot(x - start[0], y - start[1]);
    start = null;
    if (moved < CLICK_SLOP) onClick();
    return Clutter.EVENT_STOP;
  });
}

/**
 * A desktop widget: content on a rounded card of glass. Subclasses fill
 * `box` and may hide the card (`shown`) when they have nothing to show.
 */
export abstract class GlassCard implements DesktopItem {
  readonly actor: St.Widget;
  protected readonly box: St.BoxLayout;
  protected readonly glass: WallpaperGlass;
  protected env: ItemEnv;
  private _settingsIds: number[] = [];
  private _styleId = 0;
  private _lastSize = '';
  private _lastShown = false;
  private _needsMeasure = true;
  private _text: AdaptiveTextColor;
  private _shown = true;

  constructor(readonly id: string, env: ItemEnv, width: number) {
    this.env = env;
    this.actor = new St.Widget({ name: `liquid-glass-desktop-${id}`, reactive: true, track_hover: true });
    this.glass = new WallpaperGlass({
      extensionPath: env.path, settings: env.settings, logger: env.logger, owner: `desktop-${id}`,
    } as any);
    this.glass.setPadding(SHADER_PADDING);
    this.glass.setIsDock(false);
    this.glass.setShadowMaxRadius(SHADOW_MARGIN - 8);
    this.actor.add_child(this.glass);
    this.actor.add_child(this.glass.sourceActor);
    this.box = new St.BoxLayout({ style_class: 'liquid-glass-desktop-card', width, ...verticalBoxParams() } as any);
    this.actor.add_child(this.box);
    connectClicks(this.actor, () => this.activate(), (x, y) => env.menu(this, x, y));

    this._text = new AdaptiveTextColor(() => [this.box], () => [this.glass], env.logger, `desktop ${id}`, {
      signature: () => this.glass.backdropSerial,
    });
    this._styleId = this.box.connect('style-changed', () => { this._needsMeasure = true; });
    const watch = (key: string, fn: () => void) =>
      this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
    for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
      watch(`desktop-widget-${key}`, () => this._applyMaterial());
    for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
      watch(`desktop-widget-${key}`, () => this._syncText());
    this._applyMaterial();
    this._syncText();
  }

  protected activate(): void {
  }

  get shown(): boolean {
    return this._shown;
  }

  set shown(shown: boolean) {
    if (shown === this._shown) return;
    this._shown = shown;
    this._needsMeasure = true;
    this.env.relayout();
  }

  private _applyMaterial(): void {
    const s = this.env.settings;
    const g = this.glass;
    g.setTintColor(...hexToColorArray(s.get_string('desktop-widget-tint-color')));
    g.setTintStrength(s.get_double('desktop-widget-tint-strength'));
    g.setBlurRadius(s.get_int('desktop-widget-blur-radius'));
    g.setCornerRadius(s.get_double('desktop-widget-corner-radius'));
    g.setBrightness(s.get_double('desktop-widget-brightness'));
    g.setContrast(s.get_double('desktop-widget-contrast'));
    g.setSaturation(s.get_double('desktop-widget-saturation'));
    this.box.set_style(`border-radius: ${s.get_double('desktop-widget-corner-radius')}px;`);
    // The text colour is measured against the tinted glass, so a material
    // change has to re-measure it even though the wallpaper did not move.
    this._text.invalidate();
  }

  private _syncText(): void {
    const s = this.env.settings;
    if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
      this._text.clear();
      return;
    }
    this._text.start(s.get_int('desktop-widget-sample-interval-ms'),
      sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')), PREFERRED_MIN_CONTRAST);
  }

  // The content changed; measure the text colour again.
  protected contentChanged(): void {
    this._needsMeasure = true;
    this._text.invalidate();
    this.env.relayout();
  }

  size(): [number, number] {
    const [, natW] = this.box.get_preferred_width(-1);
    const [, natH] = this.box.get_preferred_height(natW);
    return [Math.ceil(Math.max(natW, this.box.width)), Math.ceil(natH)];
  }

  bounds(): [number, number, number, number] {
    return [0, 0, ...this.size()];
  }

  sync(exposed: boolean = true): boolean {
    const shown = this.shown;
    // A desktop card remains part of the layout while it is covered, but
    // unmapping it is essential: a cached wallpaper blur still has to run its
    // composite shader whenever the stage underneath a window is repainted.
    const visible = shown && exposed;
    if (this.actor.visible !== visible) this.actor.visible = visible;
    let changed = shown !== this._lastShown;
    this._lastShown = shown;

    // The content can change size without a signal, so it is measured again
    // only when contentChanged() or a style change says it may have; measuring
    // the preferred size every frame was pure polling.
    if (this._needsMeasure) {
      this._needsMeasure = false;
      const [w, h] = this.size();
      const key = `${w}x${h}`;
      if (key !== this._lastSize) {
        this._lastSize = key;
        const m = SHADOW_MARGIN;
        const p = SHADER_PADDING;
        this.glass.set_position(-m, -m);
        this.glass.set_size(w + m * 2, h + m * 2);
        this.glass.setResolution(w + m * 2, h + m * 2);
        this.glass.setGlassGeometry(m - p, m - p, w + p * 2, h + p * 2);
        this.actor.set_size(w, h);
        this._text.invalidate();
        changed = true;
      }
    }

    if (visible && this.actor.mapped) {
      ensureGlassAllocated(this.glass);
      this.glass.syncSources();
    }
    return changed;
  }

  destroy(): void {
    if (this._styleId) this.box.disconnect(this._styleId);
    this._styleId = 0;
    for (const id of this._settingsIds) this.env.settings.disconnect(id);
    this._settingsIds = [];
    this._text.clear();
    this.glass.cleanup();
    if (isActorValid(this.actor)) this.actor.destroy();
  }
}
