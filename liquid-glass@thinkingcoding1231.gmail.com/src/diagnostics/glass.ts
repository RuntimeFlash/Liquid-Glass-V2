import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { setFrameSyncFrozen, isFrameSyncFrozen } from '../animation/frames.js';
import { setDiffWritesEnabled, isDiffWritesEnabled, setWindowActorRescueMode, getWindowActorRescueMode, type WindowActorRescueMode } from '../actors.js';
import { setAdaptiveColorMode, getAdaptiveColorMode, type AdaptiveColorMode } from '../animation/colors.js';
import { diagnosticLog } from '../logger.js';
import { startGlassMonitor, stopGlassMonitor, isGlassMonitorRunning, setGlassMonitorLabel } from './monitor.js';

// Every live glass registers here so its last frame can be inspected from
// Looking Glass through global._lgGlass (installed by enable(), removed by
// disable()).
const _liveGlasses: Set<any> = new Set();

// A rolling in-memory record of the application glasses, written to the
// journal only when flushed. It exists for rare animation stalls: a capture
// started after the stall is noticed misses the frames leading up to it, and
// logging continuously from the compositor thread can stall the shell itself.
// A sample is stored only when a window's line changes, and RING_MAX caps
// the memory.
const RING_MAX = 4000;
const _ring: string[] = [];
let _ringLast: Map<any, string> = new Map();

function _ringTransition(wa: any): string {
  const trOp: any = wa.get_transition('opacity');
  if (!trOp) return '|tr=-';
  return `|tr=${trOp.is_playing() ? 'play' : 'stop'},${trOp.get_progress().toFixed(3)},` +
    `${trOp.get_frame_clock() ? 'clk' : 'NOCLK'}`;
}

function _ringLine(glass: any): string | null {
  const wa: any = glass.get_parent();
  if (!wa) return null;
  const mw = wa.get_meta_window();
  // A stranded window has the glass, the window actor and the window group
  // all waiting for an allocation, so the group's state is recorded too.
  const wg: any = wa.get_parent();
  const wgAllocated = wg?.has_allocation() ? 1 : 0;
  return `${glass._diagOwnerLabel || '?'}|sc=${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}` +
    `|op=${wa.opacity}|pos=${Math.round(wa.x)},${Math.round(wa.y)}` +
    `|map=${wa.mapped ? 1 : 0}|alloc=${wa.has_allocation() ? 1 : 0}` +
    `|gAlloc=${glass.has_allocation() ? 1 : 0}|gPos=${Math.round(glass.x)},${Math.round(glass.y)}` +
    `|gSize=${Math.round(glass.width)}x${Math.round(glass.height)}` +
    `|min=${mw?.minimized ? 1 : 0}` +
    `|wgAlloc=${wg ? wgAllocated : '-'}` +
    `|views=${wa.peek_stage_views().length}` +
    _ringTransition(wa);
}

function _isWindowGlass(glass: any): boolean {
  return glass._owner === 'application' || glass._owner === 'desktop-menu';
}

function _ringSampleOnce(): void {
  const t = GLib.get_monotonic_time();
  for (const glass of _liveGlasses) {
    if (!_isWindowGlass(glass)) continue;
    const line = _ringLine(glass);
    if (line === null || _ringLast.get(glass) === line) continue;
    _ringLast.set(glass, line);
    _ring.push(`${t} ${line}`);
    if (_ring.length > RING_MAX) _ring.shift();
  }
}

// Whether the shell's own animation is still attached to the window actor.
// A stall at a fixed scale/opacity looks the same from outside whether the
// timeline is not being ticked (playing, progress stuck; `clock=NULL` when no
// stage view reaches the actor), was stopped early (present, not playing), or
// has already been removed (absent).
function _dumpTransitions(wa: any, live: any): void {
  for (const prop of ['opacity', 'scale-x']) {
    const tr: any = wa.get_transition(prop);
    if (!tr) continue;
    live[`tr_${prop}`] =
      `playing=${tr.is_playing()},prog=${tr.get_progress().toFixed(3)}` +
      `,dur=${tr.get_duration()}` +
      `,clock=${tr.get_frame_clock() ? 'set' : 'NULL'}`;
  }
}

