import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import { markOpenTrigger, timed } from '../diagnostics/openLag.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './qsContrastSampler.js';
import Gio from 'gi://Gio';
import { suppressGnomePopupAnimation, hasStyleClass } from './qsUtils.js';
import { CustomSubmenuRenderer } from './customSubmenu.js';
import { CustomQuickSettingsRenderer } from './customQuickSettings.js';
import { QuickSettingsStampAnimation } from './quickSettingsAnimation.js';
import { isActorValid } from '../actors.js';
import { BackdropGlass } from '../rendering/backdropGlass.js';
import type { GlassRegion } from '../rendering/glassRenderer.js';
import {
  QS_DEFAULT_CORNER_RADIUS,
  QS_GLASS_PADDING,
  createQuickSettingsGlass,
  quickSettingsShadowRoom,
} from './glassAppearance.js';
import { hexToColorArray, hexToRgb, adaptiveColorTweener } from '../animation.js';
import { Logger } from '../logger.js';

// The card-backing sync's timer period: short while something is changing,
// longer once the menu has been idle (the syncs themselves stay 750ms apart
// then; the timer only has to notice an animation ending or the menu closing).
const CARD_BACKING_ACTIVE_MS = 16;
const CARD_BACKING_IDLE_WAKE_MS = 100;

const ENABLE_QS_CARD_SHADER = true;

// Drives the verbose [LG-*] animation tracing. Off by default: the template
// literals below were built on every open/close stop regardless of whether
// anything consumes the output.
const LG_DEBUG_ANIM = false;

// Submenu → QS return entrance: fade + subtle rise, crossfaded with the
// submenu shrink. No scale is animated (backings can never drift from
// content) and no BACK overshoot (no extra blurred-FBO repaints under load).
const QS_RETURN_DURATION_MS = 160;
const QS_RETURN_RISE_PX = 8;

// Assumed frame length when converting a duration or the "Animation Interval"
// setting into a number of frames.
const QS_ASSUMED_FRAME_MS = 16.667;

// The affine map from a parent actor's local space to the stage, measured by
// probing the origin and the two unit basis vectors. `identity` means the map
// can be skipped entirely.
interface AffineProjection {
  success: boolean;
  identity: boolean;
  x: number;
  y: number;
  xx: number;
  xy: number;
  yx: number;
  yy: number;
}

// How much larger the glass background should be compared to the actual menu UI.
// const GLASS_EXPAND = 12;   

// Distance to shift the entire menu downwards to avoid overlapping with the top panel.
// const MENU_Y_OFFSET = GLASS_EXPAND + 5;  

// Adaptive text color flags
// const ENABLE_ADAPTIVE_TEXT_COLOR = false;
const SAMPLE_PER_ELEMENT = false;
// const SAMPLE_INTERVAL_MS = 400; // How often to resample colors while the menu is open (in milliseconds)

interface CustomBannerActor extends St.Widget {
  _colorTweenId?: number;
  _currentTargetColor?: string;
  _currentInsensitiveState?: boolean;
  _isUpdatingAlpha?: boolean;
}

export class QuickSettingsManager {
  private extensionPath: string;
  private _settings: Gio.Settings;
  private _logger: Logger;
  private targetActor: St.Widget;
  private menu: any;
  private animActor: St.Widget;
  private _isEffectActive: boolean;
  private buttonAlpha: number;
  private _buttonTimerId: number;
  private _styledButtons: Map<Clutter.Actor, string>;
  private _buttonSignalIds: Map<Clutter.Actor, number[]>;
  private _drilldownSignalIds: Map<Clutter.Actor, { target: any, id: number }[]>;
  private _cardActors: Set<Clutter.Actor>;
  // The one glass every card is drawn into. Same architecture as the calendar
  // menu and the top bar's island style: a BackdropGlass that copies its own
  // backdrop, blurs it once and composites all the card regions in a single
  // pass.
  private _glass: BackdropGlass | null = null;
  private _cardBackingSyncId: number;
  private _cardBackingLastSignature: string;
  private _cardBackingStableFrames: number;
  private _cardBackingIdleMode: boolean;
  // The card-backing timer's current period and callback, so the period can
  // follow the idle state; see _setCardBackingInterval().
  private _cardBackingIntervalMs: number;
  private _cardBackingTick: (() => boolean) | null;
  private _hiddenMenuParts: Map<any, {
    show?: Function;
    visible?: boolean;
    opacity?: number;
    width?: number;
    height?: number;
    reactive?: boolean;
    can_focus?: boolean;
    style?: string;
  }>;
  private _signals: { target: any, id: number }[];
  private _animSignalId: number = 0;
  private _frameSyncId: number;
  private _glassExpand: number;
  private _menuXoffset: number;
  private _menuYoffset: number;

  // ---- Open/close transition -------------------------------------------
  // The whole stamp lives in QuickSettingsStampAnimation: it owns the frame
  // loop, the springs and the single ordered place where scale/opacity are
  // applied and the glass is re-synced. Nothing else may move the popup while
  // it is running.
  private _anim: QuickSettingsStampAnimation | null = null;
  private _enableAnimation: boolean;

  // Mirrors _anim.isRunning for the sync paths that only need to know whether
  // geometry is being driven by the transition.
  private _isAnimating: boolean = false;
  private _contrastSampler: StageContrastSampler;
  private _adaptiveTimerId: number;
  private _adaptiveInFlight: boolean;
  private _styledActors: Map<Clutter.Actor, string>;
  private _settingsSignals: number[];
  private _adaptiveConfig!: typeof AdaptiveContrastConfig;
  private _stableBaseW: number | undefined;
  private _stableBaseH: number | undefined;
  private _lastValidAnimAbsX: number | undefined;
  private _lastValidAnimAbsY: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _cornerRadius: number = 0;
  // Room the grid's drop shadow needs outside the padded region rects, derived
  // from the same shadow-radius/shadow-intensity settings the other glass
  // surfaces honour. Zero while the shadow is off, so the actor is not grown
  // for nothing.
  private _shadowRoom: number = 0;

  private _animationInterval: number = 16;
  private _openScale: number = 1.08;

