import Cogl from 'gi://Cogl';
import { MaterialSettings, OutlineBinding, UniformState } from './material.js';
import { BlurRenderer } from './blur.js';
import { ShaderPipelines, configureSamplerLayer, SHAPE_LAYER, RenderPasses } from './pipelines.js';
// Must match glass.frag's `#define MAX_GLASS_REGIONS 16`.
export const MAX_GLASS_REGIONS = 16;

/**
 * What every glass draws with, whatever supplies its backdrop: the shader
 * pipelines, the blur, the uniforms and the settings bound to them. The owner
 * decides when to repaint (`repaint` is called when a uniform changed) and
 * where the backdrop texture comes from.
 */
export class GlassRenderer {
    passes;
    pipelines;
    blur;
    uniforms;
    geometry;
    material;
    _outline = null;
    _repaint;
    _shapeTexture = null;

    constructor(params) {
        this._repaint = params.repaint;
        this.passes = new RenderPasses();
        this.pipelines = new ShaderPipelines(params.logger, params.shapeTexture ?? false);
        this.blur = new BlurRenderer(this.pipelines, this.passes, () => this._repaint());
        this.uniforms = new UniformState();
        this.geometry = new GlassGeometry(this.uniforms.values);
        this.material = new MaterialSettings(params.settings, this.uniforms, this.blur, params.setDiagnostics, () => this._repaintIfDirty());
        this.material.initialize();
        if (params.settings && params.outline) {
            this._outline = new OutlineBinding(params.settings, params.outline, this.uniforms, () => this._repaintIfDirty());
            this._outline.initialize();
        }
    }

    // Compiles the pipelines on the first paint, once a Cogl context exists,
    // and a tap-count change from setBlurRadius() afterwards.
    prepare(ctx) {
        if (!this.pipelines.composite) {
            this.pipelines.initialize(ctx);
            this.uniforms.attach(this.pipelines.composite);
        }
        if (this.blur.needsCompile)
            this.blur.compilePending(ctx);
    }

    /**
     * Binds the backdrop for glass.frag: the blurred one, or `unblurredTex`
     * when there is no blur. Both hold `blurRect`, the part of the glass the
     * backdrop was copied for, in shader space.
     */
    bindBackdrop(unblurredTex, blurRect) {
        const compPipeline = this.pipelines.composite;
        const haveBlur = this.blur.passCount > 0 && this.blur.result !== null;
        this.uniforms.set('blur_rect_x', blurRect[0]);
        this.uniforms.set('blur_rect_y', blurRect[1]);
        this.uniforms.set('blur_rect_w', blurRect[2]);
        this.uniforms.set('blur_rect_h', blurRect[3]);
        // Both layers get the same texture, so one UV range fits both. glass.frag
        // samples only layer 1; if it ever read layer 0 separately, the layers
        // would need their own ranges.
        const layerTex = haveBlur ? this.blur.result : unblurredTex;
        // The blur is magnified from half or quarter resolution; glass.frag needs
        // its real size to reconstruct it smoothly.
        this.uniforms.set('blur_tex_w', layerTex.get_width());
        this.uniforms.set('blur_tex_h', layerTex.get_height());
        compPipeline.set_layer_texture(0, layerTex);
        configureSamplerLayer(compPipeline, 0);
        compPipeline.set_layer_texture(1, layerTex);
        configureSamplerLayer(compPipeline, 1);
        if (this._shapeTexture) {
            compPipeline.set_layer_texture(SHAPE_LAYER, this._shapeTexture);
            configureSamplerLayer(compPipeline, SHAPE_LAYER);
        }
        // Uniforms set before the pipeline existed are written now.
        this.uniforms.flush();
    }

    /**
     * Queues glass.frag over `drawRect` [x1, y1, x2, y2]. glass.frag multiplies
     * its premultiplied output by the pipeline color, so fading means scaling
     * all four channels by the paint opacity (which already includes the
     * ancestors'); scaling alpha alone would wash the glass out.
     */
    addComposite(node, drawRect, drawUV, paintOpacity) {
        const color = new Cogl.Color();
        const opacity = paintOpacity / 255;
        color.init_from_4f(opacity, opacity, opacity, opacity);
        this.pipelines.composite.set_color(color);
        this.passes.composite(node, this.pipelines.composite, drawRect, drawUV);
    }

    // Rebuilds the pipelines on the next paint, for shader development. The
    // buffered uniforms are kept and re-applied to the new pipeline.
    reloadShaders() {
        this.pipelines.clear();
        this.uniforms.attach(null);
        this.blur.reload();
        this._repaint();
    }

