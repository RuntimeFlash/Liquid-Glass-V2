import type Gio from 'gi://Gio';

import { hexToColorArray } from '../animation/colors.js';
import type { UniformState } from './uniforms.js';

// Keeps the outline uniforms of one glass in step with its surface's
// `<prefix>-outline-*` settings. A width of 0 is how the shader turns the
// outline off.
export class OutlineBinding {
  private _ids: number[] = [];

  constructor(
    private _settings: Gio.Settings, private _prefix: string, private _uniforms: UniformState,
    private _repaintIfDirty: () => void,
  ) {}

  initialize(): void {
    this._apply();
    for (const suffix of ['enabled', 'width', 'color']) {
      this._ids.push(this._settings.connect(`changed::${this._prefix}-outline-${suffix}`, () => {
        this._apply();
        this._repaintIfDirty();
      }));
    }
  }

  clear(): void {
    this._ids.forEach(id => this._settings.disconnect(id));
    this._ids = [];
  }

  private _apply(): void {
    const s = this._settings;
    const p = this._prefix;
    const [r, g, b] = hexToColorArray(s.get_string(`${p}-outline-color`));
    this._uniforms.set('outline_width', s.get_boolean(`${p}-outline-enabled`) ? s.get_double(`${p}-outline-width`) : 0.0);
    this._uniforms.set('outline_r', r);
    this._uniforms.set('outline_g', g);
    this._uniforms.set('outline_b', b);
  }
}
