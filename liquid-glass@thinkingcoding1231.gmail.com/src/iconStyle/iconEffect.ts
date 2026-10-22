// Redraws an St.Icon from its style map with shaders/icon-style.frag: glass
// plates under a symbol, or, while a clone draws it (the launch
// animation), the icon's own picture in the style's color. In the clear look
// the plates are glass that refracts what is behind the icon (IconBackdrop, below).
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { rectInOffscreen } from '../rendering/contentLens.js';
import { configureSamplerLayer, splitShader } from '../rendering/pipelines.js';
import { coglContext } from '../shellVersion.js';
import { type IconStyleColors, iconStyleUniforms } from './styleColors.js';
import { MAP_SIZE } from './styleMap.js';
import type { Logger } from '../logger.js';
import { startSyncLoop, stopStageLoop, type IdSlot } from '../animation/frames.js';
import { GlassRenderer } from '../rendering/glassRenderer.js';
import { RelaySet, SAMPLE_MARGIN, relayHolder } from '../rendering/relays.js';
import { StageCopier } from '../rendering/stageCopy.js';

// The glass settings the clear look's plates are drawn with, by glass.frag's uniform names; icon-style.frag has
// each as glass_<name>.
const MATERIAL = ['max_z', 'displacement_scale', 'edge_smoothing', 'profile_shape_n', 'ior', 'chroma_strength',
  'specular_intensity', 'shininess', 'rim_width', 'rim_intensity', 'rim_directional_power', 'rim_power',
  'rim_light_color_intensity', 'sheen_intensity', 'light_angle_deg', 'ao_intensity', 'ao_radius',
  'highlight_backdrop_color', 'surface_light_enabled', 'brightness', 'contrast', 'saturation'];

/**
 * The pipeline every icon's is copied from, so that they share one program; with `glass`, the clear look's, which
 * also reads the lens map (layer 3) and what is behind the icon (layer 4).
 */
export function iconStylePipeline(source: string, glass = false): Cogl.Pipeline {
  const pipeline = Cogl.Pipeline.new(coglContext());
  configureSamplerLayer(pipeline, 0);
  pipeline.set_layer_wrap_mode(1, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
  // The map is drawn much smaller than it is; its mipmaps keep the symbol's edges smooth.
  pipeline.set_layer_filters(1, Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR, Cogl.PipelineFilter.LINEAR);
  const layers = glass ? [2, 3, 4] : [2];
  for (const layer of layers) {
    pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    pipeline.set_layer_filters(layer, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
  }
  const split = splitShader(source);
  const decl = glass ? `#define LG_ICON_GLASS 1\n${split.decl}` : split.decl;
  const body = split.body;
  const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d\s*;[^\n]*/g, ''), null);
  snippet.set_replace(body);
  pipeline.add_snippet(snippet);
  return pipeline;
}

/** An icon's style map, its plates' tones and its lens map (see styleMap.ts). */
export interface IconStyleTextures {
  map: Cogl.Texture;
  tone: Cogl.Texture;
  lens: Cogl.Texture;
}

/** A style map's, its tones' or its lens map's pixels (RGBA) as a texture. */
export function iconStyleTexture(data: Uint8Array, width = MAP_SIZE, height = MAP_SIZE): Cogl.Texture {
  // Declared premultiplied so that Cogl keeps the channels as they are: they are distances, not a color.
  return Cogl.Texture2D.new_from_data(coglContext(), width, height, Cogl.PixelFormat.RGBA_8888_PRE, width * 4, data);
}

// Where an St.Icon draws its image: in a child, centerd in its content box. While the image is still
// loading the child has no size, and the square in the middle of the content box stands for it.
function imageRect(actor: Clutter.Actor): number[] {
  const image = actor.get_first_child()?.get_allocation_box();
  if (image && image.get_width() >= 1 && image.get_height() >= 1)
    return [image.x1, image.y1, image.get_width(), image.get_height()];
  const box = actor instanceof St.Widget ? actor.get_theme_node().get_content_box(actor.get_allocation_box())
    : new Clutter.ActorBox({ x1: 0, y1: 0, x2: actor.width, y2: actor.height });
  const side = Math.min(box.get_width(), box.get_height());
  return [box.x1 + (box.get_width() - side) / 2, box.y1 + (box.get_height() - side) / 2, side, side];
}

