import { setUniformArray } from '../shellVersion.js';
import { hexToColorArray } from '../animation/colors.js';

export class UniformState {
    _pipeline = null;

    get values() { return this._pendingUniforms; }

    attach(pipeline) {
        this._pipeline = pipeline;
        this._compUniforms.clear();
        this._compUniformArrays.clear();
        // A new pipeline holds none of the buffered values yet.
        this._appliedUniforms.clear();
        this._appliedUniformArrays.clear();
        if (pipeline)
            this.flush();
    }

    takeDirty() {
        const changed = this._uniformsDirty;
        this._uniformsDirty = false;
        return changed;
    }

    clear() {
        this.attach(null);
        this._pendingUniforms.clear();
        this._pendingUniformArrays.clear();
        this._uniformsDirty = false;
    }

    // Uniform locations in the current pipeline.
    _compUniforms = new Map();
    _compUniformArrays = new Map();
    // Every value set so far, kept so a new pipeline can be seeded with them.
    _pendingUniforms = new Map();
    _pendingUniformArrays = new Map();
    // What the pipeline currently holds, so flush() (every paint) writes only
    // changed values instead of about 60 scalars and 8 arrays.
    _appliedUniforms = new Map();
    _appliedUniformArrays = new Map();
    // Set when a value actually changed; the glass repaints only then.
    // Changes behind the glass arrive through the relays, not here.
    _uniformsDirty = false;

    // Sets a float uniform, buffered until attach() provides a pipeline.
    set(name, value) {
        if (this._pendingUniforms.get(name) === value)
            return;
        this._pendingUniforms.set(name, value);
        this._uniformsDirty = true;
        if (this._pipeline) {
            this._applyUniform(name, value);
        }
    }

    _applyUniform(name, value) {
        if (!this._pipeline)
            return;
        if (this._appliedUniforms.get(name) === value)
            return;
        let loc = this._compUniforms.get(name);
        if (loc === undefined) {
            loc = this._pipeline.get_uniform_location(name);
            this._compUniforms.set(name, loc);
        }
        this._pipeline.set_uniform_1f(loc, value);
        this._appliedUniforms.set(name, value);
    }

    flush() {
        for (const [name, value] of this._pendingUniforms) {
            this._applyUniform(name, value);
        }
        for (const [name, values] of this._pendingUniformArrays) {
            this._applyUniformArray(name, values);
        }
    }

    // Sets a float array uniform (e.g. region_x[16]), buffered like set().
    setArray(name, values) {
        const prev = this._pendingUniformArrays.get(name);
        if (prev && prev.length === values.length) {
            let same = true;
            for (let i = 0; i < values.length; i++) {
                if (prev[i] !== values[i]) {
                    same = false;
                    break;
                }
            }
            if (same)
                return;
        }
        // Callers reuse their arrays, so keep a copy to compare against.
        this._pendingUniformArrays.set(name, values.slice());
        this._uniformsDirty = true;
        if (this._pipeline) {
            this._applyUniformArray(name, values);
        }
    }

    _applyUniformArray(name, values) {
        if (!this._pipeline)
            return;
        const applied = this._appliedUniformArrays.get(name);
        if (applied && applied.length === values.length) {
            let same = true;
            for (let i = 0; i < values.length; i++) {
                if (applied[i] !== values[i]) {
                    same = false;
                    break;
                }
            }
            if (same)
                return;
        }
        let loc = this._compUniformArrays.get(name);
        if (loc === undefined) {
            loc = this._pipeline.get_uniform_location(name);
            this._compUniformArrays.set(name, loc);
        }
        setUniformArray(this._pipeline, loc, name, values);
        this._appliedUniformArrays.set(name, values.slice());
    }
}

export class MaterialSettings {
    _settings;
    _uniforms;
    _blur;
    _setDiagnostics;
    _repaintIfDirty;
    _settingsIds = [];

    constructor(_settings, _uniforms, _blur, _setDiagnostics, _repaintIfDirty) {
        this._settings = _settings;
        this._uniforms = _uniforms;
        this._blur = _blur;
        this._setDiagnostics = _setDiagnostics;
        this._repaintIfDirty = _repaintIfDirty;
    }

