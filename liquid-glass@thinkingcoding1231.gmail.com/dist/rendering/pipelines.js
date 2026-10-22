import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import { uniformDeclarations, setUniformVector } from '../shellVersion.js';

/**
 * Splits a GLSL source string into { decl, body } at the "void main()" boundary.
 */
export function splitShader(src, warn) {
    const match = src.match(/void\s+main\s*\(\s*\)\s*\{/);
    if (!match || match.index === undefined) {
        warn?.('[Liquid Glass] void main() not found; treating entire source as decl.');
        return { decl: src, body: '' };
    }
    const decl = src.substring(0, match.index);
    const rest = src.substring(match.index + match[0].length);
    // Find the matching closing brace.
    let depth = 1;
    let bodyEnd = 0;
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '{')
            depth++;
        else if (rest[i] === '}') {
            depth--;
            if (depth === 0) {
                bodyEnd = i;
                break;
            }
        }
    }
    return { decl, body: rest.substring(0, bodyEnd) };
}

/**
 * A linear-sampling Gaussian kernel for `sigma` (half-res texels) with
 * `fetchPairs` merged tap pairs: the center stays a single sample, and each
 * (i, i+1) pair becomes one fetch at the weighted mean offset. The shader's
 * structure depends only on fetchPairs, so a sigma change within it only
 * updates the kernel_scale uniform.
 */
export function computeGaussianKernel(sigma, fetchPairs) {
    const sideTaps = Math.max(2, fetchPairs * 2);
    const raw = [];
    let sum = 0;
    for (let i = 0; i <= sideTaps; i++) {
        const w = Math.exp(-(i * i) / (2 * sigma * sigma));
        raw.push(w);
        sum += (i === 0) ? w : w * 2;
    }
    for (let i = 0; i <= sideTaps; i++) {
        raw[i] /= sum;
    }
    const offsets = [0];
    const weights = [raw[0]];
    for (let p = 0; p < fetchPairs; p++) {
        const i = p * 2 + 1;
        const j = i + 1;
        const w0 = raw[i] ?? 0;
        const w1 = (j <= sideTaps) ? raw[j] : 0;
        const wSum = w0 + w1;
        const offset = wSum > 0 ? (i * w0 + j * w1) / wSum : i;
        offsets.push(offset);
        weights.push(wSum);
    }
    return { offsets, weights };
}

/**
 * An unrolled GLSL snippet for `kernel`. Offsets and weights are constants;
 * kernel_scale scales the offsets at runtime.
 */
export function buildGaussianSnippet(kernel, direction) {
    const decl = `uniform vec2 inv_size;    /* 1/width, 1/height of the SOURCE texture */\n` +
        `uniform float kernel_scale; /* dynamic scale based on the sigma ratio, avoids recompiling */\n`;
    const lines = [];
    lines.push(`vec2 uv = cogl_tex_coord_in[0].st;`);
    lines.push(`vec4 col = texture2D(cogl_sampler0, uv) * ${kernel.weights[0].toFixed(8)};`);
    for (let i = 1; i < kernel.offsets.length; i++) {
        const off = kernel.offsets[i].toFixed(8);
        const w = kernel.weights[i].toFixed(8);
        const plusVec = direction === 'h'
            ? `vec2(${off} * kernel_scale * inv_size.x, 0.0)`
            : `vec2(0.0, ${off} * kernel_scale * inv_size.y)`;
        lines.push(`col += texture2D(cogl_sampler0, uv + ${plusVec}) * ${w};`);
        lines.push(`col += texture2D(cogl_sampler0, uv - ${plusVec}) * ${w};`);
    }
    lines.push(`cogl_color_out = col;`);
    return { decl, body: '\n    ' + lines.join('\n    ') + '\n' };
}

const SHADER_FILES = ['downsample.frag', 'upsample.frag', 'glass.frag'];
// The shader sources by path, read once. A glass made while an animation runs
// (a notification banner sliding in) then has them before its first frame,
// where reading them again would leave it undrawn for a few frames.
const shaderSources = new Map();

export function clearShaderSources() {
    shaderSources.clear();
}

export class ShaderPipelines {
    _logger;
    _shapeTexture;