export const IconStyleEffect = GObject.registerClass(
  class IconStyleEffect extends Clutter.OffscreenEffect {
    declare private _pipeline: Cogl.Pipeline | null;
    declare private _locations: Map<string, number>;
    // What the pipeline holds, so that a paint changes only what moved: a change makes Cogl flush the pipeline again.
    declare private _values: Map<string, number>;
    declare private _behind: Cogl.Texture | null;
    declare private _map: Cogl.Texture | null;
    // Where a glass pipeline reads what is behind the icon from; null for the other looks.
    declare private _backdrop: IconBackdrop | null;
    declare private _materialSerial: number;

    _init(): void {
      super._init();
      this._pipeline = null;
      this._locations = new Map();
      this._values = new Map();
      this._behind = null;
      this._map = null;
      this._backdrop = null;
      this._materialSerial = -1;
    }

    /**
     * @param pipeline A copy of iconStylePipeline(), for this effect alone.
     * @param backdrop For a glass pipeline, what is behind the icon.
     */
    prepare(pipeline: Cogl.Pipeline, textures: IconStyleTextures, colors: IconStyleColors,
      backdrop: IconBackdrop | null = null): void {
      this._pipeline = pipeline;
      this._locations.clear();
      this._values.clear();
      this._behind = null;
      this._map = textures.map;
      this._backdrop = backdrop;
      this._materialSerial = -1;
      pipeline.set_layer_texture(1, textures.map);
      pipeline.set_layer_texture(2, textures.tone);
      if (backdrop) {
        pipeline.set_layer_texture(3, textures.lens);
        this._setBehind(textures.map);
      }
      this.setColors(colors);
    }

    setColors(colors: IconStyleColors): void {
      for (const [name, value] of iconStyleUniforms(colors)) this._set(name, value);
      this.queue_repaint();
    }

    private _set(name: string, value: number): void {
      const pipeline = this._pipeline;
      if (!pipeline || this._values.get(name) === value) return;
      this._values.set(name, value);
      let location = this._locations.get(name);
      if (location === undefined) {
        location = pipeline.get_uniform_location(name);
        this._locations.set(name, location);
      }
      pipeline.set_uniform_1f(location, value);
    }

    private _setBehind(texture: Cogl.Texture): void {
      if (texture === this._behind) return;
      this._behind = texture;
      this._pipeline!.set_layer_texture(4, texture);
    }

    vfunc_paint_target(node: Clutter.PaintNode, _paintContext: Clutter.PaintContext): void {
      const texture = this.get_texture();
      const pipeline = this._pipeline;
      if (!texture || !pipeline) return;
      const actor = this.get_actor();
      const image = imageRect(actor);
      const at = rectInOffscreen(actor, image);
      if (!at) return;
      const [x0, y0, x1, y1] = at.box;
      this._set('box_x0', x0);
      this._set('box_y0', y0);
      this._set('box_x1', x1);
      this._set('box_y1', y1);
      // The offscreen is in the actor's px, which its scale enlarges on screen.
      this._set('map_px', MAP_SIZE / Math.max((x1 - x0) * texture.get_width() * actor.scale_x, 1));
      this._set('clone', actor.is_in_clone_paint() ? 1 : 0);
      this._set('opacity', actor.get_paint_opacity() / 255);
      if (this._backdrop) this._bindBackdrop(this._backdrop, actor, image);
      pipeline.set_layer_texture(0, texture);
      const drawNode = Clutter.PipelineNode.new(pipeline);
      node.add_child(drawNode);
      drawNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texture.get_width(), y2: texture.get_height() }));
    }

    // Where the icon's square is in what is behind it, or the look without glass while that is not known there:
    // before it is first copied, and while the icon is drawn away from it (being dragged). An icon partly off the
    // screen, where the copy stops, reads its edge.
    private _bindBackdrop(backdrop: IconBackdrop, actor: Clutter.Actor, [x, y, w, h]: number[]): void {
      const current = backdrop.current();
      // Icons are only moved and scaled, so their extents on the stage say where the image is.
      const ext = actor.get_transformed_extents();
      const kx = ext.get_width() / Math.max(actor.get_width(), 1), ky = ext.get_height() / Math.max(actor.get_height(), 1);
      const sx0 = ext.get_x() + x * kx, sy0 = ext.get_y() + y * ky, sx1 = sx0 + w * kx, sy1 = sy0 + h * ky;
      const r = current?.rect;
      const ready = !!r && sx0 < r[2] && sy0 < r[3] && sx1 > r[0] && sy1 > r[1] && sx1 - sx0 >= 1;
      this._set('glass_ready', ready ? 1 : 0);
      if (!ready) {
        this._setBehind(this._map!);
        return;
      }
      const [rx0, ry0, rx1, ry1] = r!;
      this._set('bd_x0', (sx0 - rx0) / (rx1 - rx0));
      this._set('bd_y0', (sy0 - ry0) / (ry1 - ry0));
      this._set('bd_x1', (sx1 - rx0) / (rx1 - rx0));
      this._set('bd_y1', (sy1 - ry0) / (ry1 - ry0));
      this._set('box_w_px', sx1 - sx0);
      this._set('box_h_px', sy1 - sy0);
      this._set('bd_w_px', rx1 - rx0);
      this._set('bd_h_px', ry1 - ry0);
      this._set('bd_tex_w', current!.texture.get_width());
      this._set('bd_tex_h', current!.texture.get_height());
      this._setBehind(current!.texture);
      if (backdrop.materialSerial === this._materialSerial) return;
      this._materialSerial = backdrop.materialSerial;
      const material = backdrop.material();
      for (const name of MATERIAL) this._set(`glass_${name}`, material.get(name) ?? 0);
    }
  }
);

