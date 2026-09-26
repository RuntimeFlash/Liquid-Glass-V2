// src/dockManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import { LiquidEffect } from './liquidEffect.js';
import { UnpickableClone, UnpickableActor } from './utils.js';
import { WallpaperCache } from './wallpaperCache.js';
// Padding to allow the shader to draw effects (like refraction and blur) outside the actor's strict bounds.
const SHADER_PADDING = 20;
// Utility: Convert HEX color string (e.g., "#ffffff") to normalized RGB array [1.0, 1.0, 1.0]
function hexToColorArray(hex) {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) {
        console.warn(`[Liquid Glass] Invalid color format received: ${hex}`);
        return [1.0, 1.0, 1.0];
    }
    let r = parseInt(hex.slice(1, 3), 16) / 255.0;
    let g = parseInt(hex.slice(3, 5), 16) / 255.0;
    let b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
}
export class DashManager {
    extensionPath;
    targetActor;
    _settings;
    bgActor = null;
    blurEffect = null;
    effect = null;
    _glassExpand;
    bgClone = null;
    wallpaperClone = null;
    windowClonesContainer = null;
    _windowClones;
    _signals;
    _signalActors;
    _overviewSignalIds;
    _settingsSignals; // GSettingsのイベントリスナーを管理
    _frameSyncId;
    _isEffectActive; // エフェクトが現在適用されているかのフラグ
    _originalStyle;
    _currentMarginStyle;
    _dockParent = null;
    clipBox = null;
    fboContainer = null;
    _lastAbsX;
    _lastAbsY;
    _lastTW;
    _lastTH;
    _stableDeltaW;
    _stableDeltaH;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _lastBaseW;
    _lastBaseH;
    _outputLogs = false;
    _marginValue = 0;
    // Overview mode tracking: when in overview, the dock is rendered
    // strictly with the desktop wallpaper and 60Hz frame syncing is stopped.
    _inOverview = false;
    // Linger fix: dock auto-hide (fullscreen) can animate an ancestor, not
    // targetActor itself. We track ancestor opacity/visibility to hide the
    // glass promptly.
    _dockVisibilitySignals = [];
    _dockVisibilityActors = new Map();
    // Injected by extension.js; see constructor comment.
    _wallpaperCache = null;
    // コンストラクタに settings を追加
    // wallpaperCache is injected by extension.js so both sides share one instance.
    // A relative import here resolves without the extension's `?v=` cache-buster,
    // which can yield a second, stale copy of the module in the same session.
    constructor(extensionPath, targetActor, settings, wallpaperCache = null) {
        this.extensionPath = extensionPath;
        this.targetActor = targetActor;
        this._settings = settings; // GSettings object
        this._wallpaperCache = wallpaperCache;
        this._glassExpand = 0; // ガラスエリアの拡張量（ピクセル）
        this._windowClones = new Map();
        this._signals = [];
        this._signalActors = new Map();
        this._overviewSignalIds = [];
        this._settingsSignals = []; // GSettingsのイベントリスナーを管理
        this._frameSyncId = 0;
        this._isEffectActive = false; // エフェクトが現在適用されているかのフラグ
    }
    // 拡張機能が有効化された時に呼ばれるエントリーポイント
    setup() {
        if (!this.targetActor || !this._settings)
            return;
        // 設定の監視を開始
        this._bindSettings();
        // 初回起動時にスイッチがONならエフェクトを適用
        if (this._settings.get_boolean('enable-dock-glass')) {
            this._applyEffect();
        }
    }
    // 設定が変更された時にリアルタイムで反映するためのバインディング
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        // ON/OFFスイッチの切り替え
        connectSetting('enable-dock-glass', () => {
            let enabled = this._settings.get_boolean('enable-dock-glass');
            if (enabled && !this._isEffectActive) {
                this._applyEffect();
            }
            else if (!enabled && this._isEffectActive) {
                this._removeEffect();
            }
        });
        connectSetting('dock-glass-expand', () => {
            if (this.effect && this._isEffectActive) {
                this._glassExpand = this._settings.get_int('dock-glass-expand');
                this._syncGeometry();
            }
        });
        // マージン変更時
        connectSetting('dock-margin-bottom', () => {
            if (this._isEffectActive)
                this._applyMargin();
            this._marginValue = this._settings.get_int('dock-margin-bottom') || 0;
            if (this._isEffectActive)
                this._syncGeometry();
        });
        // シェーダーパラメータの動的変更
        connectSetting('dock-tint-color', () => {
            if (this.effect && this._isEffectActive) {
                let colorArray = hexToColorArray(this._settings.get_string('dock-tint-color'));
                this.effect.setTintColor(...colorArray);
            }
        });
        connectSetting('dock-tint-strength', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setTintStrength(this._settings.get_double('dock-tint-strength'));
            }
        });
        connectSetting('dock-blur-radius', () => {
            if (this.blurEffect && this._isEffectActive) {
                this.blurEffect.radius = this._settings.get_int('dock-blur-radius');
            }
        });
        connectSetting('dock-corner-radius', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setCornerRadius(this._settings.get_double('dock-corner-radius'));
            }
        });
        connectSetting('output-logs', () => {
            this._outputLogs = this._settings.get_boolean('output-logs');
        });
    }
    // マージンの再計算と適用（動的反映のために独立した関数化）
    _applyMargin() {
        if (!this.targetActor)
            return;
        let marginBottom = this._settings.get_int('dock-margin-bottom');
        let [w, h] = this.targetActor.get_size();
        let [x, y] = this.targetActor.get_transformed_position();
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        // 【修正】w > h の判定をやめ、画面の各エッジとの距離から配置場所を特定する
        let distLeft = x - monitor.x;
        let distRight = (monitor.x + monitor.width) - (x + w);
        let distTop = y - monitor.y;
        let distBottom = (monitor.y + monitor.height) - (y + h);
        let minEdge = Math.min(distLeft, distRight, distTop, distBottom);
        let marginStyle = '';
        if (minEdge === distBottom || minEdge === distTop) {
            if (minEdge === distBottom) {
                marginStyle = `margin-bottom: ${marginBottom}px;`; // 下
            }
            else {
                marginStyle = `margin-top: ${marginBottom}px;`; // 上
            }
        }
        else {
            if (minEdge === distRight) {
                marginStyle = `margin-right: ${marginBottom}px;`; // 右
            }
            else {
                marginStyle = `margin-left: ${marginBottom}px;`; // 左
            }
        }
        if (this._originalStyle === undefined) {
            this._originalStyle = this.targetActor.get_style() || '';
        }
        this._currentMarginStyle = marginStyle;
        this.targetActor.set_style(`${this._originalStyle} ${marginStyle}`);
    }
    // 実際にエフェクトを描画し始める処理（元の setup() の中身）
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        this.targetActor.add_style_class_name('liquid-glass-transparent');
        this._dockParent = this.targetActor.get_parent();
        if (this._dockParent) {
            this._dockParent.add_style_class_name('liquid-glass-transparent');
        }
        this.bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        this.bgActor.set_size(2.0, 2.0);
        this.clipBox = new St.Widget({ clip_to_allocation: true });
        this.clipBox.set_size(2.0, 2.0);
        this.bgActor.add_child(this.clipBox);
        this.targetActor.set_pivot_point(0.5, 0.5);
        this.bgActor.set_pivot_point(0.0, 0.0);
        // 動的マージンを適用
        this._applyMargin();
        this._marginValue = this._settings.get_int('dock-margin-bottom');
        this._glassExpand = this._settings.get_int("dock-glass-expand");
        this._outputLogs = this._settings.get_boolean('output-logs');
        let dockRoot = this.targetActor;
        while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
            let p = dockRoot.get_parent();
            if (!p)
                break;
            dockRoot = p;
        }
        if (dockRoot && dockRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(this.bgActor, dockRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }
        // 設定から初期値を読み込み
        let blurRadius = this._settings.get_int('dock-blur-radius');
        let tintColorStr = this._settings.get_string('dock-tint-color');
        let tintStrength = this._settings.get_double('dock-tint-strength');
        let cornerRadius = this._settings.get_double('dock-corner-radius');
        this.fboContainer = new UnpickableActor();
        this.fboContainer.set_size(2.0, 2.0);
        this.clipBox.add_child(this.fboContainer);
        this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        this.fboContainer.add_effect(this.blurEffect);
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...hexToColorArray(tintColorStr));
        this.effect.setTintStrength(tintStrength);
        this.effect.setCornerRadius(cornerRadius);
        this.effect.setIsDock(true);
        this.bgActor.add_effect(this.effect);
        this.bgActor.hide();
        // Eagerly build the static wallpaper clone (Clutter.Image texture — paints offstage)
        // so it exists before any Overview signal fires. This fixes the black where
        // overview opened before desktop frame-sync ever ran and wallpaperClone was null.
        let ensureWallpaperClone = () => {
            if (this.wallpaperClone)
                return;
            try {
                const monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
                const mi = monitorIndex >= 0 ? monitorIndex : (Main.layoutManager.primaryIndex ?? 0);
                const cache = this._wallpaperCache ?? WallpaperCache.getDefault();
                const source = cache.getWallpaperActorForMonitor(mi);
                if (source) {
                    this.wallpaperClone = new UnpickableClone({ source });
                    this.fboContainer?.add_child(this.wallpaperClone);
                    this.wallpaperClone.visible = false;
                    this.wallpaperClone.hide();
                }
                else {
                    console.log(`[Liquid Glass] ensureWallpaperClone: no source for monitor ${mi}`);
                }
            }
            catch (e) {
                console.log(`[Liquid Glass] Wallpaper clone creation failed: ${e}`);
            }
        };
        // Build immediately so Overview has a valid texture even before first frameTick
        try {
            ensureWallpaperClone();
        }
        catch (e) { }
        let buildClones = () => {
            if (!this.bgActor)
                return;
            // Incremental: reuse existing clones instead of destroying and recreating
            // everything on every sync restart. Window clones are created lazily by
            // _syncGeometry(), which also AABB-culls out-of-view windows — so we no
            // longer pre-create clones for every open window here.
            if (!this.bgClone) {
                this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
                this.fboContainer?.add_child(this.bgClone);
            }
            // Static wallpaper (texture-backed Clutter.Image) — ensure exists
            ensureWallpaperClone();
            if (!this.windowClonesContainer) {
                this.windowClonesContainer = new UnpickableActor();
                this.fboContainer?.add_child(this.windowClonesContainer);
                this._windowClones.clear();
            }
        };
        let lastSyncTime = 0;
        let stableFrameCount = 0;
        let idleSyncMode = false;
        const activeSyncIntervalUs = 16_000;
        const idleSyncIntervalUs = 250_000;
        let frameTick = () => {
            // If overview is active, stop the frame sync immediately.
            // Overview uses a static wallpaper backdrop with zero 60Hz polling.
            if (this._inOverview) {
                this._destroyWindowClones();
                this._frameSyncId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (!this.bgActor || !this.targetActor.mapped) {
                if (this.bgActor) {
                    this.bgActor.opacity = 0;
                    this.bgActor.hide();
                }
                this._frameSyncId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (!this._isDockEffectivelyVisible()) {
                if (this.bgActor) {
                    this.bgActor.opacity = 0;
                    this.bgActor.hide();
                }
                this._frameSyncId = 0;
                return GLib.SOURCE_REMOVE;
            }
            let now = GLib.get_monotonic_time();
            let syncIntervalUs = idleSyncMode ? idleSyncIntervalUs : activeSyncIntervalUs;
            if (lastSyncTime !== 0 && now - lastSyncTime < syncIntervalUs) {
                return GLib.SOURCE_CONTINUE;
            }
            lastSyncTime = now;
            try {
                let oldBgW = this._lastBgW;
                let oldBgH = this._lastBgH;
                let oldBgX = this._lastBgX;
                let oldBgY = this._lastBgY;
                this._syncGeometry();
                let geometryChanged = oldBgW !== this._lastBgW ||
                    oldBgH !== this._lastBgH ||
                    oldBgX !== this._lastBgX ||
                    oldBgY !== this._lastBgY;
                if (geometryChanged) {
                    stableFrameCount = 0;
                    idleSyncMode = false;
                }
                else {
                    stableFrameCount++;
                    if (stableFrameCount >= 8) {
                        idleSyncMode = true;
                    }
                }
            }
            catch (e) {
                console.error('[Liquid Glass] Error in frameTick:', e);
            }
            return GLib.SOURCE_CONTINUE;
        };
        let startFrameSync = () => {
            if (this._inOverview) {
                this._stopFrameSync();
                this._destroyWindowClones();
                this._syncGeometry();
                return;
            }
            idleSyncMode = false;
            stableFrameCount = 0;
            lastSyncTime = 0;
            if (this._frameSyncId === 0 && this._isDockEffectivelyVisible()) {
                this._syncGeometry();
                buildClones();
                this._frameSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, frameTick);
            }
        };
        const restartSignals = [
            'notify::mapped',
            'notify::visible',
            'notify::opacity',
            'notify::allocation',
            'notify::translation-x',
            'notify::translation-y',
            'notify::margin-bottom',
            'notify::margin-top',
            'notify::margin-left',
            'notify::margin-right',
        ];
        let getAncestorByName = (actor, name) => {
            let parent = actor.get_parent();
            while (parent) {
                if (parent.get_name && parent.get_name() === name)
                    return parent;
                parent = parent.get_parent();
            }
            return null;
        };
        let animatedActor = getAncestorByName(this.targetActor, 'dashtodockContainer') || this.targetActor;
        let childSignals = new Map();
        let connectActorSignals = (actor) => {
            if (!actor)
                return;
            let ids = [];
            for (const signalName of restartSignals) {
                try {
                    let signalId = actor.connect(signalName, () => {
                        if (this._isEffectActive) {
                            if (this._inOverview) {
                                this._syncGeometry();
                            }
                            else {
                                startFrameSync();
                            }
                        }
                    });
                    ids.push(signalId);
                    this._signals.push(signalId);
                    this._signalActors.set(signalId, actor);
                }
                catch (e) { }
            }
            try {
                let sig1 = actor.connect('notify::slide-x', () => {
                    if (this._isEffectActive) {
                        if (this._inOverview)
                            this._syncGeometry();
                        else
                            startFrameSync();
                    }
                });
                let sig2 = actor.connect('notify::slide-y', () => {
                    if (this._isEffectActive) {
                        if (this._inOverview)
                            this._syncGeometry();
                        else
                            startFrameSync();
                    }
                });
                ids.push(sig1, sig2);
                this._signals.push(sig1, sig2);
                this._signalActors.set(sig1, actor);
                this._signalActors.set(sig2, actor);
            }
            catch (e) { }
            childSignals.set(actor, ids);
        };
        let disconnectActorSignals = (actor) => {
            let ids = childSignals.get(actor);
            if (ids) {
                for (let id of ids) {
                    try {
                        actor.disconnect(id);
                    }
                    catch (e) { }
                    let idx = this._signals.indexOf(id);
                    if (idx !== -1)
                        this._signals.splice(idx, 1);
                    this._signalActors.delete(id);
                }
                childSignals.delete(actor);
            }
        };
        let connectChildrenRecursively = (parentActor) => {
            if (!parentActor)
                return;
            let children = parentActor.get_children();
            for (let child of children) {
                connectActorSignals(child);
                let grandchildren = child.get_children();
                for (let gc of grandchildren) {
                    connectActorSignals(gc);
                }
            }
        };
        connectActorSignals(this.targetActor);
        connectChildrenRecursively(this.targetActor);
        if (animatedActor !== this.targetActor && animatedActor) {
            connectActorSignals(animatedActor);
            connectChildrenRecursively(animatedActor);
        }
        let connectDockVisibilityChain = () => {
            let cur = this.targetActor?.get_parent?.() ?? null;
            let seen = new Set();
            while (cur && cur !== Main.layoutManager.uiGroup && !seen.has(cur)) {
                seen.add(cur);
                try {
                    for (let sig of ['notify::visible', 'notify::mapped', 'notify::opacity', 'notify::translation-x', 'notify::translation-y']) {
                        let id = cur.connect(sig, () => {
                            if (this._inOverview) {
                                // In overview, update geometry directly without starting 60Hz loop
                                this._syncGeometry();
                                return;
                            }
                            if (!this._isDockEffectivelyVisible()) {
                                try {
                                    this.bgActor?.hide();
                                }
                                catch (e) { }
                            }
                            if (this._isEffectActive)
                                startFrameSync();
                        });
                        this._dockVisibilitySignals.push(id);
                        this._dockVisibilityActors.set(id, cur);
                    }
                }
                catch (e) { }
                try {
                    cur = cur.get_parent?.() ?? null;
                }
                catch (e) {
                    break;
                }
            }
        };
        try {
            connectDockVisibilityChain();
        }
        catch (e) { }
        this._overviewSignalIds.push(Main.overview.connect('showing', () => {
            this._inOverview = true;
            this._stopFrameSync();
            this._destroyWindowClones();
            if (this.windowClonesContainer) {
                this.windowClonesContainer.visible = false;
                this.windowClonesContainer.hide();
            }
            // Ensure FBO clones exist before syncing geometry — fixes black when
            // overview opens before desktop frame-sync ever built the clones.
            buildClones();
            this._syncGeometry();
        }));
        this._overviewSignalIds.push(Main.overview.connect('shown', () => {
            this._inOverview = true;
            this._stopFrameSync();
            this._destroyWindowClones();
            if (this.windowClonesContainer) {
                this.windowClonesContainer.visible = false;
                this.windowClonesContainer.hide();
            }
            buildClones();
            this._syncGeometry();
        }));
        this._overviewSignalIds.push(Main.overview.connect('hidden', () => {
            this._inOverview = false;
            this._destroyWindowClones();
            if (this.bgActor && this._isDockEffectivelyVisible()) {
                try {
                    if (this.windowClonesContainer) {
                        this.windowClonesContainer.visible = true;
                        this.windowClonesContainer.show();
                    }
                    this.bgActor.show();
                    this._syncGeometry();
                    startFrameSync();
                }
                catch (e) { }
            }
            else if (this.bgActor) {
                try {
                    this.bgActor.opacity = 0;
                    this.bgActor.hide();
                }
                catch (e) { }
                this._stopFrameSync();
            }
        }));
        startFrameSync();
    }
    _syncGeometry() {
        if (!this.bgActor || !this.targetActor) {
            if (this.bgActor && this.bgActor.visible) {
                try {
                    this.bgActor.hide();
                }
                catch (e) { }
            }
            return;
        }
        if (!this._inOverview && !this._isDockEffectivelyVisible()) {
            if (this.bgActor.visible) {
                try {
                    this.bgActor.hide();
                }
                catch (e) { }
            }
            return;
        }
        let findDashBackground = (actor) => {
            if (!actor)
                return null;
            // Convert to any to safely check has_style_class_name
            let stActor = actor;
            if ((stActor.has_style_class_name && stActor.has_style_class_name('dash-background')) ||
                (actor.get_name && (actor.get_name() === 'd2daBackground' || actor.get_name() === 'DockBackground'))) {
                return stActor;
            }
            if (!actor.get_children)
                return null;
            let children = actor.get_children();
            for (let i = 0; i < children.length; i++) {
                let found = findDashBackground(children[i]);
                if (found)
                    return found;
            }
            return null;
        };
        let isIgnoredDockActor = (actor) => {
            let stActor = actor;
            return !!(actor === this.bgActor ||
                actor === this.clipBox ||
                actor === this.fboContainer ||
                (stActor.has_style_class_name && (stActor.has_style_class_name('liquid-glass-bg-actor') ||
                    stActor.has_style_class_name('dash-background'))) ||
                (actor.get_name && (actor.get_name() === 'd2daBackground' || actor.get_name() === 'DockBackground')));
        };
        let unionBounds = (a, b) => {
            if (!a)
                return b;
            if (!b)
                return a;
            let x1 = Math.min(a.x, b.x);
            let y1 = Math.min(a.y, b.y);
            let x2 = Math.max(a.x + a.w, b.x + b.w);
            let y2 = Math.max(a.y + a.h, b.y + b.h);
            return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        };
        let getVisibleContentBounds = (actor) => {
            if (!actor || isIgnoredDockActor(actor))
                return null;
            let childBounds = null;
            if (actor.get_children) {
                for (let child of actor.get_children()) {
                    childBounds = unionBounds(childBounds, getVisibleContentBounds(child));
                }
            }
            if (childBounds)
                return childBounds;
            if (!actor.visible || !actor.mapped || actor.opacity === 0)
                return null;
            let [w, h] = actor.get_size();
            let [x, y] = actor.get_transformed_position();
            if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(w) || Number.isNaN(h) || w < 4 || h < 4)
                return null;
            return { x, y, w, h };
        };
        let sourceActor = this.targetActor;
        let dashBg = findDashBackground(this.targetActor);
        if (dashBg) {
            if (dashBg.opacity !== 0) {
                dashBg.opacity = 0;
            }
            if (!dashBg.visible) {
                dashBg.visible = true;
            }
            sourceActor = dashBg;
        }
        // 1. まず元の背景のサイズと位置を取得
        let contentBounds = getVisibleContentBounds(this.targetActor);
        let baseW;
        let baseH;
        let absX;
        let absY;
        [baseW, baseH] = sourceActor.get_size();
        [absX, absY] = sourceActor.get_transformed_position();
        if (sourceActor !== this.targetActor) {
            let [tX, tY] = this.targetActor.get_transformed_position();
            let [tW, tH] = this.targetActor.get_size();
            if (absX < tX) {
                baseW -= (tX - absX);
                absX = tX;
            }
            if (absY < tY) {
                baseH -= (tY - absY);
                absY = tY;
            }
            if (absX + baseW > tX + tW) {
                baseW = (tX + tW) - absX;
            }
            if (absY + baseH > tY + tH) {
                baseH = (tY + tH) - absY;
            }
        }
        if (contentBounds && contentBounds.w > 10 && contentBounds.h > 10) {
            let x2 = Math.max(absX + baseW, contentBounds.x + contentBounds.w);
            let y2 = Math.max(absY + baseH, contentBounds.y + contentBounds.h);
            absX = Math.min(absX, contentBounds.x);
            absY = Math.min(absY, contentBounds.y);
            baseW = x2 - absX;
            baseH = y2 - absY;
        }
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return;
        if (this._outputLogs)
            log(`[Raw] ${absX}, ${absY}, ${baseW}, ${baseH}`);
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        let minCenterDist = -1;
        let distLeftCenter = 0;
        let distRightCenter = 0;
        let distTopCenter = 0;
        let distBottomCenter = 0;
        if (monitor) {
            let dockCenterX = absX + (baseW / 2);
            let dockCenterY = absY + (baseH / 2);
            distLeftCenter = dockCenterX - monitor.x;
            distRightCenter = (monitor.x + monitor.width) - dockCenterX;
            distTopCenter = dockCenterY - monitor.y;
            distBottomCenter = (monitor.y + monitor.height) - dockCenterY;
            minCenterDist = Math.min(distLeftCenter, distRightCenter, distTopCenter, distBottomCenter);
        }
        if (this._lastBaseW !== undefined && this._lastBaseH !== undefined) {
            let isHorizontalDock = (minCenterDist === distTopCenter || minCenterDist === distBottomCenter);
            if (isHorizontalDock) {
                if (Math.abs(Math.abs(baseH - this._lastBaseH) - this._marginValue) <= 1) {
                    baseH = this._lastBaseH;
                }
            }
            else {
                if (Math.abs(Math.abs(baseW - this._lastBaseW) - this._marginValue) <= 1) {
                    baseW = this._lastBaseW;
                }
            }
        }
        this._lastBaseW = baseW;
        this._lastBaseH = baseH;
        let refActor = this._findReferenceActor(this.targetActor);
        if (refActor) {
            let [refW, refH] = refActor.get_size();
            let [refX, refY] = refActor.get_transformed_position();
            if (this._outputLogs)
                log(`refActor [Raw]: ${refX}, ${refY}, ${refW}, ${refH}`);
            if (!Number.isNaN(refX) && !Number.isNaN(refY) && refW > 0 && refH > 0) {
                let topGap = refY - absY;
                let bottomGap = (absY + baseH) - (refY + refH);
                if (topGap < 0 || bottomGap < 0) {
                    let trueRefY = refY - refH;
                    topGap = trueRefY - absY;
                    bottomGap = (absY + baseH) - (trueRefY + refH);
                }
                let leftGap = refX - absX;
                let rightGap = (absX + baseW) - (refX + refW);
                if (leftGap < 0 || rightGap < 0) {
                    let trueRefX = refX - refW;
                    leftGap = trueRefX - absX;
                    rightGap = (absX + baseW) - (trueRefX + refW);
                }
                if (baseW >= baseH) {
                    let diff = Math.abs(bottomGap - topGap);
                    if (diff > 0 && diff < baseH / 2) {
                        if (bottomGap > topGap) {
                            baseH -= diff;
                        }
                        else {
                            absY += diff;
                            baseH -= diff;
                        }
                    }
                }
                else {
                    let diff = Math.abs(rightGap - leftGap);
                    if (diff > 0 && diff < baseW / 2) {
                        if (minCenterDist === distLeftCenter) {
                            if (rightGap > leftGap) {
                                baseW -= diff;
                            }
                        }
                        else {
                            if (rightGap > leftGap) {
                                baseW -= diff;
                            }
                            else {
                                absX += diff;
                                baseW -= diff;
                            }
                        }
                    }
                }
            }
        }
        if (this._outputLogs)
            log(`[Gap] ${absX}, ${absY}, ${baseW}, ${baseH}`);
        let marginValue = this._settings.get_int('dock-margin-bottom') || 0;
        if (monitor && marginValue > 0) {
            this._lastAbsX = absX;
            this._lastAbsY = absY;
            let [tW, tH] = this.targetActor.get_size();
            if (this._stableDeltaW === undefined || this._lastTW !== tW) {
                this._stableDeltaW = baseW - tW;
                this._lastTW = tW;
            }
            if (this._stableDeltaH === undefined || this._lastTH !== tH) {
                this._stableDeltaH = baseH - tH;
                this._lastTH = tH;
            }
            let stableBaseW = tW + this._stableDeltaW;
            let stableBaseH = tH + this._stableDeltaH;
            if (minCenterDist === distBottomCenter) {
                let expectedBottom = monitor.y + monitor.height - marginValue;
                if (absY + baseH > expectedBottom) {
                    let overflow = (absY + baseH) - expectedBottom;
                    baseH -= overflow;
                }
                if (baseH > stableBaseH)
                    baseH = stableBaseH;
            }
            else if (minCenterDist === distTopCenter) {
                let expectedTop = monitor.y + marginValue;
                if (absY < expectedTop) {
                    let diff = expectedTop - absY;
                    absY = expectedTop;
                    baseH -= diff;
                }
                if (baseH > stableBaseH)
                    baseH = stableBaseH;
            }
            else if (minCenterDist === distRightCenter) {
                let expectedRight = monitor.x + monitor.width - marginValue;
                if (absX + baseW > expectedRight) {
                    let overflow = (absX + baseW) - expectedRight;
                    baseW -= overflow;
                }
                if (baseW > stableBaseW)
                    baseW = stableBaseW;
            }
            else {
                let expectedLeft = monitor.x + marginValue;
                if (absX < expectedLeft) {
                    let diff = expectedLeft - absX;
                    absX = expectedLeft;
                    baseW -= diff;
                }
                if (baseW > stableBaseW)
                    baseW = stableBaseW;
            }
        }
        if (this._outputLogs)
            log(`[Final] ${absX}, ${absY}, ${baseW}, ${baseH}`);
        let w = Math.max(1.0, baseW);
        let h = Math.max(1.0, baseH);
        if (baseW <= 9 || baseH <= 9) {
            this.bgActor.hide();
            return;
        }
        else {
            this.bgActor.show();
        }
        this.bgActor.opacity = this.targetActor.opacity;
        let visibleW = baseW;
        let visibleH = baseH;
        if (monitor) {
            if (absX < monitor.x)
                visibleW -= (monitor.x - absX);
            if (absY < monitor.y)
                visibleH -= (monitor.y - absY);
            if (absX + baseW > monitor.x + monitor.width)
                visibleW -= ((absX + baseW) - (monitor.x + monitor.width));
            if (absY + baseH > monitor.y + monitor.height)
                visibleH -= ((absY + baseH) - (monitor.y + monitor.height));
        }
        if (!this._inOverview && (visibleW <= 5 || visibleH <= 5 || this.targetActor.opacity === 0)) {
            this.bgActor.opacity = 0;
            this.bgActor.hide();
            return;
        }
        else {
            this.bgActor.opacity = this.targetActor.opacity || 255;
            this.bgActor.show();
        }
        let bgW = Math.max(1.0, w + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgH = Math.max(1.0, h + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgX = absX - SHADER_PADDING - this._glassExpand;
        let bgY = absY - SHADER_PADDING - this._glassExpand;
        if (this._lastBgW !== bgW || this._lastBgH !== bgH || this._lastBgX !== bgX || this._lastBgY !== bgY) {
            this.bgActor.set_size(bgW, bgH);
            this.bgActor.set_position(bgX, bgY);
            this.clipBox?.set_size(bgW, bgH);
            this.clipBox?.set_position(0, 0);
            if (this.fboContainer) {
                this.fboContainer.set_position(0, 0);
                this.fboContainer.set_size(bgW * 0.5, bgH * 0.5);
                this.fboContainer.set_scale(2.0, 2.0);
                this.fboContainer.visible = true;
                this.fboContainer.show();
            }
            this.effect?.setResolution(bgW, bgH);
            this._lastBgW = bgW;
            this._lastBgH = bgH;
            this._lastBgX = bgX;
            this._lastBgY = bgY;
        }
        // Wallpaper clone (Clutter.Image texture) — always keep positioned, and toggle
        // visibility independently of bgClone so overview wallpaper shows even if bgClone
        // was never built (e.g. dock was auto-hidden before overview opened).
        if (this.wallpaperClone) {
            // The cached wallpaper is monitor-local (origin at monitor.x/y). The
            // clone lives in the half-scale FBO, so map screen coordinates to it:
            // screenX = bgX + (cloneX * 2)  =>  cloneX = (monitor.x - bgX) * 0.5.
            // For the primary monitor this reduces to -bgX * 0.5.
            const wpx = monitor ? (monitor.x - bgX) * 0.5 : -bgX * 0.5;
            const wpy = monitor ? (monitor.y - bgY) * 0.5 : -bgY * 0.5;
            this.wallpaperClone.set_position(wpx, wpy);
            this.wallpaperClone.set_scale(0.5, 0.5);
            if (this._inOverview) {
                this.wallpaperClone.visible = true;
                this.wallpaperClone.show();
            }
            else {
                this.wallpaperClone.visible = false;
                this.wallpaperClone.hide();
            }
        }
        if (this.bgClone && this.windowClonesContainer) {
            this.bgClone.set_position(-bgX * 0.5, -bgY * 0.5);
            this.bgClone.set_scale(0.5, 0.5);
            this.windowClonesContainer.set_position(-bgX * 0.5, -bgY * 0.5);
            this.windowClonesContainer.set_scale(0.5, 0.5);
            if (this._inOverview) {
                // OVERVIEW MODE: wallpaperClone is already visible above; hide live clones.
                this.windowClonesContainer.visible = false;
                this.windowClonesContainer.hide();
                this._destroyWindowClones();
                this.bgClone.visible = false;
                this.bgClone.hide();
                // If wallpaperClone failed to build, fall back to live bgClone (may be dimmed)
                if (!this.wallpaperClone) {
                    this.bgClone.visible = true;
                    this.bgClone.show();
                }
            }
            else {
                // DESKTOP MODE: live wallpaper + live window clones (normal glass)
                this.bgClone.visible = true;
                this.bgClone.show();
                this.windowClonesContainer.visible = true;
                this.windowClonesContainer.show();
                let windows = global.get_window_actors();
                let activeWindows = new Set();
                let zIndex = 0;
                for (let w of windows) {
                    let metaWindow = w.get_meta_window();
                    if (!metaWindow || metaWindow.minimized || !w.visible)
                        continue;
                    // Skip windows completely outside the glass viewport (AABB test)
                    let wRight = w.x + w.width;
                    let wBottom = w.y + w.height;
                    if (wRight < bgX || w.x > bgX + bgW || wBottom < bgY || w.y > bgY + bgH) {
                        if (this._windowClones.has(w)) {
                            this._windowClones.get(w)?.destroy();
                            this._windowClones.delete(w);
                        }
                        continue;
                    }
                    activeWindows.add(w);
                    let clone;
                    if (!this._windowClones.has(w)) {
                        clone = new UnpickableClone({ source: w });
                        this.windowClonesContainer.add_child(clone);
                        this._windowClones.set(w, clone);
                    }
                    else {
                        clone = this._windowClones.get(w);
                    }
                    clone.set_position(w.x, w.y);
                    clone.set_size(w.width, w.height);
                    clone.set_scale(w.scale_x, w.scale_y);
                    clone.translation_x = w.translation_x;
                    clone.translation_y = w.translation_y;
                    let pX = w.pivot_point ? w.pivot_point.x : 0;
                    let pY = w.pivot_point ? w.pivot_point.y : 0;
                    clone.set_pivot_point(pX, pY);
                    let currentIndex = this.windowClonesContainer.get_children().indexOf(clone);
                    if (currentIndex !== zIndex) {
                        this.windowClonesContainer.set_child_at_index(clone, zIndex);
                    }
                    zIndex++;
                }
                // 使われなくなったクローン（閉じたウィンドウ）を削除
                for (let [w, clone] of this._windowClones.entries()) {
                    if (!activeWindows.has(w)) {
                        clone.destroy();
                        this._windowClones.delete(w);
                    }
                }
            }
        }
    }
    _isOverviewActive() {
        return this._inOverview || Main.overview.visible || Main.overview.animationInProgress;
    }
    _destroyWindowClones() {
        for (let clone of this._windowClones.values()) {
            clone.destroy();
        }
        this._windowClones.clear();
    }
    _stopFrameSync() {
        if (this._frameSyncId !== 0) {
            GLib.Source.remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
    }
    _isDockEffectivelyVisible() {
        try {
            if (!this.targetActor)
                return false;
            if (this._inOverview)
                return true;
            let cur = this.targetActor;
            while (cur && cur !== Main.layoutManager.uiGroup) {
                try {
                    if (!cur.visible || !cur.mapped)
                        return false;
                    if (typeof cur.get_paint_opacity === 'function') {
                        if (cur.get_paint_opacity() === 0)
                            return false;
                    }
                    else if (cur.opacity === 0) {
                        return false;
                    }
                }
                catch (e) { }
                try {
                    cur = cur.get_parent?.() ?? null;
                }
                catch (e) {
                    break;
                }
            }
            try {
                if (typeof this.targetActor.get_paint_opacity === 'function') {
                    if (this.targetActor.get_paint_opacity() === 0)
                        return false;
                }
            }
            catch (e) { }
            return true;
        }
        catch (e) {
            return false;
        }
    }
    // エフェクトを画面から消し、元に戻す処理
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._inOverview = false;
        this._currentMarginStyle = undefined;
        try {
            for (let sigId of this._signals) {
                try {
                    this._signalActors.get(sigId)?.disconnect(sigId);
                }
                catch (e) { }
            }
            this.targetActor.remove_style_class_name('liquid-glass-transparent');
            if (this._originalStyle !== undefined) {
                this.targetActor.set_style(this._originalStyle);
                this._originalStyle = undefined;
            }
            let children = this.targetActor.get_children();
            for (let i = 0; i < children.length; i++) {
                if (children[i].has_style_class_name('dash-background')) {
                    children[i].opacity = 255;
                    children[i].visible = true;
                }
            }
        }
        catch (e) { }
        this._signals = [];
        this._signalActors.clear();
        try {
            if (this._dockParent) {
                this._dockParent.remove_style_class_name('liquid-glass-transparent');
            }
        }
        catch (e) { }
        this._dockParent = null;
        this._stopFrameSync();
        for (let signalId of this._overviewSignalIds) {
            try {
                Main.overview.disconnect(signalId);
            }
            catch (e) { }
        }
        this._overviewSignalIds = [];
        for (let id of this._dockVisibilitySignals) {
            try {
                this._dockVisibilityActors.get(id)?.disconnect(id);
            }
            catch (e) { }
        }
        this._dockVisibilitySignals = [];
        this._dockVisibilityActors.clear();
        this._destroyWindowClones();
        if (this.effect) {
            this.effect.cleanup();
            this.effect = null;
        }
        if (this.bgActor) {
            this.bgActor.destroy();
            this.bgActor = null;
        }
        this.blurEffect = null;
        this.bgClone = null;
        this.wallpaperClone = null;
        this.fboContainer = null;
        this.windowClonesContainer = null;
    }
    // 拡張機能全体が無効化される時の最終クリーンアップ
    cleanup() {
        this._removeEffect();
        if (this._settings) {
            for (let id of this._settingsSignals) {
                this._settings.disconnect(id);
            }
            this._settingsSignals = [];
        }
    }
    // ドックの内部から、計算の基準となるアイコンを1つ再帰的に探し出す
    _findReferenceActor(actor) {
        if (!actor || typeof actor.get_children !== 'function') {
            return null;
        }
        let stActor = actor;
        let name = actor.get_name ? actor.get_name() : '';
        let str = actor.toString();
        // Ignore indicator areas, overlays, badges, backgrounds
        if (str.includes('IndicatorDrawingArea') ||
            name === 'd2daBackground' ||
            name === 'DockBackground' ||
            (stActor.has_style_class_name && (stActor.has_style_class_name('dash-background') ||
                stActor.has_style_class_name('number-overlay') ||
                stActor.has_style_class_name('notification-badge') ||
                stActor.has_style_class_name('liquid-glass-bg-actor')))) {
            return null;
        }
        // Helper to find the innermost visual icon actor inside an icon container / BaseIcon
        let getInnermostIconActor = (root) => {
            let current = root;
            while (current && typeof current.get_children === 'function') {
                let children = current.get_children();
                let bestChild = null;
                for (let child of children) {
                    let [cw, ch] = child.get_size();
                    let cStr = child.toString();
                    let cActor = child;
                    if (cStr.includes('IndicatorDrawingArea') ||
                        (cActor.has_style_class_name && (cActor.has_style_class_name('number-overlay') ||
                            cActor.has_style_class_name('notification-badge') ||
                            cActor.has_style_class_name('dash-background')))) {
                        continue;
                    }
                    if (cw >= 16 && ch >= 16) {
                        bestChild = child;
                        break;
                    }
                }
                if (bestChild && bestChild !== current) {
                    current = bestChild;
                }
                else {
                    break;
                }
            }
            return current;
        };
        // Match actual icon element by class
        if (stActor.has_style_class_name && (stActor.has_style_class_name('overview-icon') ||
            stActor.has_style_class_name('app-icon') ||
            stActor.has_style_class_name('show-apps-icon'))) {
            let [w, h] = actor.get_size();
            if (w >= 16 && h >= 16) {
                return getInnermostIconActor(actor);
            }
        }
        // Fallback: check class name / toString for StIcon or BaseIcon if no class matched
        if ((str.includes('StIcon') || str.includes('BaseIcon')) && !str.includes('IndicatorDrawingArea')) {
            let [w, h] = actor.get_size();
            if (w >= 16 && h >= 16) {
                return getInnermostIconActor(actor);
            }
        }
        // 子要素を再帰的に探索
        const children = actor.get_children();
        for (const child of children) {
            const found = this._findReferenceActor(child);
            if (found) {
                return found;
            }
        }
        return null;
    }
}
