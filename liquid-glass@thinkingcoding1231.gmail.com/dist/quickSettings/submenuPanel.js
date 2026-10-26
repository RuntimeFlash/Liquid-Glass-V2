//
// The floating submenu's panel: its glass, its geometry and its lifetime.
//
// The glass is a BackdropGlass, the same stage-copy + Dual Kawase + glass.frag
// pipeline the Quick Settings grid and the calendar menu use. It is separate
// from the grid's glass because the submenu sits above Quick Settings during
// the return crossfade; one shared glass would draw both surfaces in a single
// pass and lose that stacking.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { startSyncLoop, stopStageLoop } from '../animation/frameLoops.js';
import { QS_DEFAULT_CORNER_RADIUS, QS_GLASS_PADDING, applyQuickSettingsGlassAppearance, createQuickSettingsGlass, quickSettingsCornerRadius, quickSettingsShadowRoom, } from './glassAppearance.js';
import { SubmenuAnimation } from './submenuAnimation.js';
import { markOpenTrigger } from '../diagnostics/openLag.js';
const PANEL_WIDTH = 360;
const MIN_PANEL_HEIGHT = 96;
/** Matches `.liquid-glass-floating-window-layout` padding in the stylesheet. */
const LAYOUT_PAD_X = 10;
const LAYOUT_PAD_Y = 8;
const PALETTE_LIGHT = 'liquid-glass-control-palette-light';
const PALETTE_DARK = 'liquid-glass-control-palette-dark';

/**
 * One floating submenu panel. It is created once per renderer and reused: an
 * open is `present()`, a close is `close()`, and only `destroy()` (extension
 * teardown) actually tears the glass down. Every asynchronous continuation
 * checks `_destroyed`/`_generation` first.
 */
export class SubmenuPanel {
    _manager;
    _destroyed = false;
    _presented = false;
    _closing = false;
    _generation = 0;
    _scrim;
    _root;
    _glass;
    _panel;
    _layout;
    _content;
    _glassSyncId = 0;
    _glassFirstId = 0;

    get _glassSyncSlot() {
        return { get: () => this._glassSyncId, set: (id) => { this._glassSyncId = id; } };
    }

    get _glassFirstSlot() {
        return { get: () => this._glassFirstId, set: (id) => { this._glassFirstId = id; } };
    }

    _glassSettingsIds = [];
    _paletteSignalId = 0;
    _shadowRoom = 0;
    _cornerRadius = QS_DEFAULT_CORNER_RADIUS;
    _anim;
    // Measures the real content height (the rows list), supplied by the renderer.
    // The panel cannot use its own content box for this: that box holds a
    // ScrollView, whose preferred height does not report the full row stack.
    _contentMeasurer = null;
    _x = 0;
    _y = 0;
    _width = PANEL_WIDTH;
    _height = MIN_PANEL_HEIGHT;
    _glassW = PANEL_WIDTH + QS_GLASS_PADDING * 2;
    _glassH = MIN_PANEL_HEIGHT + QS_GLASS_PADDING * 2;
    /** Called when the close transition has finished and the panel is hidden. */
    _onClosed = null;
    /**
     * Called the instant a close starts, before the fade moves. The renderer uses
     * it to bring Quick Settings back behind the fading panel so the return is a
     * crossfade rather than submenu-out-then-QS-in.
     */
    _onClosing = null;
    _reopenOnClose = true;

    constructor(options) {
        this._manager = options.manager;
        this._build();
    }

    get width() { return this._width; }

    get height() { return this._height; }

    get destroyed() { return this._destroyed; }

    get closing() { return this._closing; }

    /** The content box; the renderer hangs its scroll/rows off this. */
    get content() { return this._content; }

    /** Supplies the height of the real content (the rows), for panel sizing. */
    setContentMeasurer(fn) {
        this._contentMeasurer = fn;
    }