export type IconStyleEffect = InstanceType<typeof IconStyleEffect>;

// What is behind the icons of one dock, app grid, folder or launcher, for the
// glass of clear icons (iconEffect.ts). It is copied from the stage once for
// all of them, just before the actor that holds them is painted, so it holds
// that surface's own glass, and blurred once. Relays (relays.ts) redraw the
// whole copied area whenever anything behind it changes, so the copy follows
// a backdrop that moves or plays.

const EFFECT_NAME = 'liquid-glass-icon-backdrop';
// Room (px) around the icons for the samples spread around each pixel.
const MARGIN = 8;
// The copy's size is rounded up to this (px), so that icons coming and going do not make new textures every frame.
const QUANTUM = 32;

export interface IconBackdropParams {
  extensionPath: string;
  settings: Gio.Settings;
  logger: Logger;
  // The surface whose blur and color adjustments the glass takes ('dock' or 'launcher').
  prefix: string;
  // The stage rect [x0, y0, x1, y1] the icons cover, or null while none is shown.
  rect: () => number[] | null;
  // Called when a new copy is taken, before the icons are painted.
  copied: () => void;
}

/** The backdrop and the stage rect [x0, y0, x1, y1] it holds. */
export interface Backdrop {
  texture: Cogl.Texture;
  rect: number[];
}

