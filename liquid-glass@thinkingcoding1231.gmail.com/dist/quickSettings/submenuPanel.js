//
// The floating submenu's panel: its glass, its geometry and its lifetime.
//
// Design (after the borrowed-backdrop experiment)
// ----------------------------------------------
// An earlier rewrite tried to reuse Quick Settings' frosted sheet as the
// submenu backdrop. That failed two ways, both measured:
//
//   * The panel's LiquidEffect was applied to an *empty* actor, so the shader
//     sampled transparent paint and the refraction/tint/rim optics rendered
//     nothing at all.
//   * The borrowed sheet was re-measured and re-sized on every animation frame,
//     which reallocates the Shell.BlurEffect offscreen buffer per frame. The
//     probe recorded 600-765ms single-frame stalls, and the open (nominally
//     ~230ms) took ~900ms of wall clock.
//
// The panel now owns a complete glass stack again -- wallpaper clone, culled
// window clones, a reduced-resolution ACTOR blur and a LiquidEffect -- exactly
// like a Quick Settings card backing. The stack is built once and survives
// across opens, and its geometry is resolved *once* before the transition
// starts. During the animation only the panel's scale and the opacities move;
// no offscreen buffer is ever reallocated mid-transition.
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect } from './liquidEffect.js';
import { UnpickableActor, UnpickableClone, createBackdropClone, syncBackdropClone } from './qsUtils.js';
import { SubmenuAnimation } from './submenuAnimation.js';
/** Transparent padding outside the glass, so the shader is never clipped. */
export const SHADER_PADDING = 20;
const PANEL_WIDTH = 360;
const MIN_PANEL_HEIGHT = 96;
const CORNER_RADIUS = 28;
/** Matches `.liquid-glass-floating-window-layout` padding in the stylesheet. */
const LAYOUT_PAD_X = 10;
const LAYOUT_PAD_Y = 8;
/**
 * Linear downscale of the backdrop blur's offscreen buffer. ShellBlurEffect
 * allocates that buffer at the actor's allocation, so blurring into a smaller
 * container and scaling it back up is the only way to cheapen the pass. The
 * radius is divided by the same factor to keep the on-screen blur identical.
 */
const BLUR_FBO_DIVISOR = 2;

