// src/quickSettingsManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import { LiquidEffect } from './liquidEffect.js';
import { BackdropBlurEffect } from './backdropBlur.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableClone, UnpickableActor, suppressGnomePopupAnimation, hasStyleClass, hexToRgb } from './utils.js';
import { CustomSubmenuRenderer } from './customSubmenu.js';
import { CustomQuickSettingsRenderer } from './customQuickSettings.js';
// ========== Configuration Parameters ==========
// Transparent padding outside the glass area. 
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;
const ENABLE_QS_CARD_SHADER = true;
const QS_CARD_SHADER_PADDING = 20;
// Whole-menu backdrop blur parameters. The Shell.BlurEffect provides the pure
// blur (radius comes from the quick-settings-blur-radius setting, shared with
// the card glass so the whole menu frosts evenly); the BackdropBlurEffect mask
// rounds the corners and feathers the edges so no hard rectangle is visible.
// PADDING is the horizontal/bottom padding around the menu (full-frost margin
// of 2px plus the 60px outward feather = 62px). The top padding is 0 so the
// blur never extends above the menu into the top panel; the shader keeps the
// mask flush with the overlay top and only fades the left/right/bottom edges.
const QS_BLUR_OVERLAY_PADDING = 62;
const QS_BLUR_OVERLAY_CORNER_RADIUS = 24;
const QS_BLUR_OVERLAY_FEATHER = 60;
// How much larger the glass background should be compared to the actual menu UI.
// const GLASS_EXPAND = 12;   
// Distance to shift the entire menu downwards to avoid overlapping with the top panel.
// const MENU_Y_OFFSET = GLASS_EXPAND + 5;  
// Adaptive text color flags
// const ENABLE_ADAPTIVE_TEXT_COLOR = false;
const SAMPLE_PER_ELEMENT = false;
// ==============================================
export class QuickSettingsManager {
    extensionPath;
    _settings;
    targetActor;
    menu;
    animActor;
    bgActor;
    blurEffect;
    effect;
    bgClone;
    _isEffectActive;
    windowClonesContainer;
    fboContainer;
    overviewCloneContainer;
    _windowClones;
    _overviewClone;
    _appDisplayClone;
    _searchClone;
    buttonAlpha;
    _buttonTimerId;
    _styledButtons;
    _buttonSignalIds;
    _drilldownSignalIds;
    _cardActors;
    _cardBackings;
    _cardBackingSyncId;
    _cardBackingLastSignature;
    _cardBackingStableFrames;
    _cardBackingIdleMode;
    _hiddenMenuParts;
    _signals;
    _animSignalId = 0;
    _frameSyncId;
    _glassExpand;
    _menuXoffset;
    _menuYoffset;
    // Spring physics parameters
    _springScale;
    _springPos;
    _springStiffness;
    _springDamping;
    _springMass;
    _enableAnimation;
    _tickId;
    _isAnimating = false;
    _contrastSampler;
    _adaptiveTimerId;
    _adaptiveInFlight;
    _styledActors;
    _settingsSignals;
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
    _cornerRadius = 0;
    _animationInterval = 16;
    _openScale = 1.08;
    _originalTargetClip;
    _originalAnimClip;
    _originalFirstChildClip;
    _disabledClipActors = new Map();
    _floatingWindow = null;
    _submenuRenderer = null;
    _customQuickSettings = null;
    _suppressNextOpenAnimation = false;
    _suppressNextCloseAnimation = false;
    _isSubmenuTransitioning = false;
    _pendingMenuClosedCallback = null;
    _restorePopupAnimPatch = null;
    _cardBackingsFrozen = false;
    _cardBackingSnapshots = new Map();
    // The actor the stamp animation actually scales. For Quick Settings this is
    // NOT menu.actor: QuickSettingsMenu overrides menu.actor to a 0x0 wrapper
    // (quickSettings.js) with the real popup (menu._boxPointer) as its child, so
    // scaling menu.actor pivots around stage (0,0). Scaling the boxpointer gives
    // real geometry and a real pivot.
    _stampActor = null;
    // Fullscreen background blur overlay that fades in/out with the QS menu animation
    _qsBlurOverlay = null;
    _qsBlurOverlayEffect = null;
    // Feathered rounded-corner mask chained after _qsBlurOverlayEffect so the
    // blur blends smoothly into the desktop instead of a hard rectangle.
    _qsBlurMask = null;
    // Clone-based blur pipeline for the overlay (mirrors the card backings):
    // clipBox -> fboContainer with an ACTOR-mode blur + desktop/window clones.
    _qsBlurClipBox = null;
    _qsBlurFboContainer = null;
    _qsBlurBgClone = null;
    _qsBlurWindowClonesContainer = null;
    _qsBlurWindowClones = new Map();
    constructor(extensionPath, settings) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        // Target the main container of the Date/Calendar menu
        this.targetActor = Main.panel.statusArea.quickSettings.menu.actor;
        this.menu = Main.panel.statusArea.quickSettings.menu;
        // Target for animations and visual offsets (The inner content)
        this.animActor = Main.panel.statusArea.quickSettings.menu.box;
        // The real popup bubble for QS (menu.actor is a 0x0 wrapper around it).
        this._stampActor = this.menu._boxPointer ?? this.targetActor;
        this.bgActor = null;
        this.blurEffect = null;
        this.effect = null;
        this.bgClone = null;
        this.windowClonesContainer = null;
        this.fboContainer = null;
        // Map to keep track of active windows and their corresponding clone actors.
        this._windowClones = new Map();
        this._signals = [];
        this._frameSyncId = 0;
        this._isEffectActive = false;
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
        this._enableAnimation = true;
        this._tickId = 0;
        this._contrastSampler = new StageContrastSampler();
        this._adaptiveTimerId = 0;
        this._adaptiveInFlight = false;
        this._styledActors = new Map();
        this._settingsSignals = [];
        this._isEffectActive = false;
        this.overviewCloneContainer = null;
        this._overviewClone = null;
        this._appDisplayClone = null;
        this._searchClone = null;
        this.buttonAlpha = 0.8;
        this._buttonTimerId = 0;
        this._styledButtons = new Map();
        this._buttonSignalIds = new Map();
        this._drilldownSignalIds = new Map();
        this._cardActors = new Set();
        this._cardBackings = new Map();
        this._cardBackingSyncId = 0;
        this._cardBackingLastSignature = '';
        this._cardBackingStableFrames = 0;
        this._cardBackingIdleMode = false;
        this._hiddenMenuParts = new Map();
        this._disabledClipActors = new Map();
        this._floatingWindow = null;
        this._suppressNextOpenAnimation = false;
        this._suppressNextCloseAnimation = false;
        this._isSubmenuTransitioning = false;
        // Suppress GNOME's own _boxPointer open/close animation so it can't
        // composite over (or hard-cut) our custom fade. No bgActor check here:
        // QS's runTick doesn't require it, and _isEffectActive covers the
        // glass-off state (the open-state-changed handler is only connected
        // while the effect is active). Arrow functions evaluate lazily.
        this._restorePopupAnimPatch = suppressGnomePopupAnimation(this.menu, {
            isCustomAnimationEnabled: () => this._enableAnimation && this._isEffectActive,
            onSuppressOpen: () => { this._pendingMenuClosedCallback = null; },
            onSuppressClose: (cb) => { this._pendingMenuClosedCallback = cb; },
        });
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        this._enableAnimation = this._settings.get_boolean('enable-quick-settings-animation');
        this._springStiffness = this._settings.get_double('quick-settings-spring-stiffness');
        this._springDamping = this._settings.get_double('quick-settings-spring-damping');
        this._springMass = this._settings.get_double('quick-settings-spring-mass');
        this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        this._springPos.updateParams(this._springStiffness, this._springDamping, this._springMass);
        this._openScale = Math.max(1.0, this._settings.get_double('quick-settings-open-scale'));
        if (this._settings.get_boolean('enable-quick-settings-glass')) {
            this._applyEffect();
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
        let monitorIndex = Main.layoutManager.findIndexForActor(this._stampActor ?? this.targetActor);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        return Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
    }
    _applyMenuOffsets() {
        if (!this.animActor)
            return;
        this.animActor.translation_y = this._menuYoffset;
        this.animActor.translation_x = this._menuXoffset;
    }
    // 追加: 設定の動的反映
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        // ON/OFF切り替え
        connectSetting('enable-quick-settings-glass', () => {
            let enabled = this._settings.get_boolean('enable-quick-settings-glass');
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting('enable-quick-settings-animation', () => {
            this._enableAnimation = this._settings.get_boolean('enable-quick-settings-animation');
        });
        connectSetting('quick-settings-spring-stiffness', () => {
            this._springStiffness = this._settings.get_double('quick-settings-spring-stiffness');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('quick-settings-spring-damping', () => {
            this._springDamping = this._settings.get_double('quick-settings-spring-damping');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('quick-settings-spring-mass', () => {
            this._springMass = this._settings.get_double('quick-settings-spring-mass');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('quick-settings-animation-interval-ms', () => {
            this._animationInterval = this._settings.get_int('quick-settings-animation-interval-ms');
        });
        connectSetting('quick-settings-open-scale', () => {
            this._openScale = Math.max(1.0, this._settings.get_double('quick-settings-open-scale'));
        });
        connectSetting('quick-settings-tint-color', () => {
            if (this.effect) {
                let colorArray = this._hexToColorArray(this._settings.get_string('quick-settings-tint-color'));
                this.effect.setTintColor(...colorArray);
            }
        });
        connectSetting('quick-settings-tint-strength', () => {
            let tintStrength = this._settings.get_double('quick-settings-tint-strength');
            if (this.effect) {
                this.effect.setTintStrength(tintStrength);
            }
            this._cardBackings.forEach((backing) => {
                if (backing && backing._liquidGlassCardEffect) {
                    backing._liquidGlassCardEffect.setTintStrength(tintStrength);
                }
            });
        });
        connectSetting('quick-settings-blur-radius', () => {
            let blurRadius = this._settings.get_int('quick-settings-blur-radius');
            if (this.blurEffect) {
                this.blurEffect.radius = blurRadius;
            }
            if (this._qsBlurOverlayEffect) {
                this._qsBlurOverlayEffect.radius = blurRadius;
            }
            this._cardBackings.forEach((backing) => {
                if (backing && backing._liquidGlassCardBlur) {
                    backing._liquidGlassCardBlur.radius = blurRadius;
                }
            });
        });
        connectSetting('quick-settings-corner-radius', () => {
            if (this.effect) {
                this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');
                this.effect.setCornerRadius(this._cornerRadius);
            }
        });
        connectSetting('quick-settings-glass-expand', () => {
            if (this.effect) {
                this._glassExpand = this._settings.get_int('quick-settings-glass-expand');
            }
        });
        connectSetting('quick-settings-y-offset', () => {
            if (this.targetActor) {
                this._menuYoffset = this._settings.get_int('quick-settings-y-offset');
                this._applyMenuOffsets();
            }
        });
        connectSetting('quick-settings-x-offset', () => {
            if (this.targetActor) {
                this._menuXoffset = this._settings.get_int('quick-settings-x-offset');
                this._applyMenuOffsets();
            }
        });
        connectSetting('quick-settings-enable-adaptive-text-color', () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean('quick-settings-enable-adaptive-text-color');
        });
        connectSetting('quick-settings-sample-interval-ms', () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('quick-settings-sample-interval-ms');
        });
    }
    _applyClassStyles() {
        if (!this.targetActor)
            return;
        if (!hasStyleClass(this.targetActor, 'liquid-glass-transparent'))
            this.targetActor.add_style_class_name('liquid-glass-transparent');
        if (!hasStyleClass(this.animActor, 'liquid-glass-transparent'))
            this.animActor.add_style_class_name('liquid-glass-transparent');
        if (!hasStyleClass(this.animActor, 'liquid-glass-qs-root'))
            this.animActor.add_style_class_name('liquid-glass-qs-root');
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
    _connectSubmenuClipping() {
        let grid = this.menu._grid;
        if (grid) {
            let children = grid.get_children();
            for (let child of children) {
                if (child && child.menu && typeof child.menu.connect === 'function') {
                    let signalId = child.menu.connect('open-state-changed', (menu, isOpen) => {
                        if (isOpen) {
                            this._disableClippingRecursively(this.targetActor);
                            // Delay sweeps to catch asynchronous elements inside the submenu
                            for (let delay of [50, 150, 300, 600]) {
                                GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                                    if (this._isEffectActive && this.menu.isOpen) {
                                        this._disableClippingRecursively(this.targetActor);
                                    }
                                    return GLib.SOURCE_REMOVE;
                                });
                            }
                        }
                    });
                    this._signals.push({ target: child.menu, id: signalId });
                }
            }
        }
    }
    _getOrCreateCardBacking(card) {
        let backing = this._cardBackings.get(card);
        if (backing && backing.get_parent())
            return backing;
        let parent = this.menu?.actor?.get_parent?.() || Main.layoutManager.uiGroup;
        if (!parent)
            return null;
        backing = new St.Widget({
            style_class: 'liquid-glass-card-backing',
            reactive: false,
            clip_to_allocation: false,
        });
        backing.set_size(2, 2);
        backing.opacity = 0;
        backing.hide();
        if (!ENABLE_QS_CARD_SHADER)
            try {
                let blurRadius = this._settings.get_int('quick-settings-blur-radius');
                let blur = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.BACKGROUND });
                backing.add_effect_with_name('liquid-glass-card-blur', blur);
                backing._liquidGlassCardBlur = blur;
            }
            catch (e) { }
        if (ENABLE_QS_CARD_SHADER)
            try {
                let clipBox = new St.Widget({ clip_to_allocation: true, reactive: false });
                clipBox.set_size(2, 2);
                backing.add_child(clipBox);
                let fboContainer = new UnpickableActor();
                fboContainer.set_size(2, 2);
                clipBox.add_child(fboContainer);
                let bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
                fboContainer.add_child(bgClone);
                let windowClonesContainer = new UnpickableActor();
                fboContainer.add_child(windowClonesContainer);
                let blurRadius = this._settings.get_int('quick-settings-blur-radius');
                let blur = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
                fboContainer.add_effect(blur);
                backing._liquidGlassClipBox = clipBox;
                backing._liquidGlassFboContainer = fboContainer;
                backing._liquidGlassBgClone = bgClone;
                backing._liquidGlassWindowClonesContainer = windowClonesContainer;
                backing._liquidGlassWindowClones = new Map();
                backing._liquidGlassCardBlur = blur;
            }
            catch (e) { }
        if (ENABLE_QS_CARD_SHADER)
            try {
                let liquid = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
                liquid.setPadding(QS_CARD_SHADER_PADDING);
                liquid.setTintColor(1.0, 1.0, 1.0);
                let tintStrength = this._settings.get_double('quick-settings-tint-strength');
                liquid.setTintStrength(tintStrength);
                liquid.setIsDock(false);
                backing.add_effect_with_name('liquid-glass-card-backing-effect', liquid);
                backing._liquidGlassCardEffect = liquid;
            }
            catch (e) { }
        try {
            parent.insert_child_below(backing, this.menu.actor);
        }
        catch (e) {
            try {
                parent.add_child(backing);
            }
            catch (e2) { }
        }
        backing.connect('destroy', () => {
            this._cardBackings.delete(card);
        });
        this._cardBackings.set(card, backing);
        return backing;
    }
    _removeCardBacking(card) {
        let backing = this._cardBackings.get(card);
        if (!backing)
            return;
        try {
            let effect = backing.get_effect('liquid-glass-card-backing-effect');
            if (effect && typeof effect.cleanup === 'function')
                effect.cleanup();
        }
        catch (e) { }
        try {
            backing.destroy();
        }
        catch (e) { }
        this._cardBackings.delete(card);
    }
    _setCardBackingsOpacity(opacity) {
        for (let backing of this._cardBackings.values()) {
            try {
                backing.opacity = opacity;
                if (opacity <= 0)
                    backing.hide();
            }
            catch (e) { }
        }
    }
    _syncBackingWindowClones(backing, stageX, stageY, windowActors) {
        let container = backing._liquidGlassWindowClonesContainer;
        let cloneMap = backing._liquidGlassWindowClones;
        if (!container || !cloneMap)
            return;
        try {
            container.remove_all_transitions();
            container.set_position(-stageX, -stageY);
            container.set_scale(1.0, 1.0);
            let activeWindows = new Set();
            let zIndex = 0;
            for (let windowActor of windowActors) {
                let metaWindow = windowActor.get_meta_window?.();
                if (!metaWindow || metaWindow.minimized || !windowActor.visible)
                    continue;
                activeWindows.add(windowActor);
                let clone = cloneMap.get(windowActor);
                if (!clone) {
                    clone = new UnpickableClone({ source: windowActor });
                    container.add_child(clone);
                    cloneMap.set(windowActor, clone);
                }
                clone.remove_all_transitions();
                clone.set_position(windowActor.x, windowActor.y);
                clone.set_size(windowActor.width, windowActor.height);
                clone.set_scale(windowActor.scale_x, windowActor.scale_y);
                clone.translation_x = windowActor.translation_x;
                clone.translation_y = windowActor.translation_y;
                try {
                    container.set_child_at_index(clone, zIndex);
                }
                catch (e) { }
                zIndex++;
            }
            for (let [windowActor, clone] of Array.from(cloneMap.entries())) {
                if (!activeWindows.has(windowActor)) {
                    try {
                        clone.destroy();
                    }
                    catch (e) { }
                    cloneMap.delete(windowActor);
                }
            }
        }
        catch (e) { }
    }
    _syncCardBackings(skipWindowClones = false) {
        if (!this.menu?.actor?.mapped && !this._isAnimating)
            return;
        let windowActors = global.get_window_actors();
        let parent = this.menu?.actor?.get_parent?.() || Main.layoutManager.uiGroup;
        for (let card of Array.from(this._cardActors)) {
            let stCard = card;
            let backing = this._getOrCreateCardBacking(card);
            if (!backing)
                continue;
            try {
                if (backing.get_parent() !== parent) {
                    backing.get_parent()?.remove_child(backing);
                    parent.insert_child_below(backing, this.menu.actor);
                }
            }
            catch (e) { }
            try {
                let [x, y] = card.get_transformed_position();
                let [w, h] = card.get_size();
                // While the spring open animation is running, the backing geometry is
                // frozen at the layout that was captured once the menu settled. This
                // masks transient reflows (native menu parts being collapsed) and any
                // brief non-identity ancestor scale so the glass never visibly shrinks
                // mid-fade. Live geometry takes over again once the animation ends.
                let snapshot = this._cardBackingsFrozen
                    ? this._cardBackingSnapshots.get(card)
                    : null;
                if (snapshot) {
                    x = snapshot.x;
                    y = snapshot.y;
                    w = snapshot.w;
                    h = snapshot.h;
                }
                if (!card.visible || !card.mapped ||
                    Number.isNaN(x) || Number.isNaN(y) ||
                    Number.isNaN(w) || Number.isNaN(h) ||
                    w <= 2 || h <= 2) {
                    backing.hide();
                    continue;
                }
                backing.show();
                // Calculate the true effective opacity by synchronously multiplying up the actor tree
                let effectiveOpacity = 255;
                if (typeof card.get_paint_opacity === 'function') {
                    effectiveOpacity = card.get_paint_opacity();
                }
                else {
                    let curr = card;
                    while (curr && curr !== parent) {
                        effectiveOpacity = (effectiveOpacity * curr.opacity) / 255;
                        curr = curr.get_parent();
                    }
                }
                backing.remove_all_transitions();
                let effectiveScale = 1.0;
                let currScale = card;
                while (currScale && currScale !== parent) {
                    effectiveScale *= currScale.scale_x;
                    currScale = currScale.get_parent();
                }
                // Frozen geometry pins the backing to the settled size/scale, so any
                // transient ancestor scale during the fade can't shrink the glass.
                if (this._cardBackingsFrozen && snapshot) {
                    effectiveScale = snapshot.effectiveScale;
                }
                let unscaledX = x;
                let unscaledY = y;
                let trackingScale = 1.0;
                // Stamp open animation: the whole popup is scaled about the boxpointer's
                // pivot. Track it — render each backing at the card's transformed
                // (scaled) position and scaled size so the liquid stays glued to the
                // content exactly like the calendar's bgActor. (Pinning the glass to the
                // settled layout instead made content visibly slide over static glass.)
                if (this._isAnimating && effectiveScale > 0.001 && Math.abs(effectiveScale - 1) > 0.001) {
                    trackingScale = effectiveScale;
                }
                else if (!this._isAnimating && effectiveScale > 0.001 && effectiveScale < 0.999 && this.animActor) {
                    let [animX, animY] = this.animActor.get_transformed_position();
                    let [animW, animH] = this.animActor.get_size();
                    let pivotX = animX + this.animActor.pivot_point.x * animW * this.animActor.scale_x;
                    let pivotY = animY + this.animActor.pivot_point.y * animH * this.animActor.scale_y;
                    unscaledX = pivotX + (x - pivotX) / effectiveScale;
                    unscaledY = pivotY + (y - pivotY) / effectiveScale;
                }
                let backingX = unscaledX;
                let backingY = unscaledY;
                try {
                    if (parent) {
                        let success, transformed;
                        if (typeof parent.apply_relative_transform_to_point === 'function') {
                            [success, transformed] = parent.apply_relative_transform_to_point(null, new Clutter.Point({ x: unscaledX, y: unscaledY }));
                        }
                        else {
                            [success, transformed] = parent.transform_stage_point(unscaledX, unscaledY);
                        }
                        if (success && transformed) {
                            if (typeof transformed.x === 'number') {
                                backingX = transformed.x;
                                backingY = transformed.y;
                            }
                            else if (transformed.length === 2) {
                                backingX = transformed[0];
                                backingY = transformed[1];
                            }
                        }
                    }
                }
                catch (e) { }
                let unscaledW = w * trackingScale;
                let unscaledH = h * trackingScale;
                // Force square backing for circle-classified cards to guarantee circular glass.
                // If the grid allocates a non-square cell (e.g. 67×74), the shader would render
                // an oval even with border-radius:999px. Clamping to Math.min(w,h) fixes this.
                if (stCard.has_style_class_name?.('liquid-glass-card-circle')) {
                    const side = Math.min(unscaledW, unscaledH);
                    unscaledW = side;
                    unscaledH = side;
                }
                let sourceStageX = unscaledX;
                let sourceStageY = unscaledY;
                if (ENABLE_QS_CARD_SHADER) {
                    backingX -= QS_CARD_SHADER_PADDING * effectiveScale;
                    backingY -= QS_CARD_SHADER_PADDING * effectiveScale;
                    unscaledW += QS_CARD_SHADER_PADDING * 2;
                    unscaledH += QS_CARD_SHADER_PADDING * 2;
                    sourceStageX -= QS_CARD_SHADER_PADDING;
                    sourceStageY -= QS_CARD_SHADER_PADDING;
                }
                backing.remove_all_transitions();
                backing.opacity = Math.round(effectiveOpacity);
                backing.set_position(backingX, backingY);
                backing.set_size(unscaledW, unscaledH);
                backing.set_scale(effectiveScale / trackingScale, effectiveScale / trackingScale);
                let clipBox = backing._liquidGlassClipBox;
                let fboContainer = backing._liquidGlassFboContainer;
                let bgClone = backing._liquidGlassBgClone;
                if (ENABLE_QS_CARD_SHADER && clipBox && fboContainer && bgClone) {
                    clipBox.remove_all_transitions();
                    clipBox.set_position(0, 0);
                    clipBox.set_size(unscaledW, unscaledH);
                    fboContainer.remove_all_transitions();
                    fboContainer.set_scale(1.0, 1.0);
                    fboContainer.set_position(0, 0);
                    fboContainer.set_size(unscaledW, unscaledH);
                    bgClone.remove_all_transitions();
                    bgClone.set_scale(1.0, 1.0);
                    bgClone.set_position(-sourceStageX, -sourceStageY);
                    bgClone.show();
                    // During the spring fade the backing clones were already built on the
                    // pre-animation sync pass; skip the per-card window-clone rebuild each
                    // tick (content is effectively static for the ~300ms the fade runs).
                    if (!skipWindowClones) {
                        this._syncBackingWindowClones(backing, sourceStageX, sourceStageY, windowActors);
                    }
                }
                let stBacking = backing;
                for (let className of [
                    'liquid-glass-card-toggle',
                    'liquid-glass-card-slider',
                    'liquid-glass-card-circle',
                    'liquid-glass-card-squircle',
                    'liquid-glass-card-pill',
                    'liquid-glass-card-rect',
                    'liquid-glass-card-compact',
                ]) {
                    if (stCard.has_style_class_name?.(className)) {
                        stBacking.add_style_class_name?.(className);
                    }
                    else {
                        stBacking.remove_style_class_name?.(className);
                    }
                }
                let effect = backing.get_effect('liquid-glass-card-backing-effect');
                if (ENABLE_QS_CARD_SHADER && effect) {
                    // Dirty-check the resolution so we don't upload GL uniforms on every
                    // animation tick for cards whose size hasn't changed.
                    let lastW = effect._liquidLastResW;
                    let lastH = effect._liquidLastResH;
                    if (lastW !== unscaledW || lastH !== unscaledH) {
                        effect._liquidLastResW = unscaledW;
                        effect._liquidLastResH = unscaledH;
                        effect.setResolution(unscaledW, unscaledH);
                    }
                    let isChecked = false;
                    try {
                        if (stCard.checked === true)
                            isChecked = true;
                    }
                    catch (e) { }
                    try {
                        if (stCard.has_style_pseudo_class && stCard.has_style_pseudo_class('checked'))
                            isChecked = true;
                    }
                    catch (e) { }
                    try {
                        if (stCard.has_style_class_name?.('checked'))
                            isChecked = true;
                    }
                    catch (e) { }
                    if (isChecked) {
                        // Apply GNOME Blue tint internally via the glass shader
                        effect.setTintColor(53 / 255, 132 / 255, 228 / 255);
                        effect.setTintStrength(0.35);
                    }
                    else {
                        // Revert to global tint settings when unchecked
                        effect.setTintColor(1.0, 1.0, 1.0);
                        let globalStrength = 0;
                        try {
                            globalStrength = this._settings.get_double('quick-settings-tint-strength');
                        }
                        catch (e) { }
                        effect.setTintStrength(globalStrength);
                    }
                    if (stCard.has_style_class_name?.('liquid-glass-card-circle') || stCard.has_style_class_name?.('liquid-glass-card-pill')) {
                        effect.setCornerRadius(Math.min(w, h) / 2);
                    }
                    else if (stCard.has_style_class_name?.('liquid-glass-card-squircle')) {
                        effect.setCornerRadius(Math.round(Math.min(w, h) * 0.46));
                    }
                    else {
                        effect.setCornerRadius(18);
                    }
                }
            }
            catch (e) {
                try {
                    backing.hide();
                }
                catch (e2) { }
            }
        }
    }
    getSubmenuMorphBounds(card) {
        try {
            if (!card)
                return null;
            this._syncCardBackings();
            let backing = this._cardBackings.get(card);
            let source = backing && backing.get_parent?.() ? backing : card;
            let [x, y] = source.get_transformed_position();
            let [w, h] = source.get_size();
            let scaleX = typeof source.scale_x === 'number' ? source.scale_x : 1.0;
            let scaleY = typeof source.scale_y === 'number' ? source.scale_y : 1.0;
            w *= scaleX;
            h *= scaleY;
            if (Number.isNaN(x) || Number.isNaN(y) ||
                Number.isNaN(w) || Number.isNaN(h) ||
                w <= 2 || h <= 2)
                return null;
            return { x, y, w, h, centerX: x + w / 2, centerY: y + h / 2 };
        }
        catch (e) {
            return null;
        }
    }
    _getCardBackingSignature() {
        let parts = [];
        try {
            for (let card of Array.from(this._cardActors)) {
                let [x, y] = card.get_transformed_position();
                let [w, h] = card.get_size();
                parts.push([
                    Math.round(x),
                    Math.round(y),
                    Math.round(w),
                    Math.round(h),
                    Math.round(card.opacity),
                    card.visible ? 1 : 0,
                    card.mapped ? 1 : 0,
                    Math.round(card.scale_x * 1000),
                    Math.round(card.scale_y * 1000),
                ].join(','));
            }
            for (let windowActor of global.get_window_actors()) {
                let metaWindow = windowActor.get_meta_window?.();
                if (!metaWindow || metaWindow.minimized || !windowActor.visible)
                    continue;
                parts.push([
                    'w',
                    Math.round(windowActor.x),
                    Math.round(windowActor.y),
                    Math.round(windowActor.width),
                    Math.round(windowActor.height),
                    Math.round(windowActor.scale_x * 1000),
                    Math.round(windowActor.scale_y * 1000),
                    Math.round(windowActor.translation_x),
                    Math.round(windowActor.translation_y),
                ].join(','));
            }
        }
        catch (e) { }
        return parts.join('|');
    }
    _wakeCardBackingSync() {
        this._cardBackingIdleMode = false;
        if (this._cardBackingSyncId !== 0) {
            this._syncCardBackings();
            this._cardBackingLastSignature = this._getCardBackingSignature();
            return;
        }
        this._startCardBackingSync();
    }
    _startCardBackingSync() {
        if (this._cardBackingSyncId !== 0)
            return;
        this._cardBackingIdleMode = false;
        this._cardBackingStableFrames = 0;
        this._cardBackingLastSignature = '';
        let lastSyncTime = 0;
        const activeIntervalUs = 16_000;
        const idleIntervalUs = 750_000;
        let syncTick = () => {
            if (!this.menu?.actor?.mapped && !this._isAnimating) {
                this._cardBackingSyncId = 0;
                return GLib.SOURCE_REMOVE;
            }
            // During animation, the animation loop handles card sync directly via frozen positions.
            // Skip the independent sync timer to avoid competing work and save CPU.
            if (this._isAnimating) {
                return GLib.SOURCE_CONTINUE;
            }
            let now = GLib.get_monotonic_time();
            let intervalUs = this._cardBackingIdleMode ? idleIntervalUs : activeIntervalUs;
            if (lastSyncTime !== 0 && now - lastSyncTime < intervalUs) {
                return GLib.SOURCE_CONTINUE;
            }
            lastSyncTime = now;
            this._syncCardBackings();
            let signature = this._getCardBackingSignature();
            if (signature === this._cardBackingLastSignature) {
                this._cardBackingStableFrames++;
                if (this._cardBackingStableFrames >= 8) {
                    this._cardBackingIdleMode = true;
                }
            }
            else {
                this._cardBackingStableFrames = 0;
                this._cardBackingIdleMode = false;
                this._cardBackingLastSignature = signature;
            }
            return GLib.SOURCE_CONTINUE;
        };
        this._syncCardBackings();
        this._cardBackingLastSignature = this._getCardBackingSignature();
        this._cardBackingSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, syncTick);
    }
    _stopCardBackingSync() {
        if (this._cardBackingSyncId !== 0) {
            GLib.source_remove(this._cardBackingSyncId);
            this._cardBackingSyncId = 0;
        }
        this._cardBackingIdleMode = false;
        this._cardBackingStableFrames = 0;
        this._cardBackingLastSignature = '';
        this._unfreezeCardBackings();
    }
    // Snapshot each card's size/position/scale once the opened menu has settled
    // so _syncCardBackings can render stable glass during the spring fade.
    _captureCardBackingGeometry() {
        if (!this.menu?.actor?.mapped)
            return false;
        let parent = this.menu?.actor?.get_parent?.() || Main.layoutManager.uiGroup;
        let snapshot = new Map();
        let validCount = 0;
        for (let card of Array.from(this._cardActors)) {
            try {
                let [x, y] = card.get_transformed_position();
                let [w, h] = card.get_size();
                if (!card.visible || !card.mapped ||
                    Number.isNaN(x) || Number.isNaN(y) ||
                    Number.isNaN(w) || Number.isNaN(h) ||
                    w <= 2 || h <= 2)
                    continue;
                let effectiveScale = 1.0;
                let currScale = card;
                while (currScale && currScale !== parent) {
                    effectiveScale *= currScale.scale_x;
                    currScale = currScale.get_parent();
                }
                snapshot.set(card, { x, y, w, h, effectiveScale });
                validCount++;
            }
            catch (e) { }
        }
        if (validCount === 0)
            return false;
        this._cardBackingSnapshots = snapshot;
        this._cardBackingsFrozen = true;
        this._syncCardBackings();
        return true;
    }
    _unfreezeCardBackings() {
        this._cardBackingsFrozen = false;
        this._cardBackingSnapshots.clear();
    }
    // Defer the freeze a couple of BEFORE_REDRAW passes so the initial reflow
    // (native menu parts collapsed to 0x0, custom arrows, label constraints)
    // finishes before the backing geometry is pinned down.
    _scheduleCardBackingFreeze() {
        this._unfreezeCardBackings();
        let addLater = (callback) => {
            try {
                if (global.compositor?.get_laters)
                    return global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, callback);
            }
            catch (e) { }
            return GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, callback);
        };
        let capture = () => {
            if (this._isEffectActive && this._isAnimating && this.menu?.actor?.mapped)
                this._captureCardBackingGeometry();
            return GLib.SOURCE_REMOVE;
        };
        // Frame 1: layout applies the compact reflow. Frame 2: capture + freeze.
        let first = () => {
            addLater(capture);
            return GLib.SOURCE_REMOVE;
        };
        addLater(first);
    }
    _disconnectDrilldown(card) {
        let signalItems = this._drilldownSignalIds.get(card);
        if (signalItems) {
            for (let item of signalItems) {
                try {
                    item.target.disconnect(item.id);
                }
                catch (e) { }
            }
            this._drilldownSignalIds.delete(card);
        }
        let stCard = card;
        delete stCard._liquidGlassDrilldownConnected;
    }
    _showMenuToggleContent(card) {
        let stCard = card;
        for (let actor of [stCard._customToggle, stCard.button, stCard._box]) {
            try {
                if (actor) {
                    actor.visible = true;
                    actor.opacity = 255;
                    actor.show?.();
                }
            }
            catch (e) { }
        }
        this._hideNativeMenuPart(stCard._separator);
        this._hideNativeMenuPart(stCard._menuButton || stCard._arrow || stCard._menuButtonActor);
        stCard.add_style_class_name?.('liquid-glass-menu-toggle-has-arrow');
        this._prepareMenuToggleLabels(card);
        this._ensureCustomMenuArrow(card);
    }
    _prepareMenuToggleLabels(card) {
        let labels = [];
        let visit = (actor) => {
            if (!actor)
                return;
            if (actor instanceof St.Label || actor.constructor?.name === 'St_Label') {
                labels.push(actor);
                return;
            }
            for (let child of actor.get_children?.() || [])
                visit(child);
        };
        visit(card);
        for (let label of labels) {
            try {
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                label.clutter_text.line_wrap = false;
                label.x_expand = false;
            }
            catch (e) { }
        }
    }
    _ensureCustomMenuArrow(card) {
        let stCard = card;
        if (stCard._liquidGlassCustomArrow)
            return;
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
        let positionArrow = () => {
            try {
                let [w, h] = card.get_size();
                let x = Math.max(0, Math.round(w - 30));
                let y = Math.max(0, Math.round((h - 22) / 2));
                arrow.set_position(x, y);
            }
            catch (e) { }
        };
        try {
            card.add_child?.(arrow);
            positionArrow();
        }
        catch (e) {
            try {
                arrow.destroy();
            }
            catch (e2) { }
            return;
        }
        let fadeArrow = (visible) => {
            try {
                arrow.ease({
                    opacity: visible ? 255 : 0,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            catch (e) {
                arrow.opacity = visible ? 255 : 0;
            }
            for (let actor of [stCard._customToggle, stCard.button, stCard._box]) {
                if (!actor || actor === arrow)
                    continue;
                try {
                    actor.ease({
                        opacity: visible ? 170 : 255,
                        duration: 120,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
                catch (e) {
                    try {
                        actor.opacity = visible ? 170 : 255;
                    }
                    catch (e2) { }
                }
            }
            return Clutter.EVENT_PROPAGATE;
        };
        stCard._liquidGlassCustomArrow = arrow;
        stCard._liquidGlassCustomArrowAllocationId = card.connect('notify::allocation', positionArrow);
        stCard._liquidGlassCustomArrowHoverSignals = [
            card.connect('enter-event', () => fadeArrow(true)),
            card.connect('leave-event', () => fadeArrow(false)),
        ];
    }
    _removeCustomMenuArrow(card) {
        let stCard = card;
        if (stCard._liquidGlassCustomArrowHoverSignals) {
            for (let id of stCard._liquidGlassCustomArrowHoverSignals) {
                try {
                    card.disconnect(id);
                }
                catch (e) { }
            }
            delete stCard._liquidGlassCustomArrowHoverSignals;
        }
        if (stCard._liquidGlassCustomArrowAllocationId) {
            try {
                card.disconnect(stCard._liquidGlassCustomArrowAllocationId);
            }
            catch (e) { }
            delete stCard._liquidGlassCustomArrowAllocationId;
        }
        if (stCard._liquidGlassCustomArrow) {
            try {
                stCard._liquidGlassCustomArrow.destroy();
            }
            catch (e) { }
            delete stCard._liquidGlassCustomArrow;
        }
        try {
            stCard.remove_style_class_name?.('liquid-glass-menu-toggle-has-arrow');
        }
        catch (e) { }
        for (let actor of [stCard._customToggle, stCard.button, stCard._box]) {
            try {
                actor.opacity = 255;
            }
            catch (e) { }
        }
    }
    _hideNativeMenuPart(actor) {
        if (!actor)
            return;
        if (!this._hiddenMenuParts.has(actor)) {
            this._hiddenMenuParts.set(actor, {
                show: actor.show,
                visible: actor.visible,
                opacity: actor.opacity,
                width: actor.width,
                height: actor.height,
                reactive: actor.reactive,
                can_focus: actor.can_focus,
                style: actor.style,
            });
        }
        try {
            actor.hide?.();
        }
        catch (e) { }
        try {
            actor.visible = false;
        }
        catch (e) { }
        try {
            actor.opacity = 0;
        }
        catch (e) { }
        try {
            actor.width = 0;
        }
        catch (e) { }
        try {
            actor.height = 0;
        }
        catch (e) { }
        try {
            actor.set_width?.(0);
        }
        catch (e) { }
        try {
            actor.set_height?.(0);
        }
        catch (e) { }
        try {
            actor.set_size?.(0, 0);
        }
        catch (e) { }
        try {
            actor.reactive = false;
        }
        catch (e) { }
        try {
            actor.can_focus = false;
        }
        catch (e) { }
        try {
            actor.set_style?.('min-width: 0px; max-width: 0px; width: 0px; min-height: 0px; max-height: 0px; height: 0px; padding: 0px; margin: 0px; border: none; border-left-width: 0px; border-right-width: 0px; background-color: transparent; opacity: 0;');
        }
        catch (e) { }
        try {
            actor.show = () => { };
        }
        catch (e) { }
    }
    _restoreNativeMenuPart(actor) {
        if (!actor)
            return;
        let original = this._hiddenMenuParts.get(actor);
        if (!original)
            return;
        try {
            if (original.show)
                actor.show = original.show;
        }
        catch (e) { }
        try {
            actor.visible = original.visible ?? true;
        }
        catch (e) { }
        try {
            actor.opacity = original.opacity ?? 255;
        }
        catch (e) { }
        try {
            actor.width = original.width ?? actor.width;
        }
        catch (e) { }
        try {
            actor.height = original.height ?? actor.height;
        }
        catch (e) { }
        try {
            if (original.width !== undefined)
                actor.set_width?.(original.width);
        }
        catch (e) { }
        try {
            if (original.height !== undefined)
                actor.set_height?.(original.height);
        }
        catch (e) { }
        try {
            actor.reactive = original.reactive ?? actor.reactive;
        }
        catch (e) { }
        try {
            actor.can_focus = original.can_focus ?? actor.can_focus;
        }
        catch (e) { }
        try {
            actor.set_style?.(original.style || '');
        }
        catch (e) { }
        try {
            if (original.visible !== false)
                actor.show?.();
            else
                actor.hide?.();
        }
        catch (e) { }
        this._hiddenMenuParts.delete(actor);
    }
    _restoreMenuToggleParts(card) {
        let stCard = card;
        this._restoreNativeMenuPart(stCard._separator);
        this._restoreNativeMenuPart(stCard._menuButton);
        this._restoreNativeMenuPart(stCard._arrow);
        this._restoreNativeMenuPart(stCard._menuButtonActor);
    }
    _getCustomSubmenuKind(card) {
        let stCard = card;
        let quickSettings = Main.panel.statusArea.quickSettings;
        // Check if it's the SystemItem by looking for a shutdown button inside
        let hasShutdown = false;
        let findShutdown = (actor) => {
            if (hasShutdown)
                return;
            try {
                let iconName = actor.icon_name || actor._icon?.icon_name || actor.get_child?.()?.icon_name || '';
                if (iconName.includes('system-shutdown')) {
                    hasShutdown = true;
                    return;
                }
            }
            catch (e) { }
            let kids = typeof actor.get_children === 'function' ? actor.get_children() : [];
            for (let k of kids)
                findShutdown(k);
        };
        findShutdown(stCard);
        if (hasShutdown && (stCard.menu || stCard._menu || stCard.hasMenu))
            return 'system';
        try {
            let bluetoothItems = quickSettings?._bluetooth?.quickSettingsItems || [];
            if (bluetoothItems.includes(stCard))
                return 'bluetooth';
        }
        catch (e) { }
        let text = `${stCard?.title || ''} ${stCard?.label || ''}`.toLowerCase();
        let icon = '';
        try {
            if (stCard.icon_name)
                icon = stCard.icon_name;
            else if (stCard._icon && stCard._icon.icon_name)
                icon = stCard._icon.icon_name;
            else if (stCard.get_child && stCard.get_child()?.icon_name)
                icon = stCard.get_child().icon_name;
        }
        catch (e) { }
        if (icon.includes('system-shutdown') || text.includes('power off') || text.includes('shutdown') || text.includes('system') || text.includes('power-off'))
            return 'system';
        if (text.includes('bluetooth'))
            return 'bluetooth';
        if (text.includes('wi-fi') || text.includes('wifi') || text.includes('wireless'))
            return 'wifi';
        if (text.includes('caffeine'))
            return 'caffeine';
        if (text.includes('power'))
            return 'power';
        try {
            let networkItems = quickSettings?._network?.quickSettingsItems || [];
            if (networkItems.includes(stCard) && text.includes('network') && !text.includes('vpn') && !text.includes('wired'))
                return 'wifi';
        }
        catch (e) { }
        return null;
    }
    _connectMenuToggleDrilldown(card) {
        let stCard = card;
        if (!(stCard?.menu || stCard?._menu) || stCard._liquidGlassDrilldownConnected)
            return;
        let submenuKind = this._getCustomSubmenuKind(card);
        if (!submenuKind)
            return;
        let signalItems = [];
        let openDetails = () => {
            let now = GLib.get_monotonic_time();
            if (stCard._liquidGlassLastDrilldown && (now - stCard._liquidGlassLastDrilldown) < 400000)
                return Clutter.EVENT_STOP;
            if ((this._submenuRenderer && this._submenuRenderer._floatingWindow) || stCard._liquidGlassDrilldownPending)
                return Clutter.EVENT_STOP;
            stCard._liquidGlassLastDrilldown = now;
            stCard._liquidGlassDrilldownPending = true;
            console.log(`[Liquid Glass] Drill-down intercepted for ${stCard.title || stCard.label || 'quick setting'}`);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                stCard._liquidGlassDrilldownPending = false;
                this.showSubmenuInFloatingWindow(stCard, submenuKind);
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_STOP;
        };
        let connectEvent = (target, signal, callback) => {
            if (!target || typeof target.connect !== 'function')
                return;
            try {
                let id = target.connect(signal, callback);
                signalItems.push({ target, id });
            }
            catch (e) { }
        };
        let isActivationEvent = (event) => {
            let eventType;
            try {
                eventType = event.type();
            }
            catch (e) {
                return false;
            }
            return eventType === Clutter.EventType.BUTTON_PRESS ||
                eventType === Clutter.EventType.TOUCH_BEGIN ||
                eventType === Clutter.EventType.KEY_PRESS;
        };
        let targets = new Set();
        let collectTargets = (actor) => {
            if (!actor || targets.has(actor))
                return;
            targets.add(actor);
            try {
                for (let child of actor.get_children?.() ?? [])
                    collectTargets(child);
            }
            catch (e) { }
        };
        if (submenuKind === 'system') {
            let shutdownBtn = null;
            let findShutdown = (actor) => {
                if (shutdownBtn)
                    return;
                try {
                    let iconName = actor.icon_name || actor._icon?.icon_name || actor.get_child?.()?.icon_name || '';
                    if (iconName.includes('system-shutdown')) {
                        shutdownBtn = actor;
                        return;
                    }
                }
                catch (e) { }
                let kids = typeof actor.get_children === 'function' ? actor.get_children() : [];
                for (let k of kids)
                    findShutdown(k);
            };
            findShutdown(stCard);
            if (shutdownBtn) {
                collectTargets(shutdownBtn);
            }
            else {
                return; // don't attach to the whole system item
            }
        }
        else {
            collectTargets(card);
            for (let actor of [stCard.button, stCard._box, stCard._customToggle, stCard._menuButton])
                collectTargets(actor);
        }
        for (let target of targets) {
            connectEvent(target, 'captured-event', (actor, event) => {
                if (isActivationEvent(event))
                    return openDetails();
                return Clutter.EVENT_PROPAGATE;
            });
            connectEvent(target, 'button-press-event', openDetails);
            connectEvent(target, 'button-release-event', openDetails);
            connectEvent(target, 'clicked', openDetails);
        }
        if (signalItems.length > 0) {
            stCard._liquidGlassDrilldownConnected = true;
            this._drilldownSignalIds.set(card, signalItems);
            console.log(`[Liquid Glass] Drill-down attached for ${stCard.title || stCard.label || 'quick setting'}`);
        }
    }
    _applyCardEffects() {
        if (!this.animActor)
            return;
        let mainBoxChildren = this.animActor.get_children();
        let targetLayoutBox = this.animActor;
        if (mainBoxChildren.length === 1 && mainBoxChildren[0].constructor && mainBoxChildren[0].constructor.name.includes('ScrollView')) {
            let scroll = mainBoxChildren[0];
            let bin = scroll.get_first_child();
            if (bin) {
                let layoutBox = bin.get_first_child();
                if (layoutBox) {
                    mainBoxChildren = layoutBox.get_children();
                    targetLayoutBox = layoutBox;
                }
            }
        }
        let hasClass = (actor, className) => !!(actor && actor.has_style_class_name && actor.has_style_class_name(className));
        let isGridActor = (actor) => !!(actor && ((actor.constructor && actor.constructor.name.includes('Grid')) || hasClass(actor, 'quick-settings-grid')));
        let isSliderActor = (actor) => hasClass(actor, 'quick-slider');
        let isToggleActor = (actor) => hasClass(actor, 'quick-toggle') || hasClass(actor, 'quick-menu-toggle') || hasClass(actor, 'quick-toggle-has-menu');
        let hasNativeMenu = (actor) => !!(actor?.menu || actor?._menu || actor?.hasMenu || hasClass(actor, 'quick-menu-toggle') || hasClass(actor, 'quick-toggle-has-menu'));
        let isCardCandidate = (actor) => actor instanceof St.Button || isSliderActor(actor) || isToggleActor(actor);
        let cards = [];
        let collectCards = (actor, allowFallback = false) => {
            if (!actor || !actor.visible)
                return false;
            if (isGridActor(actor)) {
                let foundInGrid = false;
                for (let child of actor.get_children?.() ?? []) {
                    foundInGrid = collectCards(child, true) || foundInGrid;
                }
                return foundInGrid;
            }
            if (isCardCandidate(actor)) {
                cards.push(actor);
                return true;
            }
            let foundChildCard = false;
            for (let child of actor.get_children?.() ?? []) {
                foundChildCard = collectCards(child, false) || foundChildCard;
            }
            if (!foundChildCard && allowFallback) {
                cards.push(actor);
                return true;
            }
            return foundChildCard;
        };
        for (let child of mainBoxChildren) {
            collectCards(child, true);
        }
        let isCheckableActor = (actor) => {
            if (!actor || typeof actor.connect !== 'function')
                return false;
            try {
                if (typeof actor.checked === 'boolean')
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
            return typeof actor.get_checked === 'function';
        };
        let actorIsChecked = (actor) => {
            try {
                if (actor.checked === true)
                    return true;
            }
            catch (e) { }
            try {
                if (typeof actor.get_checked === 'function' && actor.get_checked() === true)
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
        };
        let collectCheckedButtons = (actor, found = []) => {
            if (isCheckableActor(actor))
                found.push(actor);
            let children = actor.get_children ? actor.get_children() : [];
            for (let child of children) {
                collectCheckedButtons(child, found);
            }
            return found;
        };
        let removeCardActor = (card) => {
            let stCard = card;
            this._disconnectDrilldown(card);
            this._restoreMenuToggleParts(card);
            this._removeCustomMenuArrow(card);
            if (stCard._checkedSignals) {
                for (let item of stCard._checkedSignals) {
                    try {
                        item.button.disconnect(item.id);
                    }
                    catch (e) { }
                }
                delete stCard._checkedSignals;
            }
            if (stCard._liquidGlassArrowHoverSignals) {
                for (let id of stCard._liquidGlassArrowHoverSignals) {
                    try {
                        card.disconnect(id);
                    }
                    catch (e) { }
                }
                delete stCard._liquidGlassArrowHoverSignals;
            }
            if (stCard.remove_style_class_name) {
                for (let className of [
                    'liquid-glass-card',
                    'liquid-glass-card-toggle',
                    'liquid-glass-card-slider',
                    'liquid-glass-card-circle',
                    'liquid-glass-card-pill',
                    'liquid-glass-card-rect',
                    'liquid-glass-card-compact',
                    'checked',
                ]) {
                    stCard.remove_style_class_name(className);
                }
            }
            this._removeCardBacking(card);
            this._cardActors.delete(card);
        };
        let newCardSet = new Set(cards);
        for (let oldCard of Array.from(this._cardActors)) {
            if (!newCardSet.has(oldCard)) {
                removeCardActor(oldCard);
            }
        }
        let classifyCard = (card) => {
            let stCard = card;
            for (let className of [
                'liquid-glass-card-toggle',
                'liquid-glass-card-slider',
                'liquid-glass-card-circle',
                'liquid-glass-card-pill',
                'liquid-glass-card-rect',
                'liquid-glass-card-compact',
            ]) {
                stCard.remove_style_class_name?.(className);
            }
            let [w, h] = card.get_size();
            let aspect = h > 0 ? w / h : 1;
            let isMenuToggle = hasNativeMenu(stCard);
            let isSimpleToggle = hasClass(card, 'quick-toggle') && !isMenuToggle;
            if (isSliderActor(card)) {
                stCard.add_style_class_name?.('liquid-glass-card-slider');
                stCard.add_style_class_name?.('liquid-glass-card-pill');
            }
            else if (hasClass(card, 'liquid-glass-custom-card-squircle')) {
                stCard.add_style_class_name?.('liquid-glass-card-squircle');
            }
            else if (isSimpleToggle) {
                stCard.add_style_class_name?.('liquid-glass-card-circle');
            }
            else if (isMenuToggle) {
                stCard.add_style_class_name?.('liquid-glass-card-rect');
            }
            else if (card instanceof St.Button && (Math.abs(w - h) <= 16 || (w <= 70 && h <= 70))) {
                stCard.add_style_class_name?.('liquid-glass-card-circle');
            }
            else if (aspect >= 2.6 || h <= 48) {
                stCard.add_style_class_name?.('liquid-glass-card-pill');
            }
            else {
                stCard.add_style_class_name?.('liquid-glass-card-rect');
            }
            if (h > 0 && h <= 52) {
                stCard.add_style_class_name?.('liquid-glass-card-compact');
            }
        };
        for (let card of cards) {
            let stCard = card;
            if (!stCard.has_style_class_name || !stCard.has_style_class_name('liquid-glass-card')) {
                try {
                    if (stCard.add_style_class_name) {
                        stCard.add_style_class_name('liquid-glass-card');
                    }
                }
                catch (e) {
                    // Ignore failures
                }
            }
            classifyCard(card);
            classifyCard(card);
            if (hasNativeMenu(stCard)) {
                try {
                    let stCard = card;
                    if (hasNativeMenu(stCard)) {
                        try {
                            this._showMenuToggleContent(card);
                            this._connectMenuToggleDrilldown(card);
                        }
                        catch (e) { }
                    }
                }
                catch (e) { }
            }
            try {
                if (!stCard._liquidGlassCardAllocationId) {
                    stCard._liquidGlassCardAllocationId = card.connect('notify::allocation', () => {
                        classifyCard(card);
                        this._wakeCardBackingSync();
                    });
                }
            }
            catch (e) { }
            this._cardActors.add(card);
            this._getOrCreateCardBacking(card);
            if (stCard._checkedSignals) {
                for (let item of stCard._checkedSignals) {
                    try {
                        item.button.disconnect(item.id);
                    }
                    catch (e) { }
                }
                delete stCard._checkedSignals;
            }
            let checkedButtons = collectCheckedButtons(card);
            if (checkedButtons.length > 0) {
                let updateParentChecked = () => {
                    let anyChecked = checkedButtons.some((button) => actorIsChecked(button));
                    if (anyChecked) {
                        if (stCard.add_style_class_name)
                            stCard.add_style_class_name('checked');
                    }
                    else {
                        if (stCard.remove_style_class_name)
                            stCard.remove_style_class_name('checked');
                    }
                    this._wakeCardBackingSync();
                    // Force button inline styles to refresh after checked state change
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        this._updateButtonAlpha();
                        return GLib.SOURCE_REMOVE;
                    });
                };
                updateParentChecked();
                stCard._checkedSignals = checkedButtons.map((button) => {
                    try {
                        return { button, id: button.connect('notify::checked', updateParentChecked) };
                    }
                    catch (e) {
                        return null;
                    }
                }).filter((item) => item !== null);
            }
        }
        if (targetLayoutBox) {
            if (!targetLayoutBox._childAddedId) {
                targetLayoutBox._childAddedId = targetLayoutBox.connect('child-added', (parent, child) => {
                    this._applyCardEffects();
                    this._wakeCardBackingSync();
                });
            }
            for (let child of mainBoxChildren) {
                let isGrid = (child.constructor && child.constructor.name.includes('Grid')) || (child.has_style_class_name && child.has_style_class_name('quick-settings-grid'));
                if (isGrid && !child._gridChildAddedId) {
                    child._gridChildAddedId = child.connect('child-added', (parent, gridChild) => {
                        this._applyCardEffects();
                        this._wakeCardBackingSync();
                    });
                }
            }
        }
    }
    _removeCardEffects() {
        if (!this.animActor)
            return;
        let mainBoxChildren = this.animActor.get_children();
        let targetLayoutBox = this.animActor;
        if (mainBoxChildren.length === 1 && mainBoxChildren[0].constructor && mainBoxChildren[0].constructor.name.includes('ScrollView')) {
            let scroll = mainBoxChildren[0];
            let bin = scroll.get_first_child();
            if (bin) {
                let layoutBox = bin.get_first_child();
                if (layoutBox) {
                    mainBoxChildren = layoutBox.get_children();
                    targetLayoutBox = layoutBox;
                }
            }
        }
        if (targetLayoutBox && targetLayoutBox._childAddedId) {
            try {
                targetLayoutBox.disconnect(targetLayoutBox._childAddedId);
            }
            catch (e) { }
            delete targetLayoutBox._childAddedId;
        }
        for (let child of mainBoxChildren) {
            let isGrid = (child.constructor && child.constructor.name.includes('Grid')) || (child.has_style_class_name && child.has_style_class_name('quick-settings-grid'));
            if (isGrid && child._gridChildAddedId) {
                try {
                    child.disconnect(child._gridChildAddedId);
                }
                catch (e) { }
                delete child._gridChildAddedId;
            }
        }
        for (let card of Array.from(this._cardActors)) {
            try {
                let stChild = card;
                this._disconnectDrilldown(card);
                this._restoreMenuToggleParts(card);
                this._removeCustomMenuArrow(card);
                if (stChild._checkedSignals) {
                    for (let item of stChild._checkedSignals) {
                        try {
                            item.button.disconnect(item.id);
                        }
                        catch (e) { }
                    }
                    delete stChild._checkedSignals;
                }
                if (stChild._liquidGlassCardAllocationId) {
                    try {
                        card.disconnect(stChild._liquidGlassCardAllocationId);
                    }
                    catch (e) { }
                    delete stChild._liquidGlassCardAllocationId;
                }
                if (stChild.remove_style_class_name) {
                    for (let className of [
                        'liquid-glass-card',
                        'liquid-glass-card-toggle',
                        'liquid-glass-card-slider',
                        'liquid-glass-card-circle',
                        'liquid-glass-card-squircle',
                        'liquid-glass-card-pill',
                        'liquid-glass-card-rect',
                        'liquid-glass-card-compact',
                        'checked',
                    ]) {
                        stChild.remove_style_class_name(className);
                    }
                }
                this._removeCardBacking(card);
            }
            catch (e) { }
        }
        this._cardActors.clear();
        for (let actor of Array.from(this._hiddenMenuParts.keys()))
            this._restoreNativeMenuPart(actor);
        this._stopCardBackingSync();
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        if (!this.targetActor)
            return;
        // Save and disable clip_to_allocation to prevent the submenus from being cropped
        this._originalTargetClip = this.targetActor.clip_to_allocation;
        this.targetActor.clip_to_allocation = false;
        if (this.animActor) {
            this._originalAnimClip = this.animActor.clip_to_allocation;
            this.animActor.clip_to_allocation = false;
        }
        let firstChild = this.targetActor.get_first_child();
        if (firstChild) {
            this._originalFirstChildClip = firstChild.clip_to_allocation;
            firstChild.clip_to_allocation = false;
        }
        // Recursively disable clip_to_allocation on the entire hierarchy
        this._disableClippingRecursively(this.targetActor);
        // Connect to all quick settings submenu open/close states to recursively disable clipping when opened
        this._connectSubmenuClipping();
        // this.animActor.add_style_class_name('liquid-glass-qs-root');
        // this.animActor.add_style_class_name('liquid-glass-menu-root');
        // Shift the menu down to prevent it from clipping into the top bar
        this._menuYoffset = this._settings.get_int('quick-settings-y-offset');
        this._menuXoffset = this._settings.get_int('quick-settings-x-offset');
        this._glassExpand = this._settings.get_int('quick-settings-glass-expand');
        this._animationInterval = this._settings.get_int('quick-settings-animation-interval-ms');
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: this._settings.get_boolean('quick-settings-enable-adaptive-text-color'),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int('quick-settings-sample-interval-ms'),
        };
        // Create the main background actor that will hold the glass effect
        // clip_to_allocation is false so the shader can draw outside the strict bounds if needed
        this.bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        // Set an initial size of 1x1. Passing a 0x0 size to the Cogl engine 
        // while applying a shader will immediately crash the GNOME Shell.
        this.bgActor.set_size(2.0, 2.0);
        // Internal box to hold the desktop/window clones and clip them perfectly
        this.clipBox = new St.Widget({
            clip_to_allocation: true
        });
        this.clipBox.set_size(2.0, 2.0);
        this.bgActor.add_child(this.clipBox);
        this.fboContainer = new UnpickableActor();
        this.fboContainer.set_size(2.0, 2.0);
        this.clipBox.add_child(this.fboContainer);
        // Set pivot points for scaling. 
        // The menu scales from the top-center (0.5, 0.0)
        // this.animActor.set_pivot_point(0.5, 0.0);
        this.animActor.set_pivot_point(0.5, 0.0); // Scale from top-left to match the background actor's coordinate system
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
        let blurRadius = this._settings.get_int('quick-settings-blur-radius');
        let tintColorStr = this._settings.get_string('quick-settings-tint-color');
        let tintStrength = this._settings.get_double('quick-settings-tint-strength');
        this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');
        // Apply native GNOME blur to the internal clipBox (which contains the clones)
        this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        this.fboContainer.add_effect(this.blurEffect);
        // Apply our custom GLSL liquid shader to the outer background actor
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        // Tell the shader about the padding so it calculates refraction coordinates correctly
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...this._hexToColorArray(tintColorStr)); // Pure transparent base
        this.effect.setTintStrength(tintStrength); // Subtle tint strength to enhance the glass look without overpowering the background
        this.effect.setIsDock(false);
        this.bgActor.add_effect(this.effect);
        this.bgActor.hide();
        // Create a localized background blur overlay positioned behind the QS menu.
        // We blur real clones of the desktop/windows (Shell.BlurMode.ACTOR, the
        // same proven pipeline the card backings use) instead of BACKGROUND mode,
        // which does not produce visible blur in some Mutter builds. The feathered
        // BackdropBlurEffect mask chained after it rounds the corners and fades the
        // blur out toward the edges so no visible rectangle remains, and it also
        // applies the actor's animated opacity so the blur fades in lockstep with
        // the menu.
        {
            this._qsBlurOverlay = new St.Widget({
                style_class: 'liquid-glass-qs-blur-overlay',
                reactive: false,
                can_focus: false,
                clip_to_allocation: false,
                opacity: 0,
            });
            this._qsBlurOverlay.set_size(2, 2); // Initial placeholder size
            let qsClipBox = new St.Widget({ clip_to_allocation: true, reactive: false });
            qsClipBox.set_size(2, 2);
            this._qsBlurOverlay.add_child(qsClipBox);
            let qsFboContainer = new UnpickableActor();
            qsFboContainer.set_size(2, 2);
            qsClipBox.add_child(qsFboContainer);
            let qsBgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
            qsFboContainer.add_child(qsBgClone);
            let qsWindowClonesContainer = new UnpickableActor();
            qsFboContainer.add_child(qsWindowClonesContainer);
            this._qsBlurOverlayEffect = new Shell.BlurEffect({
                radius: this._settings.get_int('quick-settings-blur-radius'),
                mode: Shell.BlurMode.ACTOR,
            });
            qsFboContainer.add_effect(this._qsBlurOverlayEffect);
            let mask = new BackdropBlurEffect({ extensionPath: this.extensionPath });
            mask.setCornerRadius(this._cornerRadius || QS_BLUR_OVERLAY_CORNER_RADIUS);
            mask.setFeather(QS_BLUR_OVERLAY_FEATHER);
            this._qsBlurOverlay.add_effect(mask);
            this._qsBlurMask = mask;
            this._qsBlurClipBox = qsClipBox;
            this._qsBlurFboContainer = qsFboContainer;
            this._qsBlurBgClone = qsBgClone;
            this._qsBlurWindowClonesContainer = qsWindowClonesContainer;
            this._qsBlurWindowClones = new Map();
            this._qsBlurOverlay.hide();
            // Insert as a sibling directly below the menu (same as the card backings)
            // so it sits right behind the menu instead of being buried at the bottom
            // of uiGroup under the panel.
            let qsMenuParent = this.menu?.actor?.get_parent?.() || Main.layoutManager.uiGroup;
            try {
                qsMenuParent.insert_child_below(this._qsBlurOverlay, this.menu.actor);
            }
            catch (e) {
                try {
                    Main.layoutManager.uiGroup.add_child(this._qsBlurOverlay);
                }
                catch (e2) { }
            }
        }
        // Function to create clones of the desktop wallpaper and all visible windows
        // This is necessary because GNOME cannot blur content behind an overlay popup directly
        let buildClones = () => {
            if (!this.bgActor)
                return;
            // 1. ISOLATED CLEANUP
            // Wrap the destroy call in a helper function so one failure doesn't halt the rest
            const safeDestroy = (actorRef) => {
                if (actorRef) {
                    try {
                        actorRef.destroy();
                    }
                    catch (e) {
                        // C object was already disposed, ignore safely.
                    }
                }
            };
            // Clean up old clones independently
            safeDestroy(this.bgClone);
            this.bgClone = null;
            safeDestroy(this.windowClonesContainer);
            this.windowClonesContainer = null;
            safeDestroy(this.overviewCloneContainer);
            this.overviewCloneContainer = null;
            // 2. CREATION WITH LIFECYCLE TRACKING
            // Clone the desktop background and track its destruction
            this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
            this.bgClone.connect('destroy', () => { this.bgClone = null; });
            this.fboContainer?.add_child(this.bgClone);
            // Create and track overview clone container
            this.overviewCloneContainer = new UnpickableActor();
            this.overviewCloneContainer.connect('destroy', () => { this.overviewCloneContainer = null; });
            this.fboContainer?.add_child(this.overviewCloneContainer);
            // Create and track window clones container
            this.windowClonesContainer = new UnpickableActor();
            this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
            this.fboContainer?.add_child(this.windowClonesContainer);
            this._windowClones.clear();
            this._overviewClone = null;
            this._appDisplayClone = null;
            this._searchClone = null;
            // Window clones will be created lazily during _syncGeometry() to avoid initial lag
        };
        // Starts the render loop and builds fresh clones when the menu is opened
        let startFrameSync = () => {
            if (this.bgActor) {
                this.bgActor.opacity = 0;
                this.bgActor.hide();
            }
        };
        let stopFrameSync = () => {
            if (this._frameSyncId !== 0) {
                GLib.source_remove(this._frameSyncId);
                this._frameSyncId = 0;
            }
        };
        this._signals = [];
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                if (this.bgActor) {
                    let currentMenuParent = this.targetActor.get_parent();
                    if (currentMenuParent && this.bgActor.get_parent() !== currentMenuParent) {
                        let oldParent = this.bgActor.get_parent();
                        if (oldParent)
                            oldParent.remove_child(this.bgActor);
                        currentMenuParent.insert_child_below(this.bgActor, this.targetActor);
                    }
                }
                for (let button of this._findAllButtons(this.menu?.actor)) {
                    if (button instanceof St.Widget && typeof button.set_style === 'function') {
                        button.set_style(null);
                    }
                }
                if (!this._customQuickSettings)
                    this._customQuickSettings = new CustomQuickSettingsRenderer(this);
                this._customQuickSettings.mount();
                // Apply separately-styled glass card backgrounds to each layout block
                this._applyCardEffects();
                this._startCardBackingSync();
                // Recursively disable clip_to_allocation immediately
                this._disableClippingRecursively(this.targetActor);
                // One short sweep catches lazy widgets without visibly reflowing the menu in passes.
                for (let delay of [80]) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                        if (this._isEffectActive && this.menu.isOpen) {
                            this._disableClippingRecursively(this.targetActor);
                            // Also ensure card effects are applied to any lazy loaded widgets
                            this._applyCardEffects();
                            this._wakeCardBackingSync();
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
                this._stableBaseW = undefined;
                this._stableBaseH = undefined;
                startFrameSync();
                this._startAdaptiveColorSampling(true); // Skip animations on the first open for instant feedback
                this._clearButtonStyles();
                if (this._suppressNextOpenAnimation) {
                    this._suppressNextOpenAnimation = false;
                    this._finishInstantOpenFromSubmenu();
                    return;
                }
                // Safety-clear: if somehow the flag was left on (e.g. submenu closed
                // without reopening QS), clear it now that QS is genuinely opening.
                this._isSubmenuTransitioning = false;
                // Ensure actors are shown in case they were hidden by finishQuickSettingsSubmenuWithoutReopen
                try {
                    this.menu.actor.show?.();
                    this.animActor.show?.();
                }
                catch (e) { }
                this._applyMenuOffsets();
                this._startAnimation(1);
                return;
            }
            if (this._suppressNextCloseAnimation) {
                this._suppressNextCloseAnimation = false;
                this._finishInstantCloseForSubmenu();
                return;
            }
            this._applyClassStyles();
            this._applyMenuOffsets();
            for (let delay of [250, 700]) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    // Don't destroy card effects if we're mid-submenu transition — they'll be needed when QS reopens
                    if (!this.menu?.isOpen && !this._isSubmenuTransitioning) {
                        this._setCardBackingsOpacity(0);
                        this._removeCardEffects();
                        this._stopCardBackingSync();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
            // stopFrameSync();
            this._stopAdaptiveColorSampling();
            this._stopButtonAlphaSampling();
            // If this is a normal close (not suppressed for submenu), clear the
            // transitioning flag so delayed timeouts and notify::mapped work normally.
            this._isSubmenuTransitioning = false;
            this._startAnimation(0);
        });
        // メニューの表示状態（mapped）が変わった時のシグナルを監視
        this._signals.push({
            target: this.menu.actor,
            id: this.menu.actor.connect('notify::mapped', () => {
                if (this.menu.actor.mapped) {
                    // mapped が true になった（画面に表示された）
                    startFrameSync();
                    if (this.bgActor) {
                        this.bgActor.opacity = 0;
                        this.bgActor.hide();
                    }
                    this._syncGeometry();
                }
                else {
                    // mapped が false になった ＝ 完全に画面から消えた（hideされた）
                    stopFrameSync();
                    // Skip cleanup if we're transitioning to/from a submenu — QS will reopen shortly
                    if (!this._isSubmenuTransitioning) {
                        // Immediately clean up card effects and backings to prevent persistence artifacts
                        this._setCardBackingsOpacity(0);
                        this._removeCardEffects();
                        this._stopCardBackingSync();
                        // 念押しで確実にお掃除しておく
                        if (this.bgActor) {
                            this.bgActor.hide();
                            this.bgActor.opacity = 0;
                        }
                        if (this.animActor) {
                            this.animActor.opacity = 0;
                        }
                        if (this._qsBlurOverlay) {
                            this._qsBlurOverlay.opacity = 0;
                            this._qsBlurOverlay.hide();
                        }
                    }
                }
            })
        });
        this._applyClassStyles();
        this._applyMenuOffsets();
        this._updateResolution();
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }
    // 追加: UIクローンの位置・サイズ同期用メソッド
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
            // Catching this prevents the "already disposed" critical crash.
        }
    }
    _syncGeometry() {
        if (this.bgActor && this.bgActor.visible) {
            this.bgActor.opacity = 0;
            this.bgActor.hide();
        }
        return;
    }
    // Syncs the overlay's window clones so the ACTOR-mode blur shows the live
    // windows behind the menu. Mirrors _syncBackingWindowClones (card backings).
    _syncQsBlurOverlayWindowClones(stageX, stageY) {
        let container = this._qsBlurWindowClonesContainer;
        if (!container)
            return;
        try {
            container.remove_all_transitions();
            container.set_position(-stageX, -stageY);
            container.set_scale(1.0, 1.0);
            let windowActors = global.get_window_actors();
            let activeWindows = new Set();
            let zIndex = 0;
            for (let windowActor of windowActors) {
                let metaWindow = windowActor.get_meta_window?.();
                if (!metaWindow || metaWindow.minimized || !windowActor.visible)
                    continue;
                activeWindows.add(windowActor);
                let clone = this._qsBlurWindowClones.get(windowActor);
                if (!clone) {
                    clone = new UnpickableClone({ source: windowActor });
                    container.add_child(clone);
                    this._qsBlurWindowClones.set(windowActor, clone);
                }
                clone.remove_all_transitions();
                clone.set_position(windowActor.x, windowActor.y);
                clone.set_size(windowActor.width, windowActor.height);
                clone.set_scale(windowActor.scale_x, windowActor.scale_y);
                clone.translation_x = windowActor.translation_x;
                clone.translation_y = windowActor.translation_y;
                try {
                    container.set_child_at_index(clone, zIndex);
                }
                catch (e) { }
                zIndex++;
            }
            for (let [windowActor, clone] of Array.from(this._qsBlurWindowClones.entries())) {
                if (!activeWindows.has(windowActor)) {
                    try {
                        clone.destroy();
                    }
                    catch (e) { }
                    this._qsBlurWindowClones.delete(windowActor);
                }
            }
        }
        catch (e) { }
    }
    // Positions the blur overlay behind the QS menu, centered on the _stampActor
    // with generous padding so the feathered mask can fade the edges smoothly.
    _syncBlurOverlayGeometry() {
        if (!this._qsBlurOverlay || !this._stampActor)
            return;
        try {
            let [absX, absY] = this._stampActor.get_transformed_position();
            let [w, h] = this._stampActor.get_size();
            if (!Number.isFinite(absX) || !Number.isFinite(absY) || w <= 0 || h <= 0)
                return;
            // Apply current scale to the apparent size
            let sx = this._stampActor.scale_x ?? 1;
            let sy = this._stampActor.scale_y ?? 1;
            let scaledW = w * sx;
            let scaledH = h * sy;
            // Padding around the menu. Sides/bottom get the full-frost margin + the
            // outward feather so the soft fade fits inside the overlay; the top is
            // flush (0) so the blur never extends up into the top panel.
            let padSide = QS_BLUR_OVERLAY_PADDING;
            let padTop = 0;
            let overlayStageX = absX - padSide + (w - scaledW) * 0.5;
            let overlayStageY = absY - padTop + (h - scaledH) * 0.5;
            let overlayW = scaledW + padSide * 2;
            let overlayH = scaledH + padTop + padSide;
            // Keep the overlay a sibling directly below the menu (mirrors the card
            // backings), re-parenting if the menu moved containers on open.
            let parent = this.menu?.actor?.get_parent?.() || Main.layoutManager.uiGroup;
            if (parent && this._qsBlurOverlay.get_parent() !== parent) {
                try {
                    this._qsBlurOverlay.get_parent()?.remove_child(this._qsBlurOverlay);
                    parent.insert_child_below(this._qsBlurOverlay, this.menu.actor);
                }
                catch (e) { }
            }
            // Convert stage coordinates to the overlay's parent-local coordinates.
            let overlayX = overlayStageX;
            let overlayY = overlayStageY;
            try {
                if (parent && typeof parent.apply_relative_transform_to_point === 'function') {
                    let [success, transformed] = parent.apply_relative_transform_to_point(null, new Clutter.Point({ x: overlayStageX, y: overlayStageY }));
                    if (success && transformed && typeof transformed.x === 'number') {
                        overlayX = transformed.x;
                        overlayY = transformed.y;
                    }
                }
            }
            catch (e) { }
            this._qsBlurOverlay.set_position(Math.round(overlayX), Math.round(overlayY));
            this._qsBlurOverlay.set_size(Math.round(overlayW), Math.round(overlayH));
            // Keep the feathered mask aligned with the overlay. Scale to physical
            // pixels so the rounded mask stays pixel-accurate on HiDPI displays.
            if (this._qsBlurMask) {
                let scale = 1;
                try {
                    let themeContext = St.ThemeContext.get_for_stage(global.stage);
                    scale = themeContext.scale_factor ?? 1;
                }
                catch (e) { }
                if (scale <= 0)
                    scale = 1;
                this._qsBlurMask.setResolution(Math.max(1, Math.round(overlayW * scale)), Math.max(1, Math.round(overlayH * scale)));
                this._qsBlurMask.setCornerRadius((this._cornerRadius || QS_BLUR_OVERLAY_CORNER_RADIUS) * scale);
                this._qsBlurMask.setFeather(QS_BLUR_OVERLAY_FEATHER * scale);
            }
            // Sync the clone geometry (clipBox/fbo/bgClone + window clones) so the
            // ACTOR-mode blur shows the real desktop/windows behind the menu.
            let clipBox = this._qsBlurClipBox;
            let fboContainer = this._qsBlurFboContainer;
            let bgClone = this._qsBlurBgClone;
            if (clipBox && fboContainer && bgClone) {
                clipBox.remove_all_transitions();
                clipBox.set_position(0, 0);
                clipBox.set_size(Math.round(overlayW), Math.round(overlayH));
                fboContainer.remove_all_transitions();
                fboContainer.set_position(0, 0);
                fboContainer.set_size(Math.round(overlayW), Math.round(overlayH));
                bgClone.remove_all_transitions();
                bgClone.set_scale(1.0, 1.0);
                bgClone.set_position(-Math.round(overlayStageX), -Math.round(overlayStageY));
                bgClone.show();
                this._syncQsBlurOverlayWindowClones(Math.round(overlayStageX), Math.round(overlayStageY));
            }
        }
        catch (e) { }
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
        // Save the target color to prevent redundant animation triggers for the same color.
        // if (actor._currentTargetColor === color) return;
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
                actor.remove_style_class_name('adaptive-text-transition');
                actor.remove_style_class_name('adaptive-color-light');
                actor.remove_style_class_name('adaptive-color-dark');
                // 修正: 存在しない remove_style() を削除し、元のスタイル(またはnull)をセット
                actor.set_style(originalStyle || null);
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
                actor.set_style(null);
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
        // This allows smooth transitions starting directly from the default theme colors.
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color(); // Returns Clutter.Color
        let targetRgb = hexToRgb(targetHexColor);
        // 無効状態なら透明度を50%(0.5)にし、有効なら100%(1.0)にする
        let targetAlpha = isInsensitive ? 0.5 : 1.0;
        let startAlpha = startColor.alpha / 255.0; // Clutter.Colorのalphaは0〜255で返る
        let origStyle = this._styledActors.get(actor) || '';
        let stylePrefix = origStyle ? `${origStyle} ` : '';
        if (skipAnimations) {
            let alphaStr = targetAlpha.toFixed(3);
            let targetRgba = `rgba(${targetRgb.r}, ${targetRgb.g}, ${targetRgb.b}, ${alphaStr})`;
            actor.set_style(`${stylePrefix}color: ${targetRgba}; -st-icon-foreground-color: ${targetRgba};`);
            return;
        }
        let startTime = GLib.get_monotonic_time();
        // let durationMs = 380; // Animation duration in milliseconds
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
            actor.set_style(`${stylePrefix}color: ${currentRgba}; -st-icon-foreground-color: ${currentRgba};`);
            // Check for animation completion
            if (progress >= 1.0) {
                actor._colorTweenId = undefined;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }
    // Recursively collect all St.Button elements and quick-toggle containers
    _findAllButtons(actor, foundButtons = []) {
        if (!actor)
            return foundButtons;
        let isQuickSlider = false;
        let isToggleContainer = false;
        let isButton = actor instanceof St.Button;
        // actorがSt.Widget（CSSクラスを持てるUI要素）である場合のみスタイル判定を行う
        if (actor instanceof St.Widget) {
            isQuickSlider = actor.has_style_class_name('quick-slider');
            isToggleContainer = actor.has_style_class_name('quick-toggle');
        }
        // Collect visible St.Button elements and quick-toggle containers (for split buttons)
        if (actor.visible && !isQuickSlider) {
            if (isButton || isToggleContainer) {
                foundButtons.push(actor);
            }
        }
        // Recursively traverse children
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let i = 0; i < children.length; i++) {
            this._findAllButtons(children[i], foundButtons);
        }
        return foundButtons;
    }
    // Helper function to safely update a single button without traversing the whole menu
    _updateSingleButtonAlpha(button, targetAlpha) {
        if (!button || button._isUpdatingAlpha)
            return;
        button._isUpdatingAlpha = true;
        // Temporarily clear inline style to fetch the base theme background
        let origStyle = this._styledButtons.get(button) || '';
        button.set_style(origStyle || null);
        button.ensure_style();
        let themeNode = button.get_theme_node();
        if (themeNode) {
            let bgColor = themeNode.get_background_color();
            if (bgColor) {
                // We no longer apply a solid background patch, allowing the liquid glass shader to handle the tint dynamically.
                button.set_style(origStyle || null);
                // Ensure the parent toggle container is also updated dynamically.
                let parent = typeof button.get_parent === 'function' ? button.get_parent() : null;
                if (parent && parent instanceof St.Widget && parent.has_style_class_name('quick-toggle')) {
                    this._updateSingleButtonAlpha(parent, targetAlpha);
                }
            }
        }
        button._isUpdatingAlpha = false;
    }
    // Main initialization and polling loop
    _updateButtonAlpha() {
        if (!this.menu?.isOpen)
            return;
        const buttons = this._findAllButtons(this.menu?.actor);
        if (buttons.length === 0)
            return;
        let targetAlpha = this.buttonAlpha !== undefined ? this.buttonAlpha : 0.5;
        for (let button of buttons) {
            if (!this._styledButtons.has(button)) {
                if (button instanceof St.Widget) {
                    let origStyle = typeof button.get_style === 'function' ? button.get_style() : null;
                    this._styledButtons.set(button, origStyle || '');
                }
                const updateHandler = () => {
                    if (!this.menu?.isOpen)
                        return;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
                        this._updateSingleButtonAlpha(button, targetAlpha);
                        return GLib.SOURCE_REMOVE;
                    });
                };
                let signalIds = [];
                signalIds.push(button.connect('notify::hover', updateHandler));
                signalIds.push(button.connect('notify::active', updateHandler));
                signalIds.push(button.connect('notify::checked', updateHandler));
                signalIds.push(button.connect('notify::reactive', updateHandler));
                signalIds.push(button.connect('notify::mapped', updateHandler));
                signalIds.push(button.connect('key-focus-in', updateHandler));
                signalIds.push(button.connect('key-focus-out', updateHandler));
                // CRITICAL FIX: Removed 'style-changed'. 
                // calling set_style() triggers 'style-changed', which caused the infinite crash loop!
                this._buttonSignalIds.set(button, signalIds);
            }
            // Apply style safely
            this._updateSingleButtonAlpha(button, targetAlpha);
        }
    }
    // サンプリングタイマーの開始
    _startButtonAlphaSampling() {
        // Disabled for Control Centre cards. Inline background writes here fight
        // the card-level glass/checked styling.
        return;
    }
    // サンプリングタイマーの停止
    _stopButtonAlphaSampling() {
        if (this._buttonTimerId !== 0) {
            GLib.source_remove(this._buttonTimerId);
            this._buttonTimerId = 0;
        }
    }
    // 拡張機能無効時などに元に戻す処理
    _clearButtonStyles() {
        this._stopButtonAlphaSampling();
        if (this._buttonSignalIds) {
            for (const [button, signalIds] of this._buttonSignalIds.entries()) {
                // ボタンがまだメモリ上に存在しているか確認
                if (button) {
                    for (const id of signalIds) {
                        try {
                            button.disconnect(id);
                        }
                        catch (e) {
                            // ボタンが既に破棄されていた場合などのエラーを無視する
                        }
                    }
                }
            }
            this._buttonSignalIds.clear();
        }
        for (const [button, originalStyle] of this._styledButtons.entries()) {
            if (button && button instanceof St.Widget && typeof button.set_style === 'function') {
                button.set_style(originalStyle || null);
                // delete button._isUpdatingAlpha;
            }
        }
        this._styledButtons.clear();
    }
    // Handles the custom bounce/spring physics when the menu opens or closes
    _startAnimation(targetValue) {
        let isOpening = (targetValue === 1);
        log(`[LG-STAMP-QS] startAnimation target=${targetValue} opening=${isOpening} anim=${this._enableAnimation} bg=${!!this.bgActor} targetActor=${!!this.targetActor} tick=${this._tickId}`);
        if (this._tickId !== 0) {
            if (global.compositor?.get_laters) {
                try {
                    global.compositor.get_laters().remove(this._tickId);
                }
                catch (e) { }
            }
            this._tickId = 0;
        }
        // If animation is disabled, just hide the menu and exit
        if (!this._enableAnimation) {
            this._isAnimating = false;
            if (this.bgActor) {
                this.bgActor.remove_all_transitions();
                this.bgActor.opacity = 0;
                this.bgActor.hide();
                // 独自アニメーション（スケール変更など）の残骸をリセットし、GNOMEデフォルトの動作に任せる
                if (this.animActor) {
                    // this.animActor.remove_all_transitions();
                    this.animActor.set_scale(1.0, 1.0);
                    this.animActor.opacity = 255;
                }
            }
            if (this._qsBlurOverlay) {
                this._qsBlurOverlay.opacity = 0;
                this._qsBlurOverlay.hide();
            }
            return;
        }
        // Clear any built-in GNOME transitions that might interfere with our logic
        if (this.animActor)
            this.animActor.remove_all_transitions();
        if (this.bgActor)
            this.bgActor.remove_all_transitions();
        if (isOpening) {
            // Stamp-in: start oversized, spring down to 1.0 while fading in.
            this._springScale.value = this._openScale;
            this._springScale.velocity = 0;
            this._springScale.target = 1;
            this._springPos.value = 0;
            this._springPos.velocity = 0;
            this._springPos.target = 1;
        }
        else {
            this._springScale.value = Math.max(0.001, Math.min(1, this._springScale.value || 1));
            this._springScale.velocity = 0;
            this._springScale.target = 0;
            this._springPos.value = Math.max(0.001, Math.min(1, this._springPos.value || 1));
            this._springPos.velocity = 0;
            this._springPos.target = 0;
        }
        // If an animation loop isn't already running, start a new one
        if (this._tickId === 0) {
            this._isAnimating = true;
            if (isOpening && this._stampActor) {
                // Press down from the top-center exactly like the calendar menu. The QS
                // bubble is clamped against the screen's right edge, so the stamp's
                // rightward expansion slips invisibly off-screen while the left and
                // bottom edges press in symmetrically.
                this._stampActor.set_pivot_point(0.5, 0.0);
                this._stampActor.set_scale(this._openScale, this._openScale);
                this.animActor.opacity = 0;
                // The stamp scales the real boxpointer, so make sure it isn't clipped
                // while oversized.
                this._disableClippingRecursively(this._stampActor);
                try {
                    let [qx, qy] = this._stampActor.get_transformed_position();
                    let [qw, qh] = this._stampActor.get_size();
                    let mon = Main.layoutManager.primaryMonitor;
                    log(`[LG-QS-GEO] pos=(${Math.round(qx)},${Math.round(qy)}) size=(${Math.round(qw)}x${Math.round(qh)}) monitor=(${mon?.width}x${mon?.height})`);
                }
                catch (e) { }
                // _syncCardBackings tracks each card's glass at the popup's current
                // scale, so the liquid stays glued to the content like the calendar's
                // bgActor instead of sliding underneath it.
                this._unfreezeCardBackings();
                this._syncCardBackings();
            }
            let runTick = () => {
                if (!this._stampActor || !this.animActor) {
                    this._tickId = 0;
                    this._isAnimating = false;
                    return GLib.SOURCE_REMOVE;
                }
                let currentTime = GLib.get_monotonic_time();
                if (this._lastTickTime === undefined)
                    this._lastTickTime = currentTime;
                let elapsedUs = currentTime - this._lastTickTime;
                let elapsedMs = elapsedUs / 1000;
                this._lastTickTime = currentTime;
                // Cap elapsed time to prevent physics explosions, and enforce a MINIMUM time 
                // (4ms) to prevent Zeno's paradox (stuck at 0 movement) when the frame delta is tiny!
                if (elapsedMs > 50)
                    elapsedMs = 50;
                if (elapsedMs < 4)
                    elapsedMs = 4;
                let isClosing = (this._springScale.target === 0);
                let stopped = false;
                let s, p;
                let physicsDt = elapsedMs;
                if (isClosing) {
                    // Use a simple exponential decay for closing
                    let speed = 15.0;
                    let dtSec = physicsDt / 1000;
                    this._springScale.value += (0 - this._springScale.value) * (1.0 - Math.exp(-speed * dtSec));
                    this._springPos.value += (0 - this._springPos.value) * (1.0 - Math.exp(-speed * dtSec));
                    s = this._springScale.value;
                    p = this._springPos.value;
                    // Stop animation completely when it's virtually invisible
                    if (s < 0.005) {
                        s = 0;
                        p = 0;
                        stopped = true;
                    }
                }
                else {
                    // Use Hooke's law spring physics for opening.
                    // Update BOTH springs every frame: `&&` between the two update() calls
                    // short-circuits, leaving the opacity spring stuck at 0 for the whole
                    // open (menu stays invisible until it pops in).
                    let sStop = this._springScale.update(physicsDt);
                    let pStop = this._springPos.update(physicsDt);
                    stopped = sStop && pStop;
                    s = this._springScale.value;
                    p = this._springPos.value;
                    // Magnet effect: Snap to exactly 1.0 when almost settled
                    if (Math.abs(1.0 - s) < 0.002 && Math.abs(this._springScale.velocity) < 0.03) {
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
                this._stampActor.set_scale(currentScale, currentScale);
                if (this.effect && typeof this.effect.setAnimationScale === 'function') {
                    this.effect.setAnimationScale(currentScale);
                }
                if (typeof this._stampFrame === 'undefined')
                    this._stampFrame = 0;
                this._stampFrame++;
                if (this._stampFrame <= 3 || stopped) {
                    log(`[LG-STAMP-QS] tick #${this._stampFrame} isClosing=${isClosing} s=${s.toFixed(4)} p=${p.toFixed(4)} scale=${currentScale.toFixed(4)} opacity=${opacity.toFixed(1)} stopped=${stopped}`);
                }
                if (this.bgActor) {
                    this.bgActor.opacity = 0;
                    this.bgActor.hide();
                }
                this.animActor.opacity = opacity;
                // Drive the localized blur overlay in lockstep with the menu fade
                if (this._qsBlurOverlay) {
                    if (opacity > 0) {
                        this._qsBlurOverlay.show();
                        this._qsBlurOverlay.opacity = Math.min(255, Math.round(opacity));
                        this._syncBlurOverlayGeometry();
                    }
                    else {
                        this._qsBlurOverlay.opacity = 0;
                        this._qsBlurOverlay.hide();
                    }
                }
                // Crucial step: Sync card backings every tick, INCLUDING window clones,
                // so the blurred window content stays live under the scaling glass.
                this._syncCardBackings(false);
                // Cleanup when animation finishes
                if (stopped) {
                    this._tickId = 0;
                    this._isAnimating = false;
                    this._lastTickTime = undefined;
                    if (isClosing && this.menu.actor) {
                        this._springScale.value = 0;
                        this._springScale.velocity = 0;
                        this._springScale.target = 0;
                        this._springPos.value = 0;
                        this._springPos.velocity = 0;
                        this._springPos.target = 0;
                        this.menu.actor.hide(); // Tell GNOME the menu is officially closed
                        // For QS, menu.actor is the wrapper — hiding it leaves
                        // boxPointer.visible === true. Hide it too, mirroring GNOME's own
                        // close end-state, so PopupMenu.close()'s boxPointer.visible
                        // check stays consistent.
                        try {
                            this.menu._boxPointer?.hide?.();
                        }
                        catch (e) { }
                        // GNOME's BoxPointer.close onComplete was suppressed — emit 'menu-closed' now
                        let pendingCloseCb = this._pendingMenuClosedCallback;
                        this._pendingMenuClosedCallback = null;
                        pendingCloseCb?.();
                        if (this.bgActor) {
                            this.bgActor.opacity = 0;
                            this.bgActor.hide();
                        }
                        this.animActor.opacity = 0;
                        if (this._qsBlurOverlay) {
                            this._qsBlurOverlay.opacity = 0;
                            this._qsBlurOverlay.hide();
                        }
                        if (this._stampActor) {
                            this._stampActor.set_pivot_point(0.0, 0.0);
                            this._stampActor.set_scale(1.0, 1.0);
                        }
                        this._unfreezeCardBackings();
                        this._removeCardEffects();
                        this._stopCardBackingSync();
                    }
                    if (!isClosing) {
                        this._springScale.value = 1;
                        this._springScale.velocity = 0;
                        this._springScale.target = 1;
                        this._springPos.value = 1;
                        this._springPos.velocity = 0;
                        this._springPos.target = 1;
                        this.targetActor.set_scale(1.0, 1.0);
                        this.animActor.set_scale(1.0, 1.0);
                        this.animActor.opacity = 255;
                        if (this._stampActor)
                            this._stampActor.set_scale(1.0, 1.0);
                        if (this.bgActor) {
                            this.bgActor.opacity = 0;
                            this.bgActor.hide();
                        }
                        // Animation done: resume live geometry tracking on settled layout.
                        this._unfreezeCardBackings();
                        this._syncGeometry();
                        this._syncCardBackings();
                        // Wake up the card backing sync timer now that animation is done
                        this._wakeCardBackingSync();
                        try {
                            if (this._stampActor) {
                                let [sx, sy] = this._stampActor.get_transformed_position();
                                let [sw, sh] = this._stampActor.get_size();
                                let mon = Main.layoutManager.primaryMonitor;
                                log(`[LG-QS-SETTLED] pos=(${Math.round(sx)},${Math.round(sy)}) size=(${Math.round(sw)}x${Math.round(sh)}) mon=(${mon?.width}x${mon?.height})`);
                            }
                        }
                        catch (e) { }
                    }
                    return GLib.SOURCE_REMOVE; // Stop the GLib timeout loop
                }
                this._tickId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, runTick);
                return GLib.SOURCE_REMOVE; // Keep the loop running via before redraw
            };
            this._lastTickTime = GLib.get_monotonic_time();
            this._tickId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, runTick);
        }
    }
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        this._clearButtonStyles();
        this._stopCardBackingSync();
        this._removeCardEffects();
        this._customQuickSettings?.destroy();
        this._customQuickSettings = null;
        // Disconnect all event listeners safely
        for (let sig of this._signals) {
            try {
                if (sig && sig.id)
                    sig.target.disconnect(sig.id);
            }
            catch (e) { }
        }
        this._signals = [];
        // Stop the spring animation loop
        if (this._tickId && this._tickId !== 0) {
            if (global.compositor?.get_laters) {
                global.compositor.get_laters().remove(this._tickId);
            }
            this._tickId = 0;
        }
        // _applyEffect内で登録したアニメーションシグナルも解除する（多重登録防止）
        if (this._animSignalId) {
            try {
                this.menu.disconnect(this._animSignalId);
            }
            catch (e) { }
            this._animSignalId = 0;
        }
        // Stop the render frame loop
        if (this._frameSyncId !== 0) {
            GLib.source_remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        // Remove transparent CSS overrides
        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        if (this.animActor) {
            this.animActor.remove_style_class_name('liquid-glass-transparent');
            this.animActor.remove_style_class_name('liquid-glass-qs-root');
            // Revert UI shifts and forced states
            this.animActor.translation_x = 0;
            this.animActor.translation_y = 0;
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.set_pivot_point(0.0, 0.0);
            this.animActor.opacity = 255;
        }
        // Revert clipping values when removing effect
        if (this._originalTargetClip !== undefined) {
            this.targetActor.clip_to_allocation = this._originalTargetClip;
        }
        if (this.animActor && this._originalAnimClip !== undefined) {
            this.animActor.clip_to_allocation = this._originalAnimClip;
        }
        let firstChild = this.targetActor.get_first_child();
        if (firstChild && this._originalFirstChildClip !== undefined) {
            firstChild.clip_to_allocation = this._originalFirstChildClip;
        }
        this._restoreClippingRecursively(this.targetActor);
        this._disabledClipActors.clear();
        // Revert UI shifts and forced states when extension is disabled
        this.targetActor.translation_y = 0;
        this.targetActor.translation_x = 0;
        // this.targetActor.margin_top = 0;
        this.targetActor.set_scale(1.0, 1.0);
        this.targetActor.set_pivot_point(0.0, 0.0);
        this.targetActor.opacity = 255;
        if (this.menu.actor) {
            this.menu.actor.opacity = 255;
            this.menu.actor.translation_x = 0;
            this.menu.actor.translation_y = 0;
            // If the menu is currently open, forcefully close it 
            // without animations to reset GNOME's internal state
            if (this.menu.isOpen) {
                this.menu.close(false);
            }
        }
        if (this.effect) {
            this.effect.cleanup();
            this.effect = null;
        }
        // Destroy all injected actors and clones
        if (this.bgActor) {
            this.bgActor.destroy();
            this.bgActor = null;
        }
        // Destroy the fullscreen blur overlay
        if (this._qsBlurOverlay) {
            try {
                this._qsBlurOverlay.destroy();
            }
            catch (e) { }
            this._qsBlurOverlay = null;
            this._qsBlurOverlayEffect = null;
            this._qsBlurMask = null;
            this._qsBlurClipBox = null;
            this._qsBlurFboContainer = null;
            this._qsBlurBgClone = null;
            this._qsBlurWindowClonesContainer = null;
            this._qsBlurWindowClones.clear();
        }
        this.blurEffect = null;
        this.bgClone = null;
        this.fboContainer = null;
        this.overviewCloneContainer = null;
        this.windowClonesContainer = null;
        this._windowClones.clear();
        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
    }
    showSubmenuInFloatingWindow(stCard, kind) {
        if (!this._submenuRenderer) {
            this._submenuRenderer = new CustomSubmenuRenderer(this);
        }
        this._submenuRenderer.show(stCard, kind);
    }
    _holdSubmenuReveal;
    reopenQuickSettingsFromSubmenu(holdReveal = false) {
        this._suppressNextOpenAnimation = true;
        this._holdSubmenuReveal = holdReveal;
        try {
            this.menu.actor.remove_all_transitions?.();
            this.menu.actor.opacity = 0;
            this.menu.actor.translation_x = 0;
            this.menu.actor.translation_y = 0;
            this.animActor.remove_all_transitions();
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.opacity = 255;
            this._applyMenuOffsets();
        }
        catch (e) { }
        try {
            this.menu.open();
        }
        catch (e) { }
    }
    closeQuickSettingsForSubmenu(animate = false) {
        this._isSubmenuTransitioning = true;
        this._suppressNextCloseAnimation = true;
        if (!animate) {
            try {
                this.menu.close(false);
            }
            catch (e) { }
            if (this._qsBlurOverlay) {
                this._qsBlurOverlay.opacity = 0;
                this._qsBlurOverlay.hide();
            }
            return;
        }
        // Push QS out of the way as the submenu pops in: quick shrink + fade of the
        // popup, then close for real (suppressed, so no stamp re-runs).
        // Also fade out the background blur overlay in sync.
        if (this._qsBlurOverlay) {
            this._qsBlurOverlay.remove_all_transitions();
            this._qsBlurOverlay.ease({
                opacity: 0,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._qsBlurOverlay)
                        this._qsBlurOverlay.hide();
                },
            });
        }
        try {
            if (this._stampActor) {
                this._stampActor.remove_all_transitions();
                this._stampActor.ease({
                    scale_x: 0.9,
                    scale_y: 0.9,
                    opacity: 0,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        try {
                            this.menu.close(false);
                        }
                        catch (e) { }
                    },
                });
            }
            else {
                try {
                    this.menu.close(false);
                }
                catch (e) { }
            }
        }
        catch (e) {
            try {
                this.menu.close(false);
            }
            catch (e2) { }
        }
    }
    revealQuickSettingsAfterSubmenu(pop = false) {
        this._holdSubmenuReveal = false;
        // The layout was already settled by _finishInstantOpenFromSubmenu while
        // the submenu close animation played, so QS can be revealed cleanly
        // without re-running the bouncy spring (which reads as a disconnected,
        // jittery hand-off). Mark the springs settled so future open/closes start
        // from a clean state.
        if (this._tickId !== 0) {
            try {
                if (global.compositor?.get_laters)
                    global.compositor.get_laters().remove(this._tickId);
                else
                    GLib.source_remove(this._tickId);
            }
            catch (e) { }
            this._tickId = 0;
        }
        this._isAnimating = false;
        this._springScale.value = 1;
        this._springScale.velocity = 0;
        this._springScale.target = 1;
        this._springPos.value = 1;
        this._springPos.velocity = 0;
        this._springPos.target = 1;
        try {
            if (this.menu && this.menu.actor) {
                this.menu.actor.remove_all_transitions?.();
                this.menu.actor.opacity = 255;
            }
            if (this.animActor) {
                this.animActor.remove_all_transitions();
                this.animActor.opacity = 255;
            }
            if (this._stampActor) {
                this._stampActor.remove_all_transitions();
                this._stampActor.set_scale(1.0, 1.0);
                if (pop) {
                    // Subtle pop back into place as the submenu collapses onto the card.
                    this._stampActor.set_scale(0.96, 0.96);
                    this._stampActor.ease({
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration: 160,
                        mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    });
                }
            }
        }
        catch (e) { }
        // Re-sync the card backings immediately so the glass is visible on the
        // same frame the Quick Settings content reappears. Without this the
        // backings keep the opacity they had while the submenu was covering QS
        // (menu.actor.opacity was 0), so the glass lags the content by a frame
        // or more (up to the idle sync interval once the backing sync idles).
        this._wakeCardBackingSync();
        // Show the background blur overlay since QS is now fully visible
        if (this._qsBlurOverlay) {
            this._syncBlurOverlayGeometry();
            this._qsBlurOverlay.show();
            this._qsBlurOverlay.opacity = 255;
        }
    }
    /**
     * Complete a floating-submenu transition that intentionally does not return
     * to Quick Settings, such as launching a Settings panel or a system dialog.
     */
    finishQuickSettingsSubmenuWithoutReopen() {
        this._isSubmenuTransitioning = false;
        this._suppressNextOpenAnimation = false;
        this._suppressNextCloseAnimation = false;
        this._holdSubmenuReveal = false;
        if (this._tickId !== 0) {
            try {
                if (global.compositor?.get_laters)
                    global.compositor.get_laters().remove(this._tickId);
                else
                    GLib.source_remove(this._tickId);
            }
            catch (e) { }
            this._tickId = 0;
        }
        this._isAnimating = false;
        this._springScale.value = 1;
        this._springScale.velocity = 0;
        this._springScale.target = 1;
        this._springPos.value = 1;
        this._springPos.velocity = 0;
        this._springPos.target = 1;
        try {
            this.menu.actor.remove_all_transitions?.();
            this.menu.actor.opacity = 255;
            this.menu.actor.translation_x = 0;
            this.menu.actor.translation_y = 0;
            this.menu.actor.set_scale?.(1.0, 1.0);
            this.animActor.remove_all_transitions();
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.opacity = 255;
            this.animActor.translation_x = 0;
            this.animActor.translation_y = 0;
            this._applyMenuOffsets();
            if (this.menu.isOpen) {
                this._suppressNextCloseAnimation = true;
                this.menu.close(false);
            }
        }
        catch (e) { }
        this._suppressNextCloseAnimation = false;
        this._setCardBackingsOpacity(0);
        this._removeCardEffects();
        this._stopCardBackingSync();
        try {
            if (this.bgActor) {
                this.bgActor.remove_all_transitions();
                this.bgActor.opacity = 0;
                this.bgActor.hide();
            }
            if (this._qsBlurOverlay) {
                this._qsBlurOverlay.remove_all_transitions();
                this._qsBlurOverlay.opacity = 0;
                this._qsBlurOverlay.hide();
            }
            this.menu.actor.opacity = 255;
            this.animActor.opacity = 255;
            this.animActor.hide?.();
            this.menu.actor.hide?.();
        }
        catch (e) { }
    }
    _finishInstantOpenFromSubmenu() {
        if (this._tickId !== 0) {
            try {
                if (global.compositor?.get_laters)
                    global.compositor.get_laters().remove(this._tickId);
                else
                    GLib.source_remove(this._tickId);
            }
            catch (e) { }
            this._tickId = 0;
        }
        this._isAnimating = false;
        this._springScale.value = 1;
        this._springScale.velocity = 0;
        this._springScale.target = 1;
        this._springPos.value = 1;
        this._springPos.velocity = 0;
        this._springPos.target = 1;
        try {
            this.animActor.remove_all_transitions();
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.opacity = 255;
            this._applyMenuOffsets();
            this.animActor.show?.();
        }
        catch (e) { }
        try {
            this.menu.actor.remove_all_transitions?.();
            this.menu.actor.translation_x = 0;
            this.menu.actor.translation_y = 0;
            this.menu.actor.opacity = 0;
            this.menu.actor.show?.();
        }
        catch (e) { }
        if (this.bgActor) {
            this.bgActor.opacity = 0;
            this.bgActor.hide();
        }
        if (this._qsBlurOverlay) {
            this._qsBlurOverlay.opacity = 0;
            this._qsBlurOverlay.hide();
        }
        // Note: the synchronous _syncGeometry/_syncCardBackings pass is intentionally
        // deferred to settleFrame1 below. This runs on the same frame the submenu's
        // close animation begins; pushing it one frame later (QS is hidden here, so
        // there's no visual difference) avoids a heavy per-card clone sync stalling
        // the submenu exit.
        // Multi-frame delayed reveal: keep QS hidden (menu.actor.opacity = 0) while
        // layout settles, allocation signals fire, and card shapes stabilize.
        // Frame 1 (BEFORE_REDRAW): layout reflows, notify::allocation fires, classifyCard runs
        // Frame 2 (BEFORE_REDRAW): re-sync everything with settled positions
        // Frame 3 (timeout 16ms): final sync and reveal — everything is correct
        let addLater = (callback) => {
            try {
                if (global.compositor?.get_laters)
                    return global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, callback);
            }
            catch (e) { }
            return GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, callback);
        };
        let finalReveal = () => {
            try {
                this._isSubmenuTransitioning = false;
                // Re-apply card effects to catch any lazy-loaded widgets
                this._applyCardEffects();
                this._applyMenuOffsets();
                this._syncGeometry();
                this._syncCardBackings();
                if (!this._holdSubmenuReveal) {
                    this.menu.actor.opacity = 255;
                    this.animActor.opacity = 255;
                }
                this._wakeCardBackingSync();
            }
            catch (e) { }
            return GLib.SOURCE_REMOVE;
        };
        let settleFrame2 = () => {
            try {
                this._applyMenuOffsets();
                this._syncGeometry();
                this._syncCardBackings();
            }
            catch (e) { }
            // Use a short timeout for the final reveal to guarantee at least one
            // full paint cycle has completed with correct geometry
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, finalReveal);
            return GLib.SOURCE_REMOVE;
        };
        let settleFrame1 = () => {
            try {
                this._applyMenuOffsets();
                this._syncGeometry();
                this._syncCardBackings();
            }
            catch (e) { }
            addLater(settleFrame2);
            return GLib.SOURCE_REMOVE;
        };
        addLater(settleFrame1);
    }
    _finishInstantCloseForSubmenu() {
        if (this._tickId !== 0) {
            try {
                if (global.compositor?.get_laters)
                    global.compositor.get_laters().remove(this._tickId);
                else
                    GLib.source_remove(this._tickId);
            }
            catch (e) { }
            this._tickId = 0;
        }
        this._isAnimating = false;
        this._springScale.value = 0;
        this._springScale.velocity = 0;
        this._springScale.target = 0;
        this._springPos.value = 0;
        this._springPos.velocity = 0;
        this._springPos.target = 0;
        this._stopAdaptiveColorSampling();
        this._stopButtonAlphaSampling();
        this._setCardBackingsOpacity(0);
        this._removeCardEffects();
        this._stopCardBackingSync();
        try {
            this.animActor.remove_all_transitions();
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.opacity = 0;
            this.animActor.hide?.();
        }
        catch (e) { }
        if (this.bgActor) {
            this.bgActor.remove_all_transitions();
            this.bgActor.opacity = 0;
            this.bgActor.hide();
        }
        if (this._qsBlurOverlay) {
            this._qsBlurOverlay.remove_all_transitions();
            this._qsBlurOverlay.opacity = 0;
            this._qsBlurOverlay.hide();
        }
        try {
            this.menu.actor.opacity = 0;
            this.menu.actor.hide?.();
        }
        catch (e) { }
    }
    cleanup() {
        this._isSubmenuTransitioning = false;
        if (this._submenuRenderer) {
            this._submenuRenderer.close();
        }
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