export const IconBackdrop = GObject.registerClass(
  class IconBackdrop extends Clutter.Effect {
    declare private _params: IconBackdropParams;
    declare private _renderer: GlassRenderer;
    declare private _copier: StageCopier;
    declare private _holder: Clutter.Actor;
    declare private _relays: RelaySet | null;
    declare private _host: Clutter.Actor | null;
    declare private _loaded: boolean;
    declare private _shaderLoad: Gio.Cancellable;
    declare private _settingsIds: number[];
    declare private _mapId: number;
    declare private _signalId: number;
    declare private _firstId: number;
    declare private _signalSlot: IdSlot;
    declare private _firstSlot: IdSlot;
    // The area the relays last covered, [x, y, w, h].
    declare private _area: number[] | null;
    // The rect last painted with, which the relays follow in the next frame instead of measuring the icons again.
    declare private _paintedRect: number[] | null;
    // The serial of the last copy taken before the host was last mapped; older copies show what was there before.
    declare private _serialAtMap: number;
    /** Changes whenever material() does. */
    declare materialSerial: number;

    _init(params: IconBackdropParams): void {
      super._init();
      this._params = params;
      this._host = null;
      this._relays = null;
      this._loaded = false;
      this._shaderLoad = new Gio.Cancellable();
      this._mapId = 0;
      this._signalId = 0;
      this._firstId = 0;
      this._signalSlot = { get: () => this._signalId, set: id => { this._signalId = id; } };
      this._firstSlot = { get: () => this._firstId, set: id => { this._firstId = id; } };
      this._area = null;
      this._paintedRect = null;
      this._serialAtMap = 0;
      this.materialSerial = 0;
      this._copier = new StageCopier(params.logger);
      this._renderer = new GlassRenderer({
        settings: params.settings, logger: params.logger, repaint: () => this._materialChanged(), setDiagnostics: () => {},
      });
      this._holder = relayHolder();
      this._holder.hide();
      Main.layoutManager.uiGroup.add_child(this._holder);
      const prefix = params.prefix;
      const s = params.settings;
      const apply = () => {
        this._renderer.setBlurRadius(s.get_int(`${prefix}-blur-radius`));
        this._renderer.setBrightness(s.get_double(`${prefix}-brightness`));
        this._renderer.setContrast(s.get_double(`${prefix}-contrast`));
        this._renderer.setSaturation(s.get_double(`${prefix}-saturation`));
      };
      this._settingsIds = ['blur-radius', 'brightness', 'contrast', 'saturation']
        .map(key => s.connect(`changed::${prefix}-${key}`, apply));
      apply();
      this._loadShaders();
    }

    private async _loadShaders(): Promise<void> {
      try {
        await this._renderer.pipelines.load(this._params.extensionPath, this._shaderLoad);
      } catch (e) {
        if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
          this._params.logger.error(`[Liquid Glass] Failed to load the icon glass's shaders: ${e}`);
        return;
      }
      this._loaded = true;
      // The relays are hidden until now, so the host is what asks for the frame that copies.
      this._host?.queue_redraw();
    }

    /** Goes on `host`, the actor painted right over what the icons' glass shows. */
    attach(host: Clutter.Actor): void {
      this._host = host;
      host.add_effect_with_name(EFFECT_NAME, this);
      this._relays = new RelaySet(host, () => false, this._holder);
      this._mapId = host.connect('notify::mapped', () => this._syncMapped());
      this._syncMapped();
    }

    private _syncMapped(): void {
      if (!this._host?.mapped) {
        stopStageLoop(this._signalSlot, this._firstSlot);
        this._holder.hide();
        this._area = null;
        this._paintedRect = null;
        return;
      }
      this._serialAtMap = this._copier.lastCopy?.serial ?? 0;
      startSyncLoop(this._signalSlot, this._firstSlot, {
        alive: () => !!this._host?.mapped,
        honourFreeze: true,
        errorTag: 'IconBackdrop',
        step: () => this._sync(),
      });
    }

    // The rect to copy, [x0, y0, x1, y1] on the stage: around the icons, inside the host, which leaves out the
    // icons of an app grid's other pages. Inside the host, a redraw of the host redraws all of it.
    private _rect(): number[] | null {
      const r = this._params.rect();
      const box = this._host?.get_transformed_extents();
      if (!r || !box) return null;
      const [bx0, by0] = [Math.floor(box.get_x()), Math.floor(box.get_y())];
      const [bx1, by1] = [Math.ceil(box.get_x() + box.get_width()), Math.ceil(box.get_y() + box.get_height())];
      const x0 = Math.max(Math.floor(r[0] - MARGIN), bx0), y0 = Math.max(Math.floor(r[1] - MARGIN), by0);
      const x1 = Math.min(x0 + Math.ceil((r[2] + MARGIN - x0) / QUANTUM) * QUANTUM, bx1);
      const y1 = Math.min(y0 + Math.ceil((r[3] + MARGIN - y0) / QUANTUM) * QUANTUM, by1);
      return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1, y1] : null;
    }

    // Before every frame: the relays follow what is behind the icons, and the area is redrawn whole when it moves,
    // so that the copy is taken again in that frame.
    private _sync(): void {
      const rect = this._loaded ? this._paintedRect ?? this._rect() : null;
      const relays = this._relays;
      if (!rect || !relays) {
        if (this._holder.visible) this._holder.hide();
        this._area = null;
        return;
      }
      if (!this._holder.visible) this._holder.show();
      const m = SAMPLE_MARGIN;
      const area = [rect[0] - m, rect[1] - m, rect[2] - rect[0] + 2 * m, rect[3] - rect[1] + 2 * m];
      const moved = !this._area || area.some((v, i) => v !== this._area![i]);
      this._area = area;
      if (relays.sync(area) || moved) relays.redrawArea();
      this._copier.prune(this._host!.peek_stage_views());
    }

    vfunc_pre_paint(node: Clutter.PaintNode, paintContext: Clutter.PaintContext): boolean {
      const host = this._host;
      const rect = host && this._loaded ? this._rect() : null;
      this._paintedRect = rect;
      if (!host || !rect) return true;
      const ctx = coglContext();
      this._renderer.prepare(ctx);
      const serial = this._copier.lastCopy?.serial;
      const { copy, missed } = this._copier.take(host, node, paintContext, rect);
      // Nothing to draw with yet; the next frame redraws the whole area. The relays may not be shown yet.
      if (missed) host.queue_redraw();
      if (copy && copy.serial !== serial) this._params.copied();
      const blur = this._renderer.blur;
      if (!copy?.rect || blur.passCount <= 0) return true;
      const w = Math.max(1, Math.round(copy.rect[2] - copy.rect[0]));
      const h = Math.max(1, Math.round(copy.rect[3] - copy.rect[1]));
      const key = [copy.texture, copy.serial];
      if (blur.width === w && blur.height === h && blur.canReuse(key)) return true;
      if (blur.width !== w || blur.height !== h) blur.resize(ctx, w, h);
      if (blur.ready) blur.render(node, copy.texture, [0, 0, 1, 1], key);
      return true;
    }

    /** What is behind the icons now, or null until it has been copied since the host was last shown. */
    current(): Backdrop | null {
      const copy = this._copier.lastCopy;
      if (!copy?.rect || copy.serial <= this._serialAtMap) return null;
      const blur = this._renderer.blur;
      return { texture: blur.passCount > 0 && blur.result ? blur.result : copy.texture, rect: copy.rect };
    }

    /** The glass settings and this surface's color adjustments, by glass.frag's uniform names. */
    material(): ReadonlyMap<string, number> {
      return this._renderer.uniforms.values;
    }

    private _materialChanged(): void {
      this.materialSerial++;
      this._host?.queue_redraw();
    }

    cleanup(): void {
      stopStageLoop(this._signalSlot, this._firstSlot);
      this._shaderLoad.cancel();
      for (const id of this._settingsIds) this._params.settings.disconnect(id);
      this._settingsIds = [];
      if (this._host && this._mapId) this._host.disconnect(this._mapId);
      this._mapId = 0;
      this.get_actor()?.remove_effect(this);
      this._host = null;
      this._relays?.clear();
      this._relays = null;
      this._holder.destroy();
      this._copier.clear();
      this._renderer.cleanup();
    }
  }
);

export type IconBackdrop = InstanceType<typeof IconBackdrop>;
