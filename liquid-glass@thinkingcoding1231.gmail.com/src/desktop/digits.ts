// The glass clock's digits for one time, as the pixels of the texture
// glass.frag's LG_SHAPE_TEXTURE reads (see glassText.ts). Made in a process
// of their own (digitsWorker.ts), or in the shell where that cannot start.
import Gio from 'gi://Gio';

import { bundledFontFile } from './bundledFonts.js';
import { GlyphFields, type TallStyle, type TextFace, encodeFields, fileFace, maxDepth, pangoFace, softenedInSteps } from './glassText.js';
import { TrueTypeFont } from './trueType.js';

// How far (px) the distance field reaches past the outline: room for the
// drop shadow, whose reach stays a little inside it.
export const FIELD_RANGE = 48;
// The lens rises over at most this much of a stroke (px), as on any glass.
const MAX_BAND = 22;
// The lens's slope points the way of the outline softened by this fraction of
// its band, so it turns smoothly in a corner instead of folding along the
// corner's bisector.
const LENS_SOFTNESS = 0.35;

export interface DigitsRequest {
  extensionPath: string;
  // A font description such as "Barlow Condensed Regular".
  font: string;
  size: number;
  stretch: number;
  height: number;
  style: TallStyle;
  text: string;
}

export interface Digits {
  bytes: Uint8Array;
  width: number;
  // Of each of the two fields; the texture is twice as tall.
  height: number;
  band: number;
  // The digits' height in the font as it is, px.
  digitHeight: number;
}

function fontKey(r: DigitsRequest): string {
  return `${r.font}|${r.size}|${r.stretch}|${r.height}|${r.style}`;
}

/** Makes digits, keeping the glyphs of the last font asked for. */
export class DigitsMaker {
  private _key = '';
  private _fields: Promise<GlyphFields> | null = null;
  private _cancellable = new Gio.Cancellable();

  /** Rejects with a GError when the font cannot be read or the request was given up. */
  async make(request: DigitsRequest): Promise<Digits> {
    const key = fontKey(request);
    if (key !== this._key || !this._fields) {
      this._fields?.then(old => old.cancellable.cancel(), () => {});
      this._key = key;
      this._fields = this._face(request).then(face =>
        new GlyphFields(face, FIELD_RANGE, request.stretch, request.height, request.style));
      this._fields.catch(() => {
        if (this._key === key) this._fields = null;
      });
    }
    const fields = await this._fields;
    const field = await fields.fieldFor(request.text);
    const band = Math.min(Math.max(maxDepth(field), 2), MAX_BAND);
    const lens = await softenedInSteps(field, band * LENS_SOFTNESS, () => fields.pause());
    await fields.pause();
    return { bytes: encodeFields(field, lens, FIELD_RANGE), width: field.width, height: field.height, band,
      digitHeight: fields.digitHeight };
  }

  // One of the fonts the extension ships with, or an installed one.
  private async _face(request: DigitsRequest): Promise<TextFace> {
    const file = bundledFontFile(request.extensionPath, request.font);
    if (!file) return pangoFace(request.font, request.size);
    const gfile = Gio.File.new_for_path(file);
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      gfile.load_contents_async(this._cancellable, (_f, res) => {
        try {
          resolve(gfile.load_contents_finish(res)[1]);
        } catch (e) {
          reject(e);
        }
      });
    });
    return fileFace(new TrueTypeFont(bytes), request.size);
  }

  destroy(): void {
    this._cancellable.cancel();
    this._fields?.then(fields => fields.cancellable.cancel(), () => {});
    this._fields = null;
  }
}
