// src/backdropBlur.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import { BACKDROP_BLUR_FRAGMENT_SHADER } from './shaderSources.js';
// Feathered rounded-corner mask applied ON TOP of a Shell.BlurEffect so the
// whole-menu backdrop blur blends smoothly into the unblurred desktop instead
// of showing a hard-edged rectangle. The shader's `* cogl_color_in` also
// applies the actor's animated opacity, so fading the overlay fades the blur
// in lockstep with the Quick Settings animation.
export const BackdropBlurEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassBackdropBlurEffect',
}, class BackdropBlurEffect extends Clutter.ShaderEffect {
    _init(params) {
        delete params.extensionPath;
        super._init(params);
        // See build-shaders.mjs: this is embedded at build time so creating a
        // Quick Settings overlay never performs synchronous filesystem I/O.
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
