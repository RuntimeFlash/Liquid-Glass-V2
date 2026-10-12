import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { BackdropGlass } from '../rendering/backdropGlass.js';
import { ensureGlassAllocated } from '../actors/allocation.js';
import { isActorValid } from '../actors/lifecycle.js';
import { startSyncLoop, stopStageLoop } from '../animation/frameLoops.js';
import { hexToColorArray } from '../animation/colors.js';
import { RectTween } from '../animation/tween.js';
import { AdaptiveTextColor } from '../adaptiveText.js';
import { sanitizeColorPreference } from '../contrastSampler.js';
import { verticalBoxParams } from '../shellVersion.js';
const WIDTH = 680;
// The search field's top, as a fraction of the monitor's height.
const TOP = 0.2;
const MAX_RESULTS = 8;
const PER_PROVIDER = 5;
const ICON_SIZE = 32;
const SEARCH_DELAY_MS = 120;
// How long the previous results stay up while slow providers are still answering.
const SETTLE_MS = 400;
const SHADER_PADDING = 20;
const SHADOW_MARGIN = 60;
const FADE_MS = 150;
// The glass opens from this much larger, like SwiftUI's materialize.
const OPEN_SCALE = 1.06;
const SHAPE_MS = 220;
// Frames asked for past the glass's tween, and after the panel changes size.
const TICK_MS = 50;
const HINT_OPACITY = 178;

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * A search field on glass in the middle of the screen, like Spotlight, that
 * opens with a shortcut and asks the same search providers as the overview
 * (applications, settings, files, the calculator and whatever else is
 * installed and enabled in Settings).
 */
export class Launcher {
    _path;
    _settings;
    _logger;
    _icons;
    // The open launcher, for the test driver.
    static instance = null;
    _settingsIds = [];
    // The look's watchers, while the launcher is open.
    _materialIds = [];
    _keybinding = false;
    _root = null;
    _panel = null;
    _entry = null;
    _list = null;
    _glass = null;
    _grab = null;
    _shape = new RectTween(SHAPE_MS);
    _shapeStarted = false;
    _ticker = null;
    _frameSyncId = 0;
    _frameSignalId = 0;
    _searchId = 0;
    _cancellable = null;
    // The running search's results so far, the providers it still waits for, and its deadline.
    _found = [];
    _waiting = 0;
    _settleId = 0;
    _results = [];
    _rows = [];
    _selected = 0;
    _terms = [];
    _text;
    // The panel's top and height its text colour was last chosen for.
    _coloredFor = '';