function rectsIntersect(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * One floating submenu panel. It is created once per renderer and reused: an
 * open is `present()`, a close is `close()`, and only `destroy()` (extension
 * teardown) actually tears the glass stack down. Every asynchronous
 * continuation checks `_destroyed`/`_generation` first.
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
    _effect;
    _clipBox;
    _fboContainer;
    _halfBox;
    _bgClone;
    _windowClonesContainer;
    _windowClones = new Map();
    _blur;
    _fboScale = 1;
    _anim;
    // Measures the real content height (the rows list), supplied by the renderer.
    // The panel cannot use its own content box for this: that box holds a
    // ScrollView, whose preferred height does not report the full row stack.
    _contentMeasurer = null;
    _x = 0;
    _y = 0;
    _width = PANEL_WIDTH;
    _height = MIN_PANEL_HEIGHT;
    _glassW = PANEL_WIDTH + SHADER_PADDING * 2;
    _glassH = MIN_PANEL_HEIGHT + SHADER_PADDING * 2;
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
            style_class: `liquid-glass-floating-window-container ${this._paletteClass()}`,
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
        this._anim = new SubmenuAnimation({
            getRoot: () => (this._destroyed ? null : this._root),
            getContent: () => (this._destroyed ? null : this._content),
            getGlass: () => (this._destroyed ? null : this._glass),
            getScrim: () => (this._destroyed ? null : this._scrim),
            isAlive: () => !this._destroyed,
            onStart: () => { },
            onSettled: (opening) => this._onSettled(opening),
            onFrame: () => { },
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
     * Builds the liquid glass stack: a wallpaper clone and culled window clones
     * blurred by a reduced-resolution ACTOR blur, then refracted by a
     * LiquidEffect. This mirrors the Quick Settings card backings pipeline so the
     * submenu gets the same optics.
     */
    _buildGlass() {
        const glassW = this._width + SHADER_PADDING * 2;
        const glassH = this._height + SHADER_PADDING * 2;
        this._glassW = glassW;
        this._glassH = glassH;
        this._glass = new St.Widget({
            style_class: 'liquid-glass-floating-window-backing',
            reactive: false,
            clip_to_allocation: false,
            x: -SHADER_PADDING,
            y: -SHADER_PADDING,
            width: glassW,
            height: glassH,
        });
        this._clipBox = new St.Widget({ clip_to_allocation: true, reactive: false });
        this._clipBox.set_size(glassW, glassH);
        this._glass.add_child(this._clipBox);
        this._fboContainer = new UnpickableActor();
        this._fboContainer.set_pivot_point(0, 0);
        this._fboContainer.set_size(glassW, glassH);
        this._clipBox.add_child(this._fboContainer);
        this._halfBox = new UnpickableActor();
        this._halfBox.set_pivot_point(0, 0);
        this._fboContainer.add_child(this._halfBox);
        this._bgClone = createBackdropClone();
        this._halfBox.add_child(this._bgClone);
        this._windowClonesContainer = new UnpickableActor();
        this._halfBox.add_child(this._windowClonesContainer);
        try {
            this._blur = new Shell.BlurEffect({
                radius: this._manager._settings.get_int('quick-settings-blur-radius'),
                mode: Shell.BlurMode.ACTOR,
            });
            this._fboContainer.add_effect(this._blur);
        }
        catch (e) { }
        this._applyBlurRadius();
        const effect = new LiquidEffect({
            extensionPath: this._manager.extensionPath,
            settings: this._manager._settings,
        });
        effect.setPadding(SHADER_PADDING);
        effect.setCornerRadius(CORNER_RADIUS);
        effect.setIsDock(false);
        const tint = this._manager._hexToColorArray(this._manager._settings.get_string('quick-settings-tint-color'));
        effect.setTintColor(...tint);
        effect.setTintStrength(this._manager._settings.get_double('quick-settings-tint-strength'));
        this._glass.add_effect(effect);
        this._effect = effect;
    }

    /** Splits the requested blur radius into a reduced radius + counter-scale. */
    _applyBlurRadius() {
        try {
            let base = Math.max(0, Math.round(this._manager._settings.get_int('quick-settings-blur-radius')));
            let scale = 1;
            let radius = base;
            if (base > 1) {
                radius = Math.max(1, Math.round(base / BLUR_FBO_DIVISOR));
                scale = base / radius;
            }
            this._fboScale = scale > 0 ? scale : 1;
            if (this._blur)
                this._blur.radius = radius;
            const inverse = 1 / this._fboScale;
            this._halfBox.set_pivot_point(0, 0);
            this._halfBox.set_scale(inverse, inverse);
        }
        catch (e) { }
    }

    _paletteClass() {
        return 'liquid-glass-control-palette-dark';
    }

    // ---- geometry ---------------------------------------------------------
    /**
     * Lays the panel out offscreen and resolves its final size. Runs before the
     * panel is shown and again after a settled row rebuild; never during the
     * open/close transition.
     */
    measure() {
        const monitor = this._manager._getMenuMonitorGeometry?.()
            || Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
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
        let sourceRight = monitor.x + monitor.width - 24;
        let sourceBottom = monitor.y + 36;
        try {
            const qs = Main.panel.statusArea?.quickSettings;
            const sourceActor = qs?.container || qs;
            if (sourceActor) {
                const [sx, sy] = sourceActor.get_transformed_position();
                const [sw, sh] = sourceActor.get_size();
                sourceRight = sx + sw;
                sourceBottom = sy + sh;
            }
        }
        catch (e) { }
        const x = Math.round(Math.min(Math.max(sourceRight - PANEL_WIDTH, monitor.x + 24), monitor.x + monitor.width - PANEL_WIDTH - 24));
        const y = Math.round(Math.min(Math.max(sourceBottom + 12, monitor.y + 24), monitor.y + monitor.height - height - 24));
        const changed = x !== this._x || y !== this._y || height !== this._height;
        this._x = x;
        this._y = y;
        this._width = PANEL_WIDTH;
        this._height = height;
        if (changed || this._glassW !== this._width + SHADER_PADDING * 2) {
            this._applyGeometry();
            if (this._presented)
                this._syncBackdrop(false);
        }
    }

    /** Applies the resolved rect to every actor. Called once per open. */
    _applyGeometry() {
        this._glassW = this._width + SHADER_PADDING * 2;
        this._glassH = this._height + SHADER_PADDING * 2;
        const innerW = this._width - LAYOUT_PAD_X * 2;
        const innerH = this._height - LAYOUT_PAD_Y * 2;
        this._root.set_position(this._x, this._y);
        this._root.set_size(this._width, this._height);
        this._glass.set_position(-SHADER_PADDING, -SHADER_PADDING);
        this._glass.set_size(this._glassW, this._glassH);
        this._panel.set_size(this._width, this._height);
        this._layout.set_size(this._width, this._height);
        this._content.set_size(innerW, innerH);
        this._clipBox.set_size(this._glassW, this._glassH);
        const fboW = Math.max(1, this._glassW / this._fboScale);
        const fboH = Math.max(1, this._glassH / this._fboScale);
        this._fboContainer.set_size(fboW, fboH);
        this._fboContainer.set_position(0, 0);
        // Counter-scale so the reduced-resolution blur buffer lands back on the
        // glass rect (the half-box below is scaled by 1/k to fit the source into it).
        this._fboContainer.set_pivot_point(0, 0);
        this._fboContainer.set_scale(this._fboScale, this._fboScale);
        this._effect.setResolution(this._glassW, this._glassH);
    }

    // ---- backdrop ---------------------------------------------------------
    /**
     * Positions the wallpaper and window clones inside the glass, and (when
     * `rebuild`) rebuilds the window clone set culled to the glass rect. Clones
     * are captured in stage coordinates; the clone containers are offset by the
     * glass's stage origin so the content lands under the panel. This runs once
     * per open and once per settled remeasure -- never per animation frame.
     */
    _syncBackdrop(rebuild) {
        if (this._destroyed)
            return;
        try {
            const glassX = this._x - SHADER_PADDING;
            const glassY = this._y - SHADER_PADDING;
            syncBackdropClone(this._bgClone);
            this._bgClone.set_position(-glassX, -glassY);
            if (!this._bgClone.visible)
                this._bgClone.show();
            const container = this._windowClonesContainer;
            const state = this._cloneState || {};
            if (state.x !== -glassX || state.y !== -glassY)
                container.set_position(-glassX, -glassY);
            state.x = -glassX;
            state.y = -glassY;
            this._cloneState = state;
            if (!rebuild)
                return;
            const clipRect = { x: glassX, y: glassY, w: this._glassW, h: this._glassH };
            const windowActors = global.get_window_actors();
            const active = new Set();
            let zOrderDirty = false;
            for (const windowActor of windowActors) {
                const metaWindow = windowActor.get_meta_window?.();
                if (!metaWindow || metaWindow.minimized || !windowActor.visible)
                    continue;
                const windowRect = {
                    x: windowActor.x + windowActor.translation_x,
                    y: windowActor.y + windowActor.translation_y,
                    w: windowActor.width * windowActor.scale_x,
                    h: windowActor.height * windowActor.scale_y,
                };
                if (!rectsIntersect(windowRect, clipRect))
                    continue;
                active.add(windowActor);
                let clone = this._windowClones.get(windowActor);
                if (!clone) {
                    clone = new UnpickableClone({ source: windowActor });
                    container.add_child(clone);
                    this._windowClones.set(windowActor, clone);
                    zOrderDirty = true;
                }
                clone.set_position(windowActor.x, windowActor.y);
                clone.set_size(windowActor.width, windowActor.height);
                clone.set_scale(windowActor.scale_x, windowActor.scale_y);
                clone.translation_x = windowActor.translation_x;
                clone.translation_y = windowActor.translation_y;
            }
            for (const [windowActor, clone] of Array.from(this._windowClones.entries())) {
                if (!active.has(windowActor)) {
                    try {
                        clone.destroy();
                    }
                    catch (e) { }
                    this._windowClones.delete(windowActor);
                    zOrderDirty = true;
                }
            }
            // Clone order is paint order; reindex only when the set or the stack moved.
            const children = container.get_children();
            let orderChanged = zOrderDirty;
            if (!orderChanged) {
                let i = 0;
                for (const windowActor of active) {
                    if (children[i] !== this._windowClones.get(windowActor)) {
                        orderChanged = true;
                        break;
                    }
                    i++;
                }
                if (!orderChanged && i !== children.length)
                    orderChanged = true;
            }
            if (orderChanged) {
                let index = 0;
                for (const windowActor of active) {
                    const clone = this._windowClones.get(windowActor);
                    if (!clone)
                        continue;
                    try {
                        container.set_child_at_index(clone, index);
                    }
                    catch (e) { }
                    index++;
                }
            }
        }
        catch (e) { }
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
        // Build the window clones before the first drawn frame, while the panel is
        // still transparent: the clone cost lands on a frame nobody sees.
        this._syncBackdrop(true);
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
        try {
            this._anim.stop();
        }
        catch (e) { }
        try {
            this._effect.cleanup();
        }
        catch (e) { }
        this._windowClones.clear();
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