    cleanup() {
        this._shapeTexture = null;
        this._outline?.clear();
        this._outline = null;
        this.material.clear();
        // Dropping the references frees the textures and pipelines; GJS owns them.
        this.blur.clear();
        this.passes.clear();
        this.pipelines.clear();
        this.uniforms.clear();
    }

    _repaintIfDirty() {
        if (this.uniforms.takeDirty())
            this._repaint();
    }

    getResolution() {
        return [
            this.uniforms.values.get('resolution_x') ?? 0,
            this.uniforms.values.get('resolution_y') ?? 0,
        ];
    }

    setBlurRectEnabled(enabled) {
        this.geometry.blurEnabled = enabled;
        // The pool is sized for the old rect.
        this.blur.invalidate();
        this._repaint();
    }

    setCompositeRectEnabled(enabled) {
        this.geometry.compositeEnabled = enabled;
        this._repaint();
    }

    setEdgeTapsEnabled(enabled) {
        this.uniforms.set('edge_taps_enabled', enabled ? 1.0 : 0.0);
        this._repaintIfDirty();
    }

    setEarlyExitEnabled(enabled) {
        this.uniforms.set('early_exit_enabled', enabled ? 1.0 : 0.0);
        this._repaintIfDirty();
    }

    setDebugView(mode) {
        this.uniforms.set('debug_view', mode);
        this._repaintIfDirty();
    }

    setIsDock(isDock) {
        this.uniforms.set('isDock', isDock ? 1.0 : 0.0);
    }

    setSurfaceLightEnabled(enabled) {
        this.uniforms.set('surface_light_enabled', enabled ? 1.0 : 0.0);
        this._repaintIfDirty();
    }

    setCornerSmoothingEnabled(enabled) {
        this.uniforms.set('corner_smoothing_enabled', enabled ? 1.0 : 0.0);
        this._repaintIfDirty();
    }

    setPadding(pad) {
        this.uniforms.set('padding', pad);
    }

    setShadowMaxRadius(radius) {
        this.uniforms.set('shadow_max_radius', radius);
    }

    setBlurMethod(method) {
        this.blur.setBlurMethod(method);
    }

    setBlurRadius(radius) {
        this.blur.setBlurRadius(radius);
    }

    setTintColor(r, g, b) {
        this.uniforms.set('tint_r', r);
        this.uniforms.set('tint_g', g);
        this.uniforms.set('tint_b', b);
        this._repaintIfDirty();
    }

    setTintStrength(strength) {
        this.uniforms.set('tint_strength', strength);
        this._repaintIfDirty();
    }

    setCornerRadius(radius) {
        this.uniforms.set('corner_radius', radius);
        this._repaintIfDirty();
    }

    setAnimationScale(scale) {
        if (this.material.setAnimationScale(scale))
            this._repaintIfDirty();
    }

    setResolution(width, height) {
        this.uniforms.set('resolution_x', width);
        this.uniforms.set('resolution_y', height);
        this._repaintIfDirty();
    }

    setGlassGeometry(x, y, w, h) {
        this.uniforms.set('dock_x', x);
        this.uniforms.set('dock_y', y);
        this.uniforms.set('dock_w', w);
        this.uniforms.set('dock_h', h);
        this.geometry.rect[0] = x;
        this.geometry.rect[1] = y;
        this.geometry.rect[2] = w;
        this.geometry.rect[3] = h;
        this._repaintIfDirty();
    }

    /**
     * The distance field a shape-texture glass takes its outline from: it covers
     * the glass rect, holds `range` px each way, and the lens rises over `band`
     * px from the edge.
     */
    setShapeTexture(texture, range, band) {
        this._shapeTexture = texture;
        this.uniforms.set('shape_range', range);
        this.uniforms.set('shape_band', band);
        this.uniforms.takeDirty();
        this._repaint();
    }

    setMultiRegionMode(enabled) {
        this.uniforms.set('multi_region_mode', enabled ? 1.0 : 0.0);
        this.geometry.multiRegion = enabled;
        this._repaintIfDirty();
    }

