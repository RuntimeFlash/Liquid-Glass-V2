import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import { BACKDROP_BLUR_FRAGMENT_SHADER } from './shaderSources.js';
import { SHELL_MAJOR } from '../shellVersion.js';

// Feathered rounded-corner mask applied ON TOP of a Shell.BlurEffect so the
// whole-menu backdrop blur blends smoothly into the unblurred desktop instead
// of showing a hard-edged rectangle. The shader's `* cogl_color_in` also
// applies the actor's animated opacity, so fading the overlay fades the blur
// in lockstep with the Quick Settings animation.
export const BackdropBlurEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassQsBackdropBlurEffect',
}, class BackdropBlurEffect extends Clutter.ShaderEffect {
    _init(params) {
        delete params.extensionPath;
        super._init(params);
        // Embedded at build time, so creating the overlay never reads files.
        // GNOME 51 removed set_shader_source(); older shells still need it.
        if (SHELL_MAJOR < 51)
            this.set_shader_source(BACKDROP_BLUR_FRAGMENT_SHADER);
        // Initialize shader uniform variables with sane fallbacks. Resolution must
        // be non-zero: with 0x0 the rounded-rect SDF evaluates to alpha 0 over the
        // whole quad, which makes the overlay invisible until the first geometry
        // sync supplies real dimensions.
        this._setFloat('resolution_x', 1000.0);
        this._setFloat('resolution_y', 1000.0);
        this._setFloat('corner_radius', 24.0);
        this._setFloat('feather_px', 60.0);
    }

    // GNOME 51 port: Clutter.ShaderEffect.set_shader_source() was removed.
    // The effect now supplies its GLSL as a Cogl.Snippet: everything before
    // `void main()` becomes snippet declarations, the main() body becomes the
    // replacement code. The Cogl template declares the layer-0 sampler as
    // cogl_sampler0, so our own declaration is dropped and references renamed.
    vfunc_get_static_snippet() {
        // Must never throw or return null: Clutter dereferences this result without
        // a NULL check and gnome-shell segfaults on logout/login.
        try {
            const src = BACKDROP_BLUR_FRAGMENT_SHADER;
            const mainIdx = src.indexOf('void main()');
            const openBrace = src.indexOf('{', mainIdx);
            const declarations = src
                .slice(0, mainIdx)
                .replace(/uniform sampler2D cogl_sampler;\s*/g, '');
            const body = src
                .slice(openBrace + 1, src.lastIndexOf('}'))
                .replace(/cogl_sampler\b/g, 'cogl_sampler0');
            const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, null);
            snippet.set_replace(body);
            return snippet;
        }
        catch (e) {
            logError(e, 'BackdropBlur: snippet build failed, using pass-through');
            return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, '', 'cogl_color_out = cogl_color_in;\n');
        }
    }

    // Helper method to safely pass float values to the GLSL shader.
    _setFloat(name, value) {
        let gval = new GObject.Value();
        gval.init(GObject.TYPE_FLOAT);
        gval.set_float(value);
        this.set_uniform_value(name, gval);
    }

    // Synchronizes the shader's mask canvas with the overlay's actual size.
    // Pass physical pixel dimensions (logical size * stage scale) so the rounded
    // mask stays pixel-accurate on HiDPI displays.
    setResolution(width, height) {
        this._setFloat('resolution_x', width);
        this._setFloat('resolution_y', height);
    }

    setCornerRadius(radius) {
        this._setFloat('corner_radius', radius);
    }

    setFeather(feather) {
        this._setFloat('feather_px', feather);
    }
});
