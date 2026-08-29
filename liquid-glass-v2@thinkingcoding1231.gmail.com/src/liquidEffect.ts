// src/liquidEffect.js
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import { GLASS_FRAGMENT_SHADER } from './shaderSources.js';

interface LiquidEffectParams {
  extensionPath?: string;
  settings?: Gio.Settings;
  [key: string]: any; // super._init(params) 用に他のプロパティも許容
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

    // GLSL is compiled into shaderSources.ts during the build. Loading it from
    // memory avoids a synchronous Gio file read for every card/menu effect and
    // keeps an installed extension working if its source shader files vanish.
    this.set_shader_source(GLASS_FRAGMENT_SHADER);

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
    // GSettingsとの同期開始
    this._setFloat('padding', 20.0);
    this._setFloat('isDock', 0.0);

    this._settingsIds = [];
    if (this._settings) {
      this._bindSettings();
    } else {
      // settingsがない場合のデフォルトフォールバック
      this._setFloat('max_z', 25.0);
      this._setFloat('displacement_scale', 78.5);
    }
  }

  _bindSettings() {
    // 設定キー(GSettings) と シェーダー変数名(Uniform) の対応リスト
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
      // 初回反映
      this._setFloat(map.uniform, settings.get_double(map.key));
      // 変更監視の接続
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
    // UIのスケールに合わせて、物理的な厚みや屈折の距離も比例して小さくする
    this._setFloat('displacement_scale', settings.get_double('glass-displacement-scale') * scale);
    this._setFloat('max_z', settings.get_double('glass-max-z') * scale);
    this._setFloat('chroma_strength', settings.get_double('glass-chroma-strength') * scale); // 色収差もスケールに合わせる
  }

  // Synchronizes the exact actor dimensions with the shader's internal canvas.
  setResolution(width: number, height: number) {
    this._setFloat('resolution_x', width);
    this._setFloat('resolution_y', height);
  }

});
export type LiquidEffect = InstanceType<typeof LiquidEffect>;