    // ---- construction -----------------------------------------------------
    _build() {
        const monitor = this._manager._getMenuMonitorGeometry?.()
            || Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
        this._scrim = new St.Widget({
            style_class: 'liquid-glass-scrim',
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            opacity: 0,
        });
        // The one animated actor. Glass and content are both children, so they can
        // never drift apart: the animation writes a scale here and nothing else
        // moves either of them.
        this._root = new St.Widget({
            style_class: 'liquid-glass-floating-window-transition-root',
            reactive: false,
            can_focus: false,
            clip_to_allocation: false,
            x: 0,
            y: 0,
            width: this._width,
            height: this._height,
        });
        this._root.set_pivot_point(0.5, 0.0);
        this._buildGlass();
        this._root.add_child(this._glass);
        // The panel body. Clipped, and the only place the rows live.
        const win = new St.Widget({
            style_class: 'liquid-glass-floating-window-container',
            reactive: true,
            can_focus: true,
            x: 0,
            y: 0,
            width: this._width,
            height: this._height,
            clip_to_allocation: true,
        });
        const layout = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x: 0,
            y: 0,
            width: this._width,
            height: this._height,
            clip_to_allocation: true,
            style_class: 'liquid-glass-floating-window-layout liquid-glass-control-panel',
        });
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'liquid-glass-floating-window-content',
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        layout.add_child(content);
        win.add_child(layout);
        this._root.add_child(win);
        this._panel = win;
        this._layout = layout;
        this._content = content;
        this._syncPaletteClass();
        this._paletteSignalId = St.Settings.get().connect('notify::color-scheme', () => this._syncPaletteClass());
        this._anim = new SubmenuAnimation({
            getRoot: () => (this._destroyed ? null : this._root),
            getContent: () => (this._destroyed ? null : this._content),
            getGlass: () => (this._destroyed ? null : this._glass),
            getScrim: () => (this._destroyed ? null : this._scrim),
            isAlive: () => !this._destroyed,
            onStart: () => markOpenTrigger('submenu-open'),
            onSettled: (opening) => this._onSettled(opening),
            onFrame: () => this._syncGlass(),
        });
        this._scrim.connect('button-press-event', () => {
            this.close(true);
            return Clutter.EVENT_STOP;
        });
        this._panel.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol?.() === Clutter.KEY_Escape) {
                this.close(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /**
     * The submenu uses the same glass surface as the Quick Settings grid, but is
     * its own actor so it can sit above the grid during the return crossfade.
     */
    _buildGlass() {
        const settings = this._manager._settings;
        this._cornerRadius = quickSettingsCornerRadius(settings);
        this._shadowRoom = quickSettingsShadowRoom(settings);
        this._glass = createQuickSettingsGlass(this._manager, {
            owner: 'quick-settings-submenu',
            outline: 'quick-settings',
            multiRegion: true,
            cornerRadius: this._cornerRadius,
        });
        this._glassSettingsIds.push(settings.connect('changed::quick-settings-tint-color', () => this._applyGlassSettings()), settings.connect('changed::quick-settings-tint-strength', () => this._applyGlassSettings()), settings.connect('changed::quick-settings-blur-radius', () => this._applyGlassSettings()), settings.connect('changed::quick-settings-corner-radius', () => this._applyGlassSettings()), settings.connect('changed::shadow-radius', () => this._applyGlassSettings()), settings.connect('changed::shadow-intensity', () => this._applyGlassSettings()));
    }

    _applyGlassSettings() {
        const settings = this._manager._settings;
        this._cornerRadius = quickSettingsCornerRadius(settings);
        this._shadowRoom = applyQuickSettingsGlassAppearance(this._glass, settings, this._cornerRadius);
        if (!this._panel)
            return;
        this._applyGeometry();
        if (this._presented)
            this._syncGlass();
    }

    _syncPaletteClass() {
        const light = St.Settings.get().color_scheme !== St.SystemColorScheme.PREFER_DARK;
        this._panel.remove_style_class_name(light ? PALETTE_DARK : PALETTE_LIGHT);
        this._panel.add_style_class_name(light ? PALETTE_LIGHT : PALETTE_DARK);
    }

    // ---- geometry ---------------------------------------------------------
    /**
     * Resolves the panel's final rect. Runs on present and again after a settled
     * row rebuild; never during the open/close transition.
     */
    measure() {
        if (this._destroyed || !this._presented)
            return;
        let monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
        let sourceRight = monitor.x + monitor.width - 24;
        let sourceBottom = monitor.y + 36;
        try {
            const qs = Main.panel.statusArea?.quickSettings;
            const sourceActor = qs?.container || qs;
            if (sourceActor) {
                const index = Main.layoutManager.findIndexForActor(sourceActor);
                if (index >= 0)
                    monitor = Main.layoutManager.monitors[index] || monitor;
                const [sx, sy] = sourceActor.get_transformed_position();
                const [sw, sh] = sourceActor.get_size();
                sourceRight = sx + sw;
                sourceBottom = sy + sh;
            }
        }
        catch (e) { }
        const maxHeight = Math.max(MIN_PANEL_HEIGHT, monitor.height - 96);
        const innerWidth = PANEL_WIDTH - LAYOUT_PAD_X * 2;
        let natural = MIN_PANEL_HEIGHT;
        try {
            if (this._contentMeasurer) {
                const h = this._contentMeasurer(innerWidth);
                if (Number.isFinite(h) && h > 0)
                    natural = h;
            }
            else {
                const [, h] = this._content.get_preferred_height(innerWidth);
                if (Number.isFinite(h) && h > 0)
                    natural = h;
            }
        }
        catch (e) { }
        const height = Math.round(Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, natural + LAYOUT_PAD_Y * 2)));
        // Anchor under the Quick Settings panel button, right-aligned to it, and
        // clamp into the monitor.
        const x = Math.round(Math.min(Math.max(sourceRight - PANEL_WIDTH, monitor.x + 24), monitor.x + monitor.width - PANEL_WIDTH - 24));
        const y = Math.round(Math.min(Math.max(sourceBottom + 12, monitor.y + 24), monitor.y + monitor.height - height - 24));
        const changed = x !== this._x || y !== this._y || height !== this._height;
        this._x = x;
        this._y = y;
        this._width = PANEL_WIDTH;
        this._height = height;
        if (changed) {
            this._applyGeometry();
            if (this._presented)
                this._syncGlass();
        }
    }

    /**
     * Applies the resolved rect to every actor. The glass actor carries room for
     * the padding and the drop shadow; its single region is the padded panel.
     */
    _applyGeometry() {
        const pad = QS_GLASS_PADDING;
        const outer = Math.max(pad, this._shadowRoom);
        this._glassW = this._width + outer * 2;
        this._glassH = this._height + outer * 2;
        const innerW = this._width - LAYOUT_PAD_X * 2;
        const innerH = this._height - LAYOUT_PAD_Y * 2;
        this._root.set_position(this._x, this._y);
        this._root.set_size(this._width, this._height);
        this._panel.set_size(this._width, this._height);
        this._layout.set_size(this._width, this._height);
        this._content.set_size(innerW, innerH);
        this._glass.set_position(-outer, -outer);
        this._glass.set_size(this._glassW, this._glassH);
        this._glass.setResolution(this._glassW, this._glassH);
        this._glass.setGlassGeometry(0, 0, this._glassW, this._glassH);
        const region = {
            x: outer - pad,
            y: outer - pad,
            w: this._width + pad * 2,
            h: this._height + pad * 2,
            tintR: 1.0,
            tintG: 1.0,
            tintB: 1.0,
            baseStrength: 0.0,
            radius: this._cornerRadius,
        };
        this._glass.setGlassRegions([region]);
    }

    _syncGlass() {
        if (this._destroyed)
            return;
        this._glass.syncSources();
    }

    _startGlassSync() {
        if (this._destroyed || this._glassSyncId !== 0)
            return;
        startSyncLoop(this._glassSyncSlot, this._glassFirstSlot, {
            alive: () => !this._destroyed && this._presented,
            errorTag: 'SubmenuPanel',
            step: () => this._syncGlass(),
        });
    }

    _stopGlassSync() {
        stopStageLoop(this._glassSyncSlot, this._glassFirstSlot);
    }

    _onSettled(opening) {
        if (opening || this._destroyed)
            return;
        this._hideStage();
        const cb = this._onClosed;
        this._onClosed = null;
        try {
            cb?.(this._reopenOnClose);
        }
        catch (e) { }
    }

    // ---- lifetime ---------------------------------------------------------
    /** Shows the panel and runs the open transition. */
    present() {
        if (this._destroyed)
            return;
        const generation = ++this._generation;
        void generation;
        this._closing = false;
        // Put the panel on the stage first, then measure. Querying preferred sizes
        // off-stage makes St complain that the widgets have no theme node; on-stage
        // the measurement is exact and silent. Root opacity is dropped to 0 so the
        // frame between insertion and prepare() cannot paint stale geometry.
        this._root.opacity = 0;
        if (this._root.get_parent() !== Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.add_child(this._scrim);
            Main.layoutManager.uiGroup.add_child(this._root);
        }
        this._presented = true;
        this.measure();
        // The glass rect is final before the first drawn frame, while the panel is
        // still transparent.
        this._applyGeometry();
        this._syncGlass();
        this._startGlassSync();
        this._anim.prepare();
        this._anim.start(true);
        try {
            global.stage.set_key_focus(this._panel);
        }
        catch (e) { }
    }

    /**
     * Starts the close transition. `reopen` tells the owner whether Quick
     * Settings should come back afterwards. The panel is only hidden, never
     * destroyed, so its glass stack is reused on the next open.
     */
    close(reopen, immediate = false) {
        if (this._destroyed)
            return;
        this._closing = true;
        this._reopenOnClose = reopen;
        // Notify before the fade moves so the owner can stand Quick Settings up
        // behind the panel and start the return entrance on the same frame.
        try {
            this._onClosing?.(reopen);
        }
        catch (e) { }
        if (immediate) {
            this._hideStage();
            const cb = this._onClosed;
            this._onClosed = null;
            try {
                cb?.(reopen);
            }
            catch (e) { }
            return;
        }
        this._anim.start(false);
    }

    /**
     * Raises the panel and its scrim above everything else in uiGroup. Used on
     * the return hand-off, after Quick Settings has been re-opened behind the
     * fading panel, so the panel stays on top through the crossfade.
     */
    raise() {
        if (this._destroyed)
            return;
        const ui = Main.layoutManager.uiGroup;
        try {
            if (this._scrim.get_parent() === ui)
                ui.set_child_above_sibling(this._scrim, null);
            if (this._root.get_parent() === ui)
                ui.set_child_above_sibling(this._root, null);
        }
        catch (e) { }
    }

    /** Removes the panel from the stage but keeps every actor alive. */
    _hideStage() {
        this._presented = false;
        this._stopGlassSync();
        try {
            this._anim.stop();
        }
        catch (e) { }
        try {
            this._scrim.get_parent()?.remove_child(this._scrim);
        }
        catch (e) { }
        try {
            this._root.get_parent()?.remove_child(this._root);
        }
        catch (e) { }
    }

    /** Full teardown. Only called from the renderer's cleanup/extension disable. */
    destroy(reopen = false) {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._generation++;
        this._stopGlassSync();
        try {
            this._anim.stop();
        }
        catch (e) { }
        for (const id of this._glassSettingsIds)
            this._manager._settings.disconnect(id);
        this._glassSettingsIds = [];
        if (this._paletteSignalId) {
            St.Settings.get().disconnect(this._paletteSignalId);
            this._paletteSignalId = 0;
        }
        this._glass.cleanup();
        try {
            this._scrim.destroy();
        }
        catch (e) { }
        try {
            this._root.destroy();
        }
        catch (e) { }
        const cb = this._onClosed;
        this._onClosed = null;
        this._presented = false;
        try {
            cb?.(reopen);
        }
        catch (e) { }
    }

    /** Registers the close-completion callback (used by the renderer's handoff). */
    onClosed(cb) {
        this._onClosed = cb;
    }

    /** Registers the close-start callback (used to begin the QS return crossfade). */
    onClosing(cb) {
        this._onClosing = cb;
    }
}
