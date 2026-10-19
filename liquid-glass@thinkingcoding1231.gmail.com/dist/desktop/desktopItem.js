import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { WallpaperGlass } from '../rendering/wallpaperGlass.js';
import { ensureGlassAllocated } from '../actors/allocation.js';
import { isActorValid } from '../actors/lifecycle.js';
import { hexToColorArray } from '../animation/colors.js';
import { AdaptiveTextColor } from '../adaptiveText.js';
import { sanitizeColorPreference } from '../contrastSampler.js';
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

/**
 * A left click on `actor` calls `onClick` and a right click opens its menu.
 * Items move only in the menu's edit mode, so a stray drag does nothing.
 */
export function connectClicks(actor, onClick, onMenu) {
    let start = null;
    actor.connect('button-press-event', (_a, event) => {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            onMenu(...event.get_coords());
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        // A button inside gets the press: stopping it here would also cancel the
        // button's click gesture.
        if (global.stage.get_event_actor(event) !== actor)
            return Clutter.EVENT_PROPAGATE;
        start = event.get_coords();
        return Clutter.EVENT_STOP;
    });
    actor.connect('button-release-event', (_a, event) => {
        if (!start || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const moved = Math.hypot(x - start[0], y - start[1]);
        start = null;
        if (moved < CLICK_SLOP)
            onClick();
        return Clutter.EVENT_STOP;
    });
}

/**
 * A desktop widget: content on a rounded card of glass. Subclasses fill
 * `box` and may hide the card (`shown`) when they have nothing to show.
 */
export class GlassCard {
    id;
    actor;
    box;
    glass;
    env;
    _settingsIds = [];
    _styleId = 0;
    _lastSize = '';
    _lastShown = false;
    _needsMeasure = true;
    _text;
    _shown = true;

    constructor(id, env, width) {
        this.id = id;
        this.env = env;
        this.actor = new St.Widget({ name: `liquid-glass-desktop-${id}`, reactive: true, track_hover: true });
        this.glass = new WallpaperGlass({
            extensionPath: env.path, settings: env.settings, logger: env.logger, owner: `desktop-${id}`,
            outline: 'desktop-widget',
        });
        this.glass.setPadding(SHADER_PADDING);
        this.glass.setIsDock(false);
        this.glass.setShadowMaxRadius(SHADOW_MARGIN - 8);
        this.actor.add_child(this.glass);
        this.actor.add_child(this.glass.sourceActor);
        this.box = new St.BoxLayout({ style_class: 'liquid-glass-desktop-card', width, ...verticalBoxParams() });
        this.actor.add_child(this.box);
        connectClicks(this.actor, () => this.activate(), (x, y) => env.menu(this, x, y));
        this._text = new AdaptiveTextColor(() => [this.box], () => [this.glass], env.logger, `desktop ${id}`, {
            signature: () => this.glass.backdropSerial,
        });
        this._styleId = this.box.connect('style-changed', () => { this._needsMeasure = true; });
        const watch = (key, fn) => this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
        for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
            watch(`desktop-widget-${key}`, () => this._applyMaterial());
        for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
            watch(`desktop-widget-${key}`, () => this._syncText());
        this._applyMaterial();
        this._syncText();
    }

    activate() {
    }

    get shown() {
        return this._shown;
    }

    set shown(shown) {
        if (shown === this._shown)
            return;
        this._shown = shown;
        this._needsMeasure = true;
        this.env.relayout();
    }

    _applyMaterial() {
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

    _syncText() {
        const s = this.env.settings;
        if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
            this._text.clear();
            return;
        }
        this._text.start(s.get_int('desktop-widget-sample-interval-ms'), sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')), PREFERRED_MIN_CONTRAST);
    }

    // The content changed; measure the text colour again.
    contentChanged() {
        this._needsMeasure = true;
        this._text.invalidate();
        this.env.relayout();
    }

    size() {
        const [, natW] = this.box.get_preferred_width(-1);
        const [, natH] = this.box.get_preferred_height(natW);
        return [Math.ceil(Math.max(natW, this.box.width)), Math.ceil(natH)];
    }

    bounds() {
        return [0, 0, ...this.size()];
    }

    sync(exposed = true) {
        const shown = this.shown;
        // A desktop card remains part of the layout while it is covered, but
        // unmapping it is essential: a cached wallpaper blur still has to run its
        // composite shader whenever the stage underneath a window is repainted.
        const visible = shown && exposed;
        if (this.actor.visible !== visible)
            this.actor.visible = visible;
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

    destroy() {
        if (this._styleId)
            this.box.disconnect(this._styleId);
        this._styleId = 0;
        for (const id of this._settingsIds)
            this.env.settings.disconnect(id);
        this._settingsIds = [];
        this._text.clear();
        this.glass.cleanup();
        if (isActorValid(this.actor))
            this.actor.destroy();
    }
}