    setGlassRegions(regions) {
        const clamped = regions.slice(0, MAX_GLASS_REGIONS);
        const rx = new Array(MAX_GLASS_REGIONS).fill(0.0);
        const ry = new Array(MAX_GLASS_REGIONS).fill(0.0);
        const rw = new Array(MAX_GLASS_REGIONS).fill(0.0);
        const rh = new Array(MAX_GLASS_REGIONS).fill(0.0);
        const rTintR = new Array(MAX_GLASS_REGIONS).fill(1.0);
        const rTintG = new Array(MAX_GLASS_REGIONS).fill(1.0);
        const rTintB = new Array(MAX_GLASS_REGIONS).fill(1.0);
        const rBaseStrength = new Array(MAX_GLASS_REGIONS).fill(0.0);
        clamped.forEach((region, i) => {
            rx[i] = region.x;
            ry[i] = region.y;
            rw[i] = region.w;
            rh[i] = region.h;
            rTintR[i] = region.tintR;
            rTintG[i] = region.tintG;
            rTintB[i] = region.tintB;
            rBaseStrength[i] = Math.max(0.0, Math.min(1.0, region.baseStrength ?? 0.0));
        });
        this.geometry.regions = clamped.map(r => [r.x, r.y, r.w, r.h]);
        this.uniforms.set('region_count', clamped.length);
        this.uniforms.setArray('region_x', rx);
        this.uniforms.setArray('region_y', ry);
        this.uniforms.setArray('region_w', rw);
        this.uniforms.setArray('region_h', rh);
        this.uniforms.setArray('region_tint_r', rTintR);
        this.uniforms.setArray('region_tint_g', rTintG);
        this.uniforms.setArray('region_tint_b', rTintB);
        this.uniforms.setArray('region_base_strength', rBaseStrength);
        this._repaintIfDirty();
    }

    setBrightness(brightness) {
        this.uniforms.set('brightness', brightness);
        this._repaintIfDirty();
    }

    setContrast(contrast) {
        this.uniforms.set('contrast', contrast);
        this._repaintIfDirty();
    }

    setSaturation(saturation) {
        this.uniforms.set('saturation', saturation);
        this._repaintIfDirty();
    }
}

export class GlassGeometry {
    _uniforms;

    constructor(_uniforms) {
        this._uniforms = _uniforms;
        this.blurEnabled = GlassGeometry.USE_BLUR_RECT;
        this.compositeEnabled = GlassGeometry.USE_COMPOSITE_RECT;
    }

    // The glass rect [x, y, w, h] last given to the shader, in the space of
    // setResolution()/setGlassGeometry().
    rect = [0, 0, 0, 0];
    regions = [];
    multiRegion = false;
    // Per-instance switches (global._lgGlass.blurRect()/compositeRect()).
    blurEnabled;
    compositeEnabled;
    // Copy and blur only the part of the backdrop the glass can sample.
    static USE_BLUR_RECT = true;
    // Must match EDGE_LENS_REACH in glass.frag (the refraction's maximum
    // displacement), or the rim samples past the blurred region and streaks.
    static EDGE_LENS_REACH = 96;
    static EDGE_FOOTPRINT_SPREAD = 0.9 * 32;
    // Extra margin for the edge feather, the 4-tap RGSS spread and rounding.
    static BLUR_RECT_MIN_MARGIN = 12;
    // A rect covering more than this share of the actor saves nothing. Kept
    // close to 1 so application windows (around 0.8) still benefit.
    static BLUR_RECT_MIN_SAVING = 0.95;
    // The texture pool is keyed on the rect's size, so the size is rounded up
    // to this quantum; otherwise an opening menu would reallocate the pool
    // every frame.
    static BLUR_RECT_QUANTUM = 64;
    // Run glass.frag only where it can draw something: the glass body and the
    // drop shadow's reach. Everywhere else the source is fully transparent,
    // which the premultiplied "over" blend leaves unchanged, so skipping those
    // pixels changes nothing. Refraction moves where a pixel samples, not where
    // it is drawn, so no refraction margin is needed.
    static USE_COMPOSITE_RECT = true;
    static COMPOSITE_RECT_MIN_SAVING = 0.95;

    /**
     * The rect [x, y, w, h] (shader space) the composite has to cover, or null
     * for the whole actor. glass.frag draws no shadow beyond
     * min(shadow_radius, max(shadow_max_radius, 5)) from the body, and none in
     * multi-region mode.
     */
    compositeRect() {
        if (!this.compositeEnabled)
            return null;
        // Debug views are easier to read unclipped.
        if ((this._uniforms.get('debug_view') ?? 0) > 0.5)
            return null;
        const resW = this._uniforms.get('resolution_x') ?? 0;
        const resH = this._uniforms.get('resolution_y') ?? 0;
        if (!(resW >= 1) || !(resH >= 1))
            return null;
        const body = this._glassBodyUnion();
        if (!body)
            return null;
        let [x0, y0, x1, y1] = body;
        const shadowMax = Math.max(this._uniforms.get('shadow_max_radius') ?? 0, 5);
        const shadowRadius = Math.max(this._uniforms.get('shadow_radius') ?? 0, 0);
        const shadowIntensity = this._uniforms.get('shadow_intensity') ?? 0;
        const reach = (this.multiRegion || !(shadowIntensity > 0))
            ? 0
            : Math.min(shadowRadius, shadowMax);
        // The feather widens the body; the rim and AO lie inside it.
        const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
        const m = Math.ceil(reach + feather + 2);
        x0 -= m;
        y0 -= m;
        x1 += m;
        y1 += m;
        const maxW = Math.round(resW);
        const maxH = Math.round(resH);
        const bx = Math.max(0, Math.floor(x0));
        const by = Math.max(0, Math.floor(y0));
        const bw = Math.min(maxW, Math.ceil(x1)) - bx;
        const bh = Math.min(maxH, Math.ceil(y1)) - by;
        if (!(bw >= 2) || !(bh >= 2))
            return null;
        if (bw * bh >= maxW * maxH * GlassGeometry.COMPOSITE_RECT_MIN_SAVING)
            return null;
        return [bx, by, bw, bh];
    }

