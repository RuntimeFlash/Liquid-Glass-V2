// src/notificationManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import Gio from 'gi://Gio';
import { UnpickableClone, hexToRgb, rgbToHex } from './utils.js';
// ========== Configuration Parameters (Defaults, overridden by settings) ==========
const SHADER_PADDING = 20;
const HIDE_SAFETY_MARGIN = 7;
interface CustomBannerActor extends St.Widget {
  _colorTweenId?: number;
  _currentTargetColor?: string;
}

export class NotificationManager {
  private extensionPath: string;
  private _settings: Gio.Settings;
  private tray: St.Widget;

  private currentBanner: St.Widget | null = null;
  private bgActor: St.Widget | null = null;
  private clipBox: St.Widget | null = null;
  private blurEffect: Shell.BlurEffect | null = null;
  private effect: LiquidEffect | null = null;

  private bgClone: Clutter.Clone | null = null;
  private windowClonesContainer: Clutter.Actor | null = null;
  private overviewCloneContainer: Clutter.Actor | null = null;
  private _windowClones: Map<Clutter.Actor, Clutter.Clone>;
  private _overviewClone: Clutter.Clone | null = null;
  private _appDisplayClone: Clutter.Clone | null = null;
  private _searchClone: Clutter.Clone | null = null;

  private _signals: number[];
  private _settingsSignals: number[];
  private _frameSyncId: number;
  private _isEffectActive: boolean;

  private _stableBaseW: number | undefined;
  private _stableBaseH: number | undefined;

  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _contrastSampler: StageContrastSampler;
  private _adaptiveConfig: typeof AdaptiveContrastConfig;
  private _adaptiveTimerId: number;
  private _adaptiveInFlight: boolean;
  private _styledActors: Map<Clutter.Actor, string>;

  private _glassExpand: number;
  private _baseTint: number;
  private _currentTint: number;
  private _notificationYOffset: number;

  private _syncIdleMode: boolean = false;
  private _syncStableFrames: number = 0;
  private _syncLastSignature: string = '';

  private _isFirstAdaptiveRun: boolean = true;
  constructor(extensionPath: string, settings: Gio.Settings) {
    this.extensionPath = extensionPath;
    this._settings = settings;
    this.tray = Main.messageTray;

    this.currentBanner = null;
    this.bgActor = null;
    this.clipBox = null;
    this.blurEffect = null;
    this.effect = null;

    this.bgClone = null;
    this.windowClonesContainer = null;
    this.overviewCloneContainer = null;
    this._overviewClone = null;
    this._appDisplayClone = null;
    this._searchClone = null;

    this._signals = [];
    this._settingsSignals = [];
    this._frameSyncId = 0;
    this._isEffectActive = false;

    this._stableBaseW = undefined;
    this._stableBaseH = undefined;

    this._lastBgW = undefined;
    this._lastBgH = undefined;
    this._lastBgX = undefined;
    this._lastBgY = undefined;

    this._windowClones = new Map();

    this._contrastSampler = new StageContrastSampler();
    this._adaptiveConfig = {
      ...AdaptiveContrastConfig,
      enabled: true, // Will be overridden by settings
      samplePerElement: false,
      sampleIntervalMs: 400, // Will be overridden by settings
    };
    this._adaptiveTimerId = 0;
    this._adaptiveInFlight = false;
    this._styledActors = new Map();

    this._glassExpand = 12;
    this._baseTint = 0.08;
    this._currentTint = 0.08;
    this._notificationYOffset = 10;
  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

    // 拡張機能全体の設定または通知専用の設定で有効化を判断
    if (this._settings.get_boolean('enable-notification-glass')) {
      this._applyEffect();
    }
  }

