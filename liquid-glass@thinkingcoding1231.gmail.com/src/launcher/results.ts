import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Arithmetic typed into the launcher, such as "3*8", "3*8=" or "1-5": + - * / % ^, parentheses, decimals,
// and the × ÷ − signs. Parsed by hand rather than evaluated, so nothing typed can run as code.

const OPERATORS = '+-*/%^()';

function tokenize(text: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ') {
      i++;
    } else if (OPERATORS.includes(c)) {
      tokens.push(c);
      i++;
    } else {
      const number = /^(\d+\.?\d*|\.\d+)/.exec(text.slice(i));
      if (!number) return null;
      tokens.push(number[0]);
      i += number[0].length;
    }
  }
  return tokens;
}

class Parser {
  private _at = 0;
  // Whether a binary operator was read: a lone number is not a calculation.
  binary = false;

  constructor(private _tokens: string[]) {}

  parse(): number | null {
    const value = this._sum();
    return this._at === this._tokens.length ? value : null;
  }

  private _peek(): string | undefined {
    return this._tokens[this._at];
  }

  private _sum(): number | null {
    let value = this._product();
    while (value !== null && (this._peek() === '+' || this._peek() === '-')) {
      const op = this._tokens[this._at++];
      const right = this._product();
      if (right === null) return null;
      this.binary = true;
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  private _product(): number | null {
    let value = this._power();
    while (value !== null && (this._peek() === '*' || this._peek() === '/' || this._peek() === '%')) {
      const op = this._tokens[this._at++];
      const right = this._power();
      if (right === null) return null;
      this.binary = true;
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }

  private _power(): number | null {
    const base = this._unary();
    if (base === null || this._peek() !== '^') return base;
    this._at++;
    const exponent = this._power();
    if (exponent === null) return null;
    this.binary = true;
    return base ** exponent;
  }

  private _unary(): number | null {
    const token = this._peek();
    if (token === '-' || token === '+') {
      this._at++;
      const value = this._unary();
      return value === null ? null : token === '-' ? -value : value;
    }
    if (token === '(') {
      this._at++;
      const value = this._sum();
      if (this._peek() !== ')') return null;
      this._at++;
      return value;
    }
    if (token === undefined || OPERATORS.includes(token)) return null;
    this._at++;
    return Number(token);
  }
}

/** The value of `text` when it is a calculation, else null. */
export function evaluate(text: string): number | null {
  const expression = text.replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').trim().replace(/=$/, '');
  const tokens = tokenize(expression);
  if (!tokens || tokens.length < 3) return null;
  const parser = new Parser(tokens);
  const value = parser.parse();
  return value !== null && parser.binary && Number.isFinite(value) ? value : null;
}

/** `value` with no more digits than a double holds reliably, and no exponent for everyday sizes. */
export function formatNumber(value: number): string {
  const rounded = Number(value.toPrecision(12));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

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

export interface PinnedGrid {
  columns: number;
  // Of every tile, which share the row's width evenly.
  tile: number;
}

/**
 * The columns of the pinned page for a row `width` wide. A tile is as wide as its icon plus the room the pin in
 * its corner needs at each side, and the tiles grow to use up what is left over.
 */
export function pinnedGrid(width: number, iconSize: number, gap: number, sideRoom: number): PinnedGrid {
  const least = iconSize + sideRoom * 2;
  const columns = Math.max(1, Math.floor((width + gap) / (least + gap)));
  return { columns, tile: Math.floor((width - gap * (columns - 1)) / columns) };
}

export const SOFTWARE_PROVIDER = 'org.gnome.Software.desktop';

/**
 * The desktop file that an application found by GNOME Software's search has once it is installed, from its result id
 * (scope/kind/origin/id/branch). Null for kinds whose desktop file is not named after the id.
 */
export function softwareDesktopId(resultId: string): string | null {
  const [, kind, , appId] = resultId.split('/');
  if (!appId) return null;
  if (kind === 'flatpak') return appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
  if (kind === 'package' && appId.endsWith('.desktop')) return appId;
  return null;
}