// The window actor around a window's glass, next to the glass's own row: a
// frozen paint counter alone cannot tell minimised, unallocated and stuck
// apart.
function _dumpWindowState(glass: any): object {
  const wa: any = glass.get_parent();
  if (!wa) return {};
  const live: any = {
    hasAlloc: glass.has_allocation(),
    parentMapped: wa.mapped,
    parentHasAlloc: wa.has_allocation(),
    parentOpacity: wa.opacity,
    parentScale: `${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}`,
    shellDestroying: (Main.wm as any)._destroying.has(wa),
  };
  const mw = wa.get_meta_window();
  if (mw) {
    live.minimized = mw.minimized;
    const r = mw.get_frame_rect();
    live.wRect = `${r.x},${r.y},${r.width}x${r.height}`;
  }
  _dumpTransitions(wa, live);
  live.waViews = wa.peek_stage_views().length;
  const wg: any = wa.get_parent();
  if (wg) live.wgViews = wg.peek_stage_views().length;
  live.glassViews = glass.peek_stage_views().length;
  return live;
}

export function dumpGlassState(): string {
  const rows = [..._liveGlasses].map(glass => JSON.stringify({
    ...glass.describe(),
    ...(_isWindowGlass(glass) ? _dumpWindowState(glass) : {}),
  }));
  const out = rows.length ? rows.join('\n') : '(no live glass)';
  diagnosticLog(`[Liquid Glass][dump]\n${out}`);
  return out;
}

// While the recorder is armed, flush it automatically the first few times a
// window actor becomes stranded. Capped, because each flush writes to the
// journal.
let _autoCaptures = 0;
const AUTO_CAPTURE_LIMIT = 6;

export function noteStrandEntry(label: string, detail: string): void {
  if (!_ringArmed) return;
  if (_autoCaptures >= AUTO_CAPTURE_LIMIT) return;
  _autoCaptures++;
  diagnosticLog(`[Liquid Glass][ring] AUTO-CAPTURE ${_autoCaptures}/${AUTO_CAPTURE_LIMIT} ` +
    `on strand entry for "${label}" — ${detail}`);
  flushGlassRing();
}

// The recorder is off unless armed through global._lgGlass.ring(true), and
// its timer only exists while it is armed.
let _ringArmed = false;
let _ringSamplerEnabled = false;
let _ringSamplerId = 0;
let _ringSamplerInterval = 50;

function syncGlassRingSampler(): void {
  if (!_ringArmed || !_ringSamplerEnabled) {
    if (_ringSamplerId) GLib.Source.remove(_ringSamplerId);
    _ringSamplerId = 0;
  } else if (!_ringSamplerId) {
    _ringSamplerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, _ringSamplerInterval, () => {
      _ringSampleOnce();
      return GLib.SOURCE_CONTINUE;
    });
  }
}

export function setGlassRingArmed(armed: boolean): void {
  _ringArmed = !!armed;
  syncGlassRingSampler();
  if (!_ringArmed) {
    _ring.length = 0;
    _ringLast = new Map();
    _autoCaptures = 0;
  }
}
export function isGlassRingArmed(): boolean {
  return _ringArmed;
}

/**
 * Lets the sampler run whenever the recorder is armed. Pair with
 * stopGlassRingSampler() in disable().
 */
export function startGlassRingSampler(intervalMs: number = 50): void {
  _ringSamplerInterval = intervalMs;
  _ringSamplerEnabled = true;
  syncGlassRingSampler();
}

export function stopGlassRingSampler(): void {
  _ringSamplerEnabled = false;
  setGlassRingArmed(false);
}

/** Writes the ring buffer out and clears it. */
export function flushGlassRing(): void {
  if (!_ring.length) {
    diagnosticLog('[Liquid Glass][ring] empty');
    return;
  }
  const t0 = parseInt(_ring[0].split(' ')[0], 10);
  const tN = parseInt(_ring[_ring.length - 1].split(' ')[0], 10);
  const lines = _ring.map(r => {
    const sp = r.indexOf(' ');
    const ms = Math.round((parseInt(r.slice(0, sp), 10) - t0) / 1000);
    return `+${String(ms).padStart(6)}ms ${r.slice(sp + 1)}`;
  });

  // Medium-sized chunks: journald truncates a very long message, and a flood
  // of small ones can block the compositor thread.
  const CHUNK = 150;
  const total = Math.ceil(lines.length / CHUNK);
  diagnosticLog(`[Liquid Glass][ring] BEGIN ${lines.length} samples spanning ` +
    `${Math.round((tN - t0) / 1000)}ms in ${total} chunk(s)`);
  for (let i = 0; i < total; i++) {
    diagnosticLog(`[Liquid Glass][ring] ${i + 1}/${total}\n` +
      lines.slice(i * CHUNK, (i + 1) * CHUNK).join('\n'));
  }
  diagnosticLog('[Liquid Glass][ring] END');

  _ring.length = 0;
  _ringLast = new Map();
}