  private _originalTargetClip: boolean | undefined;
  private _originalAnimClip: boolean | undefined;
  private _originalFirstChildClip: boolean | undefined;
  private _disabledClipActors: Map<Clutter.Actor, boolean> = new Map();
  private _floatingWindow: any = null;
  private _submenuRenderer: any = null;
  private _customQuickSettings: CustomQuickSettingsRenderer | null = null;
  private _suppressNextOpenAnimation: boolean = false;
  private _suppressNextCloseAnimation: boolean = false;
  private _isSubmenuTransitioning: boolean = false;
  private _pendingMenuClosedCallback: (() => void) | null = null;
  // Backstop for GNOME's BoxPointer input mute during our custom close
  // animation; see the onSuppressClose hook in the constructor.
  private _pendingRestoreInput: (() => void) | null = null;
  private _pendingRestoreInputTimeoutId = 0;
  private _restorePopupAnimPatch: (() => void) | null = null;
  private _cardBackingsFrozen: boolean = false;
  private _cardBackingSnapshots: Map<Clutter.Actor, any> = new Map();
  // Generation counter guarding the deferred post-reveal unfreeze: a new
  // submenu handoff invalidates a still-queued unfreeze so it can never clear
  // a fresher frozen snapshot.
  private _frozenUnfreezeGen: number = 0;
  // Generation counter for the submenu → QS return entrance ease. A new close
  // (or disable) invalidates in-flight ease frames and completion callbacks.
  private _revealEaseGen: number = 0;
  // Last good backing geometry per card. When a card reports transient
  // 0-size/unmapped geometry for a frame or two during reflow (notably the
  // borrowed volume/brightness sliders), the backing reuses this instead of
  // hiding, so the glass never flashes missing. Refilled on every valid sync.
  private _cardLastGoodRect: Map<Clutter.Actor, { x: number, y: number, w: number, h: number, sx: number, sy: number, opacity: number, framesLeft: number }> = new Map();
  // The actor the stamp animation actually scales. For Quick Settings this is
  // NOT menu.actor: QuickSettingsMenu overrides menu.actor to a 0x0 wrapper
  // (quickSettings.js) with the real popup (menu._boxPointer) as its child, so
  // scaling menu.actor pivots around stage (0,0). Scaling the boxpointer gives
  // real geometry and a real pivot.
  private _stampActor: St.Widget | null = null;
  // ---- Animation-path scratch state -------------------------------------
  // Reused across ticks instead of reallocated: a single Clutter.Point for
  // matrix transforms.
  private _scratchPoint: any = null;
  // Pending "lazy widget" clip sweep (see _scheduleLateClipSweep).
  private _clipSweepPendingId: number = 0;
  // Card count captured when the menu opened, so the late sweep can tell
  // whether anything actually appeared and skip the expensive re-pass.
  private _sweepBaselineCardCount: number = 0;
  // Result of applying a parent's transform to the stage origin. Card backings
  // and the blur overlay are siblings inserted below the menu, so their parent
  // normally projects identity to the stage, which lets the sync path skip a
  // matrix transform per card and frame.
  private _originProjection: AffineProjection | null = null;
  // Actors that need clip_to_allocation disabled, keyed by the sweep root.
  // Collected once per sweep so later re-applications don't re-walk the tree.
  private _clipTargetsByRoot: WeakMap<Clutter.Actor, Clutter.Actor[]> = new WeakMap();
  // Coalesced card-sync requests: many notify::allocation / child-added signals
  // can fire within a single frame during open/layout. They share one deferred
  // sync instead of each running a full _syncCardBackings synchronously.
  private _cardSyncCoalescedPending: boolean = false;
  private _cardEffectsCoalescedPending: boolean = false;


  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger) {
    this.extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;

    // Target the main container of the Date/Calendar menu
    this.targetActor = Main.panel.statusArea.quickSettings.menu.actor;
    this.menu = Main.panel.statusArea.quickSettings.menu;

    // Target for animations and visual offsets (The inner content)
    this.animActor = Main.panel.statusArea.quickSettings.menu.box;

    // The real popup bubble for QS (menu.actor is a 0x0 wrapper around it).
    this._stampActor = (this.menu as any)._boxPointer ?? this.targetActor;

    this._signals = [];
    this._frameSyncId = 0;
    this._isEffectActive = false;

    this._glassExpand = 0;
    this._menuXoffset = 0;
    this._menuYoffset = 0;

    // The open/close stamp is built in _applyEffect(), where the settings that
    // parameterise it are first read. Until then there is no transition to run.
    this._anim = null;
    this._enableAnimation = true;

    this._contrastSampler = new StageContrastSampler(logger);
    this._adaptiveTimerId = 0;
    this._adaptiveInFlight = false;
    this._styledActors = new Map();

    this._settingsSignals = [];
    this._isEffectActive = false;

    this.buttonAlpha = 0.8;
    this._buttonTimerId = 0;
    this._styledButtons = new Map();
    this._buttonSignalIds = new Map();
    this._drilldownSignalIds = new Map();
    this._cardActors = new Set();
    this._cardBackingSyncId = 0;
    this._cardBackingLastSignature = '';
    this._cardBackingStableFrames = 0;
    this._cardBackingIdleMode = false;
    this._cardBackingIntervalMs = 0;
    this._cardBackingTick = null;
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
      onSuppressOpen: () => {
        this._pendingMenuClosedCallback = null;
        this._flushPendingRestoreInput();
      },
      onSuppressClose: (cb, restoreInput) => {
        this._pendingMenuClosedCallback = cb;
        this._pendingRestoreInput = restoreInput ?? null;
        // Backstop: if our fade-out never finishes, GNOME's input mute would
        // keep Quick Settings open and undismissable.
        if (this._pendingRestoreInputTimeoutId)
          GLib.source_remove(this._pendingRestoreInputTimeoutId);
        this._pendingRestoreInputTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
          this._pendingRestoreInputTimeoutId = 0;
          // The fade-out never reached its end (actor removed, tick stalled,
          // extension disabled mid-close). Finish the close by hand: release
          // the input mute, take the popup off screen and emit 'menu-closed'.
          // This runs at most once -- a fade that does finish clears the
          // timeout source first.
          this._flushPendingRestoreInput();
          const pendingCloseCb = this._pendingMenuClosedCallback;
          this._pendingMenuClosedCallback = null;
          try {
            this.menu?.actor?.hide();
          } catch (e) {}
          pendingCloseCb?.();
          return GLib.SOURCE_REMOVE;
        });
      },
    });
  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

    this._enableAnimation = this._settings.get_boolean('enable-quick-settings-animation');
    this._openScale = Math.max(1.0, this._settings.get_double('quick-settings-open-scale'));

    if (this._settings.get_boolean('enable-quick-settings-glass')) {
      this._applyEffect();
    }
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

  // React to settings changes.
  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    // Toggle the effect on and off.
    connectSetting('enable-quick-settings-glass', () => {
      let enabled = this._settings.get_boolean('enable-quick-settings-glass');
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    connectSetting('enable-quick-settings-animation', () => {
      this._enableAnimation = this._settings.get_boolean('enable-quick-settings-animation');
    });

    connectSetting('quick-settings-spring-stiffness', () => {
      this._applySpringSettings();
    });

    connectSetting('quick-settings-spring-damping', () => {
      this._applySpringSettings();
    });

    connectSetting('quick-settings-spring-mass', () => {
      this._applySpringSettings();
    });

    connectSetting('quick-settings-animation-interval-ms', () => {
      this._animationInterval = this._settings.get_int('quick-settings-animation-interval-ms');
      // Caps the open/close animation's frame rate; a running one picks it up.
      this._anim?.setIntervalMs(this._animationInterval);
    });

    connectSetting('quick-settings-open-scale', () => {
      this._openScale = Math.max(1.0, this._settings.get_double('quick-settings-open-scale'));
      this._anim?.setOpenScale(this._openScale);
    });

    connectSetting('quick-settings-tint-color', () => {
      this._glass?.setTintColor(...hexToColorArray(this._settings.get_string('quick-settings-tint-color')));
    });

    connectSetting('quick-settings-tint-strength', () => {
      this._glass?.setTintStrength(this._settings.get_double('quick-settings-tint-strength'));
    });

    connectSetting('quick-settings-blur-radius', () => {
      this._glass?.setBlurRadius(this._settings.get_int('quick-settings-blur-radius'));
    });

    // The drop shadow is shared with every other glass surface, so the grid
    // follows the same two settings.
    connectSetting('shadow-radius', () => {
      this._applyShadowRoom();
    });

    connectSetting('shadow-intensity', () => {
      this._applyShadowRoom();
    });

    connectSetting('quick-settings-corner-radius', () => {
      this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');
      this._glass?.setCornerRadius(this._cornerRadius || QS_DEFAULT_CORNER_RADIUS);
    });

    connectSetting('quick-settings-glass-expand', () => {
      this._glassExpand = this._settings.get_int('quick-settings-glass-expand');
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
    if (!this.targetActor) return;
    if (!hasStyleClass(this.targetActor, 'liquid-glass-transparent')) this.targetActor.add_style_class_name('liquid-glass-transparent');
    if (!hasStyleClass(this.animActor, 'liquid-glass-transparent')) this.animActor.add_style_class_name('liquid-glass-transparent');

    if (!hasStyleClass(this.animActor, 'liquid-glass-qs-root')) this.animActor.add_style_class_name('liquid-glass-qs-root');
  }

  // Walks the tree once, recording which actors actually own a
  // clip_to_allocation property, then applies the change. Repeat sweeps (the
  // submenu paths fire four of them) replay the recorded list for that same
  // root instead of re-traversing every widget in the menu.
  //
  // The list is keyed by root because callers sweep different subtrees
  // (targetActor for the menu, _stampActor for the popup); a single shared list
  // would let one sweep silently discard the other's targets.
  // Releases the input mute GNOME applies while a popup animates closed. Safe
  // to call when nothing is pending.
  private _flushPendingRestoreInput() {
    if (this._pendingRestoreInputTimeoutId) {
      GLib.source_remove(this._pendingRestoreInputTimeoutId);
      this._pendingRestoreInputTimeoutId = 0;
    }
    const restore = this._pendingRestoreInput;
    this._pendingRestoreInput = null;
    try {
      restore?.();
    } catch (e) {}
  }

  _disableClippingRecursively(actor: Clutter.Actor) {
    if (!actor) return;
    let targets: Clutter.Actor[] = [];
    this._collectClipTargets(actor, targets);
    this._clipTargetsByRoot.set(actor, targets);
    this._applyClipTargets(targets);
  }

  _collectClipTargets(actor: Clutter.Actor, targets: Clutter.Actor[]) {
    if (!actor || !isActorValid(actor)) return;
    if ('clip_to_allocation' in actor) {
      targets.push(actor);
    }
    let children = actor.get_children();
    for (let child of children) {
      this._collectClipTargets(child, targets);
    }
  }

  // Re-applies a previously collected sweep. Actors the shell has since
  // destroyed are skipped and dropped from the list. When no sweep has been
  // recorded for this root (e.g. the tree grew since), it walks afresh.
  _applyClipTargetsFor(root: Clutter.Actor) {
    return timed('clipTargets', () => this._applyClipTargetsForImpl(root));
  }

  _applyClipTargetsForImpl(root: Clutter.Actor) {
    if (!root) return;
    let targets = this._clipTargetsByRoot.get(root);
    if (!targets) {
      this._disableClippingRecursively(root);
      return;
    }
    this._applyClipTargets(targets);
  }

  _applyClipTargets(targets: Clutter.Actor[]) {
    let live: Clutter.Actor[] = [];
    for (let actor of targets) {
      if (!isActorValid(actor)) continue;
      try {
        if (!this._disabledClipActors.has(actor)) {
          this._disabledClipActors.set(actor, actor.clip_to_allocation);
        }
        actor.clip_to_allocation = false;
        live.push(actor);
      } catch (e) {}
    }
    targets.length = 0;
    for (let actor of live) targets.push(actor);
  }

  _restoreClippingRecursively(actor: Clutter.Actor) {
    if (!actor || !isActorValid(actor)) return;
    if ('clip_to_allocation' in actor && this._disabledClipActors.has(actor)) {
      actor.clip_to_allocation = this._disabledClipActors.get(actor) ?? true;
    }
    let children = actor.get_children();
    for (let child of children) {
      this._restoreClippingRecursively(child);
    }
  }

  _connectSubmenuClipping() {
    let grid = (this.menu as any)._grid;
    if (grid) {
      let children = grid.get_children();
      for (let child of children) {
        if (child && (child as any).menu && typeof (child as any).menu.connect === 'function') {
          let signalId = (child as any).menu.connect('open-state-changed', (menu: any, isOpen: boolean) => {
            if (isOpen) {
              this._disableClippingRecursively(this.targetActor);
              // Delay sweeps to catch asynchronous elements inside the submenu.
              // Later passes replay the collected target list; if lazy widgets
              // have appeared they are still covered because a fresh full walk
              // runs on the next submenu open.
              for (let delay of [50, 150, 300, 600]) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                  if (this._isEffectActive && this.menu.isOpen) {
                    this._applyClipTargetsFor(this.targetActor);
                  }
                  return GLib.SOURCE_REMOVE;
                });
              }
            }
          });
          this._signals.push({ target: (child as any).menu, id: signalId });
        }
      }
    }
  }

  // The one glass the whole grid is drawn into, created lazily and inserted
  // directly below the popup so it reads the stage before the menu paints.
  _getOrCreateGlass(): BackdropGlass | null {
    let glass = this._glass;
    if (glass && isActorValid(glass)) return glass;

    let parent = this.menu?.actor?.get_parent?.() || Main.layoutManager.uiGroup;
    if (!parent) return null;

    glass = createQuickSettingsGlass(this, {
      owner: 'quick-settings',
      outline: 'quick-settings',
      multiRegion: true,
      cornerRadius: this._cornerRadius || QS_DEFAULT_CORNER_RADIUS,
    });
    this._shadowRoom = quickSettingsShadowRoom(this._settings);
    glass.set_size(2, 2);
    glass.opacity = 0;
    glass.hide();

    try {
      parent.insert_child_below(glass, this.menu.actor);
    } catch (e) {
      try { parent.add_child(glass); } catch (e2) {}
    }

    this._glass = glass;
    return glass;
  }

  // How far each region's drop shadow reaches past its body, or 0 when the
  // shadow is off. The shader caps the shadow at `shadow_max_radius`, so the
  // actor only has to offer this much room.
  _computeShadowRoom(): number {
    return quickSettingsShadowRoom(this._settings);
  }

  // Pushes a changed shadow setting into the glass. The margin is part of the
  // geometry the sync builds, so the next sync resizes the actor around it.
  _applyShadowRoom() {
    const room = this._computeShadowRoom();
    if (room === this._shadowRoom) return;

    this._shadowRoom = room;
    try { this._glass?.setShadowMaxRadius(room); } catch (e) {}
    try { this._wakeCardBackingSync(); } catch (e) {}
  }

  // No per-card actor exists any more (one multi-region glass draws them all),
  // so this only drops the card's cached geometry hints.
  _removeCardBacking(card: Clutter.Actor) {
    this._cardLastGoodRect.delete(card);
    this._cardBackingSnapshots.delete(card);
  }

  _setCardBackingsOpacity(opacity: number) {
    const glass = this._glass;
    if (!glass) return;
    try {
      glass.opacity = opacity;
      if (opacity <= 0) glass.hide();
    } catch (e) {}
  }

  // Projects a parent-local origin onto the stage once per sync and caches it.
  // Card backings and the blur overlay are siblings inserted below the menu, so
  // when the parent's origin already sits at stage (0,0) with no scaling or
  // rotation, a parent-local coordinate *is* a stage coordinate and the
  // per-card matrix multiply can be skipped. When the parent does carry a
  // transform, the affine map is reused for every card instead of being derived
  // per card. GJS has no floating-point fast-math, so two geometrically
  // identical computations produce identical components and comparing them
  // exactly is safe here.
  _getOriginProjection(parent: Clutter.Actor | null) {
    if (this._originProjection) return this._originProjection;

    let projection: AffineProjection = {
      success: false,
      identity: false,
      x: 0,
      y: 0,
      xx: 1, xy: 0, yx: 0, yy: 1,
    };
    this._originProjection = projection;
    if (!parent) return projection;

    let toStage = typeof parent.apply_relative_transform_to_point === 'function';

    let origin: { x: number, y: number } | null = null;
    let unitX: { x: number, y: number } | null = null;
    let unitY: { x: number, y: number } | null = null;

    try {
      if (toStage) {
        if (!this._scratchPoint) this._scratchPoint = new (Clutter as any).Point({ x: 0, y: 0 });
        let point = this._scratchPoint;

        let project = (px: number, py: number) => {
          point.x = px;
          point.y = py;
          let result: any = parent.apply_relative_transform_to_point(null, point);
          let success = result?.[0];
          let transformed = result?.[1];
          if (!success || !transformed) return null;
          if (typeof transformed.x === 'number') return { x: transformed.x, y: transformed.y };
          return null;
        };

        origin = project(0, 0);
        unitX = project(1, 0);
        unitY = project(0, 1);
      } else {
        let [success, ox, oy] = parent.transform_stage_point(0, 0);
        if (success) origin = { x: ox, y: oy };
        if (success) {
          let [okX, xx, xy] = parent.transform_stage_point(1, 0);
          if (okX) unitX = { x: xx, y: xy };
          let [okY, yx, yy] = parent.transform_stage_point(0, 1);
          if (okY) unitY = { x: yx, y: yy };
        }
      }
    } catch (e) {}

    if (origin && unitX && unitY) {
      projection.success = true;
      projection.x = origin.x;
      projection.y = origin.y;
      projection.xx = unitX.x - origin.x;
      projection.xy = unitX.y - origin.y;
      projection.yx = unitY.x - origin.x;
      projection.yy = unitY.y - origin.y;
      // Only the top-left 2x2 and the translation are measured, so an identity
      // test here means "identical in the xy plane" — sufficient because this
      // map is only ever applied to 2D positions.
      projection.identity = origin.x === 0 && origin.y === 0 &&
        projection.xx === 1 && projection.xy === 0 &&
        projection.yx === 0 && projection.yy === 1;
    } else if (origin) {
      // Translation-only fallback when the basis probes failed.
      projection.success = true;
      projection.x = origin.x;
      projection.y = origin.y;
      projection.identity = origin.x === 0 && origin.y === 0;
    }

    return projection;
  }

  // Single BEFORE_REDRAW/idle hook shared by all deferred card work. Queuing
  // through the compositor keeps heavy sync off the synchronous open path so
  // the first frame can paint before backings/clones are built.
  _addLaterOnce(callback: () => boolean): void {
    try {
      if (global.compositor?.get_laters) {
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, callback);
        return;
      }
    } catch (e) {}
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, callback);
  }

  // Coalesced backing sync: allocation bursts during open/layout collapse into
  // one BEFORE_REDRAW sync instead of N synchronous full-tree syncs.
  _requestCardBackingSyncCoalesced() {
    if (this._cardSyncCoalescedPending) return;
    this._cardSyncCoalescedPending = true;
    this._addLaterOnce(() => {
      this._cardSyncCoalescedPending = false;
      if (!this._isEffectActive) return GLib.SOURCE_REMOVE;
      try { this._wakeCardBackingSync(); } catch (e) {}
      return GLib.SOURCE_REMOVE;
    });
  }

  // Coalesced card-effects re-apply for child-added/allocation bursts.
  _requestCardEffectsCoalesced() {
    if (this._cardEffectsCoalescedPending) return;
    this._cardEffectsCoalescedPending = true;
    this._addLaterOnce(() => {
      this._cardEffectsCoalescedPending = false;
      if (!this._isEffectActive || !this.menu?.isOpen) return GLib.SOURCE_REMOVE;
      try {
        this._applyCardEffects();
        this._wakeCardBackingSync();
      } catch (e) {}
      return GLib.SOURCE_REMOVE;
    });
  }

  // Call-site stable wrapper. The per-card and overlay clone rebuild arguments
  // are gone: one multi-region glass owns the whole grid's backdrop now, so
  // every sync just rebuilds the region list and re-captures the stage.
  _syncCardBackings(_skipWindowClones = false, _rebuildWindowClones = true, _frameWindowActors: any[] | null = null,
    _forceCloneRebuild = false) {
    return timed('cardBackings', () => this._syncCardBackingsImpl());
  }

  // Builds this frame's card regions and hands them to the one glass. Each card
  // keeps its own rounded-rect region (with its own corner radius and tint), so
  // the grid still reads as separate buttons; the capture, the blur and the
  // shader pass are shared, the same architecture as the calendar menu's single
  // sheet and the top bar's island style.
  _syncCardBackingsImpl() {
    if (!this.menu?.actor?.mapped && !this._isAnimating) return;

    const parent = this.menu?.actor?.get_parent?.() || Main.layoutManager.uiGroup;
    if (!parent) return;
    const glass = this._getOrCreateGlass();
    if (!glass) return;

    try {
      if (glass.get_parent() !== parent) {
        glass.get_parent()?.remove_child(glass);
        if (this.menu?.actor && parent.contains(this.menu.actor))
          parent.insert_child_below(glass, this.menu.actor);
        else
          parent.add_child(glass);
      }
    } catch (e) {}

    // Recomputed once per sync; this doubles as the tick's frame token.
    this._originProjection = null;
    const projection = this._getOriginProjection(parent);
    const projectionIsIdentity = projection.identity;

    const regions: GlassRegion[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let opacity = 255;
    let visibleCount = 0;
    const pad = QS_GLASS_PADDING;

    const pushRegion = (x: number, y: number, w: number, h: number, stCard: any) => {
      const isCircle = !!stCard.has_style_class_name?.('liquid-glass-card-circle');
      const isSquircle = !!stCard.has_style_class_name?.('liquid-glass-card-squircle');
      const isPill = !!stCard.has_style_class_name?.('liquid-glass-card-pill');
      let radius: number;
      if (isCircle || isPill) radius = Math.min(w, h) / 2;
      else if (isSquircle) radius = Math.round(Math.min(w, h) * 0.46);
      else radius = this._cornerRadius || QS_DEFAULT_CORNER_RADIUS;

      let isChecked = false;
      try { if (stCard.checked === true) isChecked = true; } catch (e) {}
      try { if (stCard.has_style_pseudo_class?.('checked')) isChecked = true; } catch (e) {}
      try { if (stCard.has_style_class_name?.('checked')) isChecked = true; } catch (e) {}

      // GNOME Blue while checked, the global tint otherwise (baseStrength 0).
      const tintR = isChecked ? 53 / 255 : 1.0;
      const tintG = isChecked ? 132 / 255 : 1.0;
      const tintB = isChecked ? 228 / 255 : 1.0;
      const baseStrength = isChecked ? 0.35 : 0.0;

      // The region rect includes the shader's `padding`; the shader insets it
      // back out to get the body (see glass.frag / GlassGeometry).
      const rx = x - pad;
      const ry = y - pad;
      const rw = w + pad * 2;
      const rh = h + pad * 2;
      regions.push({ x: rx, y: ry, w: rw, h: rh, tintR, tintG, tintB, baseStrength, radius });
      if (rx < minX) minX = rx;
      if (ry < minY) minY = ry;
      if (rx + rw > maxX) maxX = rx + rw;
      if (ry + rh > maxY) maxY = ry + rh;
      visibleCount++;
    };

    for (const card of Array.from(this._cardActors)) {
      const stCard = card as any;
      try {
        let [x, y] = card.get_transformed_position();
        let [w, h] = card.get_size();

        const snapshot = (this._cardBackingsFrozen && !this._isAnimating)
          ? this._cardBackingSnapshots.get(card) : null;
        if (snapshot) { x = snapshot.x; y = snapshot.y; w = snapshot.w; h = snapshot.h; }

        if (
          !card.visible || !card.mapped ||
          Number.isNaN(x) || Number.isNaN(y) ||
          Number.isNaN(w) || Number.isNaN(h) ||
          w <= 2 || h <= 2
        ) {
          // Transient reflow grace: a card (usually a borrowed slider) can
          // report 0-size for a frame while layout settles. Reuse its last good
          // rect for a few frames so its region never flashes missing.
          const grace = this._cardLastGoodRect.get(card);
          if (grace && grace.framesLeft > 0) {
            grace.framesLeft--;
            pushRegion(grace.x, grace.y, grace.w, grace.h, stCard);
          } else {
            this._cardLastGoodRect.delete(card);
          }
          continue;
        }

        let effectiveOpacity = 255;
        if (typeof card.get_paint_opacity === 'function') {
          effectiveOpacity = card.get_paint_opacity();
        } else {
          let curr: Clutter.Actor | null = card;
          while (curr && curr !== parent) {
            effectiveOpacity = (effectiveOpacity * curr.opacity) / 255;
            curr = curr.get_parent();
          }
        }
        // Every card shares the popup's ancestors, so one value fades the whole
        // grid's glass in lockstep with the content.
        opacity = Math.round(effectiveOpacity);

        let effectiveScale = 1.0;
        let currScale: Clutter.Actor | null = card;
        while (currScale && currScale !== parent) {
          effectiveScale *= currScale.scale_x;
          currScale = currScale.get_parent();
        }
        if (this._cardBackingsFrozen && snapshot) effectiveScale = snapshot.effectiveScale;

        let unscaledX = x;
        let unscaledY = y;
        let trackingScale = 1.0;
        // Stamp open animation: the whole popup is scaled about the boxpointer's
        // pivot. Track it so the glass stays glued to the content.
        if (this._isAnimating && effectiveScale > 0.001 && Math.abs(effectiveScale - 1) > 0.001) {
          trackingScale = effectiveScale;
        } else if (!this._isAnimating && effectiveScale > 0.001 && effectiveScale < 0.999 && this.animActor) {
          const [animX, animY] = this.animActor.get_transformed_position();
          const [animW, animH] = this.animActor.get_size();
          const pivotX = animX + this.animActor.pivot_point.x * animW * this.animActor.scale_x;
          const pivotY = animY + this.animActor.pivot_point.y * animH * this.animActor.scale_y;
          unscaledX = pivotX + (x - pivotX) / effectiveScale;
          unscaledY = pivotY + (y - pivotY) / effectiveScale;
        }

        let regionX = unscaledX;
        let regionY = unscaledY;
        if (projection.success && !projectionIsIdentity) {
          regionX = projection.x + projection.xx * unscaledX + projection.yx * unscaledY;
          regionY = projection.y + projection.xy * unscaledX + projection.yy * unscaledY;
        }
        let regionW = w * trackingScale;
        let regionH = h * trackingScale;

        // A circle-classified card in a non-square cell would render an oval;
        // clamp to the shorter side so the region (and its radius) stay round.
        if (stCard.has_style_class_name?.('liquid-glass-card-circle')) {
          const side = Math.min(regionW, regionH);
          regionW = side;
          regionH = side;
        }

        this._cardLastGoodRect.set(card, {
          x: regionX, y: regionY, w: regionW, h: regionH,
          sx: 1, sy: 1, opacity: Math.round(effectiveOpacity), framesLeft: 3,
        });

        pushRegion(regionX, regionY, regionW, regionH, stCard);
      } catch (e) {}
    }

    if (visibleCount === 0) {
      try { glass.hide(); glass.opacity = 0; } catch (e) {}
      return;
    }

    if (regions.length > 16)
      this._logger.log(`[Liquid Glass] Quick Settings has ${regions.length} cards; only the first 16 get glass regions.`);

    // Every region draws its own drop shadow, which reaches past the region
    // rect. The actor clips at its allocation, so it has to cover the shadow as
    // well: the shader's `padding` inset already spends `pad` of the reach, and
    // the rest is added here.
    const shadowMargin = Math.max(0, this._shadowRoom - pad);
    const bboxX = Math.floor(minX) - shadowMargin;
    const bboxY = Math.floor(minY) - shadowMargin;
    const bboxW = Math.max(1, Math.ceil(maxX) + shadowMargin - bboxX);
    const bboxH = Math.max(1, Math.ceil(maxY) + shadowMargin - bboxY);

    const relative: GlassRegion[] = regions.map(r => ({
      x: r.x - bboxX, y: r.y - bboxY, w: r.w, h: r.h,
      tintR: r.tintR, tintG: r.tintG, tintB: r.tintB,
      baseStrength: r.baseStrength, radius: r.radius,
    }));

    try {
      glass.set_position(bboxX, bboxY);
      glass.set_size(bboxW, bboxH);
      glass.setResolution(bboxW, bboxH);
      glass.setGlassGeometry(0, 0, bboxW, bboxH);
      glass.setGlassRegions(relative);
      if (!glass.visible) glass.show();
      glass.opacity = opacity;
      glass.syncSources();
    } catch (e) {}
  }

  getSubmenuMorphBounds(card: Clutter.Actor) {
    try {
      if (!card)
        return null;

      this._syncCardBackings();

      // The one glass draws this card's region itself, so the card's own rect
      // is the morph source.
      let source: any = card;
      let [x, y] = source.get_transformed_position();
      let [w, h] = source.get_size();
      let scaleX = typeof source.scale_x === 'number' ? source.scale_x : 1.0;
      let scaleY = typeof source.scale_y === 'number' ? source.scale_y : 1.0;
      w *= scaleX;
      h *= scaleY;
      if (
        Number.isNaN(x) || Number.isNaN(y) ||
        Number.isNaN(w) || Number.isNaN(h) ||
        w <= 2 || h <= 2
      )
        return null;

      return { x, y, w, h, centerX: x + w / 2, centerY: y + h / 2 };
    } catch (e) {
      return null;
    }
  }

  _getCardBackingSignature() {
    let parts: string[] = [];

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
    } catch (e) {}

    return parts.join('|');
  }

  _wakeCardBackingSync() {
    // During the return entrance the ease owns per-frame syncs (move-only).
    // Keep the idle timer stopped: animating opacity would defeat its idle
    // detection and trigger full clone rebuilds every frame. Stray wakes
    // during the ease only re-sync geometry.
    if (this._revealEaseGen !== 0) {
      try { this._syncCardBackings(false, false); } catch (e) {}
      return;
    }
    this._cardBackingIdleMode = false;
    if (this._cardBackingSyncId !== 0) {
      this._syncCardBackings();
      this._cardBackingLastSignature = this._getCardBackingSignature();
      this._setCardBackingInterval(CARD_BACKING_ACTIVE_MS);
      return;
    }
    this._startCardBackingSync();
  }

  // Changes the period of the card-backing timer. Idle, nothing is due for
  // 750ms, so the timer only has to look often enough to notice an animation
  // ending or the menu closing; a 16ms period there is 60 empty wakeups a
  // second. Waking it needs the short period back at once.
  _setCardBackingInterval(ms: number) {
    if (this._cardBackingSyncId === 0 || this._cardBackingTick === null ||
        this._cardBackingIntervalMs === ms)
      return;
    GLib.source_remove(this._cardBackingSyncId);
    this._cardBackingIntervalMs = ms;
    this._cardBackingSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, this._cardBackingTick);
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
        this._cardBackingTick = null;
        this._cardBackingIntervalMs = 0;
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
      } else {
        this._cardBackingStableFrames = 0;
        this._cardBackingIdleMode = false;
        this._cardBackingLastSignature = signature;
      }

      // A stop during the sync ends the timer for good.
      if (this._cardBackingTick !== syncTick) return GLib.SOURCE_REMOVE;
      const want = this._cardBackingIdleMode ? CARD_BACKING_IDLE_WAKE_MS : CARD_BACKING_ACTIVE_MS;
      if (want !== this._cardBackingIntervalMs) {
        this._cardBackingIntervalMs = want;
        this._cardBackingSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, want, syncTick);
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    };

    // The backdrop is live before the first 16ms tick so the menu's first
    // painted frame already shows the real windows; the glass's relays keep it
    // current afterwards without any window-set token of our own.
    this._syncCardBackings();
    this._cardBackingLastSignature = this._getCardBackingSignature();
    this._cardBackingTick = syncTick;
    this._cardBackingIntervalMs = CARD_BACKING_ACTIVE_MS;
    this._cardBackingSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CARD_BACKING_ACTIVE_MS, syncTick);
  }

  _stopCardBackingSync(keepFrozen = false) {
    if (this._cardBackingSyncId !== 0) {
      GLib.source_remove(this._cardBackingSyncId);
      this._cardBackingSyncId = 0;
    }
    this._cardBackingTick = null;
    this._cardBackingIntervalMs = 0;
    this._cardBackingIdleMode = false;
    this._cardBackingStableFrames = 0;
    this._cardBackingLastSignature = '';
    // Submenu handoffs keep the frozen snapshot alive (the return path renders
    // it); every other path resumes live tracking.
    if (!keepFrozen) this._unfreezeCardBackings();
  }

  // Lightweight freeze for submenu handoffs: records each card's settled
  // geometry WITHOUT running a full _syncCardBackings (which would rebuild
  // every card's window clones on the click path). The backings and their
  // clones stay alive; _syncCardBackings renders the snapshot while frozen,
  // so the return reveal paints exact glass on the first frame.
  _freezeCardBackingsSnapshot(): boolean {
    if (!this.menu?.actor?.mapped) return false;

    let parent = this.menu?.actor?.get_parent?.() || Main.layoutManager.uiGroup;
    let snapshot = new Map<Clutter.Actor, any>();
    let validCount = 0;

    for (let card of Array.from(this._cardActors)) {
      try {
        let [x, y] = card.get_transformed_position();
        let [w, h] = card.get_size();
        if (
          !card.visible || !card.mapped ||
          Number.isNaN(x) || Number.isNaN(y) ||
          Number.isNaN(w) || Number.isNaN(h) ||
          w <= 2 || h <= 2
        )
          continue;

        let effectiveScale = 1.0;
        let currScale: Clutter.Actor | null = card;
        while (currScale && currScale !== parent) {
          effectiveScale *= currScale.scale_x;
          currScale = currScale.get_parent();
        }

        snapshot.set(card, { x, y, w, h, effectiveScale });
        validCount++;
      } catch (e) {}
    }

    if (validCount === 0) return false;

    this._cardBackingSnapshots = snapshot;
    this._cardBackingsFrozen = true;
    return true;
  }

  // NOTE: there is deliberately no "capture mid-animation and pin the glass"
  // path here any more. Pinning each card's settled rect while the stamp was
  // still scaling the content is exactly what made the icons sit outside their
  // liquid glass for the whole open and then snap at the end. The snapshot map
  // below is now only ever used for a *hidden, static* menu (the submenu
  // hand-off), never while the stamp is running.

  _unfreezeCardBackings() {
    this._cardBackingsFrozen = false;
    this._cardBackingSnapshots.clear();
  }

  _disconnectDrilldown(card: Clutter.Actor) {
    let signalItems = this._drilldownSignalIds.get(card);
    if (signalItems) {
      for (let item of signalItems) {
        try { item.target.disconnect(item.id); } catch (e) {}
      }
      this._drilldownSignalIds.delete(card);
    }

    let stCard = card as any;
    delete stCard._liquidGlassDrilldownConnected;
  }

  _showMenuToggleContent(card: Clutter.Actor) {
    let stCard = card as any;
    // GNOME 51 sliders (volume / brightness / input) are QuickSlider subclasses
    // whose menus are opened by their own _iconButton and by a 'popup-menu'
    // signal on the inner slider -- not by anything we can rewire here. They
    // also have no title, so the submenu classifier below can never match them.
    // Leave them entirely native so the stock sound-output menu keeps working.
    if (stCard?.has_style_class_name?.('quick-slider'))
      return;
    // Default to keeping the native button; _connectMenuToggleDrilldown
    // clears this only for cards it actually takes over.
    stCard._liquidGlassKeepNativeMenuButton = true;
    for (let actor of [stCard._customToggle, stCard.button, stCard._box]) {
      try {
        if (actor) {
          actor.visible = true;
          actor.opacity = 255;
          actor.show?.();
        }
      } catch (e) {}
    }

    this._hideNativeMenuPart(stCard._separator);
    // GNOME 51 wires the submenu to _menuButton ('clicked' -> menu.open()).
    // Hiding it without a working replacement leaves the card with no way to
    // open its menu, so only hide it once the drill-down is actually wired.
    const nativeMenuBtn = stCard._menuButton || stCard._arrow || stCard._menuButtonActor;
    if (!stCard._liquidGlassKeepNativeMenuButton)
      this._hideNativeMenuPart(nativeMenuBtn);
    stCard.add_style_class_name?.('liquid-glass-menu-toggle-has-arrow');
    this._prepareMenuToggleLabels(card);
    // Don't draw LG's custom arrow on top of a native button we kept.
    if (!stCard._liquidGlassKeepNativeMenuButton)
      this._ensureCustomMenuArrow(card);
  }

  _prepareMenuToggleLabels(card: Clutter.Actor) {
    let labels: any[] = [];
    let visit = (actor: any) => {
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
      } catch (e) {}
    }
  }

  _ensureCustomMenuArrow(card: Clutter.Actor) {
    let stCard = card as any;
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
      } catch (e) {}
    };

    try {
      (card as any).add_child?.(arrow);
      positionArrow();
    } catch (e) {
      try { arrow.destroy(); } catch (e2) {}
      return;
    }

    let fadeArrow = (visible: boolean) => {
      try {
        (arrow as any).ease({
          opacity: visible ? 255 : 0,
          duration: 120,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      } catch (e) {
        arrow.opacity = visible ? 255 : 0;
      }
      for (let actor of [stCard._customToggle, stCard.button, stCard._box]) {
        if (!actor || actor === arrow)
          continue;
        try {
          (actor as any).ease({
            opacity: visible ? 170 : 255,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
        } catch (e) {
          try { actor.opacity = visible ? 170 : 255; } catch (e2) {}
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

  _removeCustomMenuArrow(card: Clutter.Actor) {
    let stCard = card as any;
    if (stCard._liquidGlassCustomArrowHoverSignals) {
      for (let id of stCard._liquidGlassCustomArrowHoverSignals) {
        try { card.disconnect(id); } catch (e) {}
      }
      delete stCard._liquidGlassCustomArrowHoverSignals;
    }
    if (stCard._liquidGlassCustomArrowAllocationId) {
      try { card.disconnect(stCard._liquidGlassCustomArrowAllocationId); } catch (e) {}
      delete stCard._liquidGlassCustomArrowAllocationId;
    }
    if (stCard._liquidGlassCustomArrow) {
      try { stCard._liquidGlassCustomArrow.destroy(); } catch (e) {}
      delete stCard._liquidGlassCustomArrow;
    }
    try { stCard.remove_style_class_name?.('liquid-glass-menu-toggle-has-arrow'); } catch (e) {}
    for (let actor of [stCard._customToggle, stCard.button, stCard._box]) {
      try { actor.opacity = 255; } catch (e) {}
    }
  }

  _hideNativeMenuPart(actor: any) {
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

    try { actor.hide?.(); } catch (e) {}
    try { actor.visible = false; } catch (e) {}
    try { actor.opacity = 0; } catch (e) {}
    try { actor.width = 0; } catch (e) {}
    try { actor.height = 0; } catch (e) {}
    try { actor.set_width?.(0); } catch (e) {}
    try { actor.set_height?.(0); } catch (e) {}
    try { actor.set_size?.(0, 0); } catch (e) {}
    try { actor.reactive = false; } catch (e) {}
    try { actor.can_focus = false; } catch (e) {}
    const hiddenStyle = 'min-width: 0px; max-width: 0px; width: 0px; min-height: 0px; max-height: 0px; height: 0px; ' +
      'padding: 0px; margin: 0px; border: none; border-left-width: 0px; border-right-width: 0px; ' +
      'background-color: transparent; opacity: 0;';
    try { actor.set_style?.(hiddenStyle); } catch (e) {}
    try { actor.show = () => {}; } catch (e) {}
  }

  _restoreNativeMenuPart(actor: any) {
    if (!actor)
      return;

    let original = this._hiddenMenuParts.get(actor);
    if (!original)
      return;

    try {
      if (original.show)
        actor.show = original.show;
    } catch (e) {}
    try { actor.visible = original.visible ?? true; } catch (e) {}
    try { actor.opacity = original.opacity ?? 255; } catch (e) {}
    try { actor.width = original.width ?? actor.width; } catch (e) {}
    try { actor.height = original.height ?? actor.height; } catch (e) {}
    try {
      if (original.width !== undefined)
        actor.set_width?.(original.width);
    } catch (e) {}
    try {
      if (original.height !== undefined)
        actor.set_height?.(original.height);
    } catch (e) {}
    try { actor.reactive = original.reactive ?? actor.reactive; } catch (e) {}
    try { actor.can_focus = original.can_focus ?? actor.can_focus; } catch (e) {}
    try { actor.set_style?.(original.style || ''); } catch (e) {}
    try {
      if (original.visible !== false)
        actor.show?.();
      else
        actor.hide?.();
    } catch (e) {}
    this._hiddenMenuParts.delete(actor);
  }

  _restoreMenuToggleParts(card: Clutter.Actor) {
    let stCard = card as any;
    this._restoreNativeMenuPart(stCard._separator);
    this._restoreNativeMenuPart(stCard._menuButton);
    this._restoreNativeMenuPart(stCard._arrow);
    this._restoreNativeMenuPart(stCard._menuButtonActor);
  }

  _getCustomSubmenuKind(card: Clutter.Actor): 'bluetooth' | 'wifi' | 'caffeine' | 'power' | 'system' | null {
    let stCard = card as any;
    let quickSettings = Main.panel.statusArea.quickSettings as any;
    
    // Check if it's the SystemItem by looking for a shutdown button inside
    let hasShutdown = false;
    let findShutdown = (actor: any) => {
        if (hasShutdown) return;
        try {
           let iconName = actor.icon_name || actor._icon?.icon_name || actor.get_child?.()?.icon_name || '';
           if (iconName.includes('system-shutdown')) {
               hasShutdown = true;
               return;
           }
        } catch(e) {}
        let kids = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let k of kids) findShutdown(k);
    };
    findShutdown(stCard);
    if (hasShutdown && (stCard.menu || stCard._menu || stCard.hasMenu)) return 'system';


    try {
      let bluetoothItems = quickSettings?._bluetooth?.quickSettingsItems || [];
      if (bluetoothItems.includes(stCard))
        return 'bluetooth';
    } catch (e) {}

    let text = `${stCard?.title || ''} ${stCard?.label || ''}`.toLowerCase();
    
    let icon = '';
    try {
      if (stCard.icon_name) icon = stCard.icon_name;
      else if (stCard._icon && stCard._icon.icon_name) icon = stCard._icon.icon_name;
      else if (stCard.get_child && stCard.get_child()?.icon_name) icon = stCard.get_child().icon_name;
    } catch (e) {}

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
    } catch (e) {}

    return null;
  }

  _connectMenuToggleDrilldown(card: Clutter.Actor) {
    let stCard = card as any;
    // Native sliders own their menu wiring (see _showMenuToggleContent).
    // Never attach a drill-down to them.
    if (stCard?.has_style_class_name?.('quick-slider'))
      return;
    if (!(stCard?.menu || stCard?._menu))
      return;

    if (stCard._liquidGlassDrilldownConnected) {
      // Already wired on an earlier reflow; keep the same decision so repeated
      // reflows don't flip the native button back on.
      stCard._liquidGlassKeepNativeMenuButton = false;
      return;
    }

    let submenuKind = this._getCustomSubmenuKind(card);
    if (!submenuKind)
      return;

    // This card now has a working LG replacement, so the native button can be
    // hidden. Cards that bail out above keep theirs.
    stCard._liquidGlassKeepNativeMenuButton = false;

    let signalItems: { target: any, id: number }[] = [];
    let openDetails = () => {
      let now = GLib.get_monotonic_time();
      if (stCard._liquidGlassLastDrilldown && (now - stCard._liquidGlassLastDrilldown) < 400000)
        return Clutter.EVENT_STOP;

      if ((this._submenuRenderer && this._submenuRenderer._floatingWindow) || stCard._liquidGlassDrilldownPending)
        return Clutter.EVENT_STOP;

      stCard._liquidGlassLastDrilldown = now;
      stCard._liquidGlassDrilldownPending = true;
      this._logger.log(`[Liquid Glass] Drill-down intercepted for ${stCard.title || stCard.label || 'quick setting'}`);
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        stCard._liquidGlassDrilldownPending = false;
        this.showSubmenuInFloatingWindow(stCard, submenuKind);
        return GLib.SOURCE_REMOVE;
      });

      return Clutter.EVENT_STOP;
    };

    let connectEvent = (target: any, signal: string, callback: Function) => {
      if (!target || typeof target.connect !== 'function')
        return;
      try {
        let id = target.connect(signal, callback);
        signalItems.push({ target, id });
      } catch (e) {}
    };

    let isActivationEvent = (event: any) => {
      let eventType;
      try {
        eventType = event.type();
      } catch (e) {
        return false;
      }

      return eventType === Clutter.EventType.BUTTON_PRESS ||
        eventType === Clutter.EventType.TOUCH_BEGIN ||
        eventType === Clutter.EventType.KEY_PRESS;
    };

    let targets = new Set<any>();
    let collectTargets = (actor: any) => {
      if (!actor || targets.has(actor))
        return;

      targets.add(actor);
      try {
        for (let child of actor.get_children?.() ?? [])
          collectTargets(child);
      } catch (e) {}
    };
    
    if (submenuKind === 'system') {
        let shutdownBtn = null;
        let findShutdown = (actor: any) => {
            if (shutdownBtn) return;
            try {
               let iconName = actor.icon_name || actor._icon?.icon_name || actor.get_child?.()?.icon_name || '';
               if (iconName.includes('system-shutdown')) {
                   shutdownBtn = actor;
                   return;
               }
            } catch(e) {}
            let kids = typeof actor.get_children === 'function' ? actor.get_children() : [];
            for (let k of kids) findShutdown(k);
        };
        findShutdown(stCard);
        
        if (shutdownBtn) {
            collectTargets(shutdownBtn);
        } else {
            return; // don't attach to the whole system item
        }
    } else {
        collectTargets(card);
        for (let actor of [stCard.button, stCard._box, stCard._customToggle, stCard._menuButton])
          collectTargets(actor);
    }

    for (let target of targets) {
      connectEvent(target, 'captured-event', (actor: any, event: any) => {
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
      this._logger.log(`[Liquid Glass] Drill-down attached for ${stCard.title || stCard.label || 'quick setting'}`);
    }
  }

  _applyCardEffects() {
    return timed('applyCardEffects', () => this._applyCardEffectsImpl());
  }

  _applyCardEffectsImpl() {
    if (!this.animActor) return;
    
    let mainBoxChildren = this.animActor.get_children();
    let targetLayoutBox = this.animActor;
    if (mainBoxChildren.length === 1 && mainBoxChildren[0].constructor && mainBoxChildren[0].constructor.name.includes('ScrollView')) {
      let scroll = mainBoxChildren[0];
      let bin = (scroll as any).get_first_child();
      if (bin) {
        let layoutBox = bin.get_first_child();
        if (layoutBox) {
          mainBoxChildren = layoutBox.get_children();
          targetLayoutBox = layoutBox;
        }
      }
    }

    let hasClass = (actor: any, className: string) =>
      !!(actor && actor.has_style_class_name && actor.has_style_class_name(className));

    let isGridActor = (actor: any) =>
      !!(actor && ((actor.constructor && actor.constructor.name.includes('Grid')) || hasClass(actor, 'quick-settings-grid')));

    let isSliderActor = (actor: any) => hasClass(actor, 'quick-slider');
    let isToggleActor = (actor: any) =>
      hasClass(actor, 'quick-toggle') || hasClass(actor, 'quick-menu-toggle') || hasClass(actor, 'quick-toggle-has-menu');

    let hasNativeMenu = (actor: any) =>
      !!(actor?.menu || actor?._menu || actor?.hasMenu || hasClass(actor, 'quick-menu-toggle') || hasClass(actor, 'quick-toggle-has-menu'));

    let isCardCandidate = (actor: Clutter.Actor) =>
      actor instanceof St.Button || isSliderActor(actor) || isToggleActor(actor);

    let cards: Clutter.Actor[] = [];

    let collectCards = (actor: Clutter.Actor, allowFallback: boolean = false): boolean => {
      if (!actor || !actor.visible) return false;

      if (isGridActor(actor)) {
        let foundInGrid = false;
        for (let child of (actor as any).get_children?.() ?? []) {
          foundInGrid = collectCards(child, true) || foundInGrid;
        }
        return foundInGrid;
      }

      if (isCardCandidate(actor)) {
        cards.push(actor);
        return true;
      }

      let foundChildCard = false;
      for (let child of (actor as any).get_children?.() ?? []) {
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

    let isCheckableActor = (actor: any) => {
      if (!actor || typeof actor.connect !== 'function') return false;
      try {
        if (typeof actor.checked === 'boolean') return true;
      } catch (e) {}
      try {
        if (actor.has_style_pseudo_class?.('checked')) return true;
      } catch (e) {}
      try {
        if (actor.has_style_class_name?.('checked')) return true;
      } catch (e) {}
      return typeof actor.get_checked === 'function';
    };

    let actorIsChecked = (actor: any) => {
      try {
        if (actor.checked === true) return true;
      } catch (e) {}
      try {
        if (typeof actor.get_checked === 'function' && actor.get_checked() === true) return true;
      } catch (e) {}
      try {
        if (actor.has_style_pseudo_class?.('checked')) return true;
      } catch (e) {}
      try {
        if (actor.has_style_class_name?.('checked')) return true;
      } catch (e) {}
      return false;
    };

    let collectCheckedButtons = (actor: Clutter.Actor, found: any[] = []) => {
      if (isCheckableActor(actor)) found.push(actor);
      let children = (actor as any).get_children ? (actor as any).get_children() : [];
      for (let child of children) {
        collectCheckedButtons(child, found);
      }
      return found;
    };

    let removeCardActor = (card: Clutter.Actor) => {
      let stCard = card as any;
      this._disconnectDrilldown(card);
      this._restoreMenuToggleParts(card);
      this._removeCustomMenuArrow(card);
      if (stCard._checkedSignals) {
        for (let item of stCard._checkedSignals) {
          try { item.button.disconnect(item.id); } catch (e) {}
        }
        delete stCard._checkedSignals;
      }
      if (stCard._liquidGlassArrowHoverSignals) {
        for (let id of stCard._liquidGlassArrowHoverSignals) {
          try { card.disconnect(id); } catch (e) {}
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
      if (newCardSet.has(oldCard)) continue;
      // The walk above is visibility-dependent -- collectCards() bails on any
      // actor that is not `visible` -- and this runs on every open, including
      // while the menu is still hidden. A card the walk could not see this pass
      // has therefore *not* necessarily left the menu, and treating it as gone
      // destroyed every glass backing between opens (then rebuilt them on the
      // next open, which is the stall this rewrite exists to remove). Only a
      // card that really left the menu tree is pruned.
      if (!this._isInMenuTree(oldCard)) {
        removeCardActor(oldCard);
      }
    }

    // Shape classes are applied by diffing instead of by blindly stripping all
    // six and re-adding one. Every add_style_class_name/remove_style_class_name
    // dirties the widget's theme node, and a dirty theme node is re-resolved
    // during the next layout/style pass -- which for a popup with 14 cards and
    // borrowed sliders showed up as a 70-100ms frame right after the call.
    // With the diff, a card whose shape did not change costs nothing.
    const SHAPE_CLASSES = [
      'liquid-glass-card-toggle',
      'liquid-glass-card-slider',
      'liquid-glass-card-circle',
      'liquid-glass-card-squircle',
      'liquid-glass-card-pill',
      'liquid-glass-card-rect',
      'liquid-glass-card-compact',
    ];

    let applyShapeClasses = (stCard: any, desired: string[]) => {
      let wanted = new Set(desired);
      for (let className of SHAPE_CLASSES) {
        let has = !!stCard.has_style_class_name?.(className);
        let want = wanted.has(className);
        if (want && !has) stCard.add_style_class_name?.(className);
        else if (!want && has) stCard.remove_style_class_name?.(className);
      }
    };

    let classifyCard = (card: Clutter.Actor) => {
      let stCard = card as any;
      let [w, h] = card.get_size();
      let aspect = h > 0 ? w / h : 1;

      let isMenuToggle = hasNativeMenu(stCard);
      let isSimpleToggle = hasClass(card, 'quick-toggle') && !isMenuToggle;

      let desired: string[] = [];
      if (isSliderActor(card)) {
        desired.push('liquid-glass-card-slider', 'liquid-glass-card-pill');
      } else if (hasClass(card, 'liquid-glass-custom-card-squircle')) {
        desired.push('liquid-glass-card-squircle');
      } else if (isSimpleToggle) {
        desired.push('liquid-glass-card-circle');
      } else if (isMenuToggle) {
        desired.push('liquid-glass-card-rect');
      } else if (card instanceof St.Button && (Math.abs(w - h) <= 16 || (w <= 70 && h <= 70))) {
        desired.push('liquid-glass-card-circle');
      } else if (aspect >= 2.6 || h <= 48) {
        desired.push('liquid-glass-card-pill');
      } else {
        desired.push('liquid-glass-card-rect');
      }

      if (h > 0 && h <= 52)
        desired.push('liquid-glass-card-compact');

      applyShapeClasses(stCard, desired);
    };

    for (let card of cards) {
      let stCard = card as any;
      let wasKnownCard = this._cardActors.has(card);
      
      if (!stCard.has_style_class_name || !stCard.has_style_class_name('liquid-glass-card')) {
        try {
          if (stCard.add_style_class_name) {
            stCard.add_style_class_name('liquid-glass-card');
          }
        } catch (e) {
          // Ignore failures
        }
      }
      classifyCard(card);

      // Record the classified size so the allocation handler below can skip
      // re-classifying on reflows that report identical sizes.
      try {
        let [caw, cah] = card.get_size();
        stCard._liquidGlassClassifiedW = Math.round(caw);
        stCard._liquidGlassClassifiedH = Math.round(cah);
      } catch (e) {}

      if (hasNativeMenu(stCard)) {
         try {
             let stCard = card as any;
             if (hasNativeMenu(stCard)) {
                 try {
                     // Order matters: the drilldown decides whether LG takes
                     // over the card (and therefore whether the native menu
                     // button may be hidden).
                     this._connectMenuToggleDrilldown(card);
                     this._showMenuToggleContent(card);
                 } catch(e) {}
             }
         } catch(e) {}
      }

      try {
          if (!stCard._liquidGlassCardAllocationId) {
            stCard._liquidGlassCardAllocationId = card.connect('notify::allocation', () => {
              // Reflow fires allocation repeatedly, often with identical or
              // transient sizes; re-classifying each time flaps shape classes
              // (circle vs pill vs rect) mid-animation. Only re-classify when
              // the rounded size actually changed.
              try {
                let [caw, cah] = card.get_size();
                let rw = Math.round(caw), rh = Math.round(cah);
                if (stCard._liquidGlassClassifiedW !== rw || stCard._liquidGlassClassifiedH !== rh) {
                  stCard._liquidGlassClassifiedW = rw;
                  stCard._liquidGlassClassifiedH = rh;
                  classifyCard(card);
                }
              } catch (e) {
                classifyCard(card);
              }
              // Allocation bursts (open/layout settle) share one deferred sync
              // instead of each running a full _syncCardBackings synchronously.
              this._requestCardBackingSyncCoalesced();
            });
          }
      } catch (e) {}
      this._cardActors.add(card);
      // A card that was not here before means the popup tree grew, so the clip
      // sweep recorded for this root is now incomplete. Invalidating it lets
      // the post-open sweep replay a complete list instead of re-walking the
      // whole popup on the frame right after the menu opens.
      if (!wasKnownCard) this._clipTargetsByRoot.delete(this.targetActor);

      if (stCard._checkedSignals) {
        for (let item of stCard._checkedSignals) {
          try { item.button.disconnect(item.id); } catch (e) {}
        }
        delete stCard._checkedSignals;
      }

      let checkedButtons = collectCheckedButtons(card);
      if (checkedButtons.length > 0) {
        let updateParentChecked = () => {
          let anyChecked = checkedButtons.some((button) => actorIsChecked(button));
          if (anyChecked) {
            if (stCard.add_style_class_name) stCard.add_style_class_name('checked');
          } else {
            if (stCard.remove_style_class_name) stCard.remove_style_class_name('checked');
          }
          this._requestCardBackingSyncCoalesced();
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
          } catch (e) {
            return null;
          }
        }).filter((item) => item !== null);
      }
    }

    if (targetLayoutBox) {
      if (!(targetLayoutBox as any)._childAddedId) {
        (targetLayoutBox as any)._childAddedId = targetLayoutBox.connect('child-added', (parent, child) => {
          this._requestCardEffectsCoalesced();
        });
      }

      for (let child of mainBoxChildren) {
        let isGrid = (child.constructor && child.constructor.name.includes('Grid')) || ((child as any).has_style_class_name && (child as any).has_style_class_name('quick-settings-grid'));
        if (isGrid && !(child as any)._gridChildAddedId) {
          (child as any)._gridChildAddedId = child.connect('child-added', (parent, gridChild) => {
            this._requestCardEffectsCoalesced();
          });
        }
      }
    }
  }

  _removeCardEffects() {
    if (!this.animActor) return;
    
    let mainBoxChildren = this.animActor.get_children();
    let targetLayoutBox = this.animActor;
    if (mainBoxChildren.length === 1 && mainBoxChildren[0].constructor && mainBoxChildren[0].constructor.name.includes('ScrollView')) {
      let scroll = mainBoxChildren[0];
      let bin = (scroll as any).get_first_child();
      if (bin) {
        let layoutBox = bin.get_first_child();
        if (layoutBox) {
          mainBoxChildren = layoutBox.get_children();
          targetLayoutBox = layoutBox;
        }
      }
    }

    if (targetLayoutBox && (targetLayoutBox as any)._childAddedId) {
      try {
        targetLayoutBox.disconnect((targetLayoutBox as any)._childAddedId);
      } catch (e) {}
      delete (targetLayoutBox as any)._childAddedId;
    }

    for (let child of mainBoxChildren) {
      let isGrid = (child.constructor && child.constructor.name.includes('Grid')) || ((child as any).has_style_class_name && (child as any).has_style_class_name('quick-settings-grid'));
      if (isGrid && (child as any)._gridChildAddedId) {
        try { child.disconnect((child as any)._gridChildAddedId); } catch (e) {}
        delete (child as any)._gridChildAddedId;
      }
    }

    for (let card of Array.from(this._cardActors)) {
      try {
        let stChild = card as any;
        this._disconnectDrilldown(card);
        this._restoreMenuToggleParts(card);
        this._removeCustomMenuArrow(card);
        if (stChild._checkedSignals) {
          for (let item of stChild._checkedSignals) {
            try { item.button.disconnect(item.id); } catch (e) {}
          }
          delete stChild._checkedSignals;
        }
        if (stChild._liquidGlassCardAllocationId) {
          try { card.disconnect(stChild._liquidGlassCardAllocationId); } catch (e) {}
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
      } catch (e) {}
    }
    this._cardActors.clear();
    for (let actor of Array.from(this._hiddenMenuParts.keys()))
      this._restoreNativeMenuPart(actor);
    this._stopCardBackingSync();
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    if (!this.targetActor) return;

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

    // The visible glass is one multi-region BackdropGlass behind the whole
    // grid (see _getOrCreateGlass / _syncCardBackings): the same strip-copy +
    // Dual Kawase + glass.frag pipeline the calendar menu and the top bar use,
    // with one region per card. The old menu-level glass actor and the
    // whole-menu Shell.BlurEffect overlay were two extra copies of that
    // pipeline and are gone.
    this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');

    // Kept as no-ops so the open/mapped call sites that drove the removed frame
    // loop stay untouched; the single glass syncs from the card-backing tick.
    let startFrameSync = () => {};

    let stopFrameSync = () => {
      if (this._frameSyncId !== 0) {
        GLib.source_remove(this._frameSyncId);
        this._frameSyncId = 0;
      }
    };

    this._signals = [];

    // The stamp driver is created here, alongside the glass it has to keep in
    // sync. It owns the open/close frame loop from now on.
    this._createAnimation();

    this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen: boolean) => {
      markOpenTrigger(isOpen ? 'qs-open' : 'qs-close');
      if (isOpen) {
        for (let button of this._findAllButtons(this.menu?.actor)) {
          if (button instanceof St.Widget && typeof button.set_style === 'function') {
            button.set_style(null);
          }
        }

        if (!this._customQuickSettings)
          this._customQuickSettings = new CustomQuickSettingsRenderer(this);
        // Mount is synchronous: it builds the visible content, so the menu
        // never flashes the native grid for a frame.
        this._customQuickSettings.mount();

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
        } catch (e) {}

        this._applyMenuOffsets();
        // Build the card glass synchronously so backings exist before the popup
        // is shown, then start the stamp. Both happen before BoxPointer.open(),
        // so the first frame that reaches the screen is already glassed and
        // already stamped.
        try {
          this._applyCardEffects();
          this.animActor.queue_relayout?.();
        } catch (e) {}
        this._beginOpenStamp();

        // Deferred heavy work: backing sync loop and the recursive clip sweep.
        // Runs on the next BEFORE_REDRAW so it never blocks the synchronous
        // open → first-paint path.
        this._addLaterOnce(() => {
          if (!this._isEffectActive || !this.menu?.isOpen) return GLib.SOURCE_REMOVE;
          try {
            this._startCardBackingSync();
            // Replay the recorded sweep (a full re-walk when the tree grew --
            // see _applyCardEffects) instead of unconditionally walking the
            // whole popup on the frame right after the menu opens.
            this._applyClipTargetsFor(this.targetActor);
          } catch (e) {}
          return GLib.SOURCE_REMOVE;
        });

        // Late sweep for widgets the shell adds lazily (a device appearing, an
        // extension contributing a tile). It is deliberately NOT scheduled
        // inside the stamp: replaying the sweep re-validates style and
        // clip state across the whole popup, and the frame that pays for that
        // is the frame right after -- which used to land mid-animation as an
        // 70-100ms stutter. Run it once the transition has settled instead.
        this._scheduleLateClipSweep();

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
          // Backstop only: the normal path is _onAnimationSettled(). If the
          // popup was dismissed without our fade running (the shell hid it, an
          // extension popped it down, ...) make sure no glass is left on screen.
          // Never fires mid-fade, and never destroys the backings -- rebuilding
          // 14 of them (with their shader effects) on the next open is what made
          // the open frame stall.
          if (!this.menu?.isOpen && !this._isSubmenuTransitioning && !this._isAnimating) {
            this._hideCardBackings();
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
      // Cancel any in-flight submenu-return entrance so its ease and tracking
      // frames can't fight the close fade.
      this._revealEaseGen = 0;
      try {
        this.menu.actor.remove_all_transitions?.();
        this.animActor.remove_all_transitions();
        this._stampActor?.remove_all_transitions?.();
      } catch (e) {}
      // Fade the popup out. The stamp leaves the scale alone on close; only the
      // opacity moves, and the glass follows it frame for frame.
      this._anim?.start(false);
    });

    // Stop the glass when the menu leaves the screen.
    this._signals.push({
      target: this.menu.actor,
      id: this.menu.actor.connect('notify::mapped', () => {
        if (this.menu.actor.mapped) {
          // Shown.
          startFrameSync();
          this._syncGeometry();
        } else {
          // Hidden: fully off screen.
          stopFrameSync();

          // Skip cleanup if we're transitioning to/from a submenu — QS will reopen shortly
          if (!this._isSubmenuTransitioning) {
            // Take the glass off screen, but keep it: the backings and their
            // shader effects are what the next open would otherwise rebuild
            // synchronously, and that rebuild is what stalled the open frame.
            this._hideCardBackings();
            this._stopCardBackingSync();

            // Tidy up in case anything survived.
            if (this.animActor) {
              this.animActor.opacity = 0;
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

  // Position and size the window clones.
  _syncActorProperties(source, clone: Clutter.Clone) {
    if (!source || !clone) return;

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
    } catch (e) {
      // The C-level actor was destroyed by GNOME Shell, but JS hasn't caught up yet.
      // Catching this prevents the "already disposed" critical crash.
    }
  }

  _syncGeometry() {
    // The single multi-region glass owns its own geometry inside
    // _syncCardBackings, so there is no menu-sized actor left to place. Kept as
    // a call-site stable no-op.
    return;
  }

  // The glass owns its resolution per card region, so there is nothing
  // menu-sized to resolve. Kept as a call-site stable no-op.
  _updateResolution() {
  }

  _collectAdaptiveTextTargets(actor = this.menu?.actor, targets = []) {
    if (!actor) return targets;
    return this._findAllTextActors(this.menu?.actor);
  }

  _findAllTextActors(actor: Clutter.Actor, foundActors: Clutter.Actor[] = []) {
    if (!actor) return foundActors;

    // Collect the visible text and button actors.
    if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button || actor instanceof St.Icon) {
      if (actor.visible) {
        foundActors.push(actor);
      }
    }

    // Walk the children.
    let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
    for (let i = 0; i < children.length; i++) {
      this._findAllTextActors(children[i], foundActors);
    }

    return foundActors;
  }

  // Initiates the color change for a specific actor
  _setActorColor(actor: CustomBannerActor, color: string, skipAnimations = false) {
    if (!actor || typeof actor.set_style !== 'function') return;

    if (!this._styledActors.has(actor)) {
      let origStyle = typeof actor.get_style === 'function' ? actor.get_style() : null;
      // if (origStyle) this._styledActors.set(actor, origStyle);
      this._styledActors.set(actor, origStyle || '');

      actor.connect('destroy', () => {
        adaptiveColorTweener.cancel(actor);
        this._styledActors.delete(actor);
      });
    }

    let isInsensitive = false;
    if (actor instanceof St.Button) {
      isInsensitive = (actor.reactive === false) || (typeof actor.has_style_pseudo_class === 'function' && actor.has_style_pseudo_class('insensitive'));
    }
    // Save the target color to prevent redundant animation triggers for the same color.
    // if (actor._currentTargetColor === color) return;
    if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive) return;
    actor._currentTargetColor = color;
    actor._currentInsensitiveState = isInsensitive;

    // Kick off the color transition animation!
    this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations);
  }

  // Removes all dynamically applied adaptive text color styles and stops related animations
  _clearAdaptiveStyles() {
    // Restore each actor's original inline style.
    for (const [actor, originalStyle] of this._styledActors.entries() as MapIterator<[CustomBannerActor, string]>) {
      if (actor && typeof actor.set_style === 'function') {
        adaptiveColorTweener.cancel(actor);
        actor._currentTargetColor = undefined;
        actor._currentInsensitiveState = undefined;

        actor.remove_style_class_name('adaptive-text-transition');
        actor.remove_style_class_name('adaptive-color-light');
        actor.remove_style_class_name('adaptive-color-dark');

        // Put back the original style, or clear it.
        actor.set_style(originalStyle || null);
      }
    }
    this._styledActors.clear();

    // Clear any colour left on targets still in the tree.
    const currentTargets = this._collectAdaptiveTextTargets() as CustomBannerActor[];
    for (let actor of currentTargets) {
      if (actor && typeof actor.set_style === 'function') {
        adaptiveColorTweener.cancel(actor);
        actor._currentTargetColor = undefined;
        actor._currentInsensitiveState = undefined;
        actor.set_style(null);
      }
    }
  }

  // Iterates through the color map and applies the new target colors to the respective actors
  _applyAdaptiveColorMap(colorMap: Map<Clutter.Actor, string>, skipAnimations = false) {
    if (!colorMap || colorMap.size === 0)
      return;

    for (const [actor, color] of colorMap.entries()) {
      this._setActorColor(actor as unknown as CustomBannerActor, color, skipAnimations);
    }
  }

  // Starts the timer for periodically sampling contrast and updating adaptive text colors
  _startAdaptiveColorSampling(skipAnimations = false) {
    return timed('adaptiveStart', () => this._startAdaptiveColorSamplingImpl(skipAnimations));
  }

  _startAdaptiveColorSamplingImpl(skipAnimations = false) {
    if (!this._adaptiveConfig.enabled)
      return;

    this._updateAdaptiveTextColors(skipAnimations);

    if (this._adaptiveTimerId !== 0)
      return;

    this._adaptiveTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._adaptiveConfig.sampleIntervalMs,
      () => {
        if (!this.menu?.isOpen) {
          this._adaptiveTimerId = 0;
          return GLib.SOURCE_REMOVE;
        }

        // The periodic pass walks the tree synchronously and resolves into a
        // style relayout, both of which land mid-animation if the timer fires
        // during a transition. The open sampled already and the settle pass
        // re-samples, so just skip the ticks that overlap the animation.
        if (!this._isAnimating) this._updateAdaptiveTextColors(false);
        return GLib.SOURCE_CONTINUE;
      }
    );
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
    return timed('adaptiveSample', () => this._updateAdaptiveTextColorsImpl(skipAnimations));
  }

  _updateAdaptiveTextColorsImpl(skipAnimations = false) {
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
        this._logger.error(`[Liquid Glass] Menu adaptive color update failed: ${e}`);
      })
      .finally(() => {
        this._adaptiveInFlight = false;
      });
  }

  _animateActorColor(actor: CustomBannerActor, targetHexColor: string, isInsensitive: boolean, durationMs = 380, skipAnimations = false) {
    if (!actor || Object.keys(actor).length === 0) return;

    // A tween already running is not cancelled here: add() restarts from the
    // colour it last applied, which handles a target change mid-transition.

    // --- Retrieve the "actual physical color" currently displayed on screen ---
    // This allows smooth transitions starting directly from the default theme colors.
    let themeNode = actor.get_theme_node();
    let startColor = themeNode.get_foreground_color(); // Returns Clutter.Color

    let targetRgb = hexToRgb(targetHexColor);

    // Insensitive items fade to 0.5; enabled ones stay opaque.
    let targetAlpha = isInsensitive ? 0.5 : 1.0;
    let startAlpha = startColor.alpha / 255.0; // Clutter.Color returns alpha in 0..255.

    let origStyle = this._styledActors.get(actor) || '';
    let stylePrefix = origStyle ? `${origStyle} ` : '';

    if (skipAnimations) {
      adaptiveColorTweener.cancel(actor);
      let alphaStr = targetAlpha.toFixed(3);
      let targetRgba = `rgba(${targetRgb.r}, ${targetRgb.g}, ${targetRgb.b}, ${alphaStr})`;
      actor.set_style(`${stylePrefix}color: ${targetRgba}; -st-icon-foreground-color: ${targetRgba};`);
      return;
    }

    // Stepped by the shared frame-driven tweener, as in the other managers,
    // instead of a 32ms GLib timer that beats against the frame. A plain RGB
    // interpolation (crossFade: false) keeps this menu's look as it was.
    const startRgb = { r: startColor.red, g: startColor.green, b: startColor.blue };
    adaptiveColorTweener.add(actor, {
      startRgb, startAlpha,
      targetRgb, targetAlpha,
      crossFade: false,
      durationMs,
      apply: (r, g, b, a) => {
        const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
        actor.set_style(`${stylePrefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`);
      },
    });
  }


  // Recursively collect all St.Button elements and quick-toggle containers
  _findAllButtons(actor: Clutter.Actor, foundButtons: Clutter.Actor[] = []) {
    if (!actor) return foundButtons;

    let isQuickSlider = false;
    let isToggleContainer = false;
    let isButton = actor instanceof St.Button;

    // Only St widgets carry style classes.
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
  _updateSingleButtonAlpha(button: CustomBannerActor, targetAlpha: number) {
    if (!button || button._isUpdatingAlpha) return;
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
          this._updateSingleButtonAlpha(parent as CustomBannerActor, targetAlpha);
        }
      }
    }

    button._isUpdatingAlpha = false;
  }

  // Main initialization and polling loop
  _updateButtonAlpha() {
    if (!this.menu?.isOpen) return;

    const buttons = this._findAllButtons(this.menu?.actor);
    if (buttons.length === 0) return;

    let targetAlpha = this.buttonAlpha !== undefined ? this.buttonAlpha : 0.5;

    for (let button of buttons) {
      if (!this._styledButtons.has(button)) {
        if (button instanceof St.Widget) {
          let origStyle = typeof button.get_style === 'function' ? button.get_style() : null;
          this._styledButtons.set(button, origStyle || '');
        }

        const updateHandler = () => {
          if (!this.menu?.isOpen) return;
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            this._updateSingleButtonAlpha(button as CustomBannerActor, targetAlpha);
            return GLib.SOURCE_REMOVE;
          });
        };


        let signalIds: number[] = [];

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
      this._updateSingleButtonAlpha(button as unknown as CustomBannerActor, targetAlpha);
    }
  }

  // Start the sampling timer.
  _startButtonAlphaSampling() {
    // Disabled for Control Centre cards. Inline background writes here fight
    // the card-level glass/checked styling.
    return;
  }

  // Stop the sampling timer.
  _stopButtonAlphaSampling() {
    if (this._buttonTimerId !== 0) {
      GLib.source_remove(this._buttonTimerId);
      this._buttonTimerId = 0;
    }
  }

  // Undo the restyling on disable.
  _clearButtonStyles() {
    this._stopButtonAlphaSampling();
    if (this._buttonSignalIds) {
      for (const [button, signalIds] of this._buttonSignalIds.entries()) {
        // Skip buttons that are already gone.
        if (button) {
          for (const id of signalIds) {
            try {
              button.disconnect(id);
            } catch (e) {
              // Ignore errors from actors the shell destroyed.
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

  // ---- Open/close transition -------------------------------------------
  //
  // The stamp itself lives in QuickSettingsStampAnimation. This manager's only
  // jobs are to hand it the actors, to have the glass built *before* the popup
  // is ever painted, and to re-sync that glass on every frame the stamp moves.
  //
  // The previous implementation owned its own tick here, and that tick carried
  // two defects that were visible on every single open:
  //
  //   * It froze the card geometry two frames in and rendered the glass from
  //     that snapshot for the rest of the spring, so the liquid glass sat at a
  //     stale size/position while the tiles kept moving underneath it, then
  //     snapped when the animation ended.
  //   * It repaid stalled wall-clock time by integrating up to 100ms in one
  //     frame, so the ~130ms compositor stall caused by rebuilding 14 glass
  //     backings on the open frame teleported the spring to its end state. That
  //     is the "flash" that appeared instead of an animation.
  //
  // Both are gone: the glass is measured live every frame, and the spring is
  // integrated in fixed steps that a stalled frame is not allowed to catch up.

  /** Pushes the spring settings into a live animation. */
  _applySpringSettings() {
    if (!this._anim) return;
    this._anim.setSpringParams(
      this._settings.get_double('quick-settings-spring-stiffness'),
      this._settings.get_double('quick-settings-spring-damping'),
      this._settings.get_double('quick-settings-spring-mass'));
  }

  /** Builds the stamp driver. Called from _applyEffect once the glass exists. */
  _createAnimation() {
    this._anim?.destroy();
    this._anim = new QuickSettingsStampAnimation({
      getPopup: () => this._stampActor,
      getContent: () => this.animActor,
      onFrame: (scale, opacity, opening) => this._onAnimationFrame(scale, opacity, opening),
      onStart: (opening) => this._onAnimationStart(opening),
      onSettled: (opening) => this._onAnimationSettled(opening),
      isAlive: () => this._isEffectActive,
    }, {
      springStiffness: this._settings.get_double('quick-settings-spring-stiffness'),
      springDamping: this._settings.get_double('quick-settings-spring-damping'),
      springMass: this._settings.get_double('quick-settings-spring-mass'),
      openScale: this._openScale,
      // Top-centre: the bubble presses down out of the panel button.
      pivotX: 0.5,
      pivotY: 0.0,
    });
    this._anim.setIntervalMs(this._animationInterval);
  }

  /**
   * Starts the opening stamp. Called from the menu's open-state-changed handler,
   * which GNOME emits before it positions and shows the popup.
   *
   * Running it there rather than from inside BoxPointer.open() matters: the
   * boxpointer patch snaps the popup to scale 1 as part of its bookkeeping, and
   * that happens after this. The animation's first frame is applied in
   * BEFORE_REDRAW of the very frame that shows the popup, so the transform the
   * patch wrote is never the one that reaches the screen.
   *
   * Returns true when this owns the opening transform.
   */
  _beginOpenStamp(): boolean {
    const anim = this._anim;

    if (!anim || !this._enableAnimation || !this._isEffectActive) {
      // No custom stamp (switched off, or no glass). Do not leave the menu
      // transparent and pivoted from the previous close.
      try {
        this.animActor.opacity = 255;
        this._stampActor?.set_pivot_point?.(0.5, 0);
        this._stampActor?.set_scale?.(1, 1);
      } catch (e) {}
      return false;
    }

    // A submenu hand-off re-shows Quick Settings instantly behind the closing
    // submenu. No stamp and no fade there: _finishInstantOpenFromSubmenu owns
    // that frame.
    if (this._suppressNextOpenAnimation || this._isSubmenuTransitioning || this._holdSubmenuReveal)
      return false;

    // The open-state-changed handler already ran _applyCardEffects(); this only
    // covers a direct boxpointer open that skipped it.
    if (this._cardActors.size === 0) {
      try { this._applyCardEffects(); } catch (e) {}
    }

    this._isAnimating = true;
    this._sweepBaselineCardCount = this._cardActors.size;

    // Stamp first, so the sync below measures the geometry that will actually
    // be painted. prepareOpen() also takes the content to opacity 0, so nothing
    // laid out here can be seen.
    if (!anim.prepareOpen()) {
      this._isAnimating = false;
      return false;
    }
    // Drop the previous open's remembered geometry before the first sync: the
    // transient-reflow grace path reuses it, and a stale rect would paint glass
    // at the old position for a frame.
    this._cardLastGoodRect.clear();
    this._setCardBackingsOpacity(0);
    // Replay the cached clip-target sweep where possible instead of re-walking
    // the popup subtree on the open frame.
    try { this._applyClipTargetsFor(this._stampActor ?? this.targetActor); } catch (e) {}
    // Move-only first sync. The backing containers and their window clones are
    // still live from the previous open, so rebuilding them here would put the
    // whole clone cost on the frame that opens the menu. The leading animation
    // frames pick up any rebuild that is genuinely needed, while the glass is
    // still fully transparent.
    try { this._syncCardBackings(false, false); } catch (e) {}

    anim.start(true);
    return true;
  }

  _onAnimationStart(opening: boolean) {
    this._isAnimating = true;
  }

  /**
   * The single place where a transition frame reaches the screen. The popup's
   * scale and the content's opacity have already been written by the animation;
   * this re-measures the glass against that exact geometry and paints it with
   * the same opacity, so content and liquid glass can never drift apart.
   */
  _onAnimationFrame(scale: number, opacity: number, opening: boolean) {
    return timed('animFrame', () => this._onAnimationFrameImpl(scale, opacity, opening));
  }

  _onAnimationFrameImpl(scale: number, opacity: number, opening: boolean) {
    // The one glass re-measures itself against the animated geometry each
    // frame; its opacity is derived from the cards' paint opacity, so it fades
    // in lockstep with the content from the first frame.
    try { this._syncCardBackings(); } catch (e) {}
  }

  _onAnimationSettled(opening: boolean) {
    return timed('settled', () => this._onAnimationSettledImpl(opening));
  }

  _onAnimationSettledImpl(opening: boolean) {
    this._isAnimating = false;

    if (opening) {
      // Land on exactly 1.0 / 255: settling on 0.9987 leaves the whole menu
      // scaled by a fraction and the text visibly resampled.
      try {
        this._stampActor?.set_scale?.(1, 1);
        this.animActor.opacity = 255;
        this._applyMenuOffsets();
        this._syncGeometry();
        this._syncCardBackings(false, true, null, true);
      } catch (e) {}
      this._wakeCardBackingSync();
      // Safety net for widgets the shell added while the menu was opening; it
      // is safe to pay for now that nothing is moving.
      this._runLateClipSweep();
      return;
    }

    // Closed. Hand the popup back to GNOME and finish the bookkeeping that the
    // suppressed BoxPointer.close() would have done.
    try {
      this.menu?.actor?.hide?.();
      (this.menu as any)?._boxPointer?.hide?.();
    } catch (e) {}
    this.animActor.opacity = 0;
    if (this._stampActor) {
      try {
        this._stampActor.set_pivot_point(0, 0);
        this._stampActor.set_scale(1, 1);
      } catch (e) {}
    }
    // Keep the card glass alive but invisible. It used to be destroyed here and
    // rebuilt on the next open, which cost ~40ms of synchronous work on the
    // open frame -- the stall that made the spring teleport.
    this._hideCardBackings();
    this._stopCardBackingSync();

    let pendingCloseCb = this._pendingMenuClosedCallback;
    this._pendingMenuClosedCallback = null;
    this._flushPendingRestoreInput();
    pendingCloseCb?.();
  }

  /**
   * Runs the deferred "lazy widget" sweep once the popup is visually settled.
   *
   * If the stamp is running, _onAnimationSettled() calls this at the end of the
   * transition; otherwise it is scheduled a few frames out. Either way it never
   * competes with the animation.
   */
  _scheduleLateClipSweep() {
    if (this._clipSweepPendingId !== 0) {
      try { GLib.source_remove(this._clipSweepPendingId); } catch (e) {}
      this._clipSweepPendingId = 0;
    }
    if (this._isAnimating) return; // the settle handler owns it

    this._clipSweepPendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
      this._clipSweepPendingId = 0;
      this._runLateClipSweep();
      return GLib.SOURCE_REMOVE;
    });
  }

  _runLateClipSweep() {
    return timed('lateClipSweep', () => this._runLateClipSweepImpl());
  }

  _runLateClipSweepImpl() {
    if (this._clipSweepPendingId !== 0) {
      try { GLib.source_remove(this._clipSweepPendingId); } catch (e) {}
      this._clipSweepPendingId = 0;
    }
    if (!this._isEffectActive || !this.menu?.isOpen) return;
    try {
      // Replay the sweep recorded at open time. Re-applying a clip flag that is
      // already false is a no-op for Clutter, so this is cheap.
      this._applyClipTargetsFor(this.targetActor);
      // The card pass is NOT cheap: it re-walks the popup, rewires drill-down
      // and re-hides native parts (style + width mutations that force a full
      // relayout of the menu on the next frame -- 60-90ms on the target
      // hardware). The open path already ran it, so only repeat it when a card
      // actually turned up since then.
      if (this._cardActors.size !== this._sweepBaselineCardCount)
        this._requestCardEffectsCoalesced();
    } catch (e) {}
  }

  /** Hides every card backing without tearing it (or its shader) down. */
  _hideCardBackings() {
    const glass = this._glass;
    if (!glass) return;
    try {
      glass.hide();
      glass.opacity = 0;
    } catch (e) {}
  }

  /**
   * True while the actor is still attached somewhere under the Quick Settings
   * menu. Used to tell "this card left the menu" (prune its glass) apart from
   * "this card was not visible during a tree walk" (keep its glass).
   */
  _isInMenuTree(actor: Clutter.Actor | null): boolean {
    let root: Clutter.Actor | null = this.menu?.actor ?? null;
    let current: Clutter.Actor | null = actor;
    let guard = 0;
    while (current && guard++ < 64) {
      if (current === root) return true;
      try {
        current = current.get_parent?.() ?? null;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  _removeEffect() {
    if (!this._isEffectActive) return;
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
        if (sig && sig.id) sig.target.disconnect(sig.id);
      } catch (e) { }
    }
    this._signals = [];

    // Stop the spring animation loop
    this._anim?.stop();

    // Drop the open-state signal registered in _applyEffect.
    if (this._animSignalId) {
      try {
        this.menu.disconnect(this._animSignalId);
      } catch (e) { }
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

    // Tear down the one grid glass (the caller's effect is going away).
    const glass = this._glass;
    this._glass = null;
    if (glass) {
      try { glass.cleanup(); } catch (e) {}
      try { if (isActorValid(glass)) glass.destroy(); } catch (e) {}
    }

    this._stableBaseW = undefined;
    this._stableBaseH = undefined;
  }

  // ---- Floating submenu ------------------------------------------------
  //
  // The submenu has its own BackdropGlass (see submenuPanel.ts). It is separate
  // from the grid's glass so it can sit above Quick Settings while the two
  // surfaces crossfade.
  showSubmenuInFloatingWindow(stCard: any, kind?: 'bluetooth' | 'wifi' | 'caffeine' | 'power' | 'system') {
    if (!this._submenuRenderer) {
      this._submenuRenderer = new CustomSubmenuRenderer(this);
    }
    this._submenuRenderer.show(stCard, kind);
  }

  _holdSubmenuReveal?: boolean;

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
    } catch (e) {}
    try { this.menu.open(); } catch (e) {}
  }

  closeQuickSettingsForSubmenu(animate = false) {
    this._isSubmenuTransitioning = true;
    this._suppressNextCloseAnimation = true;
    // Sequenced handoff: hide QS instantly (no 120ms stamp ease) BEFORE the
    // submenu fades in, so the two animations never compete for the compositor
    // on the same frames. `animate` is kept for API compatibility but behaves
    // like the instant path: overlapping eases were the main jitter source.
    try { this.menu.close(false); } catch (e) {}
    this._hideCardBackings();
    try {
      if (this._stampActor) {
        this._stampActor.remove_all_transitions();
        this._stampActor.set_scale(1.0, 1.0);
        this._stampActor.opacity = 255;
      }
    } catch (e) {}
  }

  revealQuickSettingsAfterSubmenu(pop = false, animated = false) {
    this._holdSubmenuReveal = false;
    // Single reveal point: QS reopened hidden at submenu-close start and
    // settled behind the fade with frozen glass. `pop` is intentionally
    // ignored: the EASE_OUT_BACK overshoot pop was a jitter source under load.
    // `animated` runs the fade+rise return entrance (crossfaded with the
    // submenu shrink); false keeps the instant hard-cut for takeovers.
    void pop;
    this._isSubmenuTransitioning = false;
    this._isAnimating = false;
    this._anim?.finish(true);
    try {
      if (this.menu && this.menu.actor) {
        this.menu.actor.remove_all_transitions?.();
      }
      if (this.animActor) {
        this.animActor.remove_all_transitions();
      }
      if (this._stampActor) {
        this._stampActor.remove_all_transitions();
        this._stampActor.set_scale(1.0, 1.0);
        this._stampActor.opacity = 255;
      }
    } catch (e) {}
    // Unfreeze upfront: layout settled hidden behind the fade, so live
    // tracking is exact from the reveal frame. Bumps the generation to
    // invalidate any queued post-reveal unfreeze from an older handoff.
    try { this._unfreezeCardBackings(); } catch (e) {}
    this._frozenUnfreezeGen++;
    // One full sync so clones are current for the reveal (unfrozen above, so
    // geometry is live and settled). The idle timer stays stopped through the
    // entrance — the ease drives move-only syncs and finishReturn restarts it.
    try { this._stopCardBackingSync(); } catch (e) {}
    try { this._syncCardBackings(false, true, null, true); } catch (e) {}

    if (!animated || !this.menu?.isOpen) {
      try {
        if (this.menu && this.menu.actor) {
          this.menu.actor.opacity = 255;
        }
        if (this.animActor) {
          this.animActor.opacity = 255;
          this._applyMenuOffsets();
        }
      } catch (e) {}
      // Resume the idle backing loop (stopped for the hidden phase above).
      this._wakeCardBackingSync();
      return;
    }

    // Animated return entrance: menu.actor fades 0→255 while animActor rises
    // into place. Glass follows via per-frame move-only syncs (backing opacity
    // derives from card paint opacity, positions track the live rise) — sizes
    // stay exact because layout already settled behind the submenu fade.
    let easeGen = ++this._revealEaseGen;
    let baseY = this._menuYoffset;
    try {
      this._applyMenuOffsets();
      baseY = this.animActor.translation_y;
      this.menu.actor.opacity = 0;
      this.animActor.translation_y = baseY + QS_RETURN_RISE_PX;
      this.animActor.opacity = 255;
    } catch (e) {}

    let finishReturn = () => {
      if (!this._isEffectActive || !this.menu?.isOpen) return;
      if (easeGen !== this._revealEaseGen) return;
      this._revealEaseGen = 0;
      try {
        this.menu.actor.opacity = 255;
        this.animActor.translation_y = baseY;
        this.animActor.opacity = 255;
        this._syncCardBackings(false, false);
      } catch (e) {}
      this._wakeCardBackingSync();
    };

    // Glass tracking frames covering the ease duration.
    let framesLeft = Math.max(1, Math.ceil(QS_RETURN_DURATION_MS / QS_ASSUMED_FRAME_MS));
    let trackFrame = (): boolean => {
      if (!this._isEffectActive || !this.menu?.isOpen) return GLib.SOURCE_REMOVE;
      if (easeGen !== this._revealEaseGen) return GLib.SOURCE_REMOVE;
      try { this._syncCardBackings(false, false); } catch (e) {}
      if (--framesLeft <= 0) return GLib.SOURCE_REMOVE;
      this._addLaterOnce(trackFrame);
      return GLib.SOURCE_REMOVE;
    };

    try {
      (this.menu.actor as any).ease({
        opacity: 255,
        duration: QS_RETURN_DURATION_MS,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: finishReturn,
      });
      (this.animActor as any).ease({
        translation_y: baseY,
        duration: QS_RETURN_DURATION_MS,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    } catch (e) {
      finishReturn();
      return;
    }
    this._addLaterOnce(trackFrame);
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

    this._isAnimating = false;
    this._anim?.finish(true);

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
    } catch (e) {}

    this._suppressNextCloseAnimation = false;
    this._setCardBackingsOpacity(0);
    this._removeCardEffects();
    this._stopCardBackingSync();
    // No return handoff follows: invalidate any queued post-reveal unfreeze.
    this._frozenUnfreezeGen++;

    try {
      this._hideCardBackings();
      this.menu.actor.opacity = 255;
      this.animActor.opacity = 255;
      this.animActor.hide?.();
      this.menu.actor.hide?.();
    } catch (e) {}
  }

  _finishInstantOpenFromSubmenu() {
    this._isAnimating = false;
    this._anim?.finish(true);
    try {
      this.animActor.remove_all_transitions();
      this.animActor.set_scale(1.0, 1.0);
      this.animActor.opacity = 255;
      this._applyMenuOffsets();
      this.animActor.show?.();
    } catch (e) {}
    try {
      this.menu.actor.remove_all_transitions?.();
      this.menu.actor.translation_x = 0;
      this.menu.actor.translation_y = 0;
      this.menu.actor.opacity = 0;
      this.menu.actor.show?.();
    } catch (e) {}
    this._hideCardBackings();
    // Card effects were kept alive (frozen) across the submenu, but re-apply
    // synchronously to catch anything the shell rebuilt while hidden, and
    // force layout so borrowed sliders report real allocation on the settle
    // frame instead of transient 0-size.
    try {
      this._applyCardEffects();
      this.animActor.queue_relayout?.();
    } catch (e) {}
    // Single hidden settle behind the submenu fade: one BEFORE_REDRAW lets
    // allocation fire, then a move-only sync (frozen snapshot = exact glass,
    // no clone rebuild to steal fade frames) and the backing timer restarts.
    // The reveal itself is owned by revealQuickSettingsAfterSubmenu at fade
    // end — a single reveal point, so content and glass appear together.
    this._addLaterOnce(() => {
      if (!this._isEffectActive) return GLib.SOURCE_REMOVE;
      try {
        if (this._revealEaseGen === 0) this._applyMenuOffsets();
        this._syncGeometry();
        this._syncCardBackings(false, false);
        // Only complete the open when no return entrance is in flight. The
        // crossfade hand-off starts the reveal at submenu-close start, so this
        // deferred settle must not jump the menu to full opacity underneath it.
        if (!this._holdSubmenuReveal && this._revealEaseGen === 0) {
          this._isSubmenuTransitioning = false;
          this.menu.actor.opacity = 255;
          this.animActor.opacity = 255;
          this._wakeCardBackingSync();
        }
        // When held for a submenu return, the timer stays stopped (nothing
        // re-syncs a hidden menu); the reveal restarts it.
      } catch (e) {}
      return GLib.SOURCE_REMOVE;
    });
  }

  _finishInstantCloseForSubmenu() {
    // A new submenu handoff cancels any in-flight return entrance: its ease
    // and tracking frames must not run against the fresh freeze.
    this._revealEaseGen = 0;
    try {
      this.menu.actor.remove_all_transitions?.();
      this._stampActor?.remove_all_transitions?.();
    } catch (e) {}
    this._isAnimating = false;
    this._anim?.finish(false);
    this._stopAdaptiveColorSampling();
    this._stopButtonAlphaSampling();
    // Submenu handoff: the menu was settled until this frame, so freeze its
    // live glass instead of destroying it. Backings, clones, card classes and
    // allocation handlers stay alive; the return path renders live settled
    // geometry with no rebuild flash. Falls back to full cleanup when there
    // is nothing live to freeze (e.g. the no-reopen Settings-launch path
    // already removed cards).
    let frozeForSubmenu = this._freezeCardBackingsSnapshot();
    if (frozeForSubmenu) {
      // Invalidate any still-queued post-reveal unfreeze from a previous
      // handoff so it cannot clear this fresh snapshot. Stop the sync timer
      // but keep the freeze: nothing should re-sync (or rebuild clones for) a
      // hidden menu; the return path restarts the timer on reveal.
      this._frozenUnfreezeGen++;
      this._stopCardBackingSync(true);
    } else {
      this._removeCardEffects();
      this._stopCardBackingSync();
    }
    this._setCardBackingsOpacity(0);
    try {
      this.animActor.remove_all_transitions();
      this.animActor.set_scale(1.0, 1.0);
      this.animActor.opacity = 0;
      this.animActor.hide?.();
    } catch (e) {}
    this._hideCardBackings();
    try {
      this.menu.actor.opacity = 0;
      this.menu.actor.hide?.();
    } catch (e) {}
  }

  cleanup() {
    this._isSubmenuTransitioning = false;
    if (this._submenuRenderer) {
      this._submenuRenderer.destroy();
    }
    // Restore GNOME's original _boxPointer methods first so the forced
    // menu.close(false) inside _removeEffect runs through the original path.
    this._restorePopupAnimPatch?.();
    // Never leave the popup's input muted after teardown.
    this._flushPendingRestoreInput();
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
      try { this.menu?.close?.(false); } catch (e) {}
    }
  }

}
