import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import { GLASS_FRAGMENT_SHADER } from './shaderSources.js';
import { SHELL_MAJOR } from '../shellVersion.js';

interface LiquidEffectParams {
  extensionPath?: string;
  settings?: Gio.Settings;
  [key: string]: any; // Extra properties are passed through to super._init(params).
}

// Register the custom shader effect class with GObject system.
export const LiquidEffect = GObject.registerClass({
  GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.ShaderEffect {
  private _settings!: Gio.Settings | undefined;
  private _settingsIds!: number[];
  _init(params: LiquidEffectParams) {
    const settings = params.settings;

    delete params.extensionPath;
    delete params.settings;

    super._init(params);

    this._settings = settings;

    // GLSL is embedded in shaderSources.ts, so creating an effect never does a
    // synchronous file read. GNOME 51 removed set_shader_source() in favour of
    // vfunc_get_static_snippet(); older shells still need the source set here.
    if (SHELL_MAJOR < 51)
      (this as any).set_shader_source(GLASS_FRAGMENT_SHADER);

    // Initialize shader uniform variables.
    // These serve as default fallbacks until real values are supplied.
    this._setFloat('resolution_x', 0.0);
    this._setFloat('resolution_y', 0.0);
    this._setFloat('pointer_x', -100.0);
    this._setFloat('pointer_y', -100.0);
    this._setFloat('intensity', 0.0);

    // Matches the CSS border-radius value to ensure the glass perfectly covers the UI.
    this._setFloat('corner_radius', 60.0);

    // Parameters controlling the physical appearance of the glass.
    // These are synchronized with standard PBR/Three.js material defaults.
    // Start syncing the uniforms with GSettings.
    this._setFloat('padding', 20.0);
    this._setFloat('isDock', 0.0);

    this._settingsIds = [];
    if (this._settings) {
      this._bindSettings();
    } else {
      // Fallback defaults when no settings were passed.
      this._setFloat('max_z', 25.0);
      this._setFloat('displacement_scale', 78.5);
    }
  }

  // GNOME 51 port: Clutter.ShaderEffect.set_shader_source() was removed.
  // The effect now supplies its GLSL as a Cogl.Snippet: everything before
  // `void main()` becomes snippet declarations, the main() body becomes the
  // replacement code. The Cogl template declares the layer-0 sampler as
  // cogl_sampler0, so our own declaration is dropped and references renamed.
  vfunc_get_static_snippet(): Cogl.Snippet {
    // Must never throw or return null: Clutter dereferences this result without
    // a NULL check and gnome-shell segfaults on logout/login.
    try {
      const src = GLASS_FRAGMENT_SHADER;
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
    } catch (e: any) {
      logError(e, 'LiquidEffect: snippet build failed, using pass-through');
      return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, '', 'cogl_color_out = cogl_color_in;\n');
    }
  }

  _bindSettings() {
    // GSettings key to shader uniform name.
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
      { key: 'glass-light-angle-deg', uniform: 'light_angle_deg' }
    ];

    const settings = this._settings;
    if (!settings) return;

    mappings.forEach(map => {
      // Apply the current value.
      this._setFloat(map.uniform, settings.get_double(map.key));
      // Watch for changes.
      let id = settings.connect(`changed::${map.key}`, () => {
        const val = settings.get_double(map.key);
        this._setFloat(map.uniform, val);
      });
      this._settingsIds.push(id);
    });
  }

  cleanup() {
    if (this._settings && this._settingsIds) {
      this._settingsIds.forEach(id => this._settings?.disconnect(id));
      this._settingsIds = [];
    }
  }

  // Helper method to safely pass float values to the GLSL shader.
  _setFloat(name: string, value: number) {
    let gval = new GObject.Value();
    gval.init(GObject.TYPE_FLOAT);
    gval.set_float(value);
    this.set_uniform_value(name, gval);
  }

  setIsDock(isDock: boolean) {
    this._setFloat('isDock', isDock ? 1.0 : 0.0);
  }

  setPadding(pad: number) {
    this._setFloat('padding', pad);
  }

  setTintColor(r: number, g: number, b: number) {
    // RGB values normalized between 0.0 and 1.0
    this._setFloat('tint_r', r);
    this._setFloat('tint_g', g);
    this._setFloat('tint_b', b);
  }

  setTintStrength(strength: number) {
    // Controls the opacity of the tint color (0.0 to 1.0)
    this._setFloat('tint_strength', strength);
  }

  setCornerRadius(radius: number) {
    this._setFloat('corner_radius', radius);
  }

  setAnimationScale(scale: number) {
    const settings = this._settings;
    if (!settings) return;
    // Scale the thickness and refraction with the UI scale.
    this._setFloat('displacement_scale', settings.get_double('glass-displacement-scale') * scale);
    this._setFloat('max_z', settings.get_double('glass-max-z') * scale);
    this._setFloat('chroma_strength', settings.get_double('glass-chroma-strength') * scale); // Scale the colour separation too.
  }

  // Synchronizes the exact actor dimensions with the shader's internal canvas.
  setResolution(width: number, height: number) {
    this._setFloat('resolution_x', width);
    this._setFloat('resolution_y', height);
  }

});
export type LiquidEffect = InstanceType<typeof LiquidEffect>;
