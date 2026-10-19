import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** A launcher result kept for later: what is needed to show it and to open it without searching again. */
export interface Pin {
  // The search provider's id ('applications', or a remote provider's application id) and the result's id in it.
  provider: string;
  id: string;
  name: string;
  description: string;
  // The icon as Gio.Icon.to_string() gives it; empty when it has no string form.
  icon: string;
}

const KEY = 'launcher-pinned';

export class PinStore {
  constructor(private _settings: Gio.Settings) {}

  all(): Pin[] {
    const stored = this._settings.get_value(KEY).deep_unpack() as Record<string, string>[];
    return stored.map(p => ({ provider: p.provider ?? '', id: p.id ?? '', name: p.name ?? '',
      description: p.description ?? '', icon: p.icon ?? '' })).filter(p => p.provider && p.id);
  }

  has(provider: string, id: string): boolean {
    return this.all().some(p => p.provider === provider && p.id === id);
  }

  /** The ids pinned from one provider. */
  idsOf(provider: string): Set<string> {
    return new Set(this.all().filter(p => p.provider === provider).map(p => p.id));
  }

  /** Pins `pin`, or unpins it if it is pinned already; true when it ends up pinned. */
  toggle(pin: Pin): boolean {
    const pins = this.all();
    const kept = pins.filter(p => p.provider !== pin.provider || p.id !== pin.id);
    const pinned = kept.length === pins.length;
    this._write(pinned ? [...kept, pin] : kept);
    return pinned;
  }

  private _write(pins: Pin[]): void {
    this._settings.set_value(KEY, new GLib.Variant('aa{ss}', pins.map(p => ({ ...p }))));
  }
}
