// src/uiManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableClone, UnpickableActor, suppressGnomePopupAnimation, hexToRgb, rgbToHex } from './utils.js';
// ========== Configuration Parameters ==========
// Transparent padding outside the glass area. 
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;
// Adaptive text color flags
const SAMPLE_PER_ELEMENT = false;
// ==============================================
export class UIManager {
    extensionPath;
    _settings;
    targetActor;
    menu;
    animActor;
    bgActor;
    blurEffect;
    effect;
    bgClone;
    windowClonesContainer;
    overviewCloneContainer;
    _windowClones;
    _overviewClone;
    _appDisplayClone;
    _searchClone;
    // private _signals: number[];
    _signals;
    _animSignalId = 0;
    _pendingMenuClosedCallback = null;
    _restorePopupAnimPatch = null;
    _frameSyncId;
    _glassExpand;
    _menuXoffset;
    _menuYoffset;
    _tickId;
    _isAnimating = false;
    _contrastSampler;
    _adaptiveTimerId;
    _adaptiveInFlight;
    _styledActors;
    _settingsSignals;
    _isEffectActive;
    _adaptiveConfig;
    clipBox = null;
    _stableBaseW;
    _stableBaseH;
    _lastValidAnimAbsX;
    _lastValidAnimAbsY;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _syncIdleMode = false;
    _syncStableFrames = 0;
    _syncLastSignature = '';
    _lastSyncTime = 0;
    _getSyncSignature() {
        let parts = [];
        try {
            if (this.targetActor) {
                let [x, y] = this.targetActor.get_transformed_position();
                let [w, h] = this.targetActor.get_size();
                parts.push(`ui:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)},${this.targetActor.opacity}`);
            }
            let windows = global.get_window_actors();
            for (let w of windows) {
                let metaWindow = w.get_meta_window?.();
                if (!metaWindow || metaWindow.minimized || !w.visible)
                    continue;
                parts.push([
                    Math.round(w.x),
                    Math.round(w.y),
                    Math.round(w.width),
                    Math.round(w.height),
                    Math.round(w.scale_x * 1000),
                    Math.round(w.scale_y * 1000),
                    Math.round(w.translation_x),
                    Math.round(w.translation_y),
                ].join(','));
            }
        }
        catch (e) { }
        return parts.join('|');
    }
    // Spring physics parameters
    _springScale;
    _springPos;
    _springStiffness;
    _springDamping;
    _springMass;
    // SwiftUI Animation parameters
    _swiftAnimation = false; // trueにするとSwiftUI風アニメーションを使用
    _swiftResponse = 0.3; // 応答時間（小さいほど速い。0.3〜0.6程度がおすすめ）
    _swiftDampingFraction = 0.65; // 減衰比（0.6〜0.8あたりが心地よいバウンド）
    _swiftSpringScale;
    _swiftSpringPos;
    _enableAnimation;
    _interfaceSettings = null;
    _accentColorSignalId = 0;
    _dynamicCssFile = null;
    _cornerRadius = 0;
    _animationInterval = 16;
    _menuOpenScale = 1.08;
    _disabledClipActors = new Map();
    constructor(extensionPath, settings, panelItem = Main.panel.statusArea.dateMenu) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        if (!panelItem?.menu?.actor || !panelItem?.menu?.box) {
            throw new Error('[Liquid Glass] Invalid panel menu target');
        }
        // Target the main container of the panel menu
        this.targetActor = panelItem.menu.actor;
        this.menu = panelItem.menu;
        // Target for animations and visual offsets (The inner content)
        this.animActor = panelItem.menu.box;
        this.bgActor = null;
        this.blurEffect = null;
        this.effect = null;
        this.bgClone = null;
        this.windowClonesContainer = null;
        this.overviewCloneContainer = null;
        // Map to keep track of active windows and their corresponding clone actors.
        this._windowClones = new Map();
        this._signals = [];
        this._frameSyncId = 0;
        this._glassExpand = 0;
        this._menuXoffset = 0;
        this._menuYoffset = 0;
        // Custom spring physics parameters for the open/close animation
        // Spring(stiffness, damping, mass)
        this._springScale = new Spring(120, 8, 1.0);
        this._springPos = new Spring(300, 12, 1.0);
        this._springStiffness = 120;
        this._springDamping = 8;
        this._springMass = 1.0;
        // SwiftUI Animation init
        this._swiftSpringScale = new SwiftSpring(this._swiftResponse, this._swiftDampingFraction);
        this._swiftSpringPos = new SwiftSpring(this._swiftResponse, this._swiftDampingFraction);
        this._enableAnimation = false;
        this._tickId = 0;
        this._contrastSampler = new StageContrastSampler();
        this._adaptiveTimerId = 0;
        this._adaptiveInFlight = false;
        this._styledActors = new Map();
        this._settingsSignals = [];
        this._isEffectActive = false;
        this._overviewClone = null;
        this._appDisplayClone = null;
        this._searchClone = null;
        // Listen for the menu opening/closing to trigger our custom physics animation
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._startAnimation(1); // Target scale: 1.0 (fully open)
            }
            else {
                this._startAnimation(0); // Target scale: 0.0 (closed)
            }
        });
        // Suppress GNOME's own _boxPointer open/close animation so it can't
        // composite over (or hard-cut) our custom fade. The bgActor/_isEffectActive
        // checks mirror runTick's bail condition, so glass-off menus keep GNOME's
        // default behavior. Arrow functions evaluate lazily — constructor order is safe.
        this._restorePopupAnimPatch = suppressGnomePopupAnimation(this.menu, {
            isCustomAnimationEnabled: () => this._enableAnimation && this._isEffectActive && !!this.bgActor,
            onSuppressOpen: () => { this._pendingMenuClosedCallback = null; },
            onSuppressClose: (cb) => { this._pendingMenuClosedCallback = cb; },
        });
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        this._enableAnimation = this._settings.get_boolean('enable-menu-animation');
        this._springStiffness = this._settings.get_double('menu-spring-stiffness');
        this._springDamping = this._settings.get_double('menu-spring-damping');
        this._springMass = this._settings.get_double('menu-spring-mass');
        this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        this._springPos.updateParams(this._springStiffness, this._springDamping, this._springMass);
        this._menuOpenScale = Math.max(1.0, this._settings.get_double('menu-open-scale'));
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._accentColorSignalId = this._interfaceSettings.connect('changed::accent-color', () => {
            console.log(`[Liquid Glass] System accent color changed.`);
            // テーマの更新を少し待ってから取得
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._applySystemAccentColor();
                return GLib.SOURCE_REMOVE;
            });
        });
        // 初回実行
        this._applySystemAccentColor();
        // uiManager は 'enable-menu-glass'、notificationManager は 'notification-enable-glass' （※スキーマによる）
        if (this._settings.get_boolean('enable-menu-glass')) {
            this._applyEffect();
        }
    }
    _applySystemAccentColor() {
        if (!this.targetActor)
            return;
        // 1. 親要素と子要素を作成して、GNOMEテーマが要求する正しい階層を再現
        const parent = new St.Widget({ style_class: 'calendar' });
        const child = new St.Widget({ style_class: 'calendar-day calendar-today' });
        parent.add_child(child);
        // 2. UIグループに追加してスタイルを強制計算させる
        Main.layoutManager.uiGroup.add_child(parent);
        child.ensure_style();
        // 3. 計算済みの色を取得
        const themeNode = child.get_theme_node();
        const bgColor = themeNode.get_background_color();
        // 4. 用が済んだらすぐお掃除
        Main.layoutManager.uiGroup.remove_child(parent);
        parent.destroy();
        // 5. HEXに変換
        const colorStr = rgbToHex(bgColor.red, bgColor.green, bgColor.blue);
        console.log(`[Liquid Glass] Set system accent color to ${colorStr}`);
        // 3. その場で読み込ませる動的CSSの内容を作成（変数は使わず、直接色を埋め込む）
        const cssContent = `
      .liquid-glass-menu-root .calendar-today,
      .liquid-glass-menu-root .calendar-today:hover,
      .liquid-glass-menu-root .calendar-today:active,
      .liquid-glass-menu-root .calendar-today:checked,
      .liquid-glass-menu-root .calendar-today:focus {
        background-color: ${colorStr} !important;
        color: white !important;
      }
    `;
        try {
            // 4. ユーザーのキャッシュディレクトリに一時CSSファイルとして保存
            const cacheDir = GLib.get_user_cache_dir();
            const filePath = GLib.build_filenamev([cacheDir, 'liquid-glass-accent.css']);
            // 文字列をファイルに書き込み
            GLib.file_set_contents(filePath, cssContent);
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const theme = themeContext.get_theme();
            // 5. 古い動くスタイルシートがあれば先にアンロード（多重適用防止）
            if (this._dynamicCssFile) {
                theme.unload_stylesheet(this._dynamicCssFile);
            }
            // 6. 新しいスタイルシートをテーマに直接ロード
            this._dynamicCssFile = Gio.File.new_for_path(filePath);
            theme.load_stylesheet(this._dynamicCssFile);
            console.log(`[Liquid Glass] 動的CSSの注入に成功しました。適用色: ${colorStr}`);
        }
        catch (e) {
            console.log(`[Liquid Glass] 動的CSSの適用に失敗しました: ${e}`);
        }
    }
    // Utility: Convert HEX color string to normalized RGB array
    _hexToColorArray(hex) {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
            return [1.0, 1.0, 1.0];
        let r = parseInt(hex.slice(1, 3), 16) / 255.0;
        let g = parseInt(hex.slice(3, 5), 16) / 255.0;
        let b = parseInt(hex.slice(5, 7), 16) / 255.0;
        return [r, g, b];
    }
    _getMenuMonitorGeometry() {
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        return Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
    }
    // 追加: 設定の動的反映
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        // ON/OFF切り替え
        connectSetting('enable-menu-glass', () => {
            let enabled = this._settings.get_boolean('enable-menu-glass');
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting('enable-menu-animation', () => {
            this._enableAnimation = this._settings.get_boolean('enable-menu-animation');
        });
        connectSetting('menu-spring-stiffness', () => {
            this._springStiffness = this._settings.get_double('menu-spring-stiffness');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('menu-spring-damping', () => {
            this._springDamping = this._settings.get_double('menu-spring-damping');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('menu-spring-mass', () => {
            this._springMass = this._settings.get_double('menu-spring-mass');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('menu-animation-interval-ms', () => {
            this._animationInterval = this._settings.get_int('menu-animation-interval-ms');
        });
        connectSetting('menu-open-scale', () => {
            this._menuOpenScale = Math.max(1.0, this._settings.get_double('menu-open-scale'));
        });
        connectSetting('menu-tint-color', () => {
            if (this.effect) {
                let colorArray = this._hexToColorArray(this._settings.get_string('menu-tint-color'));
                this.effect.setTintColor(...colorArray);
            }
        });
        connectSetting('menu-tint-strength', () => {
            if (this.effect) {
                this.effect.setTintStrength(this._settings.get_double('menu-tint-strength'));
            }
        });
        connectSetting('menu-blur-radius', () => {
            if (this.blurEffect) {
                this.blurEffect.radius = this._settings.get_int('menu-blur-radius');
            }
        });
        connectSetting('menu-corner-radius', () => {
            if (this.effect) {
                this._cornerRadius = Math.min(this._settings.get_double('menu-corner-radius'), 24.0);
                this.effect.setCornerRadius(this._cornerRadius);
            }
        });
        connectSetting('menu-glass-expand', () => {
            if (this.effect) {
                this._glassExpand = this._settings.get_int('menu-glass-expand');
            }
        });
        connectSetting('menu-x-offset', () => {
            if (this.animActor) {
                this._menuXoffset = this._settings.get_int('menu-x-offset');
                this.animActor.translation_x = this._menuXoffset;
            }
        });
        connectSetting('menu-y-offset', () => {
            if (this.animActor) {
                this._menuYoffset = this._settings.get_int('menu-y-offset');
                this.animActor.translation_y = this._menuYoffset;
            }
        });
        connectSetting('menu-enable-adaptive-text-color', () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean('menu-enable-adaptive-text-color');
        });
        connectSetting('menu-sample-interval-ms', () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('menu-sample-interval-ms');
        });
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        if (!this.targetActor)
            return;
        // Remove default GNOME styling and make the background transparent
        this.targetActor.add_style_class_name('liquid-glass-transparent');
        this.animActor.add_style_class_name('liquid-glass-transparent');
        this.animActor.add_style_class_name('liquid-glass-menu-root');
        this.animActor.add_style_class_name('liquid-glass-menu-active');
        // Shift the menu down to prevent it from clipping into the top bar
        this._menuXoffset = this._settings.get_int('menu-x-offset');
        this._menuYoffset = this._settings.get_int('menu-y-offset');
        this.animActor.translation_x = this._menuXoffset;
        this.animActor.translation_y = this._menuYoffset;
        this._glassExpand = this._settings.get_int('menu-glass-expand');
        this._animationInterval = this._settings.get_int('menu-animation-interval-ms');
        this._menuOpenScale = Math.max(1.0, this._settings.get_double('menu-open-scale'));
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: this._settings.get_boolean('menu-enable-adaptive-text-color'),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int('menu-sample-interval-ms'),
        };
        // Create the main background actor that will hold the glass effect
        // clip_to_allocation is false so the shader can draw outside the strict bounds if needed
        // 1. bgActor (LiquidEffect用：メニューサイズ)
        this.bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        this.bgActor.set_size(2.0, 2.0);
        // 2. clipBox (切り抜き用ハサミ：メニューサイズ)
        this.clipBox = new St.Widget({
            clip_to_allocation: true
        });
        this.clipBox.set_size(2.0, 2.0);
        this.bgActor.add_child(this.clipBox);
        // Set pivot points for scaling. 
        // The menu scales from the top-center (0.5, 0.0)
        this.animActor.set_pivot_point(0.5, 0.0);
        // bgActor scales from the top-left (0.0, 0.0) because we manually sync its exact coordinates
        this.bgActor.set_pivot_point(0.0, 0.0);
        // Insert the custom background *underneath* the actual menu UI
        let menuParent = this.menu.actor.get_parent();
        if (menuParent) {
            menuParent.insert_child_below(this.bgActor, this.menu.actor);
        }
        else {
            // Fallback: If it has no parent yet, add it directly to the UI group
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }
        let blurRadius = this._settings.get_int('menu-blur-radius');
        let tintColorStr = this._settings.get_string('menu-tint-color');
        let tintStrength = this._settings.get_double('menu-tint-strength');
        this._cornerRadius = Math.min(this._settings.get_double('menu-corner-radius'), 24.0);
        // Apply native GNOME blur to the internal clipBox (which contains the clones)
        this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        this.clipBox.add_effect(this.blurEffect);
        // Apply our custom GLSL liquid shader to the outer background actor
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        // Tell the shader about the padding so it calculates refraction coordinates correctly
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...this._hexToColorArray(tintColorStr)); // Pure transparent base
        this.effect.setTintStrength(tintStrength); // Subtle tint strength to enhance the glass look without overpowering the background
        this.effect.setCornerRadius(this._cornerRadius);
        this.effect.setIsDock(false);
        this.bgActor.add_effect(this.effect);
        this.bgActor.hide();
        // Function to create clones of the desktop wallpaper and all visible windows
        let buildClones = () => {
            if (!this.bgActor)
                return;
            // Incremental: reuse existing clones/containers instead of destroying and
            // recreating them on every open. Window clones are created lazily by
            // _syncGeometry() (which also AABB-culls out-of-view windows), so we never
            // pre-create the full set. The maps are only reset when a container is
            // actually (re)created to avoid dropping live clones.
            if (!this.bgClone) {
                this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
                this.bgClone.connect('destroy', () => { this.bgClone = null; });
                this.clipBox?.add_child(this.bgClone);
            }
            if (!this.overviewCloneContainer) {
                this.overviewCloneContainer = new UnpickableActor();
                this.overviewCloneContainer.connect('destroy', () => { this.overviewCloneContainer = null; });
                this.clipBox?.add_child(this.overviewCloneContainer);
                this._overviewClone = null;
                this._appDisplayClone = null;
                this._searchClone = null;
            }
            if (!this.windowClonesContainer) {
                this.windowClonesContainer = new UnpickableActor();
                this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
                this.clipBox?.add_child(this.windowClonesContainer);
                this._windowClones.clear();
            }
        };
        let wakeSync = () => {
            this._syncIdleMode = false;
        };
        let analyticsFrames = 0;
        let analyticsTickTime = 0;
        let analyticsSyncTime = 0;
        let analyticsLastLog = GLib.get_monotonic_time();
        // Render loop function, called every frame while the menu is mapped (visible)
        let frameTick = () => {
            let tickStart = GLib.get_monotonic_time();
            if (!this.bgActor || (!this.targetActor.mapped && !this.menu.isOpen)) {
                this._frameSyncId = 0;
                return GLib.SOURCE_REMOVE;
            }
            let syncStart = GLib.get_monotonic_time();
            if (this.targetActor.mapped && !this._isAnimating) {
                this._syncGeometry();
            }
            let syncEnd = GLib.get_monotonic_time();
            analyticsSyncTime += (syncEnd - syncStart);
            let signature = this._getSyncSignature();
            if (signature === this._syncLastSignature) {
                this._syncStableFrames++;
                if (this._syncStableFrames >= 8) {
                    this._syncIdleMode = true;
                }
            }
            else {
                this._syncStableFrames = 0;
                this._syncIdleMode = false;
                this._syncLastSignature = signature;
            }
            let activeIntervalMs = Math.max(24, this._animationInterval || 33);
            let nextIntervalMs = this._syncIdleMode ? 500 : activeIntervalMs;
            this._frameSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, nextIntervalMs, frameTick);
            let tickEnd = GLib.get_monotonic_time();
            analyticsTickTime += (tickEnd - tickStart);
            analyticsFrames++;
            if (tickEnd - analyticsLastLog > 5_000_000) {
                if (analyticsFrames > 0 && this._settings.get_boolean('output-logs')) {
                    let avgTick = (analyticsTickTime / analyticsFrames) / 1000;
                    let avgSync = (analyticsSyncTime / analyticsFrames) / 1000;
                    let idleState = this._syncIdleMode ? 'IDLE' : 'ACTIVE';
                    log(`[Liquid Glass Analytics] UIManager (${idleState}): ${analyticsFrames} frames in 5s. Avg tick: ${avgTick.toFixed(2)}ms, Avg sync: ${avgSync.toFixed(2)}ms`);
                }
                analyticsFrames = 0;
                analyticsTickTime = 0;
                analyticsSyncTime = 0;
                analyticsLastLog = tickEnd;
            }
            return GLib.SOURCE_REMOVE;
        };
        // Starts the render loop and builds fresh clones when the menu is opened
        let startFrameSync = () => {
            let wasIdle = this._syncIdleMode;
            wakeSync();
            if (this._frameSyncId === 0 || wasIdle) {
                if (this._frameSyncId !== 0) {
                    GLib.source_remove(this._frameSyncId);
                }
                buildClones();
                let interval = 16;
                this._frameSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, frameTick);
            }
        };
        let stopFrameSync = () => {
            if (this._frameSyncId !== 0) {
                GLib.source_remove(this._frameSyncId);
                this._frameSyncId = 0;
            }
        };
        // Clear the cached size whenever the menu opens so it can recalculate 
        // based on any new notifications or calendar events added
        this._signals.push({
            target: this.menu,
            id: this.menu.connect('open-state-changed', (menu, isOpen) => {
                if (isOpen) {
                    this._stableBaseW = undefined;
                    this._stableBaseH = undefined;
                    wakeSync();
                    startFrameSync();
                    this._startAdaptiveColorSampling(true); // Skip animations on the first open for instant feedback
                }
                else {
                    this._stopAdaptiveColorSampling();
                }
            })
        });
        // メニューの表示状態（mapped）が変わった時のシグナルを監視
        this._signals.push({
            target: this.menu.actor,
            id: this.menu.actor.connect('notify::mapped', () => {
                if (this.menu.actor.mapped) {
                    // mapped が true になった（画面に表示された）
                    startFrameSync();
                    if (this.bgActor) {
                        this.bgActor.show();
                    }
                    this._syncGeometry();
                }
                else {
                    // mapped が false になった ＝ 完全に画面から消えた（hideされた）
                    stopFrameSync();
                    // Free window/overview clones now that nothing is visible.
                    // Keeps GPU texture memory from accumulating while menus are closed;
                    // clones are recreated lazily by _syncGeometry() on the next open.
                    this._destroyWindowClones();
                    // 念押しで確実にお掃除しておく
                    if (this.bgActor) {
                        this.bgActor.hide();
                        this.bgActor.opacity = 0;
                    }
                    if (this.animActor) {
                        this.animActor.opacity = 0;
                    }
                }
            })
        });
        this._updateResolution();
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }
    // 追加: UIクローンの位置・サイズ同期用メソッド (Adopted try/catch from quickSettingsManager)
    _syncActorProperties(source, clone) {
        if (!source || !clone)
            return;
        try {
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
        catch (e) {
            // The C-level actor was destroyed by GNOME Shell, but JS hasn't caught up yet.
        }
    }
    // Calculates and synchronizes the position/size of the glass background every frame
    // Destroys all live window/overview clones. Safe to call when the menu is
    // fully unmapped; _syncGeometry() recreates them lazily on the next open.
    _destroyWindowClones() {
        if (this._windowClones) {
            for (const [, clone] of this._windowClones) {
                try {
                    clone.destroy();
                }
                catch (e) { }
            }
            this._windowClones.clear();
        }
        if (this._overviewClone) {
            try {
                this._overviewClone.destroy();
            }
            catch (e) { }
            this._overviewClone = null;
        }
        if (this._appDisplayClone) {
            try {
                this._appDisplayClone.destroy();
            }
            catch (e) { }
            this._appDisplayClone = null;
        }
        if (this._searchClone) {
            try {
                this._searchClone.destroy();
            }
            catch (e) { }
            this._searchClone = null;
        }
    }
    _syncGeometry() {
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
            if (this.bgActor && this.bgActor.visible) {
                this.bgActor.hide();
            }
            return;
        }
        if (this.targetActor.opacity === 0) {
            if (this.bgActor.visible) {
                this.bgActor.opacity = 0;
                this.bgActor.hide();
            }
            return;
        }
        if (!this.bgActor.visible) {
            this.bgActor.show();
        }
        if (!this._enableAnimation) {
            this.bgActor.opacity = this.targetActor.opacity;
        }
        let [inW, inH] = this.animActor.get_size();
        let [outW, outH] = this.targetActor.get_size();
        let [scaleX, scaleY] = this.animActor.get_scale();
        inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
        inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
        scaleX = Number.isNaN(scaleX) ? 1.0 : scaleX;
        scaleY = Number.isNaN(scaleY) ? 1.0 : scaleY;
        scaleX *= this.targetActor.get_scale()[0];
        scaleY *= this.targetActor.get_scale()[1];
        let themeNode = this.animActor.get_theme_node();
        let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
        let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
        let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;
        let marginW = mL + mR;
        let marginH = mT + mB;
        let targetW = Math.round(inW);
        let targetH = Math.round(inH);
        // バグ検知フラグを用意
        let isBugActive = false;
        // GNOME Shell Hover Bug Compensation:
        if (Math.abs(inW - outW) <= 2 && marginW > 0) {
            targetW = Math.round(inW - marginW);
            targetH = Math.round(inH - marginH);
            isBugActive = true; // バグ発動中！
        }
        this._stableBaseW = targetW;
        this._stableBaseH = targetH;
        // Multiply by the current animation scale. 
        // Math.max guarantees the size never drops below 1px (prevents Cogl crashes).
        let w = Math.max(1, this._stableBaseW * scaleX);
        let h = Math.max(1, this._stableBaseH * scaleY);
        // --- ここから修正 ---
        // 実際のUIコンテンツ領域である animActor から直接正しい座標を取得する
        let [animAbsX, animAbsY] = this.animActor.get_transformed_position();
        // --------------------------------------------------------
        // Advanced Fallback Logic for NaN Coordinates
        // GNOME sometimes fails to report actor positions during the very first frame
        // of an animation. This logic predicts where the menu should be.
        // --------------------------------------------------------
        if (Number.isNaN(animAbsX) || Number.isNaN(animAbsY)) {
            if (this._lastValidAnimAbsX !== undefined && this._lastValidAnimAbsY !== undefined) {
                // Use the last known good coordinates if available
                animAbsX = this._lastValidAnimAbsX;
                animAbsY = this._lastValidAnimAbsY;
            }
            else {
                // If no history exists, calculate based on the top panel clock button
                let monitor = Main.layoutManager.primaryMonitor;
                if (monitor) {
                    animAbsX = (monitor.width / 2) - (w / 2) + this._menuXoffset; // Apply horizontal offset
                    animAbsY = (Main.panel.height || 27) + this._menuYoffset;
                }
                else {
                    animAbsX = 0;
                    animAbsY = 0;
                }
            }
        }
        else {
            // Save successful coordinates for future fallbacks
            this._lastValidAnimAbsX = animAbsX;
            this._lastValidAnimAbsY = animAbsY;
        }
        // --------------------------------------------------------
        // The background needs to be larger than the UI to account for the glass expansion
        // and the extra padding required by the shader for edge refraction.
        let bgW = Math.round(w + (this._glassExpand * 2) + (SHADER_PADDING * 2));
        let bgH = Math.round(h + (this._glassExpand * 2) + (SHADER_PADDING * 2));
        // UIの正確な座標に対して、純粋にパディング分だけマイナスして背景を被せる
        let bgX = Math.round(animAbsX - this._glassExpand - SHADER_PADDING);
        let bgY = Math.round(animAbsY - this._glassExpand - SHADER_PADDING);
        if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0) {
            // Only update positions/sizes if they actually changed to save CPU cycles
            if (this._lastBgW !== bgW || this._lastBgH !== bgH || this._lastBgX !== bgX || this._lastBgY !== bgY) {
                this.bgActor.set_size(bgW, bgH);
                this.bgActor.set_position(bgX, bgY);
                // The internal clip region shares the same size, but sits at (0,0) relative to bgActor
                this.clipBox?.set_size(bgW, bgH);
                this.clipBox?.set_position(0, 0);
                let monitor = this._getMenuMonitorGeometry();
                let monitorX = monitor?.x ?? 0;
                let monitorY = monitor?.y ?? 0;
                let monitorW = Math.max(1, monitor?.width ?? 1);
                let monitorH = Math.max(1, monitor?.height ?? 1);
                // Scope FBO to just the glass bounding box (not full monitor).
                // This reduces GPU shader work by ~70-85% since only glass-region
                // pixels are processed instead of the entire screen.
                // We set size to half-resolution (bgW*0.5, bgH*0.5) and scale by 2.0 to downsample the blur pass.
                // Update the shader with the new resolution
                this.effect?.setResolution(bgW, bgH);
                this._lastBgW = bgW;
                this._lastBgH = bgH;
                this._lastBgX = bgX;
                this._lastBgY = bgY;
            }
        }
        if (this.effect) {
            // 縦横のスケールのうち小さい方を採用し、角丸が潰れないようにする
            let currentScale = Math.min(scaleX, scaleY);
            // let baseRadius = this._settings.get_double('menu-corner-radius');
            this.effect.setCornerRadius(this._cornerRadius * currentScale);
            if (typeof this.effect.setAnimationScale === 'function') {
                this.effect.setAnimationScale(currentScale);
            }
        }
        // Apply a negative offset to the clones inside the clipBox.
        // This ensures the cloned background matches the real desktop coordinates perfectly,
        // even while the menu is scaling and moving around.
        if (this.bgClone && this.windowClonesContainer && !Number.isNaN(bgX) && !Number.isNaN(bgY)) {
            let monitor = this._getMenuMonitorGeometry();
            let monitorX = monitor?.x ?? 0;
            let monitorY = monitor?.y ?? 0;
            // Position background clone and set its scale to 0.5 to offset the parent's 2.0 scale.
            let bgExpectedX = -(bgX - monitorX);
            let bgExpectedY = -(bgY - monitorY);
            if (this.bgClone.x !== bgExpectedX || this.bgClone.y !== bgExpectedY) {
                this.bgClone.set_position(bgExpectedX, bgExpectedY);
            }
            if (this.bgClone.scale_x !== 1.0 || this.bgClone.scale_y !== 1.0) {
                this.bgClone.set_scale(1.0, 1.0);
            }
            // Window clones use absolute screen coords, so offset the container
            // to translate them into the glass-local coordinate system.
            // We set position and scale by 0.5 to match the FBO downscaling.
            let winExpectedX = -bgX;
            let winExpectedY = -bgY;
            if (this.windowClonesContainer.x !== winExpectedX || this.windowClonesContainer.y !== winExpectedY) {
                this.windowClonesContainer.set_position(winExpectedX, winExpectedY);
            }
            if (this.windowClonesContainer.scale_x !== 1.0 || this.windowClonesContainer.scale_y !== 1.0) {
                this.windowClonesContainer.set_scale(1.0, 1.0);
            }
            if (this.overviewCloneContainer) {
                if (this.overviewCloneContainer.x !== winExpectedX || this.overviewCloneContainer.y !== winExpectedY) {
                    this.overviewCloneContainer.set_position(winExpectedX, winExpectedY);
                }
                if (this.overviewCloneContainer.scale_x !== 1.0 || this.overviewCloneContainer.scale_y !== 1.0) {
                    this.overviewCloneContainer.set_scale(1.0, 1.0);
                }
            }
            // Efficient window synchronization logic.
            let isOverview = Main.overview.visible || Main.overview.animationInProgress;
            let windows = global.get_window_actors();
            let activeWindows = new Set();
            let zIndex = 0; // Tracks the stacking order
            if (!isOverview) {
                // --- 通常時 ---
                if (this._overviewClone) {
                    this._overviewClone.destroy();
                    this._overviewClone = null;
                }
                if (this._appDisplayClone) {
                    this._appDisplayClone.destroy();
                    this._appDisplayClone = null;
                }
                if (this._searchClone) {
                    this._searchClone.destroy();
                    this._searchClone = null;
                }
                this.bgClone.show();
                // Index map of the current child order, built once per sync pass.
                // Avoids calling get_children().indexOf() per window (O(n^2)). Each
                // clone is visited once per pass, so a stale map entry only ever causes
                // a harmless redundant set_child_at_index, never a missed reorder.
                let cloneIndexMap = null;
                let getCloneIndex = (c) => {
                    if (!cloneIndexMap) {
                        cloneIndexMap = new Map();
                        const children = this.windowClonesContainer?.get_children() ?? [];
                        for (let i = 0; i < children.length; i++)
                            cloneIndexMap.set(children[i], i);
                    }
                    return cloneIndexMap.get(c) ?? -1;
                };
                for (let w of windows) {
                    try {
                        let metaWindow = w.get_meta_window();
                        if (!metaWindow || metaWindow.minimized || !w.visible)
                            continue;
                        // AABB test: skip windows completely outside the glass viewport
                        let wRight = w.x + w.width;
                        let wBottom = w.y + w.height;
                        if (wRight < bgX || w.x > bgX + bgW || wBottom < bgY || w.y > bgY + bgH) {
                            continue;
                        }
                        activeWindows.add(w);
                        let clone;
                        if (!this._windowClones.has(w)) {
                            // Create a clone for newly opened windows.
                            clone = new UnpickableClone({ source: w });
                            this.windowClonesContainer.add_child(clone);
                            this._windowClones.set(w, clone);
                        }
                        else {
                            // Retrieve existing clone.
                            clone = this._windowClones.get(w);
                        }
                        // Position using absolute coords; the container offset handles
                        // translation to glass-local space.
                        if (clone)
                            clone.set_position(w.x, w.y);
                        // Update the Z-index dynamically to reflect window focus changes.
                        if (clone) {
                            let currentIndex = getCloneIndex(clone);
                            if (currentIndex !== zIndex) {
                                this.windowClonesContainer.set_child_at_index(clone, zIndex);
                                cloneIndexMap.set(clone, zIndex);
                            }
                        }
                        zIndex++;
                    }
                    catch (e) {
                        continue;
                    }
                }
            }
            else {
                // --- Overview時 ---
                this.bgClone.show();
                let controls = Main.overview._overview?._controls;
                if (controls) {
                    if (controls._workspacesDisplay) {
                        if (!this._overviewClone) {
                            // this._overviewClone = new UnpickableClone({ source: controls._workspacesDisplay });
                            this._overviewClone = new UnpickableClone({ source: controls._workspacesDisplay });
                            this.overviewCloneContainer?.add_child(this._overviewClone);
                        }
                        this._syncActorProperties(controls._workspacesDisplay, this._overviewClone);
                    }
                    if (controls._appDisplay) {
                        if (!this._appDisplayClone) {
                            // this._appDisplayClone = new UnpickableClone({ source: controls._appDisplay });
                            this._appDisplayClone = new UnpickableClone({ source: controls._appDisplay });
                            this.overviewCloneContainer?.add_child(this._appDisplayClone);
                        }
                        this._syncActorProperties(controls._appDisplay, this._appDisplayClone);
                    }
                    if (controls._searchController && controls._searchController.actor) {
                        if (!this._searchClone) {
                            // this._searchClone = new UnpickableClone({ source: controls._searchController.actor });
                            this._searchClone = new UnpickableClone({ source: controls._searchController.actor });
                            this.overviewCloneContainer?.add_child(this._searchClone);
                        }
                        this._syncActorProperties(controls._searchController.actor, this._searchClone);
                    }
                }
            }
            // Destroy clones for windows that have been closed or minimized.
            for (let [w, clone] of this._windowClones.entries()) {
                if (!activeWindows.has(w)) {
                    clone.destroy();
                    this._windowClones.delete(w);
                }
            }
        }
    }
    // Updates the shader resolution based on the current background actor size
    _updateResolution() {
        if (!this.bgActor || !this.effect)
            return;
        let [width, height] = this.bgActor.get_size();
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            this.effect.setResolution(width, height);
        }
    }
    _collectAdaptiveTextTargets(actor = this.menu?.actor, targets = []) {
        if (!actor)
            return targets;
        return this._findAllTextActors(this.menu?.actor);
    }
    _findAllTextActors(actor, foundActors = []) {
        if (!actor)
            return foundActors;
        // 該当するテキストまたはボタン要素で、かつ可視状態のものを収集
        if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button || actor instanceof St.Icon) {
            if (actor.visible) {
                foundActors.push(actor);
            }
        }
        // 子要素を再帰的に走査
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let i = 0; i < children.length; i++) {
            this._findAllTextActors(children[i], foundActors);
        }
        return foundActors;
    }
    // Initiates the color change for a specific actor
    _setActorColor(actor, color, skipAnimations = false) {
        if (!actor || typeof actor.set_style !== 'function')
            return;
        if (!this._styledActors.has(actor)) {
            let origStyle = typeof actor.get_style === 'function' ? actor.get_style() : null;
            // if (origStyle) this._styledActors.set(actor, origStyle);
            this._styledActors.set(actor, origStyle || '');
            actor.connect('destroy', () => {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = undefined;
                }
                this._styledActors.delete(actor);
            });
        }
        let isInsensitive = false;
        if (actor instanceof St.Button) {
            isInsensitive = (actor.reactive === false) || (typeof actor.has_style_pseudo_class === 'function' && actor.has_style_pseudo_class('insensitive'));
        }
        if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive)
            return;
        actor._currentTargetColor = color;
        actor._currentInsensitiveState = isInsensitive;
        // Kick off the color transition animation!
        this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations);
    }
    // Removes all dynamically applied adaptive text color styles and stops related animations
    _clearAdaptiveStyles() {
        // 1. 変更履歴 (styledActors) から元の状態を復元する
        for (const [actor, originalStyle] of this._styledActors.entries()) {
            if (actor && typeof actor.set_style === 'function') {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = undefined;
                }
                actor._currentTargetColor = undefined;
                actor._currentInsensitiveState = undefined;
                try {
                    actor.remove_style_class_name('adaptive-text-transition');
                    actor.remove_style_class_name('adaptive-color-light');
                    actor.remove_style_class_name('adaptive-color-dark');
                    // 元のスタイル(またはnull)をセット
                    actor.set_style(originalStyle || null);
                }
                catch (e) { }
            }
        }
        this._styledActors.clear();
        // 2. 念のため、現在DOM上に存在するターゲットの色も強制クリア（フェイルセーフ）
        const currentTargets = this._collectAdaptiveTextTargets();
        for (let actor of currentTargets) {
            if (actor && typeof actor.set_style === 'function') {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = undefined;
                }
                actor._currentTargetColor = undefined;
                actor._currentInsensitiveState = undefined;
                try {
                    actor.set_style(null);
                }
                catch (e) { }
            }
        }
    }
    // Iterates through the color map and applies the new target colors to the respective actors
    _applyAdaptiveColorMap(colorMap, skipAnimations = false) {
        if (!colorMap || colorMap.size === 0)
            return;
        for (const [actor, color] of colorMap.entries()) {
            this._setActorColor(actor, color, skipAnimations);
        }
    }
    // Starts the timer for periodically sampling contrast and updating adaptive text colors
    _startAdaptiveColorSampling(skipAnimations = false) {
        if (!this._adaptiveConfig.enabled)
            return;
        this._updateAdaptiveTextColors(skipAnimations);
        if (this._adaptiveTimerId !== 0)
            return;
        this._adaptiveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._adaptiveConfig.sampleIntervalMs, () => {
            if (!this.menu?.isOpen) {
                this._adaptiveTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._updateAdaptiveTextColors(false);
            return GLib.SOURCE_CONTINUE;
        });
    }
    // Stops the adaptive color sampling timer
    _stopAdaptiveColorSampling() {
        if (this._adaptiveTimerId !== 0) {
            GLib.source_remove(this._adaptiveTimerId);
            this._adaptiveTimerId = 0;
        }
    }
    // Collects target actors, samples their contrast, and triggers color updates
    _updateAdaptiveTextColors(skipAnimations = false) {
        if (!this._adaptiveConfig.enabled || this._adaptiveInFlight)
            return;
        const targets = this._collectAdaptiveTextTargets();
        if (targets.length === 0)
            return;
        this._adaptiveInFlight = true;
        this._contrastSampler
            .chooseColorsForActors(targets, this._adaptiveConfig)
            .then(colorMap => {
            this._applyAdaptiveColorMap(colorMap, skipAnimations);
        })
            .catch(e => {
            console.error(`[Liquid Glass] Menu adaptive color update failed: ${e}`);
        })
            .finally(() => {
            this._adaptiveInFlight = false;
        });
    }
    _animateActorColor(actor, targetHexColor, isInsensitive, durationMs = 380, skipAnimations = false) {
        if (!actor || Object.keys(actor).length === 0)
            return;
        // Cancel any existing color tween if running (handles mid-transition target changes).
        if (actor._colorTweenId) {
            GLib.source_remove(actor._colorTweenId);
            actor._colorTweenId = undefined;
        }
        // --- Retrieve the "actual physical color" currently displayed on screen ---
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color(); // Returns Clutter.Color
        let targetRgb = hexToRgb(targetHexColor);
        // 無効状態なら透明度を50%(0.5)にし、有効なら100%(1.0)にする
        let targetAlpha = isInsensitive ? 0.5 : 1.0;
        let startAlpha = startColor.alpha / 255.0;
        let origStyle = this._styledActors.get(actor) || '';
        let stylePrefix = origStyle ? `${origStyle} ` : '';
        if (skipAnimations) {
            let alphaStr = targetAlpha.toFixed(3);
            let targetRgba = `rgba(${targetRgb.r}, ${targetRgb.g}, ${targetRgb.b}, ${alphaStr})`;
            try {
                actor.set_style(`${stylePrefix}color: ${targetRgba}; -st-icon-foreground-color: ${targetRgba};`);
            }
            catch (e) { }
            return;
        }
        let startTime = GLib.get_monotonic_time();
        actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
            if (!actor || Object.keys(actor).length === 0)
                return GLib.SOURCE_REMOVE;
            let currentTime = GLib.get_monotonic_time();
            let elapsedMs = (currentTime - startTime) / 1000;
            let progress = Math.min(elapsedMs / durationMs, 1.0);
            // Standard ease-in-out easing function
            let easeProgress = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            // Linearly interpolate (lerp) each RGB channel individually
            let r = Math.round(startColor.red + (targetRgb.r - startColor.red) * easeProgress);
            let g = Math.round(startColor.green + (targetRgb.g - startColor.green) * easeProgress);
            let b = Math.round(startColor.blue + (targetRgb.b - startColor.blue) * easeProgress);
            // Alpha値も補間して rgba() 形式を生成
            let a = startAlpha + (targetAlpha - startAlpha) * easeProgress;
            a = Math.max(0.0, Math.min(1.0, a)); // 0.0 ~ 1.0 に安全にクランプ
            let alphaStr = a.toFixed(3); // CSS用に小数点第3位まで
            let currentRgba = `rgba(${r}, ${g}, ${b}, ${alphaStr})`;
            // Override text color and icon foreground color directly using inline CSS
            try {
                actor.set_style(`${stylePrefix}color: ${currentRgba}; -st-icon-foreground-color: ${currentRgba};`);
            }
            catch (e) { }
            // Check for animation completion
            if (progress >= 1.0) {
                actor._colorTweenId = undefined;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }
    _disableClippingRecursively(actor) {
        if (!actor)
            return;
        if ('clip_to_allocation' in actor) {
            if (!this._disabledClipActors.has(actor)) {
                this._disabledClipActors.set(actor, actor.clip_to_allocation);
            }
            actor.clip_to_allocation = false;
        }
        let children = actor.get_children();
        for (let child of children) {
            this._disableClippingRecursively(child);
        }
    }
    _restoreClippingRecursively(actor) {
        if (!actor)
            return;
        if ('clip_to_allocation' in actor && this._disabledClipActors.has(actor)) {
            actor.clip_to_allocation = this._disabledClipActors.get(actor) ?? true;
        }
        let children = actor.get_children();
        for (let child of children) {
            this._restoreClippingRecursively(child);
        }
    }
    // Handles the custom bounce/spring physics when the menu opens or closes
    _startAnimation(targetValue) {
        let isClosing = (targetValue === 0);
        log(`[LG-STAMP] startAnimation target=${targetValue} anim=${this._enableAnimation} bg=${!!this.bgActor} targetActor=${!!this.targetActor} tick=${this._tickId}`);
        if (this._tickId !== 0) {
            if (global.compositor?.get_laters) {
                global.compositor.get_laters().remove(this._tickId);
            }
            this._tickId = 0;
        }
        // If animation is disabled, just hide the menu and exit
        if (!this._enableAnimation) {
            this._isAnimating = false;
            if (this.bgActor) {
                this.bgActor.remove_all_transitions();
                this.bgActor.opacity = 255;
                this.bgActor.set_scale(1.0, 1.0);
                // 独自アニメーション（スケール変更など）の残骸をリセットし、GNOMEデフォルトの動作に任せる
                if (this.animActor) {
                    // this.animActor.remove_all_transitions();
                    this.animActor.set_scale(1.0, 1.0);
                    this.animActor.opacity = 255;
                }
                // アニメーション中の透明度や位置の同期は _syncGeometry が行います
            }
            return;
        }
        // Clear any built-in GNOME transitions that might interfere with our logic
        if (this.animActor)
            this.animActor.remove_all_transitions();
        if (this.bgActor)
            this.bgActor.remove_all_transitions();
        // Update the spring physics parameters
        // this._springScale.updateParams(this._settings.get_double("menu-spring-stiffness"), this._settings.get_double("menu-spring-damping"), this._settings.get_double("menu-spring-mass"));
        if (this._swiftAnimation) {
            this._swiftSpringScale.updateParams(this._swiftResponse, this._swiftDampingFraction);
            this._swiftSpringPos.updateParams(this._swiftResponse, this._swiftDampingFraction);
            this._swiftSpringScale.target = targetValue;
            this._swiftSpringPos.target = targetValue;
            // Safety check
            if (Number.isNaN(this._swiftSpringScale.value))
                this._swiftSpringScale.value = 0;
            if (Number.isNaN(this._swiftSpringPos.value))
                this._swiftSpringPos.value = 0;
            if (!isClosing) {
                // Stamp-in: start oversized, spring down to 1.0 while fading in.
                this._swiftSpringScale.value = this._menuOpenScale;
                this._swiftSpringScale.velocity = 0;
                this._swiftSpringPos.value = 0;
                this._swiftSpringPos.velocity = 0;
            }
        }
        else {
            this._springScale.target = targetValue;
            this._springPos.target = targetValue;
            if (!isClosing) {
                // Stamp-in: start oversized, spring down to 1.0 while fading in.
                this._springScale.value = this._menuOpenScale;
                this._springScale.velocity = 0;
                this._springPos.value = 0;
                this._springPos.velocity = 0;
            }
        }
        // Stamp-in pivots from the top-center so the popup appears to press down.
        // (Menu bubbles are clamped into the work area by GNOME, so a centered
        // pivot's outward expansion either fits or slips invisibly off-screen.)
        if (!isClosing && this.targetActor) {
            this.targetActor.set_pivot_point(0.5, 0.0);
            // The calendar popup is a boxpointer bubble with clip_to_allocation;
            // disable clipping while oversized so the stamp doesn't get cut off.
            this._disableClippingRecursively(this.targetActor);
        }
        // If an animation loop isn't already running, start a new one
        if (this._tickId === 0) {
            let lastTime = GLib.get_monotonic_time();
            this._isAnimating = true;
            let runTick = () => {
                if (!this.bgActor || !this.targetActor) {
                    this._tickId = 0;
                    this._isAnimating = false;
                    return GLib.SOURCE_REMOVE;
                }
                let currentTime = GLib.get_monotonic_time();
                let elapsedMs = (currentTime - lastTime) / 1000;
                lastTime = currentTime;
                let isClosing = this._swiftAnimation ? (this._swiftSpringScale.target === 0) : (this._springScale.target === 0);
                if (elapsedMs > 50)
                    elapsedMs = 50;
                if (elapsedMs < 4)
                    elapsedMs = 4;
                let stopped = false;
                let s, p;
                let physicsDt = 1000 / 80;
                if (isClosing) {
                    // Use a simple exponential decay for closing (faster, no bounce)
                    let speed = 15.0;
                    let dtSec = physicsDt / 1000;
                    if (this._swiftAnimation) {
                        this._swiftSpringScale.value += (0 - this._swiftSpringScale.value) * (1.0 - Math.exp(-speed * dtSec));
                        this._swiftSpringPos.value += (0 - this._swiftSpringPos.value) * (1.0 - Math.exp(-speed * dtSec));
                        s = this._swiftSpringScale.value;
                        p = this._swiftSpringPos.value;
                    }
                    else {
                        this._springScale.value += (0 - this._springScale.value) * (1.0 - Math.exp(-speed * dtSec));
                        this._springPos.value += (0 - this._springPos.value) * (1.0 - Math.exp(-speed * dtSec));
                        s = this._springScale.value;
                        p = this._springPos.value;
                    }
                    // Stop animation completely when it's virtually invisible
                    if (s < 0.005) {
                        s = 0;
                        p = 0;
                        stopped = true;
                    }
                }
                else {
                    // Use Hooke's law spring physics for opening (creates a nice bounce effect).
                    // Update BOTH springs every frame: `&&` between the two update() calls
                    // short-circuits, leaving the opacity spring stuck at 0 for the whole
                    // open (menu stays invisible until it pops in).
                    if (this._swiftAnimation) {
                        let sStop = this._swiftSpringScale.update(physicsDt);
                        let pStop = this._swiftSpringPos.update(physicsDt);
                        stopped = sStop && pStop;
                        s = this._swiftSpringScale.value;
                        p = this._swiftSpringPos.value;
                    }
                    else {
                        let sStop = this._springScale.update(physicsDt);
                        let pStop = this._springPos.update(physicsDt);
                        stopped = sStop && pStop;
                        s = this._springScale.value;
                        p = this._springPos.value;
                    }
                    // Magnet effect: Snap to exactly 1.0 when the bounce is almost settled.
                    if (Math.abs(1.0 - s) < 0.002 && Math.abs(this._swiftAnimation ? this._swiftSpringScale.velocity : this._springScale.velocity) < 0.03) {
                        s = 1.0;
                        p = 1.0;
                        stopped = true;
                    }
                }
                // Opening uses the scale spring for the stamp (oversized -> 1.0);
                // closing keeps the menu at full size while it fades out.
                let currentScale = isClosing ? 1.0 : Math.max(s, 0.9);
                let opacity = Math.min(255, Math.max(0, p * 255));
                // Apply the calculated scale to the UI
                this.targetActor.set_scale(currentScale, currentScale);
                if (this.effect && typeof this.effect.setAnimationScale === 'function') {
                    this.effect.setAnimationScale(currentScale);
                }
                if (typeof this._stampFrame === 'undefined')
                    this._stampFrame = 0;
                this._stampFrame++;
                if (this._stampFrame <= 3 || stopped) {
                    log(`[LG-STAMP] tick #${this._stampFrame} isClosing=${isClosing} s=${s.toFixed(4)} p=${p.toFixed(4)} scale=${currentScale.toFixed(4)} opacity=${opacity.toFixed(1)} stopped=${stopped}`);
                }
                /* Remove this code (do in _syncGeometry)
                // Dynamically adjust the shader's corner radius during the animation.
                if (this.effect && typeof this.effect.setCornerRadius === 'function') {
                  let baseRadius = this._settings.get_double('menu-corner-radius');
                  this.effect.setCornerRadius(baseRadius * currentScale);
                  if (typeof this.effect.setAnimationScale === 'function') {
                    this.effect.setAnimationScale(currentScale);
                  }
                }
                */
                this.bgActor.opacity = opacity;
                this.animActor.opacity = opacity;
                // Crucial step: Instantly update geometry right after scaling.
                this._syncGeometry();
                // Cleanup when animation finishes
                if (stopped) {
                    this._tickId = 0;
                    this._isAnimating = false;
                    if (isClosing && this.menu.actor) {
                        this.menu.actor.hide(); // Tell GNOME the menu is officially closed
                        // GNOME's BoxPointer.close onComplete was suppressed — emit 'menu-closed' now
                        let pendingCloseCb = this._pendingMenuClosedCallback;
                        this._pendingMenuClosedCallback = null;
                        pendingCloseCb?.();
                        this.bgActor.opacity = 0; // Ensure the background is fully transparent when closed
                        this.animActor.opacity = 0;
                        this.targetActor.set_pivot_point(0.0, 0.0);
                        this._restoreClippingRecursively(this.targetActor);
                    }
                    if (!isClosing) {
                        // Restore scale to exactly 1.0 to fix font hinting/blurriness issues
                        this.targetActor.set_scale(1.0, 1.0);
                        this.animActor.set_scale(1.0, 1.0);
                        this.animActor.opacity = 255;
                        this.bgActor.opacity = 255;
                        this._syncGeometry();
                        try {
                            let [sx, sy] = this.targetActor.get_transformed_position();
                            let [sw, sh] = this.targetActor.get_size();
                            let mon = Main.layoutManager.primaryMonitor;
                            log(`[LG-UI-SETTLED] pos=(${Math.round(sx)},${Math.round(sy)}) size=(${Math.round(sw)}x${Math.round(sh)}) mon=(${mon?.width}x${mon?.height})`);
                        }
                        catch (e) { }
                    }
                    return GLib.SOURCE_REMOVE;
                }
                this._tickId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, runTick);
                return GLib.SOURCE_REMOVE;
            };
            this._tickId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, runTick);
        }
    }
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        // Disconnect all event listeners
        for (let sig of this._signals) {
            try {
                if (sig && sig.id)
                    sig.target.disconnect(sig.id);
            }
            catch (e) { }
        }
        this._signals = [];
        if (this._tickId && this._tickId !== 0) {
            if (global.compositor?.get_laters) {
                global.compositor.get_laters().remove(this._tickId);
            }
            this._tickId = 0;
        }
        // Stop the render frame loop
        if (this._frameSyncId !== 0) {
            GLib.source_remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        if (this._interfaceSettings && this._accentColorSignalId) {
            this._interfaceSettings.disconnect(this._accentColorSignalId);
            this._accentColorSignalId = 0;
            this._interfaceSettings = null;
        }
        // Remove transparent CSS overrides
        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        if (this.animActor) {
            this.animActor.remove_style_class_name('liquid-glass-transparent');
            this.animActor.remove_style_class_name('liquid-glass-menu-root');
            this.animActor.remove_style_class_name('liquid-glass-menu-active');
            // Revert UI shifts and forced states
            this.animActor.translation_y = 0;
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.opacity = 255;
        }
        if (this._dynamicCssFile) {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const theme = themeContext.get_theme();
            theme.unload_stylesheet(this._dynamicCssFile);
            this._dynamicCssFile = null;
        }
        /*
        const messageList = Main.panel.statusArea.dateMenu._messageList;
        if (messageList && "actor" in messageList) {
            messageList.actor.remove_style_class_name('liquid-glass-message-list');
        }
        */
        // Revert UI shifts and forced states when extension is disabled
        this.targetActor.translation_y = 0;
        this.targetActor.set_scale(1.0, 1.0);
        this.targetActor.set_pivot_point(0.0, 0.0);
        this._restoreClippingRecursively(this.targetActor);
        this.targetActor.opacity = 255;
        if (this.menu.actor) {
            this.menu.actor.opacity = 255;
            // If the menu is currently open, forcefully close it 
            // without animations to reset GNOME's internal state
            if (this.menu.isOpen) {
                this.menu.close(false);
            }
        }
        // DESTROY EFFECT FIRST
        if (this.effect) {
            this.effect.cleanup();
            this.effect = null;
        }
        // DESTROY ACTOR SECOND
        if (this.bgActor) {
            this.bgActor.destroy();
            this.bgActor = null;
        }
        this.blurEffect = null;
        this.overviewCloneContainer = null;
        this.bgClone = null;
        this.windowClonesContainer = null;
        this._windowClones.clear();
        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
    }
    cleanup() {
        // Restore GNOME's original _boxPointer methods first so the forced
        // menu.close(false) inside _removeEffect runs through the original path.
        this._restorePopupAnimPatch?.();
        this._restorePopupAnimPatch = null;
        if (!this.targetActor) {
            this._pendingMenuClosedCallback = null;
            return;
        }
        this._removeEffect();
        // If torn down mid-fade-out, isOpen was already false so _removeEffect's
        // close(false) was skipped. The pending callback is dropped, not fired:
        // this close(false) re-emits 'menu-closed' through GNOME's original path
        // (the boxpointer is still visible) — firing both would double-emit.
        if (this._pendingMenuClosedCallback) {
            this._pendingMenuClosedCallback = null;
            try {
                this.menu?.close?.(false);
            }
            catch (e) { }
        }
    }
}
// A straightforward mathematical implementation of Hooke's Law for spring physics
class Spring {
    stiffness;
    damping;
    mass;
    value;
    velocity;
    target;
    constructor(stiffness, damping, mass) {
        this.stiffness = stiffness; // How rigid the spring is (higher = faster, more snappy)
        this.damping = damping; // Friction (higher = less bounce, settles quicker)
        this.mass = mass; // Weight of the object
        this.value = 0; // Current position/scale
        this.velocity = 0; // Current speed
        this.target = 0; // Destination value
    }
    updateParams(stiffness, damping, mass) {
        this.stiffness = stiffness; // How rigid the spring is (higher = faster, more snappy)
        this.damping = damping; // Friction (higher = less bounce, settles quicker)
        this.mass = mass; // Weight of the object
    }
    update(elapsedMs) {
        // Cap max delta time to prevent the spring from violently exploding during heavy CPU load
        let dt = elapsedMs / 1000;
        if (dt > 0.033)
            dt = 0.033;
        // F = -k * x
        let springForce = -this.stiffness * (this.value - this.target);
        // F = -c * v
        let dampingForce = -this.damping * this.velocity;
        // a = F / m
        let acceleration = (springForce + dampingForce) / this.mass;
        // Update velocity and position using Euler integration
        this.velocity += acceleration * dt;
        this.value += this.velocity * dt;
        // Return true if the spring has virtually stopped moving and reached its destination
        return Math.abs(this.velocity) < 0.01 && Math.abs(this.value - this.target) < 0.001;
    }
}
class SwiftSpring {
    response;
    dampingFraction;
    mass;
    value;
    velocity;
    target;
    constructor(response, dampingFraction, mass = 1.0) {
        // 徹底した型チェックとデフォルト値フォールバック
        this.response = typeof response === 'number' && !isNaN(response) && response > 0.01 ? response : 0.4;
        this.dampingFraction = typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0 ? dampingFraction : 0.7;
        this.mass = typeof mass === 'number' && !isNaN(mass) && mass > 0.01 ? mass : 1.0;
        this.value = 0;
        this.velocity = 0;
        this.target = 0;
    }
    updateParams(response, dampingFraction, mass = 1.0) {
        if (typeof response === 'number' && !isNaN(response) && response > 0.01)
            this.response = response;
        if (typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0)
            this.dampingFraction = dampingFraction;
        if (typeof mass === 'number' && !isNaN(mass) && mass > 0.01)
            this.mass = mass;
    }
    update(elapsedMs) {
        let dt = elapsedMs / 1000;
        if (isNaN(dt) || dt <= 0)
            return false;
        if (dt > 0.1)
            dt = 0.1; // ラグ時のカクつき防止（最大100ms制限）
        // 万が一、現在の状態がすでに NaN 等で壊れていた場合の緊急復帰
        if (isNaN(this.value) || !isFinite(this.value) || isNaN(this.velocity) || !isFinite(this.velocity)) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        const x0 = this.value - this.target;
        const v0 = this.velocity;
        // すでにターゲットに到達している場合は即座に終了
        if (Math.abs(x0) < 0.001 && Math.abs(v0) < 0.001) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        const omega0 = (2 * Math.PI) / this.response;
        const zeta = this.dampingFraction;
        let x_t = 0;
        let v_t = 0;
        // 数学的な解析解 (Analytical Solution) による1発計算
        // ループによる近似ではないため、バネがどれだけ硬くても絶対に数値爆発（無限大化）しません
        if (zeta < 0.999) {
            // 1. 不足減衰 (Underdamped) - ふわっと跳ねる標準的な動き
            const omegaD = omega0 * Math.sqrt(1.0 - zeta * zeta);
            const alpha = zeta * omega0;
            const exp = Math.exp(-alpha * dt);
            const cos = Math.cos(omegaD * dt);
            const sin = Math.sin(omegaD * dt);
            x_t = exp * (x0 * cos + ((v0 + alpha * x0) / omegaD) * sin);
            v_t = exp * (v0 * cos - ((alpha * v0 + omega0 * omega0 * x0) / omegaD) * sin);
        }
        else if (zeta > 1.001) {
            // 2. 過減衰 (Overdamped) - もっさり粘り気のある動き
            const beta = omega0 * Math.sqrt(zeta * zeta - 1.0);
            const gamma1 = -zeta * omega0 + beta;
            const gamma2 = -zeta * omega0 - beta;
            const exp1 = Math.exp(gamma1 * dt);
            const exp2 = Math.exp(gamma2 * dt);
            const c1 = (v0 - gamma2 * x0) / (gamma1 - gamma2);
            const c2 = x0 - c1;
            x_t = c1 * exp1 + c2 * exp2;
            v_t = c1 * gamma1 * exp1 + c2 * gamma2 * exp2;
        }
        else {
            // 3. 臨界減衰 (Critically damped) - 最速でピッタリ止まる動き
            const exp = Math.exp(-omega0 * dt);
            x_t = exp * (x0 + (v0 + omega0 * x0) * dt);
            v_t = exp * (v0 - omega0 * (v0 + omega0 * x0) * dt);
        }
        this.value = x_t + this.target;
        this.velocity = v_t;
        // 最終出力の安全確認（値を物理的な常識の範囲「-0.5 〜 2.5」に強制クランプ）
        if (isNaN(this.value) || !isFinite(this.value)) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        this.value = Math.max(-0.5, Math.min(2.5, this.value));
        // 停止判定
        if (Math.abs(this.value - this.target) < 0.001 && Math.abs(this.velocity) < 0.001) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        return false;
    }
}
