// Redraws an St.Icon from its style map with shaders/icon-style.frag: glass
// plates under a symbol, or, while a clone draws it (the launch
// animation), the icon's own picture in the style's colour.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { rectInOffscreen } from '../rendering/contentLens.js';
import { configureSamplerLayer } from '../rendering/pipelines.js';
import { splitShader } from '../rendering/shaderSource.js';
import { coglContext } from '../shellVersion.js';
import { type IconStyleColors, iconStyleUniforms } from './styleColors.js';
import { MAP_SIZE } from './styleMap.js';

/** The pipeline every icon's is copied from, so that they share one program. */
export function iconStylePipeline(source: string): Cogl.Pipeline {
  const pipeline = Cogl.Pipeline.new(coglContext());
  configureSamplerLayer(pipeline, 0);
  pipeline.set_layer_wrap_mode(1, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
  // The map is drawn much smaller than it is; its mipmaps keep the symbol's edges smooth.
  pipeline.set_layer_filters(1, Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR, Cogl.PipelineFilter.LINEAR);
  pipeline.set_layer_wrap_mode(2, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
  pipeline.set_layer_filters(2, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
  const { decl, body } = splitShader(source);
  const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d\s*;[^\n]*/g, ''), null);
  snippet.set_replace(body);
  pipeline.add_snippet(snippet);
  return pipeline;
}

/** An icon's style map and its plates' tones (see styleMap.ts). */
export interface IconStyleTextures {
  map: Cogl.Texture;
  tone: Cogl.Texture;
}

/** A style map's or its tones' pixels (MAP_SIZE square, RGBA) as a texture. */
export function iconStyleTexture(data: Uint8Array): Cogl.Texture {
  // Declared premultiplied so that Cogl keeps the channels as they are: they are distances, not a colour.
  return Cogl.Texture2D.new_from_data(coglContext(), MAP_SIZE, MAP_SIZE, Cogl.PixelFormat.RGBA_8888_PRE, MAP_SIZE * 4, data);
}

// Where an St.Icon draws its image: in a child, centred in its content box. While the image is still
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

    _init(): void {
      super._init();
      this._pipeline = null;
      this._locations = new Map();
    }

    /** @param pipeline A copy of iconStylePipeline(), for this effect alone. */
    prepare(pipeline: Cogl.Pipeline, textures: IconStyleTextures, colors: IconStyleColors): void {
      this._pipeline = pipeline;
      this._locations.clear();
      pipeline.set_layer_texture(1, textures.map);
      pipeline.set_layer_texture(2, textures.tone);
      this.setColors(colors);
    }

    setColors(colors: IconStyleColors): void {
      for (const [name, value] of iconStyleUniforms(colors)) this._set(name, value);
      this.queue_repaint();
    }

    private _set(name: string, value: number): void {
      const pipeline = this._pipeline;
      if (!pipeline) return;
      let location = this._locations.get(name);
      if (location === undefined) {
        location = pipeline.get_uniform_location(name);
        this._locations.set(name, location);
      }
      pipeline.set_uniform_1f(location, value);
    }

    vfunc_paint_target(node: Clutter.PaintNode, _paintContext: Clutter.PaintContext): void {
      const texture = this.get_texture();
      const pipeline = this._pipeline;
      if (!texture || !pipeline) return;
      const actor = this.get_actor();
      const at = rectInOffscreen(actor, imageRect(actor));
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
      pipeline.set_layer_texture(0, texture);
      const drawNode = Clutter.PipelineNode.new(pipeline);
      node.add_child(drawNode);
      drawNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texture.get_width(), y2: texture.get_height() }));
    }
  }
);

export type IconStyleEffect = InstanceType<typeof IconStyleEffect>;