    initialize() {
        // Buffered until the pipeline exists.
        this._uniforms.set('resolution_x', 0.0);
        this._uniforms.set('resolution_y', 0.0);
        this._uniforms.set('corner_radius', 60.0);
        this._uniforms.set('brightness', 1.0);
        this._uniforms.set('contrast', 1.0);
        this._uniforms.set('saturation', 1.0);
        this._uniforms.set('padding', 20.0);
        // How far the drop shadow can extend before the glass actor's clip,
        // unlike the small optical 'padding'. The managers set the real value.
        this._uniforms.set('shadow_max_radius', 180.0);
        this._uniforms.set('isDock', 0.0);
        // Rim, specular and sheen highlights. Application windows turn them off
        // and keep only the drop shadow and the inner AO.
        this._uniforms.set('surface_light_enabled', 1.0);
        // Application windows turn continuous corners off to match the window.
        this._uniforms.set('corner_smoothing_enabled', 1.0);
        // No outline until a surface's settings ask for one.
        this._uniforms.set('outline_width', 0.0);
        this._uniforms.set('outline_r', 1.0);
        this._uniforms.set('outline_g', 1.0);
        this._uniforms.set('outline_b', 1.0);
        // Where the glass sits inside the actor, which for the UI glass covers
        // the monitor.
        this._uniforms.set('dock_x', 0.0);
        this._uniforms.set('dock_y', 0.0);
        this._uniforms.set('dock_w', 0.0);
        this._uniforms.set('dock_h', 0.0);
        // One glass per region, for Quick Settings' toggle-button mode.
        this._uniforms.set('multi_region_mode', 0.0);
        this._uniforms.set('region_count', 0.0);
        // An unset uniform reads 0.0, which would disable these.
        this._uniforms.set('early_exit_enabled', 1.0);
        this._uniforms.set('debug_view', 0.0);
        // Zero means the whole actor until the paint path computes the rect.
        this._uniforms.set('blur_rect_x', 0.0);
        this._uniforms.set('blur_rect_y', 0.0);
        this._uniforms.set('blur_rect_w', 0.0);
        this._uniforms.set('blur_rect_h', 0.0);
        // Set on every paint, once layer 1's size is known.
        this._uniforms.set('blur_tex_w', 0.0);
        this._uniforms.set('blur_tex_h', 0.0);
        this._uniforms.set('edge_taps_enabled', 1.0);
        this._settingsIds = [];
        if (this._settings) {
            this._bindSettings();
        }
        else {
            // Without settings, the schema's defaults.
            this._uniforms.set('max_z', 88.0);
            this._uniforms.set('displacement_scale', 10.5);
            this._uniforms.set('edge_smoothing', 0.5);
            this._uniforms.set('profile_shape_n', 3.6);
            this._uniforms.set('ior', 2.40);
            this._uniforms.set('chroma_strength', 0.0);
            this._uniforms.set('corner_smoothing', 0.6);
            this._uniforms.set('highlight_backdrop_color', 1.0);
            this._uniforms.set('specular_intensity', 0.0);
            this._uniforms.set('shininess', 42.0);
            this._uniforms.set('rim_width', 2.3);
            this._uniforms.set('rim_intensity', 0.5);
            this._uniforms.set('rim_directional_power', 1.9);
            this._uniforms.set('rim_power', 3.0);
            this._uniforms.set('rim_light_color_intensity', 1.0);
            this._uniforms.set('sheen_intensity', 0.0);
            this._uniforms.set('light_angle_deg', 90.0);
            this._uniforms.set('shadow_radius', 50.0);
            this._uniforms.set('shadow_intensity', 0.22);
            this._uniforms.set('ao_intensity', 0.65);
            this._uniforms.set('ao_radius', 1.0);
            this._uniforms.set('tint_strength', 0.0);
            this._uniforms.set('tint_r', 1.0);
            this._uniforms.set('tint_g', 1.0);
            this._uniforms.set('tint_b', 1.0);
        }
    }

    clear() {
        if (this._settings)
            this._settingsIds.forEach(id => this._settings?.disconnect(id));
        this._settingsIds = [];
    }

