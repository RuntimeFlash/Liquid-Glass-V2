// Glass whose backdrop is the wallpaper under it. The desktop widgets sit
// behind every window, so what is behind them is the wallpaper alone, and it
// only changes when the wallpaper does.
//
// The live background group is unmapped while the overview is open, so a clone
// of it (or of anything inside it) paints nothing there. Instead an actor built
// with the shell's own BackgroundManager, which keeps painting the wallpaper on
// its own, is captured into this glass once per wallpaper; the blur and the
// composite then read that capture instead of the stage every frame.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { BackgroundManager } from 'resource:///org/gnome/shell/ui/background.js';

import { GlassActor, type GlassActorParams } from './backdropGlass.js';
import { paintNodeWithContext } from '../shellVersion.js';

// A capture needs a nonzero size to have a texture at all.
const MIN_CAPTURE = 2;
// A wallpaper that changes without the settings saying so (a slideshow) is
// taken up this late at worst.
const SAFETY_REFRESH_S = 30;

/**
 * Captures the actor it is on into an offscreen and draws nothing: the actor is
 * only there to be read, never to be seen.
 */
const WallpaperCapture = GObject.registerClass(
  class WallpaperCapture extends Clutter.OffscreenEffect {
    vfunc_paint_target(): void {
    }
  }
);

