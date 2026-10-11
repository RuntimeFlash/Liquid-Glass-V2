import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { Spinner } from 'resource:///org/gnome/shell/ui/animation.js';
import { SubmenuPanel } from './submenuPanel.js?v=mv3llad7';
// DEV-PROBE-START
import { bump } from './devProbe.js?v=mv3llad7';
// DEV-PROBE-END
// How long the renderer refuses to rebuild rows after an open starts. Row
// rebuilds call destroy_all_children, which resets allocation; doing that mid
// transition would fight the animation for the panel's geometry. This is a
// guard on *row rebuilds*, not the animation's duration: the animation ends on
// its own schedule (SubmenuAnimation), and if it runs long the guard simply
// expires first, which is harmless.
const SUBMENU_OPEN_GUARD_MS = 260;
export class CustomSubmenuRenderer {
    manager;
    _floatingWindow;
    // The panel is built once and reused across opens: its glass stack is
    // expensive to construct, and rebuilding it per open was a large part of the
    // open-frame stall. It is destroyed only on extension teardown.
    _panel = null;
    _pendingActions;
    _refreshTimerIds;
    _wifiScanActive;
    _wifiScanGeneration;
    // True while the open/close fade runs. The 300ms poll skips rebuilds during
    // this window so rows can't be destroyed/recreated mid-animation (jump).
    _submenuTransitioning = false;
    // The row-rebuild guard timer for the current open. Tracked so a superseding
    // open cannot be un-guarded early by the previous open's timer.
    _transitionTimerId = 0;
    // True when the current close already began the Quick Settings return
    // crossfade in _onPanelClosing, so _onPanelClosed must not start it again.
    _revealedOnClose = false;
    constructor(manager) {
        this.manager = manager;
        this._floatingWindow = null;
        this._panel = null;
        this._pendingActions = new Map();
        this._refreshTimerIds = [];
        this._wifiScanActive = false;
        this._wifiScanGeneration = 0;
    }
    /** Full teardown of the reused panel. Called from the manager's cleanup. */
    destroy() {
        this._clearRefreshTimers();
        if (this._transitionTimerId) {
            try {
                GLib.source_remove(this._transitionTimerId);
            }
            catch (e) { }
            this._transitionTimerId = 0;
        }
        this._submenuTransitioning = false;
        this._floatingWindow = null;
        if (this._panel) {
            try {
                this._panel.destroy(false);
            }
            catch (e) { }
            this._panel = null;
        }
    }
    close(immediate = true, reopen = false) {
        this._clearRefreshTimers();
        const panel = this._floatingWindow;
        this._floatingWindow = null;
        if (panel && !panel.destroyed) {
            // The panel owns its own teardown; the callback below performs the Quick
            // Settings hand-off exactly once, whether the close was animated or not.
            panel.onClosed((shouldReopen) => this._onPanelClosed(panel, shouldReopen));
            panel.close(reopen, immediate);
        }
        else if (reopen) {
            // Nothing on screen to animate; hand straight back to Quick Settings.
            this._reopenQuickSettings(false);
        }
    }
    /**
     * Runs the instant a close starts. Quick Settings is brought back *behind*
     * the still-fading panel and its entrance begins on the same frame, so the
     * two surfaces crossfade instead of playing back to back. The panel is raised
     * above Quick Settings afterwards so it stays on top through the fade.
     */
    _onPanelClosing(panel, reopen) {
        if (this._floatingWindow && this._floatingWindow !== panel)
            return;
        if (!reopen)
            return;
        try {
            this.manager.reopenQuickSettingsFromSubmenu?.(true);
            panel.raise();
            this.manager.revealQuickSettingsAfterSubmenu?.(false, true);
            this._revealedOnClose = true;
        }
        catch (e) { }
    }
    /**
     * The single place a panel's life ends. Runs after the close transition (or
     * immediately for an instant close), and owns the hand-off back to Quick
     * Settings.
     *
     * Guarded on the panel identity so a panel that was superseded by a newer
     * open can never drive Quick Settings: its close callback still fires, but it
     * is no longer the current panel and so returns without touching anything.
     */
    _onPanelClosed(panel, reopen) {
        if (this._floatingWindow && this._floatingWindow !== panel)
            return;
        if (this._transitionTimerId) {
            try {
                GLib.source_remove(this._transitionTimerId);
            }
            catch (e) { }
            this._transitionTimerId = 0;
        }
        this._submenuTransitioning = false;
        if (reopen) {
            // The crossfade normally started in _onPanelClosing; this is the fallback
            // for a close path that never fired it (e.g. suppressed panel).
            if (!this._revealedOnClose)
                this._reopenQuickSettings(true);
        }
        else {
            this.manager.finishQuickSettingsSubmenuWithoutReopen?.();
        }
        this._revealedOnClose = false;
    }
    _reopenQuickSettings(animated) {
        try {
            if (typeof this.manager.reopenQuickSettingsFromSubmenu === 'function')
                this.manager.reopenQuickSettingsFromSubmenu(true);
            else
                this.manager.menu.open();
        }
        catch (e) { }
        try {
            this.manager.revealQuickSettingsAfterSubmenu?.(false, animated);
        }
        catch (e) { }
    }
    show(stCard, kind) {
        let detectedKind = kind || this._getKindFromCard(stCard);
        if (!detectedKind)
            return;
        // Switching submenus: retire the old panel's *content* but keep the panel
        // (and its glass stack) alive. It is re-presented in the same frame with the
        // new rows, so two panels never both own a glass stack.
        if (this._floatingWindow) {
            this._floatingWindow = null;
        }
        if (detectedKind === 'bluetooth')
            this._showPanel(this._buildBluetoothRows.bind(this), 'bluetooth', stCard);
        else if (detectedKind === 'wifi')
            this._showPanel(() => this._buildWifiRows(stCard), 'wifi', stCard);
        else
            this._showPanel(() => this._buildGenericRows(stCard, detectedKind), detectedKind, stCard);
    }
    showBluetooth(stCard) {
        this.show(stCard, 'bluetooth');
    }
    showWifi(stCard) {
        this.show(stCard, 'wifi');
    }
    _getKindFromCard(stCard) {
        let text = `${stCard?.title || ''} ${stCard?.label || ''}`.toLowerCase();
        if (text.includes('bluetooth'))
            return 'bluetooth';
        if (text.includes('wi-fi') || text.includes('wifi') || text.includes('wireless'))
            return 'wifi';
        if (text.includes('caffeine'))
            return 'caffeine';
        if (text.includes('power'))
            return 'power';
        return null;
    }
    _getSourceBounds(sourceActor) {
        try {
            let managerBounds = this.manager?.getSubmenuMorphBounds?.(sourceActor);
            if (managerBounds)
                return managerBounds;
            if (!sourceActor)
                return null;
            let [x, y] = sourceActor.get_transformed_position();
            let [w, h] = sourceActor.get_size();
            if (Number.isNaN(x) || Number.isNaN(y) || w <= 0 || h <= 0)
                return null;
            return { x, y, w, h, centerX: x + w / 2, centerY: y + h / 2 };
        }
        catch (e) {
            return null;
        }
    }
    _showPanel(rowBuilder, settingsPanel, sourceCard) {
        this._clearRefreshTimers();
        // A fresh open supersedes any previous row-rebuild guard from an earlier
        // open (e.g. when switching submenus mid-transition).
        if (this._transitionTimerId) {
            try {
                GLib.source_remove(this._transitionTimerId);
            }
            catch (e) { }
            this._transitionTimerId = 0;
        }
        this._submenuTransitioning = false;
        // Reuse the persistent panel; only its rows are rebuilt.
        let panel = this._panel;
        if (!panel || panel.destroyed) {
            panel = new SubmenuPanel({ manager: this.manager });
            this._panel = panel;
        }
        let rowsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'liquid-glass-control-list',
            x_expand: true,
            y_expand: true,
        });
        let scrollView = new St.ScrollView({
            style_class: 'liquid-glass-control-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
        });
        scrollView.add_child(rowsBox);
        // Size the panel from the real row stack, not the ScrollView's viewport.
        panel.setContentMeasurer((innerWidth) => {
            try {
                const [, h] = rowsBox.get_preferred_height(innerWidth);
                return h;
            }
            catch (e) {
                return 0;
            }
        });
        // The panel owns its content box; swap the previous content out for this
        // open's rows before it is measured.
        let contentArea = panel.content;
        contentArea.destroy_all_children();
        contentArea.add_child(scrollView);
        let serializeRows = (rows) => {
            return JSON.stringify(rows.map(r => ({
                title: r.title, subtitle: r.subtitle, iconName: r.iconName,
                active: r.active, actionLabel: r.actionLabel, disabled: r.disabled,
                pending: r.pending, scanning: r.scanning, section: r.section,
                switchRow: r.switchRow, pendingKey: r.pendingKey, desiredActive: r.desiredActive
            })));
        };
        let lastRowsHash = '';
        // Remeasure the panel after a row rebuild. The panel's rect is constant for
        // the whole open transition, so this only ever runs once the open has
        // settled; during the transition it is skipped entirely (see refreshRows),
        // which is what keeps the frost's rect stable frame to frame.
        let remeasurePending = false;
        let requestRemeasure = () => {
            if (remeasurePending)
                return;
            remeasurePending = true;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                remeasurePending = false;
                // DEV-PROBE-START
                bump('heightSync');
                // DEV-PROBE-END
                try {
                    if (this._submenuTransitioning || panel.destroyed)
                        return GLib.SOURCE_REMOVE;
                    panel.measure();
                }
                catch (e) { }
                return GLib.SOURCE_REMOVE;
            });
        };
        let refreshRows = () => {
            // DEV-PROBE-START
            bump('refreshRows');
            // DEV-PROBE-END
            // Never rebuild rows mid-fade: destroy_all_children during the open or
            // close ease resets allocation and visibly jumps.
            if (this._submenuTransitioning)
                return;
            let rows = rowBuilder();
            let newHash = serializeRows(rows);
            if (newHash === lastRowsHash)
                return;
            lastRowsHash = newHash;
            // DEV-PROBE-START
            bump('rowsRebuilt');
            // DEV-PROBE-END
            rowsBox.destroy_all_children();
            for (let row of rows) {
                if (row.pendingKey && row.desiredActive !== undefined && row.active === row.desiredActive)
                    this._pendingActions.delete(row.pendingKey);
                if (row.section)
                    rowsBox.add_child(this._createSectionLabel(row.title, !!row.scanning));
                else {
                    rowsBox.add_child(this._createControlRow(row, refreshRows));
                    // DEV-PROBE-START
                    bump('rowsCreated');
                    // DEV-PROBE-END
                }
            }
            rowsBox.add_child(this._createDivider());
            if (settingsPanel === 'bluetooth' || settingsPanel === 'wifi' || settingsPanel === 'power') {
                let settingsTitle = settingsPanel === 'bluetooth' ? 'Bluetooth Settings' : (settingsPanel === 'wifi' ? 'Wi-Fi Settings' : 'Power Settings');
                rowsBox.add_child(this._createControlRow({
                    title: settingsTitle,
                    iconName: 'emblem-system-symbolic',
                    actionLabel: 'Open',
                    onActivate: () => this._openSettings(settingsPanel),
                }, refreshRows));
            }
            requestRemeasure();
        };
        refreshRows();
        let allocationSyncId = 0;
        try {
            allocationSyncId = rowsBox.connect('notify::allocation', () => {
                if (allocationSyncId) {
                    try {
                        rowsBox.disconnect(allocationSyncId);
                    }
                    catch (e) { }
                    allocationSyncId = 0;
                }
                requestRemeasure();
            });
        }
        catch (e) { }
        // present() measures the panel on-stage before the transition starts, so
        // the rect is final for the first drawn frame.
        this._floatingWindow = panel;
        panel.onClosing((reopen) => this._onPanelClosing(panel, reopen));
        panel.onClosed((reopen) => this._onPanelClosed(panel, reopen));
        this._submenuTransitioning = true;
        // The floating submenu replaces Quick Settings: dismiss the Quick Settings
        // menu so the two surfaces are never on screen together.
        try {
            this.manager.closeQuickSettingsForSubmenu?.(true);
        }
        catch (e) {
            try {
                this.manager.menu.close(false);
            }
            catch (e2) { }
        }
        panel.present();
        this._transitionTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUBMENU_OPEN_GUARD_MS, () => {
            this._transitionTimerId = 0;
            this._submenuTransitioning = false;
            // One settled pass after the fade, in case data arrived while rebuilds
            // were paused.
            try {
                refreshRows();
            }
            catch (e) { }
            return GLib.SOURCE_REMOVE;
        });
        let pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            try {
                if (this._submenuTransitioning)
                    return GLib.SOURCE_CONTINUE;
                if (settingsPanel === 'wifi')
                    this._syncNativeWifiItems(sourceCard);
                refreshRows();
            }
            catch (e) { }
            return GLib.SOURCE_CONTINUE;
        });
        this._refreshTimerIds.push(pollId);
        if (settingsPanel === 'wifi')
            this._startWifiPolling(sourceCard, refreshRows);
    }
    _buildBluetoothRows() {
        let indicator = Main.panel.statusArea.quickSettings?._bluetooth;
        let client = indicator?._client;
        if (!client) {
            return [{
                    title: 'Bluetooth Unavailable',
                    subtitle: 'No adapter found',
                    iconName: 'bluetooth-disabled-symbolic',
                    disabled: true,
                }];
        }
        let powerPendingKey = 'bluetooth-power';
        let powerPending = this._pendingActions.get(powerPendingKey);
        let rows = [{
                title: client.active ? 'Bluetooth On' : 'Bluetooth Off',
                subtitle: client.available ? 'Devices' : 'Adapter unavailable',
                iconName: client.active ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic',
                active: !!client.active,
                actionLabel: powerPending || (client.active ? 'On' : 'Off'),
                pending: !!powerPending,
                pendingKey: powerPendingKey,
                desiredActive: powerPending ? powerPending.includes('On') : undefined,
                switchRow: true,
                disabled: !client.available,
                onActivate: () => {
                    this._markPending(powerPendingKey, client.active ? 'Turning Off...' : 'Turning On...');
                    try {
                        client.toggleActive();
                    }
                    catch (e) { }
                },
            }];
        if (!client.available)
            return rows;
        rows.push({ title: 'Devices', iconName: '', section: true });
        let devices = [];
        try {
            devices = Array.from(client.getDevices?.() || []);
        }
        catch (e) { }
        devices.sort((a, b) => Number(!!b.connected) - Number(!!a.connected) || this._deviceName(a).localeCompare(this._deviceName(b)));
        if (devices.length === 0) {
            rows.push({
                title: 'No Devices',
                subtitle: client.active ? 'Pair devices in Bluetooth Settings' : 'Turn on Bluetooth to connect',
                iconName: 'audio-headphones-symbolic',
                disabled: true,
            });
            return rows;
        }
        for (let device of devices) {
            let connected = !!device.connected;
            let pendingKey = this._deviceKey(device);
            let pendingLabel = this._pendingActions.get(pendingKey);
            if (pendingLabel && ((pendingLabel.includes('Connecting') && connected) || (pendingLabel.includes('Disconnecting') && !connected))) {
                this._pendingActions.delete(pendingKey);
                pendingLabel = undefined;
            }
            rows.push({
                title: this._deviceName(device),
                subtitle: pendingLabel || (connected ? 'Connected' : (device.paired ? 'Paired' : 'Available')),
                iconName: this._deviceIcon(device, 'audio-headphones-symbolic'),
                active: connected,
                actionLabel: '',
                pending: !!pendingLabel,
                pendingKey,
                desiredActive: pendingLabel ? pendingLabel.includes('Connecting') : undefined,
                disabled: !client.active,
                onActivate: () => {
                    if (!client.active)
                        return;
                    this._markPending(pendingKey, connected ? 'Disconnecting...' : 'Connecting...');
                    try {
                        Promise.resolve(client.toggleDevice(device)).catch(() => { });
                    }
                    catch (e) { }
                },
            });
        }
        return rows;
    }
    _buildWifiRows(stCard) {
        let rows = [];
        // Always read from the real wireless toggle. A wired toggle also exposes
        // `_items`/a menu, but an empty one, which would read as "unavailable".
        let wifiToggle = this._getWifiToggle(stCard);
        let subtitle = wifiToggle?.subtitle || stCard?.subtitle || this._findSubtitle(stCard) || 'Wireless networks';
        let isActive = this._isActorChecked(wifiToggle) || this._isActorChecked(stCard) || !`${subtitle}`.toLowerCase().includes('off');
        let wifiPowerPendingKey = 'wifi-power';
        let wifiPowerPending = this._pendingActions.get(wifiPowerPendingKey);
        let menuItems = this._getNativeMenuItems(wifiToggle);
        let powerItem = this._findWifiPowerItem(menuItems, isActive);
        rows.push({
            title: isActive ? 'Wi-Fi On' : 'Wi-Fi Off',
            subtitle,
            iconName: isActive ? 'network-wireless-signal-excellent-symbolic' : 'network-wireless-offline-symbolic',
            active: isActive,
            actionLabel: wifiPowerPending || (isActive ? 'On' : 'Off'),
            pending: !!wifiPowerPending,
            pendingKey: wifiPowerPendingKey,
            desiredActive: wifiPowerPending ? wifiPowerPending.includes('On') : undefined,
            switchRow: true,
            disabled: !powerItem,
            onActivate: () => {
                this._markPending(wifiPowerPendingKey, isActive ? 'Turning Off...' : 'Turning On...');
                try {
                    if (typeof powerItem?.activate === 'function')
                        powerItem.activate(Clutter.get_current_event?.());
                    else if (typeof powerItem?.emit === 'function')
                        powerItem.emit('activate', Clutter.get_current_event?.());
                }
                catch (e) { }
            },
        });
        let seen = new Set();
        let parsedRows = menuItems.map((item) => this._rowFromNativeItem(item, 'wifi')).filter((row) => {
            if (!row)
                return false;
            let key = row.title.toLowerCase();
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        if (parsedRows.length === 0) {
            rows.push({
                title: 'Networks Unavailable',
                subtitle: 'Open Wi-Fi Settings to connect',
                iconName: 'network-wireless-offline-symbolic',
                disabled: true,
            });
            return rows;
        }
        let knownRows = parsedRows.filter((row) => row.active || row.pending);
        let otherRows = parsedRows.filter((row) => !knownRows.includes(row));
        if (knownRows.length > 0)
            rows.push({ title: 'Current Network', iconName: '', section: true, scanning: isActive && this._wifiScanActive }, ...knownRows.map((row) => ({
                ...row,
                subtitle: row.active ? 'Connected' : row.subtitle,
                scanning: false,
            })));
        if (otherRows.length > 0)
            rows.push({ title: 'Other Networks', iconName: '', section: true }, ...otherRows);
        return rows;
    }
    _buildGenericRows(stCard, kind) {
        let rows = [];
        let fallbackTitle = kind === 'power' ? 'Power Off' : (kind === 'system' ? 'System' : 'Caffeine');
        let fallbackIcon = kind === 'power' ? 'system-shutdown-symbolic' : (kind === 'system' ? 'system-shutdown-symbolic' : 'caffeine-cup-full-symbolic');
        let title = stCard?.title || stCard?.label || fallbackTitle;
        let subtitle = stCard?.subtitle || this._findSubtitle(stCard) || '';
        let iconName = this._extractIconName(stCard) || fallbackIcon;
        let menuItems = this._getNativeMenuItems(stCard);
        let isActive = this._isActorChecked(stCard) || !`${subtitle}`.toLowerCase().includes('off');
        // Add master toggle row only if it's not power mode, as power mode is just a selector
        if (kind !== 'power' && kind !== 'system') {
            rows.push({
                title: isActive ? `${title} On` : `${title} Off`,
                subtitle,
                iconName: iconName,
                active: isActive,
                switchRow: true,
                onActivate: () => {
                    try {
                        if (typeof stCard?.activate === 'function')
                            stCard.activate(Clutter.get_current_event?.());
                        else if (typeof stCard?._toggle?.activate === 'function')
                            stCard._toggle.activate(Clutter.get_current_event?.());
                        else if (typeof stCard?.emit === 'function')
                            stCard.emit('activate', Clutter.get_current_event?.());
                    }
                    catch (e) { }
                }
            });
        }
        let seen = new Set();
        let parsedRows = menuItems.map((item) => {
            let row = this._rowFromNativeItem(item, kind);
            if (row && (kind === 'power' || kind === 'caffeine' || kind === 'system')) {
                row.pending = false;
                row.pendingKey = undefined;
                row.desiredActive = undefined;
                row.onActivate = () => {
                    try {
                        if (kind === 'system' || kind === 'power') {
                            let event = Clutter.get_current_event?.();
                            this.close(true);
                            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                                try {
                                    if (typeof item.activate === 'function')
                                        item.activate(event);
                                    else if (typeof item.emit === 'function')
                                        item.emit('activate', event);
                                }
                                catch (e) { }
                                return GLib.SOURCE_REMOVE;
                            });
                            return;
                        }
                        else {
                            if (typeof item.activate === 'function')
                                item.activate(Clutter.get_current_event?.());
                            else if (typeof item.emit === 'function')
                                item.emit('activate', Clutter.get_current_event?.());
                        }
                    }
                    catch (e) { }
                };
            }
            return row;
        }).filter((row) => {
            if (!row)
                return false;
            let key = row.title.toLowerCase();
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        if (parsedRows.length > 0) {
            rows.push({ title: 'Options', iconName: '', section: true });
            rows.push(...parsedRows);
        }
        return rows;
    }
    _createControlRow(row, refreshRows) {
        let styleClass = 'liquid-glass-control-row';
        if (row.active)
            styleClass += ' liquid-glass-control-row-active';
        if (row.pending)
            styleClass += ' liquid-glass-control-row-pending';
        if (row.switchRow)
            styleClass += ' liquid-glass-control-row-switch';
        let button = new St.Button({
            style_class: styleClass,
            reactive: !row.disabled,
            can_focus: !row.disabled,
            x_expand: true,
        });
        let box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'liquid-glass-control-row-box',
            x_expand: true,
        });
        button.set_child(box);
        let iconStyleClass = 'liquid-glass-control-icon';
        if (row.active)
            iconStyleClass += ' liquid-glass-control-icon-active';
        if (row.pending)
            iconStyleClass += ' liquid-glass-control-icon-pending';
        let iconBin = new St.Bin({
            style_class: iconStyleClass,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        iconBin.set_child(new St.Icon({ icon_name: row.iconName, style_class: 'liquid-glass-control-icon-symbol' }));
        box.add_child(iconBin);
        let labelBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'liquid-glass-control-labels',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        labelBox.add_child(new St.Label({ text: row.title, style_class: 'liquid-glass-control-title' }));
        if (row.subtitle) {
            let subtitleClass = row.active ? 'liquid-glass-control-subtitle liquid-glass-control-subtitle-active' : 'liquid-glass-control-subtitle';
            if (row.pending)
                subtitleClass += ' liquid-glass-control-subtitle-pending';
            labelBox.add_child(new St.Label({ text: row.subtitle, style_class: subtitleClass }));
        }
        box.add_child(labelBox);
        if (row.switchRow && (row.pending || row.scanning)) {
            let spinner = new Spinner(16, { animate: true, hideOnStop: false });
            spinner.add_style_class_name('liquid-glass-control-spinner');
            spinner.play();
            box.add_child(spinner);
        }
        else if (row.switchRow) {
            box.add_child(this._createSwitch(!!row.active && !row.pending));
        }
        else if (row.pending || row.scanning) {
            let spinner = new Spinner(16, { animate: true, hideOnStop: false });
            spinner.add_style_class_name('liquid-glass-control-spinner');
            spinner.play();
            box.add_child(spinner);
        }
        else if (row.active) {
            box.add_child(new St.Icon({
                icon_name: 'object-select-symbolic',
                style_class: 'liquid-glass-control-check',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        else if (row.actionLabel) {
            box.add_child(new St.Label({
                text: row.actionLabel,
                style_class: row.active ? 'liquid-glass-control-action liquid-glass-control-action-active' : 'liquid-glass-control-action',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        if (row.onActivate) {
            button.connect('clicked', () => {
                try {
                    let result = row.onActivate?.();
                    refreshRows();
                    Promise.resolve(result).finally(() => {
                        this._scheduleRefreshes(refreshRows);
                    });
                }
                catch (e) { }
            });
        }
        return button;
    }
    _rowFromNativeItem(item, kind = 'wifi') {
        if (!item || item.visible === false || item.reactive === false)
            return null;
        let labels = this._extractLabels(item);
        let title = labels[0];
        if (!title || this._isNativeUtilityLabel(title))
            return null;
        let subtitle = labels.slice(1).find((label) => label !== title && !this._isNativeUtilityLabel(label));
        if (title.toLowerCase().includes('all networks'))
            return null;
        let active = !!item.is_active || !!item.checked || item.has_style_pseudo_class?.('checked') || item.has_style_class_name?.('active');
        let pendingKey = `${kind}:${title}`;
        let pendingLabel = this._pendingActions.get(pendingKey);
        if (pendingLabel && active) {
            this._pendingActions.delete(pendingKey);
            pendingLabel = undefined;
        }
        let fallbackIcon = 'network-wireless-signal-good-symbolic';
        if (kind === 'caffeine')
            fallbackIcon = 'caffeine-cup-full-symbolic';
        else if (kind === 'power')
            fallbackIcon = 'power-profile-balanced-symbolic';
        else if (kind === 'bluetooth')
            fallbackIcon = 'bluetooth-active-symbolic';
        else if (kind === 'system')
            fallbackIcon = 'system-shutdown-symbolic';
        else if (kind === 'wifi')
            fallbackIcon = active ? 'network-wireless-signal-excellent-symbolic' : 'network-wireless-signal-good-symbolic';
        let iconName = this._extractIconName(item) || fallbackIcon;
        return {
            title,
            subtitle: pendingLabel || subtitle,
            iconName,
            active,
            actionLabel: '',
            pending: !!pendingLabel,
            pendingKey,
            desiredActive: pendingLabel ? true : undefined,
            onActivate: () => {
                if (!active)
                    this._markPending(pendingKey, 'Connecting...');
                try {
                    if (typeof item.activate === 'function')
                        item.activate(Clutter.get_current_event?.());
                    else if (typeof item.emit === 'function')
                        item.emit('activate', Clutter.get_current_event?.());
                }
                catch (e) { }
            },
        };
    }
    _getNativeMenuItems(stCard) {
        // DEV-PROBE-START
        bump('nativeMenuWalk');
        // DEV-PROBE-END
        let submenu = stCard?.menu || stCard?._menu;
        if (!submenu)
            return [];
        let roots = [];
        try {
            if (submenu._getMenuItems)
                roots = submenu._getMenuItems();
            else if (submenu.box)
                roots = submenu.box.get_children();
        }
        catch (e) { }
        let items = [];
        let visit = (item) => {
            if (!item)
                return;
            if (this._extractLabels(item).length > 0 && (typeof item.activate === 'function' || typeof item.emit === 'function'))
                items.push(item);
            for (let child of item._getMenuItems?.() || [])
                visit(child);
            for (let child of item.get_children?.() || [])
                visit(child);
        };
        for (let root of roots)
            visit(root);
        return items;
    }
    _createDivider() {
        return new St.Widget({ style_class: 'liquid-glass-control-divider', x_expand: true });
    }
    _createSectionLabel(title, scanning = false) {
        let box = new St.BoxLayout({
            style_class: 'liquid-glass-control-section-row',
            x_expand: true,
        });
        box.add_child(new St.Label({
            text: title,
            style_class: 'liquid-glass-control-section',
            x_expand: true,
        }));
        let spinner = new Spinner(12, { animate: true, hideOnStop: false });
        spinner.add_style_class_name('liquid-glass-control-section-spinner');
        spinner.opacity = scanning ? 255 : 0;
        if (scanning)
            spinner.play();
        else
            spinner.stop();
        box.add_child(spinner);
        return box;
    }
    _startWifiPolling(stCard, refreshRows) {
        let generation = ++this._wifiScanGeneration;
        this._wifiScanActive = true;
        refreshRows();
        this._triggerWifiScan(stCard).finally(() => {
            if (generation !== this._wifiScanGeneration)
                return;
            this._wifiScanActive = false;
            try {
                refreshRows();
            }
            catch (e) { }
        });
    }
    _clearRefreshTimers() {
        for (let id of this._refreshTimerIds) {
            try {
                GLib.source_remove(id);
            }
            catch (e) { }
        }
        this._refreshTimerIds = [];
        this._wifiScanActive = false;
        this._wifiScanGeneration++;
    }
    async _triggerWifiScan(stCard) {
        try {
            let wifiToggle = this._getWifiToggle(stCard);
            if (typeof wifiToggle?._scanDevices === 'function') {
                await Promise.resolve(wifiToggle._scanDevices());
                return;
            }
            let devices = this._getWifiDeviceItems(wifiToggle)
                .map((item) => item?._device)
                .filter((device) => device && typeof device.request_scan_async === 'function');
            for (let device of devices) {
                try {
                    device.request_scan_async(null, null);
                }
                catch (e) { }
            }
            await new Promise((resolve) => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                    resolve(null);
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
        catch (e) { }
    }
    _syncNativeWifiItems(stCard) {
        try {
            let wifiToggle = this._getWifiToggle(stCard);
            for (let item of this._getWifiDeviceItems(wifiToggle)) {
                item?._sync?.();
                item?._updateItemsVisibility?.();
            }
            wifiToggle?._sync?.();
        }
        catch (e) { }
    }
    _getWifiToggle(stCard) {
        // The wired toggle also owns a `_items` Map, so checking `_items` would
        // mistake it for Wi-Fi and scrape a menu with no wireless networks. Only
        // the wireless toggle owns `_scanDevices`; otherwise fall back to it.
        if (stCard && (typeof stCard._scanDevices === 'function' || stCard._deviceType === 2))
            return stCard;
        return Main.panel.statusArea.quickSettings?._network?._wirelessToggle || stCard;
    }
    _getWifiDeviceItems(wifiToggle) {
        let items = [];
        try {
            if (wifiToggle?._items instanceof Map)
                items.push(...wifiToggle._items.values());
            else if (wifiToggle?._items)
                items.push(...Array.from(wifiToggle._items.values?.() || []));
        }
        catch (e) { }
        return items;
    }
    _getPaletteClass() {
        try {
            let interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            let colorScheme = interfaceSettings.get_string('color-scheme');
            if (colorScheme === 'prefer-light')
                return 'liquid-glass-control-palette-light';
        }
        catch (e) { }
        return 'liquid-glass-control-palette-dark';
    }
    _createSwitch(active) {
        let track = new St.Widget({
            style_class: active ? 'liquid-glass-control-switch liquid-glass-control-switch-active' : 'liquid-glass-control-switch',
            y_align: Clutter.ActorAlign.CENTER,
        });
        let knob = new St.Widget({ style_class: 'liquid-glass-control-switch-knob' });
        knob.set_position(active ? 17 : 2, 2);
        track.add_child(knob);
        return track;
    }
    _markPending(key, label) {
        this._pendingActions.set(key, label);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
            this._pendingActions.delete(key);
            return GLib.SOURCE_REMOVE;
        });
    }
    _findWifiPowerItem(items, currentlyActive) {
        let desired = currentlyActive ? 'turn off' : 'turn on';
        return items.find((item) => {
            let labels = this._extractLabels(item).map((label) => label.toLowerCase());
            return labels.some((label) => label.includes(desired) || label.includes('wi-fi off') || label.includes('wi-fi on'));
        });
    }
    _scheduleRefreshes(refreshRows) {
        // Deprecated: UI now relies on continuous 300ms polling with DOM diffing to prevent loader jerks
    }
    _openSettings(panel) {
        try {
            this.close(true);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                try {
                    GLib.spawn_command_line_async(`gnome-control-center ${panel}`);
                }
                catch (e) { }
                return GLib.SOURCE_REMOVE;
            });
        }
        catch (e) { }
    }
    _deviceName(device) {
        return device?.alias || device?.name || device?.display_name || device?.get_name?.() || 'Unknown Device';
    }
    _deviceIcon(device, fallback) {
        return device?.icon || device?.icon_name || device?.gicon?.to_string?.() || fallback;
    }
    _deviceKey(device) {
        return `bt:${device?.object_path || device?.path || device?.address || this._deviceName(device)}`;
    }
    _findSubtitle(actor) {
        let labels = this._extractLabels(actor);
        return labels.length > 1 ? labels[1] : '';
    }
    _extractLabels(actor) {
        // DEV-PROBE-START
        bump('labelWalks');
        // DEV-PROBE-END
        let labels = [];
        let visit = (node) => {
            if (!node)
                return;
            if (node instanceof St.Label || node.constructor?.name === 'St_Label') {
                let text = `${node.text || ''}`.trim();
                if (text && !labels.includes(text))
                    labels.push(text);
                return;
            }
            for (let child of node.get_children?.() || [])
                visit(child);
        };
        visit(actor);
        return labels;
    }
    _extractIconName(actor) {
        let iconName = '';
        let visit = (node) => {
            if (!node || iconName)
                return;
            if (node.icon_name) {
                iconName = node.icon_name;
                return;
            }
            for (let child of node.get_children?.() || [])
                visit(child);
        };
        visit(actor);
        return iconName;
    }
    _isActorChecked(actor) {
        try {
            if (actor.checked === true)
                return true;
        }
        catch (e) { }
        try {
            if (actor.get_checked?.() === true)
                return true;
        }
        catch (e) { }
        try {
            if (actor.has_style_pseudo_class?.('checked'))
                return true;
        }
        catch (e) { }
        try {
            if (actor.has_style_class_name?.('checked'))
                return true;
        }
        catch (e) { }
        return false;
    }
    _isNativeUtilityLabel(label) {
        let normalized = label.toLowerCase();
        return normalized.includes('settings') ||
            normalized.includes('turn off') ||
            normalized.includes('turn on') ||
            normalized === 'connect' ||
            normalized === 'disconnect';
    }
}