function report(msg: string): string {
  diagnosticLog(`[Liquid Glass] ${msg}`);
  return msg;
}

function onOff(enabled: boolean): string {
  return enabled ? 'ENABLED' : 'DISABLED';
}

// Applies a setter to every live glass and returns how many it reached.
function onEveryGlass(apply: (glass: any) => void): number {
  for (const glass of _liveGlasses) apply(glass);
  return _liveGlasses.size;
}

function createDebugApi(): object {
  return {
    count: () => _liveGlasses.size,
    dump: () => dumpGlassState(),

    // 0 = normal, 1 = red where the shader computes the drop shadow and green
    // where it computes the glass shape, 2 = raw values.
    debugView: (mode: number) =>
      report(`debug_view = ${mode} on ${onEveryGlass(fx => fx.setDebugView(mode))} instance(s)`),

    // Every tick of every per-frame sync loop does nothing while frozen, so
    // the cost of the polling itself can be measured. The glass stops
    // following anything that moves.
    freezeSync: (frozen: boolean) => {
      setFrameSyncFrozen(frozen);
      return report(`per-frame sync ${frozen ? 'FROZEN' : 'RUNNING'}`);
    },
    syncFrozen: () => isFrameSyncFrozen(),

    // 'cross-fade' (default) dissolves through alpha so a white/black flip
    // never sits at mid-grey; 'rgb-lerp' interpolates the channels.
    textColorMode: (mode: string) => {
      const m: AdaptiveColorMode = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
      setAdaptiveColorMode(m);
      return report(`adaptive text color mode = ${m}`);
    },
    textColorModeName: () => getAdaptiveColorMode(),

    // 'two-stage' (default) asks the window group to relayout first and only
    // then remaps the window actor; 'remap' goes straight to hide()/show();
    // 'off' never touches the window actor.
    windowRescue: (mode: string) => {
      setWindowActorRescueMode(mode as WindowActorRescueMode);
      return report(`window-actor rescue = ${getWindowActorRescueMode()}`);
    },
    windowRescueMode: () => getWindowActorRescueMode(),

    ring: (on: boolean) => {
      setGlassRingArmed(on);
      return report(`ring recorder ${on ? 'ARMED (50ms)' : 'disarmed'}`);
    },
    ringArmed: () => isGlassRingArmed(),
    ringFlush: () => { flushGlassRing(); return 'flushed'; },

    // Compare-then-write in the per-frame sync loops. Changes how often the
    // stage is damaged, not what is drawn.
    diffWrites: (enabled: boolean) => {
      setDiffWritesEnabled(enabled);
      return report(`diff writes ${onOff(enabled)}`);
    },
    diffWritesEnabled: () => isDiffWritesEnabled(),

    // The rect each glass is drawing with right now, straight from its
    // uniforms, for per-frame tracking probes.
    geom: (owner?: string) => {
      const out: { owner: string, x: number, y: number, w: number, h: number }[] = [];
      const add = (glassOwner: string, u: ReadonlyMap<string, number>) => {
        if (owner && glassOwner !== owner) return;
        out.push({ owner: glassOwner, x: u.get('dock_x') ?? 0, y: u.get('dock_y') ?? 0,
          w: u.get('dock_w') ?? 0, h: u.get('dock_h') ?? 0 });
      };
      for (const glass of _liveGlasses) add(glass._owner, glass.uniformValues);
      return out;
    },

    // The live glass actors themselves, for scripted checks.
    glassObjects: () => [..._liveGlasses],

    // One journal line per second with what is on screen, every shown glass's
    // work and the GPU's busy percentage (see diagnostics/monitor.ts).
    // 0 runs until monitorStop().
    monitor: (seconds: number = 30) => {
      startGlassMonitor(() => _liveGlasses, seconds);
      return report(`monitor running${seconds > 0 ? ` for ${seconds}s` : ''}; see journalctl -o cat | grep '\[monitor\]'`);
    },
    monitorStop: () => {
      stopGlassMonitor();
      return report('monitor stopped');
    },
    monitorRunning: () => isGlassMonitorRunning(),
    monitorLabel: (label: string | null) => setGlassMonitorLabel(label),

    blurRect: (enabled: boolean) =>
      report(`blur sub-rect ${onOff(enabled)} on ${onEveryGlass(fx => fx.setBlurRectEnabled(enabled))} instance(s)`),
    compositeRect: (enabled: boolean) =>
      report(`composite sub-rect ${onOff(enabled)} on ${onEveryGlass(fx => fx.setCompositeRectEnabled(enabled))} instance(s)`),
    // false = the plain four-tap pattern along the edge.
    edgeTaps: (enabled: boolean) =>
      report(`edge footprint taps ${onOff(enabled)} on ${onEveryGlass(fx => fx.setEdgeTapsEnabled(enabled))} instance(s)`),
    earlyExit: (enabled: boolean) =>
      report(`early exits ${onOff(enabled)} on ${onEveryGlass(fx => fx.setEarlyExitEnabled(enabled))} instance(s)`),
  };
}