    /**
     * The union [x0, y0, x1, y1] of the glass bodies, or null. The rect a
     * manager passes is the background box; the shader insets the body by
     * `padding` (the shadow margin for application windows).
     */
    _glassBodyUnion() {
        const pad = Math.max(this._uniforms.get('padding') ?? 0, 0);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const rects = this.multiRegion ? this.regions : [this.rect];
        for (const r of rects) {
            const [rx, ry, rw, rh] = r;
            if (!(rw > 0) || !(rh > 0))
                continue;
            // The shader clamps the half-size to 1px, so the inset never inverts
            // the box.
            const ix = Math.min(pad, Math.max(rw / 2 - 1, 0));
            const iy = Math.min(pad, Math.max(rh / 2 - 1, 0));
            if (rx + ix < x0)
                x0 = rx + ix;
            if (ry + iy < y0)
                y0 = ry + iy;
            if (rx + rw - ix > x1)
                x1 = rx + rw - ix;
            if (ry + rh - iy > y1)
                y1 = ry + rh - iy;
        }
        if (!(x1 > x0) || !(y1 > y0))
            return null;
        return [x0, y0, x1, y1];
    }

    _samplingReachPx(resW, resH) {
        // The color separation moves blue further along the refraction, by up
        // to this fraction of it.
        const chroma = Math.min(Math.max(this._uniforms.get('chroma_strength') ?? 0, 0), 1);
        const minRes = Math.max(Math.min(resW, resH), 1);
        return Math.min(0.30 * minRes, GlassGeometry.EDGE_LENS_REACH * (1 + chroma) + GlassGeometry.EDGE_FOOTPRINT_SPREAD);
    }

    /**
     * The part of the actor that has to be blurred, [x, y, w, h] in shader
     * space, or null for all of it. The margin is how far a visible pixel's
     * sample can travel from the glass (_samplingReachPx()): the refraction
     * (EDGE_LENS_REACH), stretched by the chromatic aberration, and the edge
     * footprint taps (EDGE_FOOTPRINT_SPREAD), capped at 0.30 of the shorter
     * side, plus the RGSS spread, the feather and BLUR_RECT_MIN_MARGIN. The
     * drop shadow does not sample the blur.
     */
    blurRect() {
        if (!this.blurEnabled)
            return null;
        const resW = this._uniforms.get('resolution_x') ?? 0;
        const resH = this._uniforms.get('resolution_y') ?? 0;
        if (!(resW >= 1) || !(resH >= 1))
            return null;
        const body = this._glassBodyUnion();
        if (!body)
            return null;
        const [x0, y0, x1, y1] = body;
        const dispPx = this._samplingReachPx(resW, resH);
        const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
        const extra = GlassGeometry.BLUR_RECT_MIN_MARGIN + feather + 2.5;
        const mx = Math.ceil(dispPx + extra);
        const my = Math.ceil(dispPx + extra);
        const maxW = Math.round(resW);
        const maxH = Math.round(resH);
        let bx = Math.max(0, Math.floor(x0 - mx));
        let by = Math.max(0, Math.floor(y0 - my));
        let bw = Math.min(maxW, Math.ceil(x1 + mx)) - bx;
        let bh = Math.min(maxH, Math.ceil(y1 + my)) - by;
        if (!(bw >= 2) || !(bh >= 2))
            return null;
        // Round the size up and pull the origin back so the rect still covers
        // the region.
        const q = GlassGeometry.BLUR_RECT_QUANTUM;
        bw = Math.min(maxW, Math.ceil(bw / q) * q);
        bh = Math.min(maxH, Math.ceil(bh / q) * q);
        bx = Math.max(0, Math.min(bx, maxW - bw));
        by = Math.max(0, Math.min(by, maxH - bh));
        if (bw * bh >= resW * resH * GlassGeometry.BLUR_RECT_MIN_SAVING)
            return null;
        return [bx, by, bw, bh];
    }
}
