import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { QuickSettingsLayoutEditor } from './layoutEditor.js';
const DEFAULT_GRID_ORDER = [
    ['network', 2], ['dark', 1], ['airplane', 1],
    ['bluetooth', 2], ['night', 1], ['dnd', 1],
    ['power-mode', 2], ['caffeine', 2],
];
const DEFAULT_HIDDEN = ['battery', 'suspend'];
/**
 * Visual replacement for GNOME's quick-settings grid. Native controls remain
 * the source of truth; this renderer only mirrors their state and activation.
 */
export class CustomQuickSettingsRenderer {
    manager;
    root = null;
    nativeGrid = null;
    movedSliders = [];
    signalIds = [];
    _renderedKeys = new Set();
    _renderedSources = new Map();
    _layoutEditor = null;
    constructor(manager) {
        this.manager = manager;
    }
    mount() {
        if (this.root) {
            // Floating submenus remove the card effects (and their checked classes)
            // while Quick Settings is hidden. The renderer itself stays mounted, so
            // restore each card's mirrored state before new glass backings are made.
            this._syncExistingCards();
            this._refreshIfControlsChanged();
            return;
        }
        this.nativeGrid = this.manager.menu?._grid;
        if (!this.nativeGrid)
            return;
        this.root = new St.BoxLayout({
            vertical: true,
            style_class: 'liquid-glass-custom-quick-settings',
            x_expand: true,
        });
        this.root.set_width(350);
        try {
            this.manager.animActor.set_width?.(350);
        }
        catch (e) { }
        this.manager.animActor.add_child(this.root);
        this.nativeGrid.hide();
        this._build();
    }
    refresh() {
        if (!this.root)
            return;
        this._disconnectSignals();
        // Restore the borrowed native sliders before wiping children, otherwise
        // they would be destroyed along with the rest of the grid.
        this._restoreSliders();
        this.root.destroy_all_children();
        this._build();
    }
    _refreshIfControlsChanged() {
        if (!this.root)
            return;
        // The shell can rebuild the native quick-settings grid when extensions
        // with tiles (e.g. Caffeine) are enabled or disabled. Re-point at the
        // live grid before comparing so a rebuilt grid is picked up too.
        let grid = null;
        try {
            grid = this.manager.menu?._grid ?? null;
        }
        catch (e) { }
        if (grid && grid !== this.nativeGrid) {
            this._restoreSliders();
            try {
                this.nativeGrid?.show();
            }
            catch (e) { }
            this.nativeGrid = grid;
            grid.hide();
        }
        if (!this.nativeGrid)
            return;
        let controls;
        try {
            controls = this._discoverControls();
        }
        catch (e) {
            return;
        }
        if (controls.size === this._renderedKeys.size) {
            let changed = false;
            for (let key of this._renderedKeys) {
                if (!controls.has(key) || controls.get(key)?.source !== this._renderedSources.get(key)) {
                    changed = true;
                    break;
                }
            }
            if (!changed)
                return;
        }
        this.refresh();
    }
    destroy() {
        this._layoutEditor?.close();
        this._layoutEditor = null;
        this._disconnectSignals();
        this._restoreSliders();
        if (this.nativeGrid)
            this.nativeGrid.show();
        this.root?.destroy();
        this.root = null;
        this.nativeGrid = null;
        this._renderedKeys = new Set();
        this._renderedSources.clear();
    }
    _build() {
        if (!this.root || !this.nativeGrid)
            return;
        let controls = this._discoverControls();
        this._renderedKeys = new Set(controls.keys());
        this._renderedSources = new Map(Array.from(controls, ([key, control]) => [key, control.source]));
        let grid = new St.Widget({
            style_class: 'liquid-glass-custom-grid',
            layout_manager: new Clutter.GridLayout({
                column_homogeneous: true,
                column_spacing: 10,
                row_spacing: 10,
            }),
            x_expand: true,
        });
        this.root.add_child(grid);
        let layout = grid.layout_manager;
        let placed = new Set();
        // Resolve the visible grid order from the saved layout (if any), falling
        // back to the default arrangement and appending newly detected controls.
        let saved = this._savedLayout();
        let hidden = new Set(saved ? saved.hidden : DEFAULT_HIDDEN);
        let items = [];
        let seen = new Set();
        if (saved) {
            for (let item of saved.items) {
                if (!controls.has(item.key) || seen.has(item.key))
                    continue;
                items.push(item);
                seen.add(item.key);
            }
        }
        else {
            for (let [key, span] of DEFAULT_GRID_ORDER) {
                if (!controls.has(key) || seen.has(key))
                    continue;
                items.push({ key, span });
                seen.add(key);
            }
        }
        for (let [key, control] of controls) {
            if (seen.has(key) || hidden.has(key))
                continue;
            items.push({ key, span: this._defaultSpan(control) });
        }
        // Flow placement: fill four columns left to right, wrapping rows. A span
        // that does not fit the remaining columns wraps to the next row.
        let row = 0;
        let column = 0;
        for (let item of items) {
            let control = controls.get(item.key);
            if (hidden.has(item.key)) {
                continue;
            }
            // Sliders need the complete four-column row to remain usable.
            let span = control.kind === 'slider' ? 4 : Math.min(item.span, 2);
            if (column + span > 4) {
                column = 0;
                row++;
            }
            let card = null;
            if (control.kind === 'slider') {
                card = this._attachSlider(layout, control.source, column, row, span);
            }
            else {
                // Resolve the render mode: saved mode wins; otherwise span decides.
                let mode = item.mode ?? (span === 2 ? 'wide' : 'circle');
                let effKind = mode === 'circle' ? 'single' : 'wide';
                card = this._createCard({
                    ...control,
                    kind: effKind,
                    squircle: effKind === 'wide',
                    mode,
                });
            }
            if (card) {
                layout.attach(card, column, row, span, 1);
                placed.add(control.source);
            }
            column += span;
            if (column >= 4) {
                column = 0;
                row++;
            }
        }
        // Keep any slider GNOME did not expose as a layout item visible below the
        // grid. This also preserves volume/brightness while a native grid rebuild
        // is settling.
        this._moveSliders();
        this.root.add_child(this._createEditControlsButton(controls));
    }
    _defaultSpan(control) {
        return control.kind === 'slider' ? 4 : control.kind === 'wide' ? 2 : 1;
    }
    _savedLayout() {
        try {
            let raw = this.manager._settings?.get_string('quick-settings-layout');
            if (!raw)
                return null;
            let parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.items))
                return null;
            return {
                items: parsed.items
                    .filter((it) => it && typeof it.key === 'string')
                    .map((it) => {
                    let span = it.span === 4 ? 4 : it.span === 2 ? 2 : 1;
                    return {
                        // v2 used `wifi`; network state now has one permanent key for
                        // both Wi-Fi and Ethernet so a cable can never add a new tile.
                        key: it.key === 'wifi' ? 'network' : it.key,
                        span,
                        mode: span > 1 ? 'wide' : 'circle',
                    };
                }),
                hidden: Array.isArray(parsed.hidden)
                    ? parsed.hidden.filter((k) => typeof k === 'string').map((key) => key === 'wifi' ? 'network' : key)
                    : [],
            };
        }
        catch (e) {
            return null;
        }
    }
    _attachSlider(layoutManager, slider, column, row, span) {
        try {
            if (!slider || !slider.get_parent())
                return null;
            this.movedSliders.push({
                actor: slider,
                parent: slider.get_parent(),
                index: slider.get_parent().get_children().indexOf(slider),
            });
            slider.get_parent().remove_child(slider);
            slider.add_style_class_name('liquid-glass-custom-slider');
            slider.x_expand = true;
            return slider;
        }
        catch (e) {
            return null;
        }
    }
    _createEditControlsButton(controls) {
        let button = new St.Button({
            style_class: 'liquid-glass-custom-edit-button',
            label: 'Edit Controls',
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        button.connect('clicked', () => {
            try {
                // Re-discover controls fresh so newly added/removed tiles are
                // reflected even if no full refresh has run since the last build.
                let fresh = controls;
                try {
                    if (this.nativeGrid)
                        fresh = this._discoverControls();
                }
                catch (e) { }
                this._addMovedSlidersToControls(fresh);
                this._openLayoutEditor(fresh);
            }
            catch (e) {
                try {
                    console.log(`[Liquid Glass] edit controls failed: ${e}`);
                }
                catch (e2) { }
            }
        });
        return button;
    }
    /**
     * Visible fallback sliders are temporarily parented under our custom root,
     * not the native grid. Include them explicitly when opening the editor so
     * volume/brightness can always be positioned or hidden again.
     */
    _addMovedSlidersToControls(controls) {
        for (const { actor } of this.movedSliders) {
            const key = this._sliderKeyFor(actor);
            if (!key || controls.has(key))
                continue;
            const title = `${this._labels(actor).join(' ')}`;
            controls.set(key, {
                key,
                source: actor,
                title: title ? title.charAt(0).toUpperCase() + title.slice(1)
                    : key === 'volume' ? 'Volume' : key === 'brightness' ? 'Brightness' : 'Slider',
                iconName: this._icon(actor) || this._fallbackIcon(key),
                kind: 'slider',
                squircle: false,
            });
        }
    }
    _editorTiles(controls) {
        let saved = this._savedLayout();
        let hiddenSet = new Set(saved ? saved.hidden : DEFAULT_HIDDEN);
        let items = [];
        let seen = new Set();
        if (saved) {
            for (let item of saved.items) {
                if (!controls.has(item.key) || seen.has(item.key))
                    continue;
                items.push(item);
                seen.add(item.key);
            }
        }
        else {
            for (let [key, span] of DEFAULT_GRID_ORDER) {
                if (!controls.has(key) || seen.has(key))
                    continue;
                items.push({ key, span, mode: span === 2 ? 'wide' : 'circle' });
                seen.add(key);
            }
        }
        // Every discovered control is editable, including the former footer.
        for (let [key, control] of controls) {
            if (seen.has(key))
                continue;
            let mode = control.kind === 'wide' || control.kind === 'slider' ? 'wide' : 'circle';
            items.push({ key, span: this._defaultSpan(control), mode });
        }
        return items.map((item) => {
            let control = controls.get(item.key);
            let mode = item.mode ?? (item.span === 2 ? 'wide' : 'circle');
            return {
                key: item.key,
                title: control.title,
                iconName: control.iconName,
                mode,
                slider: control.kind === 'slider',
                hidden: hiddenSet.has(item.key),
                defaultMode: control.kind === 'slider' ? 'wide' : this._defaultSpan(control) === 2 ? 'wide' : 'circle',
                defaultHidden: DEFAULT_HIDDEN.includes(item.key),
            };
        });
    }
    _openLayoutEditor(controls) {
        // The modal dialog grabs input; close the quick settings behind it.
        try {
            this.manager.menu?.close?.();
        }
        catch (e) { }
        if (!this._layoutEditor) {
            this._layoutEditor = new QuickSettingsLayoutEditor({
                settings: this.manager._settings,
                onSaved: () => this.refresh(),
            });
        }
        this._layoutEditor.open(this._editorTiles(controls));
    }
    _moveSliders() {
        if (!this.root || !this.nativeGrid)
            return;
        let hidden = this._hiddenKeys();
        for (let child of this.nativeGrid.get_children()) {
            if (!child.has_style_class_name?.('quick-slider'))
                continue;
            // Phase 4: skip sliders the user has hidden so they stay in the
            // (hidden) native grid and are not hoisted into the live view.
            let key = this._sliderKeyFor(child);
            if (key && hidden.has(key))
                continue;
            let parent = child.get_parent();
            this.movedSliders.push({ actor: child, parent, index: parent.get_children().indexOf(child) });
            parent.remove_child(child);
            child.add_style_class_name('liquid-glass-custom-slider');
            this.root.add_child(child);
        }
    }
    _restoreSliders() {
        for (let { actor, parent, index } of this.movedSliders) {
            try {
                actor.get_parent()?.remove_child(actor);
                // Phase 4: clamp the restore index in case the native grid's child
                // list changed (extension enable/disable) since the slider was moved.
                let count = parent.get_children().length;
                let at = Math.max(0, Math.min(index, count));
                parent.insert_child_at_index(actor, at);
                actor.remove_style_class_name('liquid-glass-custom-slider');
            }
            catch (e) { }
        }
        this.movedSliders = [];
    }
    _createCard(control) {
        let style = `liquid-glass-custom-card liquid-glass-custom-card-${control.kind}`;
        if (control.squircle)
            style += ' liquid-glass-custom-card-squircle';
        let card = new St.Button({
            style_class: style,
            reactive: true,
            can_focus: true,
            x_expand: control.kind === 'wide',
            x_align: control.kind === 'wide'
                ? Clutter.ActorAlign.FILL
                : Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (control.kind === 'single') {
            card.set_size(68, 68);
        }
        let box = new St.BoxLayout({ style_class: 'liquid-glass-custom-card-content', x_expand: true });
        let icon = new St.Icon({ icon_name: control.iconName, style_class: 'liquid-glass-custom-card-icon' });
        box.y_align = Clutter.ActorAlign.CENTER;
        box.y_expand = true;
        icon.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        if (control.kind === 'wide') {
            let labels = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'liquid-glass-custom-card-labels' });
            let subtitleText = this._subtitle(control.source, control.key);
            let titleLabel = new St.Label({ text: control.title, style_class: 'liquid-glass-custom-card-title' });
            labels.add_child(titleLabel);
            let subtitleLabel = new St.Label({
                text: subtitleText,
                style_class: 'liquid-glass-custom-card-subtitle',
                visible: true,
            });
            labels.add_child(subtitleLabel);
            box.add_child(labels);
            // Store the subtitle label so _syncCardState can update it.
            card._liquidGlassSubtitleLabel = subtitleLabel;
            card._liquidGlassTitleLabel = titleLabel;
            card._liquidGlassSubtitleFixed = false;
            card._liquidGlassControlKey = control.key;
        }
        if (control.kind === 'single') {
            box.x_align = Clutter.ActorAlign.CENTER;
            box.y_expand = true;
            icon.x_align = Clutter.ActorAlign.CENTER;
            icon.x_expand = true;
            icon.y_expand = true;
        }
        card.set_child(box);
        if (control.submenu)
            this._addHoverArrow(card, box);
        this._syncCardState(card, control.source, icon);
        card._liquidGlassSyncState = () => this._syncCardState(card, control.source, icon);
        card.connect('clicked', () => {
            try {
                if (control.submenu)
                    this.manager.showSubmenuInFloatingWindow(control.source, control.submenu);
                else
                    this._activate(control.source, control.key);
            }
            catch (e) {
                try {
                    console.log(`[Liquid Glass] card '${control.key}' click failed: ${e}`);
                }
                catch (e2) { }
            }
            this._scheduleRefresh();
        });
        this._watch(control.source, control.key, () => this._syncCardState(card, control.source, icon));
        return card;
    }
    _addHoverArrow(card, content) {
        let arrow = new St.Bin({
            style_class: 'liquid-glass-custom-menu-arrow',
            reactive: false,
            can_focus: false,
            opacity: 0,
        });
        arrow.set_child(new St.Icon({
            icon_name: 'pan-end-symbolic',
            style_class: 'liquid-glass-custom-menu-arrow-icon',
        }));
        arrow.set_size(22, 22);
        card.add_child?.(arrow);
        let positionArrow = () => {
            let [width, height] = card.get_size();
            arrow.set_position(Math.max(0, width - 30), Math.max(0, Math.round((height - 22) / 2)));
        };
        let setHover = (hovered) => {
            arrow.ease({
                opacity: hovered ? 255 : 0,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            content.ease({
                opacity: hovered ? 175 : 255,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return Clutter.EVENT_PROPAGATE;
        };
        this.signalIds.push({ target: card, id: card.connect('notify::allocation', positionArrow) }, { target: card, id: card.connect('enter-event', () => setHover(true)) }, { target: card, id: card.connect('leave-event', () => setHover(false)) });
    }
    _discoverControls() {
        let controls = new Map();
        // Each candidate remembers which direct child of the native grid it
        // belongs to, so unknown tiles can be detected per top-level control.
        let candidates = [];
        let visit = (actor, root) => {
            if (!actor)
                return;
            if (actor.reactive && (typeof actor.activate === 'function' || typeof actor.emit === 'function' || actor instanceof St.Button)) {
                candidates.push({ actor, root });
            }
            for (let child of actor.get_children?.() || [])
                visit(child, root);
        };
        for (let child of this.nativeGrid.get_children()) {
            // Sliders are discovered separately below.
            if (!child.has_style_class_name?.('quick-slider'))
                visit(child, child);
        }
        let matchedRoots = new Set();
        for (let { actor: source, root } of candidates) {
            let title = `${this._labels(source).join(' ')} ${this._accessibleName(source)}`.toLowerCase();
            let icon = this._icon(source);
            let key = this._keyFor(title, icon);
            if (!key)
                continue;
            // Multiple native actors can represent one logical control (notably
            // Wi-Fi plus a newly connected Ethernet device). Mark aliases as
            // claimed so the auto-detector cannot turn them into a new layout tile.
            if (controls.has(key)) {
                matchedRoots.add(root);
                continue;
            }
            matchedRoots.add(root);
            let src = source;
            if (`${source.style_class || ''}`.includes('quick-toggle-menu-button')) {
                let p = source.get_parent?.();
                for (let i = 0; i < 5 && p; i++) {
                    if (`${p.style_class || ''}`.includes('quick-toggle')) {
                        src = p;
                        break;
                    }
                    p = p.get_parent?.();
                }
            }
            let kind = ['network', 'bluetooth', 'power-mode', 'caffeine'].includes(key) ? 'wide' : 'single';
            let submenu = key === 'network' || key === 'bluetooth' || key === 'caffeine' || key === 'power-mode' || key === 'power'
                ? (key === 'network' ? 'wifi' : key === 'power-mode' || key === 'power' ? 'power' : key)
                : undefined;
            controls.set(key, {
                key,
                source: src,
                title: this._title(src, key),
                iconName: this._icon(src) || this._fallbackIcon(key),
                kind,
                squircle: kind === 'wide',
                submenu,
            });
        }
        // Auto-detector: any direct grid child that did not match a known control
        // is treated as a new tile contributed by an extension. Derive a stable
        // key from its own label/icon so it survives sessions.
        let seenRoots = new Set();
        for (let child of this.nativeGrid.get_children()) {
            if (child.has_style_class_name?.('quick-slider') || seenRoots.has(child))
                continue;
            seenRoots.add(child);
            if (matchedRoots.has(child))
                continue;
            let best = null;
            for (let { actor, root } of candidates) {
                if (root !== child)
                    continue;
                if (!best || (this._labels(actor).length > this._labels(best).length))
                    best = actor;
            }
            if (!best)
                continue;
            let title = this._labels(best)[0] || this._accessibleName(best);
            let icon = this._icon(best);
            let key = this._syntheticKey(title, icon);
            if (!key || controls.has(key))
                continue;
            controls.set(key, {
                key,
                source: best,
                title: title || 'Quick Setting',
                iconName: icon || this._fallbackIcon(''),
                kind: 'single',
                squircle: false,
                submenu: undefined,
            });
        }
        // Sliders live directly in the native grid; expose them so layouts can
        // place them among the buttons.
        let sliderIndex = 0;
        for (let child of this.nativeGrid.get_children()) {
            if (!child.has_style_class_name?.('quick-slider'))
                continue;
            sliderIndex++;
            let title = `${this._labels(child).join(' ')}`;
            let icon = this._icon(child);
            let key = this._sliderKeyFor(child, sliderIndex);
            if (!key || controls.has(key))
                continue;
            controls.set(key, {
                key,
                source: child,
                title: title ? title.charAt(0).toUpperCase() + title.slice(1)
                    : (key === 'volume' ? 'Volume' : key === 'brightness' ? 'Brightness' : `Slider ${sliderIndex}`),
                iconName: icon || this._fallbackIcon(key),
                kind: 'slider',
                squircle: false,
                submenu: undefined,
            });
        }
        return controls;
    }
    _hiddenKeys() {
        let saved = this._savedLayout();
        return new Set(saved ? saved.hidden : DEFAULT_HIDDEN);
    }
    /**
     * Derive the stable layout key for a native `quick-slider` child, mirroring
     * the logic in _discoverControls so _moveSliders can match sliders against
     * the saved hidden set.
     */
    _sliderKeyFor(child, sliderIndex = 0) {
        let title = `${this._labels(child).join(' ')}`;
        let icon = this._icon(child);
        let value = `${title} ${icon}`.toLowerCase();
        let key = value.includes('brightness') ? 'brightness'
            : /volume|audio/.test(value) ? 'volume'
                : null;
        if (!key)
            key = this._syntheticKey(title, icon) || (sliderIndex > 0 ? `ext:slider-${sliderIndex}` : null);
        return key;
    }
    _syntheticKey(title, icon) {
        let base = `${title} ${icon}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!base)
            return null;
        return `ext:${base}`;
    }
    _keyFor(text, icon) {
        let value = `${text} ${icon}`.toLowerCase();
        if (value.includes('ethernet') || value.includes('wired'))
            return 'network';
        if (value.includes('wi-fi') || value.includes('wifi') || value.includes('wireless') || value.includes('network'))
            return 'network';
        if (value.includes('bluetooth'))
            return 'bluetooth';
        if (value.includes('dark mode') || value.includes('night theme'))
            return 'dark';
        if (value.includes('night light'))
            return 'night';
        if (value.includes('airplane') || value.includes('flight'))
            return 'airplane';
        if (value.includes('do not disturb') || value.includes('notifications-disabled'))
            return 'dnd';
        if (value.includes('caffeine'))
            return 'caffeine';
        if (value.includes('power mode') || value.includes('power profile'))
            return 'power-mode';
        if (value.includes('screenshot'))
            return 'screenshot';
        if (value.includes('settings') || value.includes('emblem-system'))
            return 'settings';
        if (value.includes('battery') || value.includes('power-level'))
            return 'battery';
        if (value.includes('suspend'))
            return 'suspend';
        if (value.includes('lock') || value.includes('lock screen'))
            return 'lock';
        if (value.includes('shutdown') || value.includes('power off'))
            return 'power';
        if (value.includes('dark') || value.includes('dark-mode-symbolic'))
            return 'dark';
        if (value.includes('screenshooter') || value.includes('take screenshot'))
            return 'screenshot';
        if (value.includes('preferences-system') || value.includes('emblem-system'))
            return 'settings';
        if (value.includes('battery-level') || value.includes('battery-') || value.includes('power-level'))
            return 'battery';
        return null;
    }
    _labels(actor) {
        let labels = [];
        let visit = (node) => {
            if (!node)
                return;
            if (node instanceof St.Label || node.constructor?.name === 'St_Label') {
                let text = `${node.text || ''}`.trim();
                if (text && !labels.includes(text))
                    labels.push(text);
            }
            for (let child of node.get_children?.() || [])
                visit(child);
        };
        visit(actor);
        return labels;
    }
    _accessibleName(actor) {
        try {
            return `${actor.accessible_name || ''}`.trim();
        }
        catch (e) {
            return '';
        }
    }
    _icon(actor) {
        let icon = '';
        const ARROW_ICONS = new Set(['go-next-symbolic', 'pan-end-symbolic']);
        let visit = (node) => {
            if (!node || icon)
                return;
            if (node !== actor && `${node.style_class || ''}`.includes('quick-toggle-menu-button'))
                return;
            let candidate = '';
            if (node.icon_name)
                candidate = node.icon_name;
            else if (node.gicon?.get_names?.())
                candidate = node.gicon.get_names()[0];
            if (candidate && !ARROW_ICONS.has(candidate))
                icon = candidate;
            for (let child of node.get_children?.() || [])
                visit(child);
        };
        visit(actor);
        return icon;
    }
    _title(source, key) {
        if (key === 'network')
            return this._networkDetails().title;
        return this._labels(source)[0] || {
            network: 'Network', bluetooth: 'Bluetooth', dark: 'Dark Mode', night: 'Night Light',
            airplane: 'Airplane Mode', dnd: 'Do Not Disturb', caffeine: 'Caffeine', 'power-mode': 'Power Mode',
            screenshot: 'Screenshot', settings: 'Settings', battery: 'Battery', power: 'Power', suspend: 'Suspend', lock: 'Lock',
        }[key] || 'Quick Setting';
    }
    _subtitle(source, key) {
        if (key === 'network') {
            return this._networkDetails().subtitle;
        }
        // Bluetooth's native labels and checked state can lag behind the actual
        // controller. Read the controller first so its tint and subtitle agree.
        if (key === 'bluetooth') {
            try {
                let client = this._bluetoothClient();
                if (client) {
                    if (client.active) {
                        // Try to find connected device names
                        let devices = Array.from(client.getDevices?.() || []);
                        let connected = devices.filter((d) => d.connected);
                        if (connected.length > 0) {
                            let firstDev = connected[0];
                            let name = firstDev.alias || firstDev.name || firstDev.display_name || firstDev.get_name?.() || 'Connected';
                            return connected.length > 1 ? `${name} +${connected.length - 1}` : name;
                        }
                        return 'On';
                    }
                    return 'Off';
                }
            }
            catch (e) { }
        }
        let labelText = this._labels(source).slice(1).join(' ');
        if (labelText)
            return labelText;
        return this._isChecked(source, key) ? 'On' : 'Off';
    }
    _bluetoothClient() {
        try {
            return Main.panel.statusArea.quickSettings?._bluetooth?._client || null;
        }
        catch (e) {
            return null;
        }
    }
    _fallbackIcon(key) {
        return { network: 'network-wireless-signal-good-symbolic', bluetooth: 'bluetooth-active-symbolic', dark: 'weather-clear-night-symbolic', night: 'night-light-symbolic', airplane: 'airplane-mode-symbolic', dnd: 'notifications-disabled-symbolic', caffeine: 'caffeine-cup-full-symbolic', 'power-mode': 'power-profile-balanced-symbolic', screenshot: 'camera-photo-symbolic', settings: 'emblem-system-symbolic', battery: 'battery-level-100-symbolic', power: 'system-shutdown-symbolic', suspend: 'media-playback-pause-symbolic', lock: 'system-lock-screen-symbolic' }[key] || 'emblem-system-symbolic';
    }
    _activate(source, key) {
        if (!source)
            return;
        const tag = `${key || ''} (${source.constructor?.name})`;
        const event = Clutter.get_current_event?.();
        let button = 1;
        try {
            if (event && typeof event.get_button === 'function')
                button = event.get_button() || 1;
        }
        catch (e) { }
        try {
            if (source.toggle_mode === true || source.get_toggle_mode?.() === true) {
                source.checked = !source.checked;
                return;
            }
        }
        catch (e) { }
        if (typeof source.emit === 'function') {
            try {
                source.emit('clicked', button);
                return;
            }
            catch (e) {
                try {
                    console.log(`[Liquid Glass] activate ${tag}: emit('clicked') threw: ${e}`);
                }
                catch (e2) { }
            }
        }
        if (typeof source.activate === 'function') {
            try {
                source.activate(event);
            }
            catch (e) {
                try {
                    console.log(`[Liquid Glass] activate ${tag}: activate() threw: ${e}`);
                }
                catch (e2) { }
            }
        }
    }
    _isChecked(source, key) {
        if (key === 'bluetooth') {
            let client = this._bluetoothClient();
            // Do not fall back to the native tile: its checked flag is known to be
            // stale for Bluetooth. If the controller exists, it is authoritative.
            if (client)
                return client.active === true;
        }
        if (key === 'network') {
            const connected = this._networkConnected();
            if (connected !== null)
                return connected;
            // The checked state is often held by a nested quick-toggle rather than
            // the menu-button wrapper used as our activation source.
            let checked = false;
            let visit = (actor) => {
                if (!actor || checked)
                    return;
                try {
                    checked = actor.checked === true || actor.get_checked?.() === true || actor.has_style_pseudo_class?.('checked') === true;
                }
                catch (e) { }
                for (let child of actor.get_children?.() || [])
                    visit(child);
            };
            visit(source);
            return checked;
        }
        try {
            return source.checked === true || source.get_checked?.() === true || source.has_style_pseudo_class?.('checked');
        }
        catch (e) {
            return false;
        }
    }
    /** Read NetworkManager's actual device state instead of a QuickToggle skin. */
    _networkConnected() {
        try {
            const network = Main.panel.statusArea.quickSettings?._network;
            const client = network?._client;
            if (!client)
                return null;
            const checked = (actor) => {
                if (!actor)
                    return null;
                try {
                    return actor.checked === true || actor.get_checked?.() === true || actor.has_style_pseudo_class?.('checked') === true;
                }
                catch (e) {
                    return null;
                }
            };
            // GNOME exposes radio state through these toggles even when there is no
            // primary connection (for example, Wi-Fi is on but scanning).
            const radioState = checked(network?._wirelessToggle) ?? checked(network?._wiredToggle);
            if (radioState !== null)
                return radioState;
            const wirelessEnabled = client.wireless_enabled ?? client.get_wireless_enabled?.();
            if (typeof wirelessEnabled === 'boolean')
                return wirelessEnabled;
            const networkingEnabled = client.networking_enabled ?? client.get_networking_enabled?.();
            if (typeof networkingEnabled === 'boolean' && networkingEnabled === false)
                return false;
            const primary = client.primary_connection ?? client.get_primary_connection?.();
            if (primary) {
                const state = primary.state ?? primary.get_state?.();
                // NMActiveConnectionState.ACTIVATED is 2.
                return state === 2 || `${state}`.toLowerCase() === 'activated';
            }
            const devices = client.get_devices?.() ?? client.devices ?? [];
            for (const device of devices) {
                const state = device.state ?? device.get_state?.();
                // NMDeviceState.ACTIVATED is 100.
                if (state === 100 || `${state}`.toLowerCase() === 'activated')
                    return true;
            }
            return false;
        }
        catch (e) {
            return null;
        }
    }
    _networkDetails() {
        try {
            const network = Main.panel.statusArea.quickSettings?._network;
            const client = network?._client;
            const primary = client?.primary_connection ?? client?.get_primary_connection?.();
            if (primary) {
                const state = primary.state ?? primary.get_state?.();
                const active = state === 2 || `${state}`.toLowerCase() === 'activated';
                const connection = primary.connection ?? primary.get_connection?.();
                const type = `${primary.connection_type ?? primary.type ?? primary.get_connection_type?.() ?? connection?.connection_type ?? ''}`.toLowerCase();
                const name = `${primary.id ?? primary.get_id?.() ?? connection?.id ?? connection?.get_id?.() ?? ''}`.trim();
                const ethernet = /ethernet|wired|802-3/.test(type);
                if (ethernet)
                    return { title: 'Ethernet', subtitle: active ? 'Connected' : 'Connecting…' };
                if (active)
                    return { title: 'Wi-Fi', subtitle: name || 'Connected' };
            }
            const connected = this._networkConnected();
            if (connected)
                return { title: 'Wi-Fi', subtitle: 'On' };
            return { title: 'Network', subtitle: 'Off' };
        }
        catch (e) {
            return { title: 'Network', subtitle: 'Off' };
        }
    }
    _syncCardState(card, source, icon) {
        if (!card || !source)
            return;
        let key = card._liquidGlassControlKey;
        if (this._isChecked(source, key))
            card.add_style_class_name('checked');
        else
            card.remove_style_class_name('checked');
        if (source.gicon)
            icon.gicon = source.gicon;
        else {
            let iconName = this._icon(source);
            if (iconName)
                icon.icon_name = iconName;
        }
        // Also update the subtitle text so Bluetooth/network status stays in sync.
        // Pill (custom) subtitles are user-authored and must not be overwritten.
        let subtitleLabel = card._liquidGlassSubtitleLabel;
        let subtitleFixed = card._liquidGlassSubtitleFixed === true;
        if (subtitleLabel && !subtitleFixed) {
            subtitleLabel.text = this._subtitle(source, key);
        }
        if (key === 'network') {
            const titleLabel = card._liquidGlassTitleLabel;
            if (titleLabel)
                titleLabel.text = this._networkDetails().title;
        }
        this.manager._wakeCardBackingSync?.();
    }
    _syncExistingCards() {
        let visit = (actor) => {
            try {
                actor?._liquidGlassSyncState?.();
            }
            catch (e) { }
            for (let child of actor?.get_children?.() || [])
                visit(child);
        };
        visit(this.root);
    }
    _watch(source, key, callback) {
        for (let signal of ['notify::checked', 'notify::visible', 'notify::icon-name', 'style-changed']) {
            try {
                this.signalIds.push({ target: source, id: source.connect(signal, callback) });
            }
            catch (e) { }
        }
        if (key === 'network') {
            let client = null;
            let network = null;
            try {
                network = Main.panel.statusArea.quickSettings?._network;
                client = network?._client;
            }
            catch (e) { }
            for (let signal of ['notify::primary-connection', 'notify::active-connections', 'notify::connectivity', 'device-added', 'device-removed']) {
                try {
                    this.signalIds.push({ target: client, id: client.connect(signal, callback) });
                }
                catch (e) { }
            }
            for (let toggle of [network?._wirelessToggle, network?._wiredToggle]) {
                for (let signal of ['notify::checked', 'notify::visible', 'style-changed']) {
                    try {
                        this.signalIds.push({ target: toggle, id: toggle.connect(signal, callback) });
                    }
                    catch (e) { }
                }
            }
            return;
        }
        if (key !== 'bluetooth')
            return;
        // The Bluetooth controller can change outside this menu (Settings, a
        // hardware switch, or another shell component), without the native tile
        // emitting notify::checked. Watch it directly.
        let client = this._bluetoothClient();
        for (let signal of ['notify::active', 'notify::available', 'devices-changed', 'device-added', 'device-removed']) {
            try {
                this.signalIds.push({ target: client, id: client.connect(signal, callback) });
            }
            catch (e) { }
        }
    }
    _scheduleRefresh() {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this.manager._wakeCardBackingSync?.();
            return GLib.SOURCE_REMOVE;
        });
    }
    _disconnectSignals() {
        for (let { target, id } of this.signalIds) {
            try {
                target.disconnect(id);
            }
            catch (e) { }
        }
        this.signalIds = [];
    }
}
