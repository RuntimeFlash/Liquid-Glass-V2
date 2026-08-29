// src/osdManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableClone, hexToRgb, rgbToHex } from './utils.js';
// ========== Configuration Parameters (Defaults, overridden by settings) ==========
const SHADER_PADDING = 20;
export class OsdManager {
    extensionPath;
    _settings;
    _settingsSignals;
    _frameSyncId;
    _isEffectActive;
    _osdYOffset;
    _osdStates;
    _baseTint;
    _glassExpand;
    _monitorsChangedId;
    _contrastSampler;
    _adaptiveConfig;
    _adaptiveTimerId;
    _adaptiveInFlight;
    _styledActors;
    _isFirstAdaptiveRun;
    constructor(extensionPath, settings) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        // マルチモニター対応：各モニターのOSD状態を管理する配列
        this._osdStates = [];
        // this._signals = [];
        this._settingsSignals = [];
        this._frameSyncId = 0;
        this._monitorsChangedId = 0;
        this._isEffectActive = false;
        // this._windowClones = new Map();
        this._contrastSampler = new StageContrastSampler();
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: true,
            samplePerElement: false,
            sampleIntervalMs: 400,
        };
        this._adaptiveTimerId = 0;
        this._adaptiveInFlight = false;
        this._styledActors = new Map();
        this._glassExpand = 12;
        this._baseTint = 0.08;
        this._osdYOffset = 0;
        this._isFirstAdaptiveRun = true;
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        if (this._settings.get_boolean('enable-osd-glass')) {
            this._applyEffect();
        }
    }
    _hexToColorArray(hex) {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
            return [1.0, 1.0, 1.0];
        let r = parseInt(hex.slice(1, 3), 16) / 255.0;
        let g = parseInt(hex.slice(3, 5), 16) / 255.0;
        let b = parseInt(hex.slice(5, 7), 16) / 255.0;
        return [r, g, b];
    }
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        connectSetting('enable-osd-glass', () => {
            let enabled = this._settings.get_boolean('enable-osd-glass');
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting('osd-tint-color', () => {
            if (this._isEffectActive) {
                let colorArray = this._hexToColorArray(this._settings.get_string('osd-tint-color'));
                for (let state of this._osdStates) {
                    if (state.effect)
                        state.effect.setTintColor(...colorArray);
                }
            }
        });
        connectSetting('osd-tint-strength', () => {
            if (this._isEffectActive) {
                this._baseTint = this._settings.get_double('osd-tint-strength');
                for (let state of this._osdStates) {
                    state._currentTint = this._baseTint;
                    if (state.effect)
                        state.effect.setTintStrength(this._baseTint);
                }
            }
        });
        connectSetting('osd-blur-radius', () => {
            if (this._isEffectActive) {
                let radius = this._settings.get_int('osd-blur-radius');
                for (let state of this._osdStates) {
                    if (state.blurEffect)
                        state.blurEffect.radius = radius;
                }
            }
        });
        connectSetting('osd-corner-radius', () => {
            if (this._isEffectActive) {
                let radius = this._settings.get_double('osd-corner-radius');
                for (let state of this._osdStates) {
                    if (state.effect)
                        state.effect.setCornerRadius(radius);
                }
            }
        });
        connectSetting('osd-glass-expand', () => {
            if (this._isEffectActive) {
                this._glassExpand = this._settings.get_int('osd-glass-expand');
            }
        });
        connectSetting('osd-enable-adaptive-text-color', () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean('osd-enable-adaptive-text-color');
            if (this._adaptiveConfig.enabled)
                this._startAdaptiveColorSampling();
            else {
                this._stopAdaptiveColorSampling();
                this._clearAdaptiveStyles();
            }
        });
        connectSetting('osd-sample-interval-ms', () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('osd-sample-interval-ms');
        });
        connectSetting('osd-y-offset', () => {
            this._osdYOffset = this._settings.get_int('osd-y-offset');
            for (let state of this._osdStates) {
                if (state.targetBox) {
                    // 上方向へのシフトのためマイナス値を設定
                    state.targetBox.translation_y = -this._osdYOffset;
                }
            }
        });
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        this._adaptiveConfig.enabled = this._settings.get_boolean('osd-enable-adaptive-text-color');
        this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('osd-sample-interval-ms');
        this._glassExpand = this._settings.get_int('osd-glass-expand');
        this._baseTint = this._settings.get_double('osd-tint-strength');
        this._osdYOffset = this._settings.get_int('osd-y-offset');
        let osdWindows = Main.osdWindowManager._osdWindows;
        if (!osdWindows)
            return;
        // 各モニターのOSDに対してエフェクトをセットアップ
        for (let osdWindow of osdWindows) {
            this._setupOsdEffect(osdWindow);
        }
        this._startFrameSync();
        this._startAdaptiveColorSampling();
        // モニター構成が変更された場合はOSDの再構築が必要
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._removeEffect();
            if (this._settings.get_boolean('enable-osd-glass')) {
                this._applyEffect();
            }
        });
    }
    _setupOsdEffect(osdWindow) {
        if (!osdWindow._liquidOrigEase) {
            let actorToPatch = osdWindow.actor || osdWindow;
            if (typeof actorToPatch.ease === 'function') {
                actorToPatch._liquidOrigEase = actorToPatch.ease;
                actorToPatch.ease = function (props) {
                    if (props.scale_x !== undefined)
                        delete props.scale_x;
                    if (props.scale_y !== undefined)
                        delete props.scale_y;
                    this.set_scale(1.0, 1.0);
                    this._liquidOrigEase(props);
                };
            }
        }
        let targetBox = null;
        if (osdWindow._icon && osdWindow._icon.get_parent) {
            targetBox = osdWindow._icon.get_parent();
        }
        else if (typeof osdWindow.get_first_child === 'function') {
            targetBox = osdWindow.get_first_child();
        }
        // それでもSt.Widgetが見つからない場合は子要素をスキャン
        if (targetBox && typeof targetBox.add_style_class_name !== 'function') {
            let children = osdWindow.get_children();
            for (let child of children) {
                if (typeof child.add_style_class_name === 'function') {
                    targetBox = child;
                    break;
                }
            }
        }
        if (!targetBox || typeof targetBox.add_style_class_name !== 'function') {
            console.warn("[Liquid Glass] OSDのUIコンテナが見つかりませんでした。");
            return;
        }
        // ここで初めてクラスを付与
        targetBox.add_style_class_name('liquid-glass-transparent');
        targetBox.translation_y = -this._osdYOffset;
        let bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        bgActor.set_size(2.0, 2.0);
        bgActor.set_pivot_point(0.0, 0.0);
        let clipBox = new St.Widget({ clip_to_allocation: true });
        clipBox.set_size(2.0, 2.0);
        bgActor.add_child(clipBox);
        // OSD内部のレイアウトマネージャーの干渉を防ぐため、
        // targetBoxの親ではなく、OSDウィンドウ自体の背後に差し込む
        let osdParent = osdWindow.get_parent();
        if (osdParent) {
            osdParent.insert_child_below(bgActor, osdWindow);
        }
        else {
            Main.layoutManager.uiGroup.add_child(bgActor);
        }
        let blurRadius = this._settings.get_int('osd-blur-radius');
        let tintColorStr = this._settings.get_string('osd-tint-color');
        let cornerRadius = this._settings.get_double('osd-corner-radius');
        let blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        clipBox.add_effect(blurEffect);
        let effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        effect.setPadding(SHADER_PADDING);
        effect.setTintColor(...this._hexToColorArray(tintColorStr));
        effect.setTintStrength(this._baseTint);
        effect.setCornerRadius(cornerRadius);
        effect.setIsDock(false);
        bgActor.add_effect(effect);
        bgActor.hide();
        // 状態オブジェクトを作成
        let state = {
            osdWindow: osdWindow,
            targetBox: targetBox,
            bgActor: bgActor,
            clipBox: clipBox,
            blurEffect: blurEffect,
            effect: effect,
            bgClone: null,
            windowClonesContainer: null,
            overviewCloneContainer: null,
            _windowClones: new Map(),
            _overviewClone: null,
            _appDisplayClone: null,
            _searchClone: null,
            _stableBaseW: undefined,
            _stableBaseH: undefined,
            _lastBgW: undefined,
            _lastBgH: undefined,
            _lastBgX: undefined,
            _lastBgY: undefined,
            _currentTint: this._baseTint,
            _wasVisible: false,
            _isFirstAdaptiveRun: true,
            _destroyId: 0,
            _visibilitySignalIds: []
        };
        this._buildClones(state);
        this._osdStates.push(state);
        const onPropertyChange = () => {
            this._syncOsdVisibilityAndOpacity(state);
            maybeStart();
        };
        const maybeStart = () => {
            if (!this._isEffectActive || !this._hasVisibleOsd())
                return;
            this._startFrameSync();
            this._startAdaptiveColorSampling();
        };
        const connectVisibilitySignal = (target, signalName) => {
            if (!target || typeof target.connect !== 'function')
                return;
            try {
                let id = target.connect(signalName, onPropertyChange);
                state._visibilitySignalIds.push({ target, id });
            }
            catch (e) {
                // Some GNOME Shell versions do not expose every notify property.
            }
        };
        for (const target of [osdWindow, targetBox]) {
            connectVisibilitySignal(target, 'notify::visible');
            connectVisibilitySignal(target, 'notify::mapped');
            connectVisibilitySignal(target, 'notify::opacity');
            connectVisibilitySignal(target, 'notify::allocation');
        }
        // クリーンアップの徹底：OSDウィンドウが破棄されたらbgActorも道連れにする
        state._destroyId = osdWindow.connect('destroy', () => {
            this._osdStates = this._osdStates.filter(s => s !== state);
            if (state.bgActor) {
                state.bgActor.destroy();
                // state.bgActor = null;
            }
            if (state.effect) {
                state.effect.cleanup();
                // state.effect = null;
            }
        });
        // Run initial sync
        this._syncOsdVisibilityAndOpacity(state);
    }
    _isOsdStateVisible(state) {
        let op = Math.min(state.osdWindow?.opacity ?? 0, state.targetBox?.opacity ?? 0);
        return op > 0 &&
            !!state.osdWindow?.visible &&
            !!state.osdWindow?.mapped &&
            !!state.targetBox?.visible &&
            !!state.targetBox?.mapped;
    }
    _syncOsdVisibilityAndOpacity(state) {
        if (!state.bgActor || !state.targetBox || !state.osdWindow)
            return;
        let isVisible = this._isOsdStateVisible(state);
        let currentOpacity = Math.min(state.osdWindow.opacity, state.targetBox.opacity);
        state.bgActor.opacity = currentOpacity;
        if (!isVisible) {
            state.bgActor.hide();
        }
        else {
            // Sync geometry immediately before showing the background actor
            this._syncGeometry(state);
            let [w, h] = state.targetBox.get_size();
            if (w > 0 && h > 0 && w <= 500 && h <= 500) {
                state.bgActor.show();
            }
            else {
                state.bgActor.hide();
            }
        }
    }
    _hasVisibleOsd() {
        return this._osdStates.some(state => this._isOsdStateVisible(state));
    }
    _startFrameSync() {
        if (this._frameSyncId !== 0 || !this._isEffectActive || !this._hasVisibleOsd())
            return;
        const frameTick = () => {
            if (!this._isEffectActive) {
                this._frameSyncId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (!this._hasVisibleOsd()) {
                for (let state of this._osdStates) {
                    state.bgActor?.hide();
                }
                this._stopAdaptiveColorSampling();
                this._frameSyncId = 0;
                return GLib.SOURCE_REMOVE;
            }
            for (let state of this._osdStates) {
                this._syncGeometry(state);
            }
            return GLib.SOURCE_CONTINUE;
        };
        this._frameSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, frameTick);
    }
    _syncActorProperties(source, clone) {
        if (!source || !clone)
            return;
        let [absX, absY] = source.get_transformed_position();
        let [w, h] = source.get_size();
        if (Number.isNaN(absX) || Number.isNaN(absY) || Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0) {
            clone.visible = false;
            return;
        }
        clone.set_position(absX, absY);
        clone.set_size(w, h);
        clone.set_scale(source.scale_x, source.scale_y);
        let pX = source.pivot_point ? source.pivot_point.x : 0;
        let pY = source.pivot_point ? source.pivot_point.y : 0;
        clone.set_pivot_point(pX, pY);
        clone.translation_x = 0;
        clone.translation_y = 0;
        clone.opacity = source.opacity;
        clone.visible = source.visible && source.mapped;
    }
    _syncGeometry(state) {
        if (!state.bgActor || !state.targetBox)
            return;
        let [w, h] = state.targetBox.get_size();
        let [absX, absY] = state.targetBox.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return;
        // 不透明度を連動（GNOMEのOSDアニメーションを尊重）
        let currentOpacity = Math.min(state.osdWindow.opacity, state.targetBox.opacity);
        let isVisible = this._isOsdStateVisible(state);
        if (isVisible && !state._wasVisible) {
            state._wasVisible = true;
            state._stableBaseH = undefined;
            state._stableBaseW = undefined;
            state._lastBgW = undefined;
            state._lastBgH = undefined;
            state._lastBgX = undefined;
            state._lastBgY = undefined;
            this._isFirstAdaptiveRun = true; // 初回フラグを立てる
            this._updateAdaptiveTextColors(); // 400msタイマーを待たずに即座に実行！
            this._startAdaptiveColorSampling();
            // フレームループが停止している場合は再起動
            this._startFrameSync();
        }
        else if (!isVisible && state._wasVisible) {
            state._wasVisible = false;
        }
        state.bgActor.opacity = currentOpacity;
        if (!isVisible) {
            state.bgActor.hide();
            return;
        }
        // Size sanity check to prevent flickering into a large size on initial layout
        if (w <= 0 || h <= 0 || w > 500 || h > 500) {
            state.bgActor.hide();
            return;
        }
        if (!state.bgActor.visible) {
            state.bgActor.show();
        }
        // OSD特有のバグ対策：アイコン切り替え時に一時的に margin-bottom が height に加算されてしまう現象を検知
        let themeNode = state.targetBox.get_theme_node();
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;
        if (state._stableBaseH === undefined) {
            let initH = h;
            try {
                // get_preferred_height() includes the margin-bottom, but get_size() does
                // not, so prefer the current allocation to seed the non-bloated baseline
                let [_, naturalH] = state.targetBox.get_preferred_height(-1);
                if (naturalH - mB > 0) {
                    initH = naturalH - mB;
                }
            }
            catch (e) {
                console.warn(`[Liquid Glass] Failed to get preferred height for OSD initialization: ${e}`);
            }
            state._stableBaseH = initH;
        }
        let isHeightBloated = Math.abs(h - (state._stableBaseH + mB)) <= 1;
        let visualW = w;
        let visualH = h;
        if (isHeightBloated) {
            // 異常膨張を検知した場合は、margin-bottom分を差し引いて正しい高さを保つ
            visualH = h - mB;
        }
        else {
            // 正常な状態なら、基準の高さを更新
            state._stableBaseH = h;
            visualH = h;
        }
        let scaleX = Number.isNaN(state.osdWindow.scale_x) ? 1.0 : state.osdWindow.scale_x;
        let scaleY = Number.isNaN(state.osdWindow.scale_y) ? 1.0 : state.osdWindow.scale_y;
        let pX = 0;
        let pY = 0;
        let parent = state.bgActor.get_parent();
        if (parent) {
            let [transX, transY] = parent.get_transformed_position();
            if (!Number.isNaN(transX) && !Number.isNaN(transY)) {
                pX = transX;
                pY = transY;
            }
        }
        let centerX = absX - pX + (visualW * scaleX) / 2;
        let centerY = absY - pY + (visualH * scaleY) / 2;
        let bgW = visualW + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = visualH + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgX_local = centerX - bgW / 2;
        let bgY_local = centerY - bgH / 2;
        let bgX_abs = centerX + pX - bgW / 2;
        let bgY_abs = centerY + pY - bgH / 2;
        state.bgActor.set_pivot_point(0.5, 0.5);
        state.bgActor.set_scale(scaleX, scaleY);
        if (state._lastBgW === undefined || state._lastBgH === undefined || state._lastBgX === undefined || state._lastBgY === undefined ||
            Math.abs(state._lastBgW - bgW) > 0.5 || Math.abs(state._lastBgH - bgH) > 0.5 ||
            Math.abs(state._lastBgX - bgX_abs) > 0.5 || Math.abs(state._lastBgY - bgY_abs) > 0.5) {
            state.bgActor.set_size(bgW, bgH);
            state.bgActor.set_position(bgX_local, bgY_local);
            state.clipBox.set_size(bgW, bgH);
            state.clipBox.set_position(0, 0);
            state.effect?.setResolution(bgW, bgH);
            // state.effect.setResolution(bgW, bgH);
            state._lastBgW = bgW;
            state._lastBgH = bgH;
            state._lastBgX = bgX_abs;
            state._lastBgY = bgY_abs;
        }
        if (state.bgClone && state.windowClonesContainer) {
            state.bgClone.set_position(-bgX_abs, -bgY_abs);
            state.windowClonesContainer.set_position(-bgX_abs, -bgY_abs);
            if (state.overviewCloneContainer) {
                state.overviewCloneContainer.set_position(-bgX_abs, -bgY_abs);
            }
            let isOverview = Main.overview.visible || Main.overview.animationInProgress;
            let windows = global.get_window_actors();
            let activeWindows = new Set();
            let zIndex = 0;
            if (!isOverview) {
                if (state._overviewClone) {
                    state._overviewClone.destroy();
                    state._overviewClone = null;
                }
                if (state._appDisplayClone) {
                    state._appDisplayClone.destroy();
                    state._appDisplayClone = null;
                }
                if (state._searchClone) {
                    state._searchClone.destroy();
                    state._searchClone = null;
                }
                state.bgClone.show();
                for (let w of windows) {
                    let metaWindow = w.get_meta_window();
                    if (!metaWindow || metaWindow.minimized || !w.visible)
                        continue;
                    // AABB culling: ガラス領域と交差しないウィンドウクローンをスキップ（GPU節約）
                    let wRight = w.x + w.width;
                    let wBottom = w.y + w.height;
                    if (wRight < bgX_abs || w.x > bgX_abs + bgW || wBottom < bgY_abs || w.y > bgY_abs + bgH) {
                        if (state._windowClones.has(w)) {
                            state._windowClones.get(w)?.destroy();
                            state._windowClones.delete(w);
                        }
                        continue;
                    }
                    activeWindows.add(w);
                    let clone;
                    if (!state._windowClones.has(w)) {
                        clone = new UnpickableClone({ source: w });
                        state.windowClonesContainer.add_child(clone);
                        state._windowClones.set(w, clone);
                    }
                    else {
                        clone = state._windowClones.get(w);
                    }
                    clone?.set_position(w.x, w.y);
                    if (clone)
                        state.windowClonesContainer.set_child_at_index(clone, zIndex);
                    zIndex++;
                }
            }
            else {
                state.bgClone.show();
                let controls = Main.overview._overview?._controls;
                if (controls) {
                    if (controls._workspacesDisplay) {
                        if (!state._overviewClone) {
                            state._overviewClone = new UnpickableClone({ source: controls._workspacesDisplay });
                            state.overviewCloneContainer?.add_child(state._overviewClone);
                        }
                        this._syncActorProperties(controls._workspacesDisplay, state._overviewClone);
                    }
                    if (controls._appDisplay) {
                        if (!state._appDisplayClone) {
                            state._appDisplayClone = new UnpickableClone({ source: controls._appDisplay });
                            state.overviewCloneContainer?.add_child(state._appDisplayClone);
                        }
                        this._syncActorProperties(controls._appDisplay, state._appDisplayClone);
                    }
                    if (controls._searchController && controls._searchController.actor) {
                        if (!state._searchClone) {
                            state._searchClone = new UnpickableClone({ source: controls._searchController.actor });
                            state.overviewCloneContainer?.add_child(state._searchClone);
                        }
                        this._syncActorProperties(controls._searchController.actor, state._searchClone);
                    }
                }
            }
            for (let [w, clone] of state._windowClones.entries()) {
                if (!activeWindows.has(w)) {
                    clone.destroy();
                    state._windowClones.delete(w);
                }
            }
        }
    }
    _buildClones(state) {
        if (!state.bgActor)
            return;
        // Incremental: window clones are created lazily by _syncGeometry() (which
        // AABB-culls out-of-view windows), so avoid pre-creating the full set here.
        if (!state.bgClone) {
            state.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
            state.clipBox.add_child(state.bgClone);
        }
        if (!state.overviewCloneContainer) {
            state.overviewCloneContainer = new Clutter.Actor();
            state.clipBox.add_child(state.overviewCloneContainer);
            state._overviewClone = null;
            state._appDisplayClone = null;
            state._searchClone = null;
        }
        if (!state.windowClonesContainer) {
            state.windowClonesContainer = new Clutter.Actor();
            state.clipBox.add_child(state.windowClonesContainer);
            state._windowClones.clear();
        }
    }
    // --- Adaptive Colors ---
    _collectAdaptiveTextTargets() {
        let targets = [];
        for (let state of this._osdStates) {
            // 表示されているOSDだけを対象にする
            if (this._isOsdStateVisible(state)) {
                this._findAllTextActors(state.targetBox, targets);
            }
        }
        return targets;
    }
    _findAllTextActors(actor, foundActors = []) {
        if (!actor)
            return foundActors;
        let isProgressBar = actor.has_style_class_name && actor.has_style_class_name('level');
        if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button || actor instanceof St.Icon || isProgressBar) {
            if (actor.visible) {
                foundActors.push(actor);
            }
        }
        let children = actor.get_children();
        for (let i = 0; i < children.length; i++) {
            this._findAllTextActors(children[i], foundActors);
        }
        return foundActors;
    }
    _setActorColor(actor, color, skipAnimations = false) {
        if (!actor || typeof actor.set_style !== 'function')
            return;
        if (!this._styledActors.has(actor)) {
            let origStyle = typeof actor.get_style === 'function' ? actor.get_style() : null;
            this._styledActors.set(actor, origStyle || '');
            actor.connect('destroy', () => {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = undefined;
                }
                this._styledActors.delete(actor);
            });
        }
        if (actor._currentTargetColor === color)
            return;
        actor._currentTargetColor = color;
        this._animateActorColor(actor, color, 380, skipAnimations);
    }
    _clearAdaptiveStyles() {
        for (const [actor, style] of this._styledActors.entries()) {
            if (actor && typeof actor.set_style === 'function') {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = undefined;
                }
                actor._currentTargetColor = undefined;
                actor.remove_style_class_name('adaptive-text-transition');
                actor.remove_style_class_name('adaptive-color-light');
                actor.remove_style_class_name('adaptive-color-dark');
                actor.set_style(style);
            }
        }
        this._styledActors.clear();
    }
    _applyAdaptiveColorMap(colorMap, skipAnimations = false) {
        if (!colorMap || colorMap.size === 0)
            return;
        for (const [actor, color] of colorMap.entries()) {
            this._setActorColor(actor, color, skipAnimations);
        }
    }
    _startAdaptiveColorSampling() {
        if (!this._adaptiveConfig.enabled || !this._hasVisibleOsd())
            return;
        this._updateAdaptiveTextColors();
        if (this._adaptiveTimerId !== 0)
            return;
        this._adaptiveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._adaptiveConfig.sampleIntervalMs, () => {
            if (!this._hasVisibleOsd()) {
                this._adaptiveTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._updateAdaptiveTextColors();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopAdaptiveColorSampling() {
        if (this._adaptiveTimerId !== 0) {
            GLib.source_remove(this._adaptiveTimerId);
            this._adaptiveTimerId = 0;
        }
    }
    _updateAdaptiveTextColors() {
        if (!this._adaptiveConfig.enabled || this._adaptiveInFlight)
            return;
        const targets = this._collectAdaptiveTextTargets();
        if (targets.length === 0)
            return;
        this._adaptiveInFlight = true;
        let isFirst = this._isFirstAdaptiveRun;
        this._isFirstAdaptiveRun = false;
        this._contrastSampler
            .chooseColorsForActors(targets, this._adaptiveConfig)
            .then(colorMap => {
            this._applyAdaptiveColorMap(colorMap, isFirst);
        })
            .catch(e => {
            console.error(`[Liquid Glass] OSD adaptive color update failed: ${e}`);
        })
            .finally(() => {
            this._adaptiveInFlight = false;
        });
    }
    _animateActorColor(actor, targetHexColor, durationMs = 380, skipAnimations = false) {
        if (!actor || Object.keys(actor).length === 0)
            return;
        if (actor._colorTweenId) {
            GLib.source_remove(actor._colorTweenId);
            actor._colorTweenId = undefined;
        }
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color();
        let startBgColor = themeNode.get_background_color(); // トラック（背景）の現在の色を取得
        let targetRgb = hexToRgb(targetHexColor);
        // --- プログレスバー専用の Lerp (線形補間) ロジック ---
        let isProgressBar = actor.has_style_class_name && actor.has_style_class_name('level');
        let trackTargetRgb = targetRgb; // デフォルトは同じ色
        if (isProgressBar) {
            // AdaptiveConfig からlight/dark色を取得 (無ければ白黒にフォールバック)
            let lightHex = this._adaptiveConfig?.lightTextColor || '#ffffff';
            let darkHex = this._adaptiveConfig?.darkTextColor || '#000000';
            // ターゲット色がLightかDarkかを判定して、もう片方の色（otherRgb）を決定
            let isTargetLight = targetHexColor.toLowerCase() === lightHex.toLowerCase();
            let otherHexColor = isTargetLight ? darkHex : lightHex;
            let otherRgb = hexToRgb(otherHexColor);
            // 補間割合 x (0.0=全く変えない, 1.0=完全にもう片方の色)
            // 0.85 くらいにすると、不透明なまま絶妙に背景トラックっぽく沈む色になります
            let lerpRatio = 0.7;
            trackTargetRgb = {
                r: Math.round(targetRgb.r + (otherRgb.r - targetRgb.r) * lerpRatio),
                g: Math.round(targetRgb.g + (otherRgb.g - targetRgb.g) * lerpRatio),
                b: Math.round(targetRgb.b + (otherRgb.b - targetRgb.b) * lerpRatio)
            };
        }
        let origStyle = this._styledActors.get(actor) || '';
        let stylePrefix = origStyle ? `${origStyle} ` : '';
        if (skipAnimations) {
            let finalHex = rgbToHex(targetRgb.r, targetRgb.g, targetRgb.b);
            if (isProgressBar) {
                let finalBgHex = rgbToHex(trackTargetRgb.r, trackTargetRgb.g, trackTargetRgb.b);
                actor.set_style(`${stylePrefix}-barlevel-active-background-color: ${finalHex}; -barlevel-background-color: ${finalBgHex};`);
            }
            else {
                actor.set_style(`${stylePrefix}color: ${finalHex}; -st-icon-foreground-color: ${finalHex};`);
            }
            return;
        }
        let startTime = GLib.get_monotonic_time();
        actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!actor || Object.keys(actor).length === 0)
                return GLib.SOURCE_REMOVE;
            let currentTime = GLib.get_monotonic_time();
            let elapsedMs = (currentTime - startTime) / 1000;
            let progress = Math.min(elapsedMs / durationMs, 1.0);
            let easeProgress = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            // 前景色（filled部分・テキスト・アイコン）のアニメーション
            let r = Math.round(startColor.red + (targetRgb.r - startColor.red) * easeProgress);
            let g = Math.round(startColor.green + (targetRgb.g - startColor.green) * easeProgress);
            let b = Math.round(startColor.blue + (targetRgb.b - startColor.blue) * easeProgress);
            let currentHex = rgbToHex(r, g, b);
            if (isProgressBar) {
                // BarLevel専用のプロパティで色を適用
                let bgR = Math.round(startBgColor.red + (trackTargetRgb.r - startBgColor.red) * easeProgress);
                let bgG = Math.round(startBgColor.green + (trackTargetRgb.g - startBgColor.green) * easeProgress);
                let bgB = Math.round(startBgColor.blue + (trackTargetRgb.b - startBgColor.blue) * easeProgress);
                let currentBgHex = rgbToHex(bgR, bgG, bgB);
                // 発見した -barlevel-* プロパティを使用！
                actor.set_style(`${stylePrefix}-barlevel-active-background-color: ${currentHex}; -barlevel-background-color: ${currentBgHex};`);
            }
            else {
                actor.set_style(`${stylePrefix}color: ${currentHex}; -st-icon-foreground-color: ${currentHex};`);
            }
            if (progress >= 1.0) {
                actor._colorTweenId = undefined;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        if (this._monitorsChangedId !== 0) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._frameSyncId !== 0) {
            GLib.source_remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        for (let state of this._osdStates) {
            this._cleanupOsdState(state);
        }
        this._osdStates = [];
    }
    _cleanupOsdState(state) {
        const isDisposed = (obj) => {
            if (!obj)
                return true;
            try {
                return Object.getOwnPropertyNames(obj).length === 0;
            }
            catch (e) {
                return true;
            }
        };
        // 各処理を独立させ、1つがコケても他が巻き添えを食らわないようにする
        for (let sig of state._visibilitySignalIds) {
            try {
                sig.target.disconnect(sig.id);
            }
            catch (e) { }
        }
        state._visibilitySignalIds = [];
        if (state.osdWindow && !isDisposed(state.osdWindow)) {
            if (state._destroyId) {
                try {
                    state.osdWindow.disconnect(state._destroyId);
                }
                catch (e) {
                    // すでにC側で自動切断されている場合はスルー
                }
                state._destroyId = 0;
            }
        }
        if (state.targetBox && !isDisposed(state.targetBox)) {
            try {
                state.targetBox.remove_style_class_name('liquid-glass-transparent');
                state.targetBox.translation_y = 0;
            }
            catch (e) { }
        }
        if (state.effect) {
            try {
                state.effect.cleanup();
            }
            catch (e) { }
            state.effect = null;
        }
        if (state.bgActor && !isDisposed(state.bgActor)) {
            try {
                state.bgActor.destroy();
            }
            catch (e) { }
            state.bgActor = null;
        }
        state.blurEffect = null;
        state.bgClone = null;
        state.windowClonesContainer = null;
        state.overviewCloneContainer = null;
        state._windowClones.clear();
    }
    cleanup() {
        for (let sigId of this._settingsSignals) {
            this._settings.disconnect(sigId);
        }
        this._settingsSignals = [];
        this._removeEffect();
    }
}
