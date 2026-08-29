import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { Spinner } from 'resource:///org/gnome/shell/ui/animation.js';
import { LiquidEffect } from './liquidEffect.js';
import { UnpickableActor, UnpickableClone } from './utils.js';
const FLOATING_SHADER_PADDING = 20;
const FLOATING_GLASS_EXPAND = 0;
const FLOATING_OPEN_DURATION_MS = 300;
const FLOATING_CLOSE_DURATION_MS = 180;
const FLOATING_SCALE_START = 0.88;
const FLOATING_CONTENT_DELAY_MS = 50;
export class CustomSubmenuRenderer {
    manager;
    _floatingWindow;
    _pendingActions;
    _refreshTimerIds;
    _wifiScanActive;
    _wifiScanGeneration;
    constructor(manager) {
        this.manager = manager;
        this._floatingWindow = null;
        this._pendingActions = new Map();
        this._refreshTimerIds = [];
        this._wifiScanActive = false;
        this._wifiScanGeneration = 0;
    }
    close(immediate = true) {
        this._clearRefreshTimers();
        if (this._floatingWindow) {
            try {
                this._floatingWindow.close(false, immediate);
            }
            catch (e) { }
        }
    }
    show(stCard, kind) {
        let detectedKind = kind || this._getKindFromCard(stCard);
        if (!detectedKind)
            return;
        if (this._floatingWindow) {
            try {
                this._floatingWindow.close(false, true);
            }
            catch (e) { }
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
        let shell = this._createFloatingShell(sourceCard);
        if (!shell)
            return;
        this._clearRefreshTimers();
        let rowsBox = new St.BoxLayout({
            vertical: true,
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
        shell.contentArea.add_child(scrollView);
        let serializeRows = (rows) => {
            return JSON.stringify(rows.map(r => ({
                title: r.title, subtitle: r.subtitle, iconName: r.iconName,
                active: r.active, actionLabel: r.actionLabel, disabled: r.disabled,
                pending: r.pending, scanning: r.scanning, section: r.section,
                switchRow: r.switchRow, pendingKey: r.pendingKey, desiredActive: r.desiredActive
            })));
        };
        let lastRowsHash = '';
        let refreshRows = () => {
            let rows = rowBuilder();
            let newHash = serializeRows(rows);
            if (newHash === lastRowsHash)
                return;
            lastRowsHash = newHash;
            rowsBox.destroy_all_children();
            for (let row of rows) {
                if (row.pendingKey && row.desiredActive !== undefined && row.active === row.desiredActive)
                    this._pendingActions.delete(row.pendingKey);
                if (row.section)
                    rowsBox.add_child(this._createSectionLabel(row.title, !!row.scanning));
                else
                    rowsBox.add_child(this._createControlRow(row, refreshRows));
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
            shell.syncHeight(rowsBox, scrollView);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                shell.syncHeight(rowsBox, scrollView);
                return GLib.SOURCE_REMOVE;
            });
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
                shell.syncHeight(rowsBox, scrollView);
            });
        }
        catch (e) { }
        shell.present();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            shell.syncHeight(rowsBox, scrollView);
            return GLib.SOURCE_REMOVE;
        });
        let pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            try {
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
    _createFloatingShell(sourceCard) {
        let monitor = this.manager._getMenuMonitorGeometry?.() || Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
        if (!monitor)
            return null;
        let [menuWidth] = this.manager.targetActor?.get_size?.() || [420, 0];
        let maxWidth = Math.max(320, monitor.width - 48);
        let maxHeight = Math.max(280, monitor.height - 96);
        let winWidth = Math.round(Math.min(maxWidth, Math.max(320, Math.min(menuWidth || 360, 360))));
        let winHeight = Math.round(Math.min(maxHeight, 390));
        let sourceActor = Main.panel.statusArea.quickSettings?.container || Main.panel.statusArea.quickSettings;
        let sourceRight = monitor.x + monitor.width - 24;
        let sourceBottom = monitor.y + 36;
        try {
            let [sourceX, sourceY] = sourceActor.get_transformed_position();
            let [sourceW, sourceH] = sourceActor.get_size();
            sourceRight = sourceX + sourceW;
            sourceBottom = sourceY + sourceH;
        }
        catch (e) { }
        let winX = Math.round(Math.min(Math.max(sourceRight - winWidth, monitor.x + 24), monitor.x + monitor.width - winWidth - 24));
        let winY = Math.round(Math.min(Math.max(sourceBottom + 12, monitor.y + 24), monitor.y + monitor.height - winHeight - 24));
        // --- Pivot: top-center, matching the QS popup's stamp. The window pops
        // out of the clicked card's bounds (cardScale + translation) up to full.
        let pivotX = 0.5;
        let pivotY = 0.0;
        // Bounds of the card the submenu was opened from, in stage coordinates.
        // Used to morph: the glass starts exactly on the card and pops to full.
        let cardBounds = null;
        try {
            cardBounds = this.manager?.getSubmenuMorphBounds?.(sourceCard) || null;
        }
        catch (e) {
            cardBounds = null;
        }
        // Scale that makes the window's width match the card's width, and the
        // top-center translation that lands the (scaled) window on the card.
        let cardScale = FLOATING_SCALE_START;
        let cardTX = 0;
        let cardTY = 0;
        if (cardBounds && cardBounds.w > 4 && cardBounds.h > 4) {
            const s = cardBounds.w / winWidth;
            if (s >= 0.04 && s <= 1) {
                cardScale = s;
                cardTX = cardBounds.centerX - (winX + winWidth / 2);
                cardTY = cardBounds.y - winY;
            }
        }
        let scrim = new St.Widget({
            style_class: 'liquid-glass-scrim',
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        let winActor = new St.Widget({
            style_class: `liquid-glass-floating-window-container ${this._getPaletteClass()}`,
            reactive: true,
            can_focus: true,
            x: winX,
            y: winY,
            width: winWidth,
            height: winHeight,
            clip_to_allocation: true,
        });
        let glassPad = FLOATING_SHADER_PADDING + FLOATING_GLASS_EXPAND;
        let glassActor = new St.Widget({
            style_class: 'liquid-glass-floating-window-backing',
            reactive: false,
            clip_to_allocation: false,
            x: winX - glassPad,
            y: winY - glassPad,
            width: winWidth + glassPad * 2,
            height: winHeight + glassPad * 2,
        });
        // Set pivot points for scale animation
        winActor.set_pivot_point(pivotX, pivotY);
        glassActor.set_pivot_point(pivotX, pivotY);
        let clipBox = new St.Widget({
            clip_to_allocation: true,
            reactive: false,
            x: 0,
            y: 0,
            width: winWidth + glassPad * 2,
            height: winHeight + glassPad * 2,
        });
        glassActor.add_child(clipBox);
        let fboContainer = new UnpickableActor();
        fboContainer.set_size(winWidth + glassPad * 2, winHeight + glassPad * 2);
        clipBox.add_child(fboContainer);
        let bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
        bgClone.set_position(-(winX - glassPad), -(winY - glassPad));
        bgClone.set_size(monitor.width, monitor.height);
        fboContainer.add_child(bgClone);
        let windowClonesContainer = new UnpickableActor();
        windowClonesContainer.set_position(-(winX - glassPad), -(winY - glassPad));
        fboContainer.add_child(windowClonesContainer);
        let cloneMap = new Map();
        let zIndex = 0;
        // AABB culling bounds: only clone windows that can actually be reflected
        // through the floating glass panel (incl. its shader padding).
        let cullLeft = winX - glassPad;
        let cullTop = winY - glassPad;
        let cullRight = winX + winWidth + glassPad;
        let cullBottom = winY + winHeight + glassPad;
        for (let windowActor of global.get_window_actors()) {
            let metaWindow = windowActor.get_meta_window?.();
            if (!metaWindow || metaWindow.minimized || !windowActor.visible)
                continue;
            let wRight = windowActor.x + windowActor.width;
            let wBottom = windowActor.y + windowActor.height;
            if (wRight < cullLeft || windowActor.x > cullRight || wBottom < cullTop || windowActor.y > cullBottom)
                continue;
            let clone = new UnpickableClone({ source: windowActor });
            windowClonesContainer.add_child(clone);
            cloneMap.set(windowActor, clone);
            clone.set_position(windowActor.x, windowActor.y);
            clone.set_size(windowActor.width, windowActor.height);
            clone.set_scale(windowActor.scale_x, windowActor.scale_y);
            clone.translation_x = windowActor.translation_x;
            clone.translation_y = windowActor.translation_y;
            try {
                windowClonesContainer.set_child_at_index(clone, zIndex);
            }
            catch (e) { }
            zIndex++;
        }
        let blurRadius = this.manager._settings.get_int('quick-settings-blur-radius');
        let blur = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        fboContainer.add_effect(blur);
        let effect = new LiquidEffect({ extensionPath: this.manager.extensionPath, settings: this.manager._settings });
        let tintColor = this.manager._hexToColorArray(this.manager._settings.get_string('quick-settings-tint-color'));
        effect.setPadding(FLOATING_SHADER_PADDING);
        effect.setTintColor(...tintColor);
        effect.setTintStrength(this.manager._settings.get_double('quick-settings-tint-strength'));
        effect.setCornerRadius(28);
        effect.setIsDock(false);
        effect.setResolution(winWidth + glassPad * 2, winHeight + glassPad * 2);
        glassActor.add_effect(effect);
        let layout = new St.BoxLayout({
            vertical: true,
            x: 0,
            y: 0,
            width: winWidth,
            height: winHeight,
            clip_to_allocation: true,
            style_class: 'liquid-glass-floating-window-layout liquid-glass-control-panel',
        });
        winActor.add_child(layout);
        let contentArea = new St.BoxLayout({
            style_class: 'liquid-glass-floating-window-content',
            vertical: true,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        layout.add_child(contentArea);
        let syncHeight = (contentActor, scrollActor) => {
            try {
                let contentWidth = Math.max(1, winWidth - 20);
                let [, naturalHeight] = contentActor.get_preferred_height(contentWidth);
                let chromeHeight = 16;
                let scrollHeight = Math.round(Math.min(maxHeight - chromeHeight, Math.max(1, naturalHeight)));
                let targetHeight = Math.round(Math.min(maxHeight, Math.max(150, scrollHeight + chromeHeight)));
                let targetY = Math.round(Math.min(Math.max(sourceBottom + 12, monitor.y + 24), monitor.y + monitor.height - targetHeight - 24));
                let glassW = winWidth + glassPad * 2;
                let glassH = targetHeight + glassPad * 2;
                let glassX = winX - glassPad;
                let glassY = targetY - glassPad;
                winHeight = targetHeight;
                winY = targetY;
                winActor.set_position(winX, winY);
                winActor.set_size(winWidth, winHeight);
                glassActor.set_position(glassX, glassY);
                glassActor.set_size(glassW, glassH);
                clipBox.set_position(0, 0);
                clipBox.set_size(glassW, glassH);
                fboContainer.set_size(glassW, glassH);
                bgClone.set_position(-glassX, -glassY);
                windowClonesContainer.set_position(-glassX, -glassY);
                layout.set_size(winWidth, winHeight);
                contentArea.set_size(contentWidth, scrollHeight);
                scrollActor?.set_size?.(contentWidth, scrollHeight);
                effect.setResolution(glassW, glassH);
            }
            catch (e) { }
        };
        let closeCalled = false;
        let closeFloatingWindow = (reopenQuickSettings = true, immediate = false) => {
            if (closeCalled)
                return;
            closeCalled = true;
            this._clearRefreshTimers();
            let quickSettingsReopened = false;
            let reopenMenu = () => {
                if (reopenQuickSettings) {
                    try {
                        if (typeof this.manager.reopenQuickSettingsFromSubmenu === 'function')
                            this.manager.reopenQuickSettingsFromSubmenu(true);
                        else
                            this.manager.menu.open();
                    }
                    catch (e) { }
                    quickSettingsReopened = true;
                }
            };
            if (!reopenQuickSettings) {
                try {
                    this.manager.finishQuickSettingsSubmenuWithoutReopen?.();
                }
                catch (e) { }
            }
            // Reopen Quick Settings immediately but keep it hidden. This allows it to
            // settle its layout and card bounds before the submenu finishes animating.
            if (!immediate)
                reopenMenu();
            let cleanupDone = false;
            let finishCleanup = () => {
                if (cleanupDone)
                    return GLib.SOURCE_REMOVE;
                cleanupDone = true;
                try {
                    scrim.destroy();
                }
                catch (e) { }
                try {
                    winActor.destroy();
                }
                catch (e) { }
                try {
                    glassActor.destroy();
                }
                catch (e) { }
                for (let clone of cloneMap.values()) {
                    try {
                        clone.destroy();
                    }
                    catch (e) { }
                }
                cloneMap.clear();
                try {
                    effect.cleanup();
                }
                catch (e) { }
                this._floatingWindow = null;
                if (reopenQuickSettings && quickSettingsReopened) {
                    try {
                        if (typeof this.manager.revealQuickSettingsAfterSubmenu === 'function')
                            this.manager.revealQuickSettingsAfterSubmenu(true);
                        else
                            this.manager.menu.actor.opacity = 255;
                    }
                    catch (e) { }
                }
                return GLib.SOURCE_REMOVE;
            };
            if (immediate) {
                finishCleanup();
                return;
            }
            // --- Close animation: pop back into the source card ---
            try {
                scrim.remove_all_transitions();
                layout.remove_all_transitions();
                winActor.remove_all_transitions();
                glassActor.remove_all_transitions();
                // Fade out content first (faster), then shrink the window
                layout.ease({
                    opacity: 0,
                    duration: Math.round(FLOATING_CLOSE_DURATION_MS * 0.3),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                scrim.ease({
                    opacity: 0,
                    duration: FLOATING_CLOSE_DURATION_MS,
                    mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                });
                winActor.ease({
                    opacity: 0,
                    scale_x: cardScale,
                    scale_y: cardScale,
                    translation_x: cardTX,
                    translation_y: cardTY,
                    duration: FLOATING_CLOSE_DURATION_MS,
                    mode: Clutter.AnimationMode.EASE_IN_BACK,
                });
                glassActor.ease({
                    opacity: 0,
                    scale_x: cardScale,
                    scale_y: cardScale,
                    translation_x: cardTX,
                    translation_y: cardTY,
                    duration: FLOATING_CLOSE_DURATION_MS,
                    mode: Clutter.AnimationMode.EASE_IN_BACK,
                    onComplete: finishCleanup,
                });
            }
            catch (e) {
                finishCleanup();
            }
        };
        scrim.connect('button-press-event', () => {
            closeFloatingWindow(true);
            return Clutter.EVENT_STOP;
        });
        winActor.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol?.() === Clutter.KEY_Escape) {
                closeFloatingWindow(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._floatingWindow = { close: closeFloatingWindow };
        return {
            contentArea,
            syncHeight,
            present: () => {
                blur.enabled = true;
                // --- Initial state: popped down onto the source card + transparent ---
                scrim.opacity = 0;
                winActor.opacity = 0;
                glassActor.opacity = 0;
                layout.opacity = 0;
                winActor.set_scale(cardScale, cardScale);
                glassActor.set_scale(cardScale, cardScale);
                winActor.translation_x = cardTX;
                winActor.translation_y = cardTY;
                glassActor.translation_x = cardTX;
                glassActor.translation_y = cardTY;
                // Push the Quick Settings panel out of the way as the submenu pops in.
                try {
                    this.manager.closeQuickSettingsForSubmenu?.(true);
                }
                catch (e) {
                    try {
                        this.manager.menu.close(false);
                    }
                    catch (e2) { }
                }
                Main.layoutManager.uiGroup.add_child(scrim);
                Main.layoutManager.uiGroup.add_child(glassActor);
                Main.layoutManager.uiGroup.add_child(winActor);
                try {
                    scrim.remove_all_transitions();
                    layout.remove_all_transitions();
                    winActor.remove_all_transitions();
                    glassActor.remove_all_transitions();
                    // --- Open animation: pop out of the card with an elastic overshoot ---
                    scrim.ease({
                        opacity: 140,
                        duration: Math.round(FLOATING_OPEN_DURATION_MS * 0.75),
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    winActor.ease({
                        opacity: 255,
                        scale_x: 1.0,
                        scale_y: 1.0,
                        translation_x: 0,
                        translation_y: 0,
                        duration: FLOATING_OPEN_DURATION_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    });
                    glassActor.ease({
                        opacity: 255,
                        scale_x: 1.0,
                        scale_y: 1.0,
                        translation_x: 0,
                        translation_y: 0,
                        duration: FLOATING_OPEN_DURATION_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    });
                    // Stagger the content reveal for a polished feel
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLOATING_CONTENT_DELAY_MS, () => {
                        try {
                            layout.ease({
                                opacity: 255,
                                duration: Math.round(FLOATING_OPEN_DURATION_MS * 0.6),
                                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            });
                        }
                        catch (e) {
                            layout.opacity = 255;
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                    global.stage.set_key_focus(winActor);
                }
                catch (e) {
                    // Fallback: show everything immediately
                    layout.opacity = 255;
                    glassActor.opacity = 255;
                    winActor.opacity = 255;
                    scrim.opacity = 140;
                    glassActor.set_scale(1.0, 1.0);
                    winActor.set_scale(1.0, 1.0);
                    glassActor.translation_x = 0;
                    glassActor.translation_y = 0;
                    winActor.translation_x = 0;
                    winActor.translation_y = 0;
                }
            },
        };
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
        let subtitle = stCard?.subtitle || this._findSubtitle(stCard) || 'Wireless networks';
        let isActive = this._isActorChecked(stCard) || !`${subtitle}`.toLowerCase().includes('off');
        let wifiPowerPendingKey = 'wifi-power';
        let wifiPowerPending = this._pendingActions.get(wifiPowerPendingKey);
        let menuItems = this._getNativeMenuItems(stCard);
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
            vertical: false,
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
            vertical: true,
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
        if (stCard && (typeof stCard._scanDevices === 'function' || stCard._items))
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