/** Called from enable(): publishes global._lgGlass and the ring sampler. */
export function installGlassDiagnostics(): void {
  (global as any)._lgGlass = createDebugApi();
  startGlassRingSampler(50);
}

/** Called from disable(). */
export function removeGlassDiagnostics(): void {
  stopGlassMonitor();
  stopGlassRingSampler();
  delete (global as any)._lgGlass;
}

export function registerGlass(glass: any): void {
  _liveGlasses.add(glass);
}

export function unregisterGlass(glass: any): void {
  _liveGlasses.delete(glass);
}

const INTERVAL_MS = 100;
const TICKS = 600;
const KEYBINDING = 'dump-loop-keybinding';

/**
 * An optional shortcut (enable-dump-shortcut, off by default) that writes the state of every glass to the journal
 * for a minute, for bug reports. Pressed again, it stops early.
 */
export class DumpShortcut {
  private _settingId = 0;
  private _installed = false;
  private _loopId = 0;

  constructor(private _settings: Gio.Settings) {}

  setup(): void {
    this._settingId = this._settings.connect('changed::enable-dump-shortcut', () => this._sync());
    this._sync();
  }

  cleanup(): void {
    this._settings.disconnect(this._settingId);
    this._stop();
    if (this._installed) Main.wm.removeKeybinding(KEYBINDING);
    this._installed = false;
  }

  private _sync(): void {
    const wanted = this._settings.get_boolean('enable-dump-shortcut');
    if (wanted && !this._installed) {
      Main.wm.addKeybinding(KEYBINDING, this._settings, Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
      this._installed = true;
    } else if (!wanted && this._installed) {
      Main.wm.removeKeybinding(KEYBINDING);
      this._installed = false;
      this._stop();
    }
  }

  // The accelerator as the user sees it, for the notifications.
  private _label(): string {
    const accel = this._settings.get_strv(KEYBINDING)[0];
    if (!accel) return 'the shortcut';
    return accel.replace(/<Control>/gi, 'Ctrl+').replace(/<Alt>/gi, 'Alt+').replace(/<Shift>/gi, 'Shift+')
      .replace(/<Super>/gi, 'Super+').replace(/\+([a-z])$/, (_, k: string) => `+${k.toUpperCase()}`);
  }

  private _stop(): boolean {
    if (!this._loopId) return false;
    GLib.Source.remove(this._loopId);
    this._loopId = 0;
    return true;
  }

  private _toggle(): void {
    if (this._stop()) {
      Main.notify('Liquid Glass', 'Diagnostic dump stopped');
      return;
    }
    // The ring buffer holds the frames before the key press, which the loop that starts now cannot capture.
    flushGlassRing();
    const seconds = (TICKS * INTERVAL_MS) / 1000;
    const endsAt = new Date(Date.now() + seconds * 1000);
    const hhmmss = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    // Marks where the capture starts in the journal.
    diagnosticLog(`[Liquid Glass][dump-loop] STARTED ${TICKS} ticks @ ${INTERVAL_MS}ms, ends ${hhmmss(endsAt)}`);
    Main.notify('Liquid Glass', `Diagnostic dump running ${seconds}s — ends at ${hhmmss(endsAt)} (${this._label()} to stop)`);
    let count = 0;
    this._loopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, INTERVAL_MS, () => {
      dumpGlassState();
      if (++count < TICKS) return GLib.SOURCE_CONTINUE;
      this._loopId = 0;
      return GLib.SOURCE_REMOVE;
    });
  }
}