    // `shapeTexture`: the composite takes the glass's outline from a distance
    // field on layer 2 (glass text) instead of the rounded rect.
    constructor(_logger, _shapeTexture = false) {
        this._logger = _logger;
        this._shapeTexture = _shapeTexture;
    }

    async load(extensionPath, cancellable = null) {
        if (!extensionPath)
            throw new Error('Missing extension path for shader loading');
        const sources = [];
        for (const name of SHADER_FILES)
            sources.push(await this._readFileAsync(`${extensionPath}/shaders/${name}`, cancellable));
        [this._downsampleSource, this._upsampleSource, this._glassSource] = sources;
    }

    /** Takes the sources another glass has read already; false while none has. */
    loadCached(extensionPath) {
        const sources = SHADER_FILES.map(name => shaderSources.get(`${extensionPath}/shaders/${name}`));
        if (!extensionPath || sources.some(source => source === undefined))
            return false;
        [this._downsampleSource, this._upsampleSource, this._glassSource] = sources;
        return true;
    }

    clear() {
        this.downsample = null;
        this.upsample = null;
        this.composite = null;
        this.passthrough = null;
        this.boxDown = null;
    }

    // Compiled once and reused across frames. downsample/upsample are Dual Kawase.
    downsample = null;
    upsample = null;
    composite = null;
    // A plain one-fetch copy with a UV remap, for the Gaussian's half-res
    // pre-pass. No snippet: Cogl's default combine modulates the
    // texture by the pipeline color, which is opaque white.
    passthrough = null;
    // A 4x4 box filter, the first pass when glass-blur-downscale is 4.
    boxDown = null;
    _downsampleSource = null;
    _upsampleSource = null;
    _glassSource = null;

    // load_contents_finish() throws a GError when the file cannot be read.
    _readFileAsync(path, cancellable) {
        return new Promise((resolve, reject) => {
            const file = Gio.File.new_for_path(path);
            file.load_contents_async(cancellable, (_, res) => {
                try {
                    const [ok, bytes] = file.load_contents_finish(res);
                    if (!ok) {
                        reject(new Error(`load_contents_finish returned false for ${path}`));
                    }
                    else {
                        const source = new TextDecoder('utf-8').decode(bytes);
                        shaderSources.set(path, source);
                        resolve(source);
                    }
                }
                catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Compiles the pipelines. Runs on the first frame, once a Cogl context
     * exists; call clear() first to recompile.
     */
    initialize(ctx) {
        this.downsample = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this.downsample, 0);
        if (this._downsampleSource) {
            const downSnippet = splitShader(this._downsampleSource, message => this._logger?.warn(message));
            const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(downSnippet.decl), null);
            s.set_replace(downSnippet.body);
            this.downsample.add_snippet(s);
        }
        this.upsample = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this.upsample, 0);
        if (this._upsampleSource) {
            const upSnippet = splitShader(this._upsampleSource, message => this._logger?.warn(message));
            const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(upSnippet.decl), null);
            s.set_replace(upSnippet.body);
            this.upsample.add_snippet(s);
        }
        this.passthrough = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this.passthrough, 0);
        // For a 4x reduction a single bilinear fetch covers only the inner 2x2 of
        // each 4x4 block and aliases. These four taps land on source texel
        // corners, so each fetch averages one 2x2 quadrant and together they
        // weigh the whole block equally.
        this.boxDown = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this.boxDown, 0);
        {
            const boxSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations('uniform vec2 inv_size;\n'), null);
            boxSnip.set_replace('vec2 uv = cogl_tex_coord_in[0].st;\n' +
                'vec4 c  = texture2D(cogl_sampler0, uv + vec2( 1.0,  1.0) * inv_size);\n' +
                'c += texture2D(cogl_sampler0, uv + vec2( 1.0, -1.0) * inv_size);\n' +
                'c += texture2D(cogl_sampler0, uv + vec2(-1.0,  1.0) * inv_size);\n' +
                'c += texture2D(cogl_sampler0, uv + vec2(-1.0, -1.0) * inv_size);\n' +
                'cogl_color_out = c * 0.25;\n');
            this.boxDown.add_snippet(boxSnip);
        }
        // The Gaussian pipelines depend on the blur radius and are compiled by
        // BlurRenderer when needed.
        this.composite = Cogl.Pipeline.new(ctx);
        configureSamplerLayer(this.composite, 0);
        if (this._shapeTexture)
            configureSamplerLayer(this.composite, SHAPE_LAYER);
        // Premultiplied-alpha "over", as ShaderEffect blends by default.
        this.composite.set_blend('RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))');
        this._loadCompositeShader();
    }

    /**
     * Adds glass.frag to the composite pipeline. The shader uses ShaderEffect's
     * "cogl_sampler", which becomes "cogl_sampler0", the name Cogl declares for
     * layer 0 in a fragment snippet; the shader's own declaration is dropped.
     */
    _loadCompositeShader() {
        if (!this.composite || !this._glassSource)
            return;
        let { decl, body } = splitShader(this._glassSource, message => this._logger?.warn(message));
        decl = decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d*\s*;[^\n]*/g, '');
        body = body.replace(/\bcogl_sampler\b/g, 'cogl_sampler0');
        if (this._shapeTexture)
            decl = `#define LG_SHAPE_TEXTURE 1\n${decl}`;
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(decl), null);
        snippet.set_replace(body);
        this.composite.add_snippet(snippet);
    }
}