    _bindSettings() {
        const mappings = [
            { key: 'glass-max-z', uniform: 'max_z' },
            { key: 'glass-displacement-scale', uniform: 'displacement_scale' },
            { key: 'glass-edge-smoothing', uniform: 'edge_smoothing' },
            { key: 'glass-profile-shape-n', uniform: 'profile_shape_n' },
            { key: 'glass-ior', uniform: 'ior' },
            { key: 'glass-chroma-strength', uniform: 'chroma_strength' },
            { key: 'glass-specular-intensity', uniform: 'specular_intensity' },
            { key: 'glass-shininess', uniform: 'shininess' },
            { key: 'glass-rim-width', uniform: 'rim_width' },
            { key: 'glass-rim-intensity', uniform: 'rim_intensity' },
            { key: 'glass-rim-directional-power', uniform: 'rim_directional_power' },
            { key: 'glass-rim-power', uniform: 'rim_power' },
            { key: 'glass-rim-light-color-intensity', uniform: 'rim_light_color_intensity' },
            { key: 'glass-sheen-intensity', uniform: 'sheen_intensity' },
            { key: 'glass-light-angle-deg', uniform: 'light_angle_deg' },
            { key: 'shadow-radius', uniform: 'shadow_radius' },
            { key: 'shadow-intensity', uniform: 'shadow_intensity' },
            { key: 'glass-ao-intensity', uniform: 'ao_intensity' },
            { key: 'glass-ao-radius', uniform: 'ao_radius' },
            { key: 'glass-corner-smoothing', uniform: 'corner_smoothing' },
        ];
        const settings = this._settings;
        if (!settings)
            return;
        mappings.forEach(map => {
            this._uniforms.set(map.uniform, settings.get_double(map.key));
            // Without a repaint only the parts of the glass that something else
            // damaged would pick up the new value.
            const id = settings.connect(`changed::${map.key}`, () => {
                this._uniforms.set(map.uniform, settings.get_double(map.key));
                this._repaintIfDirty();
            });
            this._settingsIds.push(id);
        });
        const applyBackdropHighlights = () => {
            this._uniforms.set('highlight_backdrop_color', settings.get_boolean('glass-backdrop-highlights') ? 1.0 : 0.0);
        };
        applyBackdropHighlights();
        const highlightsId = settings.connect('changed::glass-backdrop-highlights', () => {
            applyBackdropHighlights();
            this._repaintIfDirty();
        });
        this._settingsIds.push(highlightsId);
        // 2 = half resolution, 4 = quarter. Read before blur-method, since the
        // Gaussian kernel is expressed in texels of that level.
        const applyDownscale = () => {
            const factor = settings.get_int('glass-blur-downscale') >= 4 ? 4 : 2;
            this._blur.setDownscale(factor);
        };
        applyDownscale();
        const downscaleId = settings.connect('changed::glass-blur-downscale', applyDownscale);
        this._settingsIds.push(downscaleId);
        // 0 = Gaussian, 1 = Dual Kawase.
        const applyBlurMethod = () => {
            const raw = settings.get_int('blur-method');
            this._blur.setBlurMethod(raw === 0 ? 0 : 1);
        };
        applyBlurMethod();
        const blurMethodId = settings.connect('changed::blur-method', applyBlurMethod);
        this._settingsIds.push(blurMethodId);
        // Cached, so the paint path does not query GSettings.
        const applyDiagFlag = () => {
            this._setDiagnostics(settings.get_boolean('glass-debug-diagnostics'));
        };
        applyDiagFlag();
        const diagId = settings.connect('changed::glass-debug-diagnostics', applyDiagFlag);
        this._settingsIds.push(diagId);
    }

    setAnimationScale(scale) {
        const settings = this._settings;
        if (!settings)
            return false;
        this._uniforms.set('displacement_scale', settings.get_double('glass-displacement-scale') * scale);
        this._uniforms.set('max_z', settings.get_double('glass-max-z') * scale);
        // The color separation is a fraction of the displacement, so it already
        // scales with it.
        return true;
    }
}

// Keeps the outline uniforms of one glass in step with its surface's
// `<prefix>-outline-*` settings. A width of 0 is how the shader turns the
// outline off.
export class OutlineBinding {
    _settings;
    _prefix;
    _uniforms;
    _repaintIfDirty;
    _ids = [];

    constructor(_settings, _prefix, _uniforms, _repaintIfDirty) {
        this._settings = _settings;
        this._prefix = _prefix;
        this._uniforms = _uniforms;
        this._repaintIfDirty = _repaintIfDirty;
    }

    initialize() {
        this._apply();
        for (const suffix of ['enabled', 'width', 'color']) {
            this._ids.push(this._settings.connect(`changed::${this._prefix}-outline-${suffix}`, () => {
                this._apply();
                this._repaintIfDirty();
            }));
        }
    }

    clear() {
        this._ids.forEach(id => this._settings.disconnect(id));
        this._ids = [];
    }

    _apply() {
        const s = this._settings;
        const p = this._prefix;
        const [r, g, b] = hexToColorArray(s.get_string(`${p}-outline-color`));
        this._uniforms.set('outline_width', s.get_boolean(`${p}-outline-enabled`) ? s.get_double(`${p}-outline-width`) : 0.0);
        this._uniforms.set('outline_r', r);
        this._uniforms.set('outline_g', g);
        this._uniforms.set('outline_b', b);
    }
}