  // Utility: Convert HEX color string to normalized RGB array
  _hexToColorArray(hex: string): [number, number, number] {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) return [1.0, 1.0, 1.0];
    let r = parseInt(hex.slice(1, 3), 16) / 255.0;
    let g = parseInt(hex.slice(3, 5), 16) / 255.0;
    let b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
  }

  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    connectSetting('enable-notification-glass', () => {
      let enabled = this._settings.get_boolean('enable-notification-glass');
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    connectSetting('notification-tint-color', () => {
      if (this.effect && this._isEffectActive) {
        let colorArray = this._hexToColorArray(this._settings.get_string('notification-tint-color'));
        this.effect.setTintColor(...colorArray);
      }
    });

    connectSetting('notification-tint-strength', () => {
      if (this.effect && this._isEffectActive) {
        this._baseTint = this._settings.get_double('notification-tint-strength');
        this._currentTint = this._baseTint;
        this.effect.setTintStrength(this._baseTint);
      }
    });

    connectSetting('notification-blur-radius', () => {
      if (this.blurEffect && this._isEffectActive) {
        this.blurEffect.radius = this._settings.get_int('notification-blur-radius');
      }
    });

    connectSetting('notification-corner-radius', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setCornerRadius(this._settings.get_double('notification-corner-radius'));
      }
    });

    connectSetting('notification-glass-expand', () => {
      if (this._isEffectActive) {
        this._glassExpand = this._settings.get_int('notification-glass-expand');
      }
    });

    connectSetting('notification-enable-adaptive-text-color', () => {
      this._adaptiveConfig.enabled = this._settings.get_boolean('notification-enable-adaptive-text-color');
    });

    connectSetting('notification-sample-interval-ms', () => {
      this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('notification-sample-interval-ms');
    });

    connectSetting('notification-y-offset', () => {
      this._notificationYOffset = this._settings.get_int('notification-y-offset');
    });
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    // @ts-expect-error: _bannerBinは内部プロパティのため型定義に存在しない
    let bannerBin = this.tray._bannerBin;
    if (!bannerBin) {
      console.error("[Liquid Glass] _bannerBin is not found. GNOME internal structure might have changed.");
      return;
    }

    // Apply settings initially
    this._adaptiveConfig.enabled = this._settings.get_boolean('notification-enable-adaptive-text-color');
    this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('notification-sample-interval-ms');
    this._glassExpand = this._settings.get_int('notification-glass-expand');
    this._baseTint = this._settings.get_double('notification-tint-strength');
    this._currentTint = this._baseTint;
    this._notificationYOffset = this._settings.get_int('notification-y-offset');

    // Listen for new notifications
    if (!(bannerBin as any)._liquidOrigEase) {
      (bannerBin as any)._liquidOrigEase = bannerBin.ease;
      bannerBin.ease = function(props: any) {
        if (props.translation_y !== undefined) {
          let targetY = props.translation_y;
          delete props.translation_y;
          // Set to a fixed offset (usually 0 or slight padding)
          this.translation_y = 0;

          if (targetY >= -10) {
            this.opacity = 0;
            props.opacity = 255;
          } else {
            props.opacity = 0;
          }
        }
        (this as any)._liquidOrigEase(props);
      };
    }

    this._signals.push(bannerBin.connect('child-added', (container, actor: St.Widget) => {
      if (actor === this.bgActor || actor.has_style_class_name('liquid-glass-bg-actor')) return;

      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        // @ts-expect-error: _bannerは内部プロパティのため型定義に存在しない
        let banner = this.tray._banner || actor;
        if (banner && banner !== this.currentBanner) {
          this._cleanupCurrentBanner();
          this.currentBanner = banner;
          this._setupBannerEffect(banner);
        }
        return GLib.SOURCE_REMOVE;
      });
    }));

    this._signals.push(bannerBin.connect('child-removed', (container, actor: St.Widget) => {
      if (actor === this.bgActor || actor.has_style_class_name('liquid-glass-bg-actor')) return;
      this._cleanupCurrentBanner();
    }));
    // @ts-expect-error
    if (this.tray._banner) {
      // @ts-expect-error
      this.currentBanner = this.tray._banner;
      // @ts-expect-error
      this._setupBannerEffect(this.tray._banner);
    }
  }

  _setupBannerEffect(targetActor: St.Widget) {
    targetActor.add_style_class_name('liquid-glass-transparent');
    // @ts-expect-error
    if (this.tray._bannerBin) {
      // @ts-expect-error
      this.tray._bannerBin.translation_y = this._settings.get_int('notification-y-offset');
    }

    this.bgActor = new St.Widget({
      style_class: 'liquid-glass-bg-actor',
      clip_to_allocation: false,
      reactive: false
    });
    this.bgActor.set_size(2.0, 2.0);
    this.bgActor.set_pivot_point(0.0, 0.0);

    this.clipBox = new St.Widget({ clip_to_allocation: true });
    this.clipBox.set_size(2.0, 2.0);
    this.bgActor.add_child(this.clipBox);
    // @ts-expect-error
    let bannerBin = this.tray._bannerBin;
    let parent = bannerBin ? bannerBin.get_parent() : null;

    if (parent) {
      parent.insert_child_below(this.bgActor, bannerBin);
    } else {
      Main.layoutManager.uiGroup.add_child(this.bgActor);
    }

    let blurRadius = this._settings.get_int('notification-blur-radius');
    let tintColorStr = this._settings.get_string('notification-tint-color');
    let cornerRadius = this._settings.get_double('notification-corner-radius');
    let tintStrength = this._settings.get_double('notification-tint-strength');
    this._baseTint = tintStrength;

    this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
    this.clipBox.add_effect(this.blurEffect);

    this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings } as any);
    this.effect.setPadding(SHADER_PADDING);
    this.effect.setTintColor(...this._hexToColorArray(tintColorStr));
    this.effect.setTintStrength(this._baseTint);
    this.effect.setCornerRadius(cornerRadius);
    this.effect.setIsDock(false);
    this.bgActor.add_effect(this.effect);

    this.bgActor.show();

    this._buildClones();

    const frameTick = () => {
      if (!this.bgActor || !this.currentBanner) {
        this._frameSyncId = 0;
        return GLib.SOURCE_REMOVE;
      }

      // Idle throttle: the expensive geometry/window-clone sync only runs when
      // something actually changed (banner geometry/opacity, window positions).
      // While stable, poll slowly instead of rebuilding the glass every frame.
      let signature = this._getSyncSignature();
      if (signature === this._syncLastSignature) {
        this._syncStableFrames++;
        if (this._syncStableFrames >= 8) this._syncIdleMode = true;
      } else {
        this._syncStableFrames = 0;
        this._syncIdleMode = false;
        this._syncLastSignature = signature;
      }

      if (!this._syncIdleMode) {
        this._syncGeometry();
      }

      let isHovered = this.currentBanner.hover;
      let targetTint = isHovered ? (this._baseTint + 0.1) : this._baseTint;
      let tintDelta = Math.abs(this._currentTint - targetTint);
      if (tintDelta > 0.001) {
        // Keep the tint interpolation responsive while it's moving.
        this._syncIdleMode = false;
        this._currentTint += (targetTint - this._currentTint) * 0.1;
        this.effect?.setTintStrength(this._currentTint);
      }

      let intervalMs = this._syncIdleMode ? 500 : 16;
      this._frameSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, frameTick);
      return GLib.SOURCE_REMOVE;
    };

    this._syncGeometry();
    this._frameSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, frameTick);
    this._isFirstAdaptiveRun = true;
    this._startAdaptiveColorSampling();
  }

  _syncActorProperties(source, clone) {
    if (!source || !clone) return;

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

  _getSyncSignature(): string {
    let parts: string[] = [];
    try {
      if (this.currentBanner) {
        let [x, y] = this.currentBanner.get_transformed_position();
        let [w, h] = this.currentBanner.get_size();
        parts.push(`b:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)},${this.currentBanner.opacity}`);
      }
      let windows = global.get_window_actors();
      for (let w of windows) {
        let metaWindow = w.get_meta_window?.();
        if (!metaWindow || metaWindow.minimized || !w.visible) continue;
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
    } catch (e) {}
    return parts.join('|');
  }

  _syncGeometry() {
    if (!this.bgActor || !this.currentBanner) return;

    let [w, h] = this.currentBanner.get_size();
    let [absX, absY] = this.currentBanner.get_transformed_position();
    if (Number.isNaN(absX) || Number.isNaN(absY)) return;

    this.bgActor.opacity = this.currentBanner.opacity;

    let themeNode = this.currentBanner.get_theme_node();
    let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
    let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
    let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
    let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;

    let marginW = mL + mR;
    let marginH = mT + mB;

    if (absY + h <= mB + HIDE_SAFETY_MARGIN) {
      this.bgActor.hide();
      return;
    } else if (!this.bgActor.visible) {
      this.bgActor.show();
    }

    if (this._stableBaseW === undefined) {
      this._stableBaseW = w;
    }

    if (Math.abs(this._stableBaseW - (w + marginW)) <= 1) {
      this._stableBaseW = w;
    }

    let isBloated = Math.abs(w - (this._stableBaseW + marginW)) <= 1;

    let visualW = w;
    let visualH = h;

    if (isBloated) {
      visualW = w - marginW;
      visualH = h - marginH;
    } else {
      this._stableBaseW = w;
      visualW = w;
      visualH = h;
    }

    let visualX = absX;
    let visualY = absY;

    let bgW = Math.round(visualW + (this._glassExpand * 2) + (SHADER_PADDING * 2));
    let bgH = Math.round(visualH + (this._glassExpand * 2) + (SHADER_PADDING * 2));

    let bgX_abs = Math.round(visualX - this._glassExpand - SHADER_PADDING);
    let bgY_abs = Math.round(visualY - this._glassExpand - SHADER_PADDING);

    let bgX_local = bgX_abs;
    let bgY_local = bgY_abs;
    let parent = this.bgActor.get_parent();
    if (parent) {
      let [pX, pY] = parent.get_transformed_position();
      if (!Number.isNaN(pX) && !Number.isNaN(pY)) {
        bgX_local = bgX_abs - pX;
        bgY_local = bgY_abs - pY;
      }
    }

    if (this._lastBgW === undefined || this._lastBgH === undefined || this._lastBgX === undefined || this._lastBgY === undefined ||
      Math.abs(this._lastBgW - bgW) > 0.5 || Math.abs(this._lastBgH - bgH) > 0.5 ||
      Math.abs(this._lastBgX - bgX_abs) > 0.5 || Math.abs(this._lastBgY - bgY_abs) > 0.5) {

      this.bgActor.set_size(bgW, bgH);
      this.bgActor.set_position(bgX_local, bgY_local);

      this.clipBox?.set_size(bgW, bgH);
      this.clipBox?.set_position(0, 0);

      this.effect?.setResolution(bgW, bgH);

      this._lastBgW = bgW;
      this._lastBgH = bgH;
      this._lastBgX = bgX_abs;
      this._lastBgY = bgY_abs;
    }

    if (this.bgClone && this.windowClonesContainer) {
      this.bgClone.set_position(-bgX_abs, -bgY_abs);
      this.windowClonesContainer.set_position(-bgX_abs, -bgY_abs);
      if (this.overviewCloneContainer) {
        this.overviewCloneContainer.set_position(-bgX_abs, -bgY_abs);
      }

      let isOverview = Main.overview.visible || Main.overview.animationInProgress;
      let windows = global.get_window_actors();
      let activeWindows = new Set();
      let zIndex = 0;

      if (!isOverview) {
        if (this._overviewClone) { this._overviewClone.destroy(); this._overviewClone = null; }
        if (this._appDisplayClone) { this._appDisplayClone.destroy(); this._appDisplayClone = null; }
        if (this._searchClone) { this._searchClone.destroy(); this._searchClone = null; }

        this.bgClone.show();

        for (let w of windows) {
          let metaWindow = w.get_meta_window();
          if (!metaWindow || metaWindow.minimized || !w.visible) continue;

          // Skip windows completely outside the glass viewport
          let wRight = w.x + w.width;
          let wBottom = w.y + w.height;
          if (wRight < bgX_abs || w.x > bgX_abs + bgW || wBottom < bgY_abs || w.y > bgY_abs + bgH) {
            if (this._windowClones.has(w)) {
              this._windowClones.get(w)?.destroy();
              this._windowClones.delete(w);
            }
            continue;
          }

          activeWindows.add(w);

          let clone: Clutter.Clone | undefined;
          if (!this._windowClones.has(w)) {
            clone = new UnpickableClone({ source: w });
            this.windowClonesContainer.add_child(clone);
            this._windowClones.set(w, clone);
          } else {
            clone = this._windowClones.get(w);
          }

          clone?.set_position(w.x, w.y);
          if (clone) this.windowClonesContainer.set_child_at_index(clone, zIndex);
          zIndex++;
        }
      } else {
        this.bgClone.show();
        let controls = Main.overview._overview?._controls;

        if (controls) {
          if (controls._workspacesDisplay) {
            if (!this._overviewClone) {
              this._overviewClone = new UnpickableClone({ source: controls._workspacesDisplay });
              this.overviewCloneContainer?.add_child(this._overviewClone);
            }
            this._syncActorProperties(controls._workspacesDisplay, this._overviewClone);
          }
          if (controls._appDisplay) {
            if (!this._appDisplayClone) {
              this._appDisplayClone = new UnpickableClone({ source: controls._appDisplay });
              this.overviewCloneContainer?.add_child(this._appDisplayClone);
            }
            this._syncActorProperties(controls._appDisplay, this._appDisplayClone);
          }
          if (controls._searchController && controls._searchController.actor) {
            if (!this._searchClone) {
              this._searchClone = new UnpickableClone({ source: controls._searchController.actor });
              this.overviewCloneContainer?.add_child(this._searchClone);
            }
            this._syncActorProperties(controls._searchController.actor, this._searchClone);
          }
        }
      }

      for (let [w, clone] of this._windowClones.entries()) {
        if (!activeWindows.has(w)) {
          clone.destroy();
          this._windowClones.delete(w);
        }
      }
    }
  }

  _buildClones() {
    if (!this.bgActor) return;

    // Incremental: window clones are created lazily by _syncGeometry() (which
    // AABB-culls out-of-view windows), so avoid pre-creating the full set here.
    if (!this.bgClone) {
      this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
      this.clipBox?.add_child(this.bgClone);
    }

    if (!this.overviewCloneContainer) {
      this.overviewCloneContainer = new Clutter.Actor();
      this.clipBox?.add_child(this.overviewCloneContainer);
      this._overviewClone = null;
      this._appDisplayClone = null;
      this._searchClone = null;
    }

    if (!this.windowClonesContainer) {
      this.windowClonesContainer = new Clutter.Actor();
      this.clipBox?.add_child(this.windowClonesContainer);
      this._windowClones.clear();
    }
  }
  _collectAdaptiveTextTargets(actor: Clutter.Actor | null = this.currentBanner, targets: Clutter.Actor[] = []): Clutter.Actor[] {
    if (!actor) return targets;
    // this.currentBanner ではなく、nullチェック済みの actor を渡す
    return this._findAllTextActors(actor);
  }

  _setActorColor(actor: CustomBannerActor, color: string, skipAnimations = false) {
    if (!actor || typeof actor.set_style !== 'function') return;

    if (!this._styledActors.has(actor)) {
      let origStyle = typeof actor.get_style === 'function' ? actor.get_style() : null;
      this._styledActors.set(actor, origStyle || '');

      actor.connect('destroy', () => {
        if (actor._colorTweenId !== undefined) {
          GLib.source_remove(actor._colorTweenId);
          actor._colorTweenId = undefined;
        }
        this._styledActors.delete(actor);
      });
    }

    if (actor._currentTargetColor === color) return;
    actor._currentTargetColor = color;

    this._animateActorColor(actor, color, 380, skipAnimations);
  }

  _clearAdaptiveStyles() {
    for (const [actor, style] of this._styledActors.entries() as MapIterator<[CustomBannerActor, string]>) {
      if (actor && typeof actor.set_style === 'function') {
        if (actor._colorTweenId !== undefined) {
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

  _applyAdaptiveColorMap(colorMap: Map<Clutter.Actor, string>, skipAnimations = false) {
    if (!colorMap || colorMap.size === 0) return;
    for (const [actor, color] of colorMap.entries()) {
      this._setActorColor(actor as unknown as CustomBannerActor, color, skipAnimations);
    }
  }

  _startAdaptiveColorSampling() {
    if (!this._adaptiveConfig.enabled) return;
    this._updateAdaptiveTextColors();

    if (this._adaptiveTimerId !== 0) return;

    this._adaptiveTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._adaptiveConfig.sampleIntervalMs,
      () => {
        if (!this.currentBanner || !this.bgActor) {
          this._adaptiveTimerId = 0;
          return GLib.SOURCE_REMOVE;
        }
        this._updateAdaptiveTextColors();
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  _stopAdaptiveColorSampling() {
    if (this._adaptiveTimerId !== 0) {
      GLib.source_remove(this._adaptiveTimerId);
      this._adaptiveTimerId = 0;
    }
  }

  _findAllTextActors(actor: Clutter.Actor, foundActors: Clutter.Actor[] = []) {
    if (!actor) return foundActors;

    if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button) {
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

  _updateAdaptiveTextColors() {
    if (!this._adaptiveConfig.enabled || this._adaptiveInFlight) return;

    let [absX, absY] = this.currentBanner?.get_transformed_position() ?? [0, 0];
    if (absY < 0) return;

    const targets = this._collectAdaptiveTextTargets();
    if (targets.length === 0) return;

    this._adaptiveInFlight = true;

    this._contrastSampler
      .chooseColorsForActors(targets, this._adaptiveConfig)
      .then(colorMap => {
        this._applyAdaptiveColorMap(colorMap, this._isFirstAdaptiveRun);
        this._isFirstAdaptiveRun = false; // 初回適用後にフラグを下ろす
      })
      .catch(e => {
        console.error(`[Liquid Glass] Notification adaptive color update failed: ${e}`);
      })
      .finally(() => {
        this._adaptiveInFlight = false;
      });
  }

  _animateActorColor(actor: CustomBannerActor, targetHexColor: string, durationMs = 380, skipAnimations = false) {
    if (!actor || Object.keys(actor).length === 0) return;

    if (actor._colorTweenId) {
      GLib.source_remove(actor._colorTweenId);
      actor._colorTweenId = undefined;
    }

    let themeNode = actor.get_theme_node();
    let startColor = themeNode.get_foreground_color();

    let targetRgb = hexToRgb(targetHexColor);
    let startTime = GLib.get_monotonic_time();

    let origStyle = this._styledActors.get(actor) || '';
    let stylePrefix = origStyle ? `${origStyle} ` : '';

    if (skipAnimations) {
      actor.set_style(`${stylePrefix}color: ${targetHexColor}; -st-icon-foreground-color: ${targetHexColor};`);
      return;
    }

    actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      if (!actor || Object.keys(actor).length === 0) return GLib.SOURCE_REMOVE;

      let currentTime = GLib.get_monotonic_time();
      let elapsedMs = (currentTime - startTime) / 1000;
      let progress = Math.min(elapsedMs / durationMs, 1.0);

      let easeProgress = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;

      let r = Math.round(startColor.red + (targetRgb.r - startColor.red) * easeProgress);
      let g = Math.round(startColor.green + (targetRgb.g - startColor.green) * easeProgress);
      let b = Math.round(startColor.blue + (targetRgb.b - startColor.blue) * easeProgress);

      let currentHex = rgbToHex(r, g, b);

      actor.set_style(`${stylePrefix}color: ${currentHex}; -st-icon-foreground-color: ${currentHex};`);

      if (progress >= 1.0) {
        actor._colorTweenId = undefined;
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;
    // @ts-expect-error
    let bannerBin = this.tray._bannerBin;
    for (let sigId of this._signals) {
      bannerBin.disconnect(sigId);
    }
    this._signals = [];

    this._cleanupCurrentBanner();
  }

  _cleanupCurrentBanner() {
    this._stopAdaptiveColorSampling();
    this._clearAdaptiveStyles();
    // @ts-expect-error
    if (this.tray._bannerBin) {
      // @ts-expect-error
      this.tray._bannerBin.translation_y = 0;
    }

    if (this.currentBanner) {
      this.currentBanner.remove_style_class_name('liquid-glass-transparent');
      this.currentBanner.translation_y = 0;
      this.currentBanner = null;
    }

    if (this._frameSyncId !== 0) {
      GLib.source_remove(this._frameSyncId);
      this._frameSyncId = 0;
    }
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
    this.windowClonesContainer = null;
    this.overviewCloneContainer = null;

    this._windowClones.clear();

    this._lastBgW = undefined;
    this._lastBgH = undefined;
    this._lastBgX = undefined;
    this._lastBgY = undefined;
    this._stableBaseW = undefined;
    this._stableBaseH = undefined;

    this._syncIdleMode = false;
    this._syncStableFrames = 0;
    this._syncLastSignature = '';

    this._isFirstAdaptiveRun = true;
  }

  cleanup() {
    for (let sigId of this._settingsSignals) {
      this._settings.disconnect(sigId);
    }
    this._settingsSignals = [];
    this._removeEffect();
  }
}