export const WallpaperGlass = GObject.registerClass(paintNodeWithContext(
  class WallpaperGlass extends GlassActor {
    // Holds the wallpaper actor; the owner puts it in its own actor, in the
    // glass's coordinates. An actor draws its children, and the glass's own
    // paint node does not, so this cannot live under the glass.
    declare private _captureActor: St.Widget;
    declare private _capture: any;
    declare private _manager: any;
    declare private _monitorIndex: number;
    // Bumped when the wallpaper under this glass may have changed: the capture
    // re-renders and the blur is run again.
    declare private _serial: number;
    // The stage rect the capture holds, for the text colour sampler.
    declare private _rect: number[];
    declare private _lastRect: number[];
    declare private _settingsIds: { settings: Gio.Settings, id: number }[];
    declare private _monitorId: number;
    declare private _refreshId: number;

    _init(params: GlassActorParams = {}) {
      super._init(params);
      this._captureActor = new St.Widget({ name: 'liquid-glass-wallpaper', clip_to_allocation: true, reactive: false });
      this._capture = new WallpaperCapture();
      this._captureActor.add_effect(this._capture);
      this._manager = null;
      this._monitorIndex = -1;
      this._serial = 0;
      this._rect = [];
      this._lastRect = [];
      this._settingsIds = [];
      this._monitorId = 0;
      this._refreshId = 0;
      this._watchWallpaper();
    }

    /** The actor holding the wallpaper, for the owner to add to its own actor. */
    get sourceActor(): Clutter.Actor {
      return this._captureActor;
    }

    private _watchWallpaper(): void {
      const background = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
      const appearance = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
      for (const settings of [background, appearance])
        this._settingsIds.push({ settings, id: settings.connect('changed', () => this._wallpaperChanged()) });
      this._monitorId = Main.layoutManager.connect('monitors-changed', () => this._wallpaperChanged());
      this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAFETY_REFRESH_S, () => {
        if (this.mapped && this.get_paint_opacity() > 0) this._wallpaperChanged();
        return GLib.SOURCE_CONTINUE;
      });
    }

    private _wallpaperChanged(): void {
      this._serial++;
      if (this._monitorIndex >= 0) this._captureActor.queue_redraw();
      this._queueRepaint();
    }

    // Places the capture under the glass's blur rect and keeps the wallpaper
    // actor at the right offset inside it. Runs every frame from the owner's
    // sync, like the relays of a stage-reading glass, but only changes anything
    // when the rect or the monitor changed.
    syncSources(): void {
      const scale = this._shaderScale();
      const s = this._sampleShaderRect();
      if (!scale || !s) return;
      const [kx, ky] = scale;
      const [gx, gy] = this.get_transformed_position();
      const rect = [
        gx + Math.round(s[0] * kx), gy + Math.round(s[1] * ky),
        Math.max(1, Math.round(s[2] * kx)), Math.max(1, Math.round(s[3] * ky)),
      ];
      const monitorIndex = this._monitorIndexFor(rect);
      if (monitorIndex !== this._monitorIndex) this._rebuildCapture(monitorIndex);
      const monitor = Main.layoutManager.monitors[this._monitorIndex];
      if (!monitor || !this._manager)
        return;

      if (!this._same(this._lastRect, rect)) {
        this._lastRect = rect;
        this._rect = rect;
        const [px, py] = this.get_position();
        this._captureActor.set_position(px + Math.round(s[0] * kx), py + Math.round(s[1] * ky));
        this._captureActor.set_size(rect[2], rect[3]);
        this._wallpaperChanged();
      }
      this._manager.backgroundActor.set_position(monitor.x - rect[0], monitor.y - rect[1]);
    }

    private _same(a: number[], b: number[]): boolean {
      return a.length === b.length && a.every((v, i) => v === b[i]);
    }

    private _monitorIndexFor(rect: number[]): number {
      const monitors = Main.layoutManager.monitors;
      const cx = rect[0] + rect[2] / 2, cy = rect[1] + rect[3] / 2;
      for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        if (cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height)
          return i;
      }
      return Main.layoutManager.primaryIndex ?? 0;
    }

    // A wallpaper actor of its own per glass: the shared per-monitor manager
    // would have to parent its actor somewhere, and a clone of an unmapped one
    // paints nothing.
    private _rebuildCapture(monitorIndex: number): void {
      if (this._manager) this._manager.destroy();
      this._manager = null;
      this._monitorIndex = monitorIndex;
      this._captureActor.set_size(MIN_CAPTURE, MIN_CAPTURE);
      this._manager = new BackgroundManager({
        container: this._captureActor,
        monitorIndex,
        controlPosition: false,
      });
      this._manager.backgroundActor.set_position(0, 0);
      this._serial++;
    }

    vfunc_paint_node(root: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
      const ctx = this._beginPaint();
      if (!ctx) return;
      const scale = this._paintScale();
      const s = this._sampleShaderRect();
      if (!scale || !s) return;
      const texture = this._capture.get_texture() as Cogl.Texture | null;
      // The capture lands in the frame it is first asked for.
      if (!texture) {
        this._queueRepaint();
        return;
      }
      this._runBlur(root, ctx, texture, s, [texture, this._serial]);
      const compositeRect = this._composite(root, texture, s, scale.kx, scale.ky, scale.resW, scale.resH);
      this._snapshot(() => ({
        mode: 'wallpaper',
        serial: this._serial,
        capture: `${texture.get_width()}x${texture.get_height()}`,
        compositeRect: compositeRect.map(v => +v.toFixed(2)),
      }));
    }

    /** What the text colour sampler reads instead of the screen. */
    backdropCopy(): { texture: Cogl.Texture, rect: number[] } | null {
      const texture = this._capture.get_texture() as Cogl.Texture | null;
      if (!texture || this._rect.length !== 4) return null;
      return { texture, rect: this._rect };
    }

    /** Counters for the test driver and the dump: a copy is a fresh blur. */
    get stats(): { paints: number, copies: number, reuses: number, misses: number, offStage: number } {
      return {
        paints: this._paints,
        copies: this._blurRuns,
        reuses: Math.max(0, this._paints - this._blurRuns),
        misses: 0,
        offStage: 0,
      };
    }

    describe(): object {
      return {
        ...super.describe(),
        ...this.stats,
        mode: 'wallpaper',
      };
    }

    cleanup(): void {
      if (this._refreshId) GLib.Source.remove(this._refreshId);
      this._refreshId = 0;
      if (this._monitorId) Main.layoutManager.disconnect(this._monitorId);
      this._monitorId = 0;
      for (const { settings, id } of this._settingsIds) settings.disconnect(id);
      this._settingsIds = [];
      this._manager?.destroy();
      this._manager = null;
      if (this._captureActor) this._captureActor.destroy();
      this._capture = null;
      this._rect = [];
      super.cleanup();
    }
  }
));

export type WallpaperGlass = InstanceType<typeof WallpaperGlass>;