// The composite's layer for the distance field of a shape-texture glass.
export const SHAPE_LAYER = 2;

// Bilinear filtering and clamp-to-edge on one layer.
export function configureSamplerLayer(pipeline, layer) {
    pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    pipeline.set_layer_filters(layer, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
}

export class RenderPasses {
    // Per-pass pipeline copies; see pipeline().
    _passPipelines = new Map();

    clear() {
        this._passPipelines.clear();
    }

    /**
     * A copy of `base` for one pass. Paint nodes run after the paint that
     * queued them returns, so passes sharing a pipeline would all draw with the
     * last pass's uniforms. Copies are copy-on-write and are replaced only when
     * `base` is (a shader recompile). Blending is plain replace: a LayerNode
     * does not clear, and every pass covers its whole target.
     */
    pipeline(key, base) {
        const cached = this._passPipelines.get(key);
        if (cached && cached.base === base)
            return cached.copy;
        const copy = base.copy();
        copy.set_blend('RGBA = ADD(SRC_COLOR, 0)');
        this._passPipelines.set(key, { base, copy });
        return copy;
    }

    /**
     * Queues a render-to-texture pass as a paint node. An actor builds its
     * node tree first and runs it afterwards, so the backdrop copy queued in the
     * same tree has not reached its texture yet; drawing immediately would read
     * the previous copy. As a paint node the pass runs after it. The
     * projection is framebuffer state, so setting it at build time is fine.
     */
    add(parentNode, targetFbo, pipeline, destW, destH, uv) {
        targetFbo.orthographic(0, 0, destW, destH, -1, 1);
        const layerNode = Clutter.LayerNode.new_to_framebuffer(targetFbo, pipeline);
        parentNode.add_child(layerNode);
        const drawNode = Clutter.PipelineNode.new(pipeline);
        layerNode.add_child(drawNode);
        drawNode.add_texture_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: destW, y2: destH }), uv[0], uv[1], uv[2], uv[3]);
    }

    /**
     * Queues the final composite as a paint node, after the copy and the blur
     * passes. Every layer is drawn with the same UV range:
     * add_multitexture_rectangle()'s introspection is broken and crashes the
     * shell.
     */
    composite(parentNode, pipeline, dest, uv) {
        const drawNode = Clutter.PipelineNode.new(pipeline);
        parentNode.add_child(drawNode);
        drawNode.add_texture_rectangle(new Clutter.ActorBox({ x1: dest[0], y1: dest[1], x2: dest[2], y2: dest[3] }), uv[0], uv[1], uv[2], uv[3]);
    }
}

// Cogl caches uniform locations, so these are cheap to call every frame.
export function setPipelineVec2(pipeline, name, x, y) {
    setUniformVector(pipeline, name, [x, y]);
}

export function setPipelineFloat(pipeline, name, value) {
    pipeline.set_uniform_1f(pipeline.get_uniform_location(name), value);
}