    constructor(_path, _settings, _logger, _icons) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
        this._icons = _icons;
        // One colour for the field and the results, set on the panel. Rows that come in take it at once, and the
        // colour for the panel's new size is chosen as they come, while the glass is still growing to it.
        this._text = new AdaptiveTextColor(() => (this._panel ? [this._panel] : []), () => (this._glass ? [this._glass] : []), _logger, 'launcher', { ownColor: true, held: () => this._shape.remaining(GLib.get_monotonic_time()) > 0 });
    }

    setup() {
        Launcher.instance = this;
        const watch = (key, fn) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
        watch('enable-launcher', () => this._syncKeybinding());
        this._syncKeybinding();
    }

    _syncKeybinding() {
        const wanted = this._settings.get_boolean('enable-launcher');
        if (wanted && !this._keybinding) {
            Main.wm.addKeybinding('launcher-shortcut', this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
            this._keybinding = true;
        }
        else if (!wanted && this._keybinding) {
            Main.wm.removeKeybinding('launcher-shortcut');
            this._keybinding = false;
            this.close();
        }
    }

    toggle() {
        if (this._root)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._root)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const root = new St.Widget({ name: 'liquid-glass-launcher', reactive: true,
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, opacity: 0 });
        const glass = new BackdropGlass({
            extensionPath: this._path, settings: this._settings, logger: this._logger, owner: 'launcher',
        });
        glass.setPadding(SHADER_PADDING);
        glass.setIsDock(false);
        glass.setShadowMaxRadius(SHADOW_MARGIN - 10);
        root.add_child(glass);
        const panel = new St.BoxLayout({ style_class: 'liquid-glass-launcher', reactive: true, width: WIDTH,
            x: Math.round((monitor.width - WIDTH) / 2), y: Math.round(monitor.height * TOP), ...verticalBoxParams() });
        // A click outside the field closes it. Presses inside must not be stopped: from GNOME 49 a button clicks
        // through a gesture, and an actor that stops the press cancels it.
        root.connect('button-press-event', (_actor, event) => {
            if (panel.contains(global.stage.get_event_actor(event)))
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        // The glass follows the panel from before-update, which does not ask for frames and runs ahead of the layout
        // that resizes the panel. Without the ticker, an idle stage leaves the glass, and the clip that also limits
        // where rows can be hovered and clicked, at the old size. It runs for a set time, so that it stops even when
        // no JS can run.
        const ticker = new Clutter.Timeline({ actor: root, duration: TICK_MS });
        ticker.connect('completed', () => this._keepTicking());
        panel.connect('notify::allocation', () => {
            if (ticker.is_playing())
                return;
            ticker.set_duration(TICK_MS);
            ticker.start();
        });
        const entry = new St.Entry({ style_class: 'lg-launcher-entry', hint_text: 'Search', can_focus: true, x_expand: true,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic', style_class: 'lg-launcher-entry-icon' }) });
        // The hint takes the panel's colour too, dimmed the way the theme dims it.
        entry.hint_actor.opacity = HINT_OPACITY;
        // Hidden while empty, so the panel's spacing does not add room below the field.
        const list = new St.BoxLayout({ style_class: 'lg-launcher-list', visible: false, ...verticalBoxParams() });
        panel.add_child(entry);
        panel.add_child(list);
        root.add_child(panel);
        Main.layoutManager.uiGroup.add_child(root);
        this._root = root;
        this._panel = panel;
        this._entry = entry;
        this._list = list;
        this._glass = glass;
        this._ticker = ticker;
        this._results = [];
        this._rows = [];
        this._selected = 0;
        this._applyMaterial();
        this._materialIds = (['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast',
            'saturation']).map(key => this._settings.connect(`changed::launcher-${key}`, () => this._applyMaterial()));
        entry.clutter_text.connect('text-changed', () => this._queueSearch());
        entry.clutter_text.connect('key-press-event', (_a, event) => this._onKey(event));
        this._grab = Main.pushModal(root, { actionMode: Shell.ActionMode.POPUP });
        global.stage.set_key_focus(entry.clutter_text);
        this._shapeStarted = false;
        startSyncLoop(this._frameSignalSlot, this._frameSlot, {
            alive: () => !!this._root,
            honourFreeze: true,
            errorTag: 'Launcher',
            step: () => this._sync(),
        });
        root.ease({ opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        this._coloredFor = '';
        if (this._settings.get_boolean('launcher-enable-adaptive-text-color')) {
            this._text.start(this._settings.get_int('launcher-sample-interval-ms'), sanitizeColorPreference(this._settings.get_string('launcher-adaptive-text-preference')));
        }
        this._colorText();
    }

    close() {
        const root = this._root;
        if (!root)
            return;
        this._root = null;
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        this._ticker?.stop();
        this._ticker = null;
        this._cancelSearch();
        this._text.clear();
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        for (const id of this._materialIds)
            this._settings.disconnect(id);
        this._materialIds = [];
        const glass = this._glass;
        this._glass = null;
        this._panel = null;
        this._entry = null;
        this._list = null;
        this._rows = [];
        this._results = [];
        root.remove_all_transitions();
        glass?.cleanup();
        if (isActorValid(root))
            root.destroy();
    }

    /** Types `text` into the field, for the test driver. */
    setText(text) {
        if (this._entry)
            this._entry.text = text;
    }

    _applyMaterial() {
        const glass = this._glass;
        if (!glass)
            return;
        const s = this._settings;
        glass.setTintColor(...hexToColorArray(s.get_string('launcher-tint-color')));
        glass.setTintStrength(s.get_double('launcher-tint-strength'));
        glass.setBlurRadius(s.get_int('launcher-blur-radius'));
        glass.setCornerRadius(s.get_double('launcher-corner-radius'));
        glass.setBrightness(s.get_double('launcher-brightness'));
        glass.setContrast(s.get_double('launcher-contrast'));
        glass.setSaturation(s.get_double('launcher-saturation'));
    }

    // Every frame: the glass eases to the field and its results, which are cut
    // off where the glass ends.
    _sync() {
        const glass = this._glass;
        const panel = this._panel;
        const root = this._root;
        const [w, h] = [panel.width, panel.height];
        if (!(w >= 1) || !(h >= 1))
            return;
        const rest = [panel.x, panel.y, w, h];
        const now = GLib.get_monotonic_time();
        if (!this._shapeStarted) {
            this._shapeStarted = true;
            const grow = (OPEN_SCALE - 1) / 2;
            this._shape.start([rest[0] - w * grow, rest[1] - h * grow, w * OPEN_SCALE, h * OPEN_SCALE], rest, now);
        }
        this._shape.setTarget(rest, now);
        const [x, y, gw, gh] = this._shape.rect(now);
        const p = SHADER_PADDING;
        glass.set_position(0, 0);
        glass.set_size(root.width, root.height);
        glass.setResolution(root.width, root.height);
        glass.setGlassGeometry(x - p, y - p, gw + p * 2, gh + p * 2);
        panel.set_clip(x - panel.x, y - panel.y, gw, gh);
        this._keepTicking();
        ensureGlassAllocated(glass);
        glass.syncSources();
    }

    _keepTicking() {
        const ticker = this._ticker;
        const left = this._shape.remaining(GLib.get_monotonic_time());
        if (!ticker || ticker.is_playing() || left <= 0)
            return;
        ticker.set_duration(Math.ceil(left) + TICK_MS);
        ticker.start();
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
            const n = this._rows.length;
            if (n > 0)
                this._select((this._selected + (key === Clutter.KEY_Down ? 1 : n - 1)) % n);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || key === Clutter.KEY_ISO_Enter) {
            this._activate(this._selected);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _select(index) {
        this._rows[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = index;
        this._rows[index]?.add_style_pseudo_class('selected');
    }

    _activate(index) {
        const result = this._results[index];
        if (!result)
            return;
        const { provider, meta } = result;
        const terms = this._terms;
        this.close();
        if (provider.isRemoteProvider) {
            provider.activateResult(meta.id, terms);
        }
        else if (meta.id.endsWith('.desktop')) {
            Shell.AppSystem.get_default().lookup_app(meta.id)?.activate();
        }
        else {
            SystemActions.getDefault().activateAction(meta.id);
        }
    }

    _cancelSearch() {
        if (this._searchId)
            GLib.Source.remove(this._searchId);
        this._searchId = 0;
        if (this._settleId)
            GLib.Source.remove(this._settleId);
        this._settleId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _queueSearch() {
        this._cancelSearch();
        this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this._searchId = 0;
            this._search();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The overview's providers, applications first.
    _providers() {
        return Main.overview.searchController._searchResults._providers;
    }

    // The previous results stay up until every provider has answered, or SETTLE_MS have passed, so that the glass
    // does not shrink and grow back on each keystroke. Answers after the deadline are shown as they come.
    _search() {
        const text = this._entry?.text.trim() ?? '';
        this._terms = text ? text.split(/\s+/) : [];
        const providers = this._terms.length ? this._providers() : [];
        this._found = [];
        this._waiting = providers.length;
        if (!this._waiting) {
            this._commit();
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleId = 0;
            this._commit();
            return GLib.SOURCE_REMOVE;
        });
        providers.forEach((provider, order) => this._ask(provider, order, cancellable));
    }

    async _ask(provider, order, cancellable) {
        const terms = this._terms;
        let metas = [];
        try {
            const ids = await provider.getInitialResultSet(terms, cancellable);
            const wanted = provider.filterResults(ids, PER_PROVIDER);
            if (wanted.length > 0 && !cancellable.is_cancelled())
                metas = await provider.getResultMetas(wanted, cancellable);
        }
        catch (e) {
            if (!isCancelled(e))
                this._logger.log(`[Liquid Glass] Search provider failed: ${e}`);
        }
        if (cancellable.is_cancelled())
            return;
        this._found.push(...metas.map(meta => ({ provider, order, meta })));
        this._waiting--;
        if (this._waiting === 0 || !this._settleId)
            this._commit();
    }

    _commit() {
        if (this._settleId)
            GLib.Source.remove(this._settleId);
        this._settleId = 0;
        this._results = [...this._found].sort((a, b) => a.order - b.order).slice(0, MAX_RESULTS);
        this._show();
    }

    _show() {
        const list = this._list;
        if (!list)
            return;
        list.destroy_all_children();
        this._rows = this._results.map((result, i) => {
            const row = new St.Button({ style_class: 'lg-launcher-result', can_focus: false, x_expand: true });
            const box = new St.BoxLayout({ style_class: 'lg-launcher-result-box', x_expand: true });
            // A remote provider's result may come without an icon; its application's icon stands in.
            const gicon = result.provider.appInfo?.get_icon();
            const icon = result.meta.createIcon(ICON_SIZE) ?? (gicon ? new St.Icon({ gicon, icon_size: ICON_SIZE }) : null);
            const text = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, x_expand: true, ...verticalBoxParams() });
            const name = new St.Label({ text: result.meta.name ?? '', style_class: 'lg-launcher-name' });
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(name);
            const detail = result.meta.description || result.provider.appInfo?.get_name() || '';
            if (detail) {
                const label = new St.Label({ text: detail, style_class: 'lg-launcher-detail' });
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                text.add_child(label);
            }
            if (icon instanceof St.Icon && result.provider.id === 'applications')
                this._icons.styleLauncherIcon(icon, result.meta.id);
            if (icon)
                box.add_child(icon);
            box.add_child(text);
            row.set_child(box);
            row.connect('clicked', () => this._activate(i));
            row.connect('notify::hover', () => { if (row.hover)
                this._select(i); });
            list.add_child(row);
            return row;
        });
        list.visible = this._rows.length > 0;
        this._select(Math.min(this._selected, Math.max(this._rows.length - 1, 0)));
        this._text.invalidate();
        this._colorText();
    }

    // Chooses the text colour for where the panel is about to be, from its size with the rows it has now, before
    // the next layout gives it that size.
    _colorText() {
        const root = this._root;
        const panel = this._panel;
        const [, height] = panel.get_preferred_height(WIDTH);
        const rect = { x: root.x + panel.x, y: root.y + panel.y, width: WIDTH, height: Math.ceil(height) };
        const key = `${rect.y},${rect.height}`;
        if (key === this._coloredFor)
            return;
        this._coloredFor = key;
        this._text.colorFor(rect);
    }

    cleanup() {
        this.close();
        if (this._keybinding)
            Main.wm.removeKeybinding('launcher-shortcut');
        this._keybinding = false;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        Launcher.instance = null;
    }

    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }

    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
}
