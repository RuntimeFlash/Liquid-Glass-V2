import GLib from 'gi://GLib';
// Arithmetic typed into the launcher, such as "3*8", "3*8=" or "1-5": + - * / % ^, parentheses, decimals,
// and the × ÷ − signs. Parsed by hand rather than evaluated, so nothing typed can run as code.
const OPERATORS = '+-*/%^()';

function tokenize(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === ' ') {
            i++;
        }
        else if (OPERATORS.includes(c)) {
            tokens.push(c);
            i++;
        }
        else {
            const number = /^(\d+\.?\d*|\.\d+)/.exec(text.slice(i));
            if (!number)
                return null;
            tokens.push(number[0]);
            i += number[0].length;
        }
    }
    return tokens;
}

class Parser {
    _tokens;
    _at = 0;
    // Whether a binary operator was read: a lone number is not a calculation.
    binary = false;

    constructor(_tokens) {
        this._tokens = _tokens;
    }

    parse() {
        const value = this._sum();
        return this._at === this._tokens.length ? value : null;
    }

    _peek() {
        return this._tokens[this._at];
    }

    _sum() {
        let value = this._product();
        while (value !== null && (this._peek() === '+' || this._peek() === '-')) {
            const op = this._tokens[this._at++];
            const right = this._product();
            if (right === null)
                return null;
            this.binary = true;
            value = op === '+' ? value + right : value - right;
        }
        return value;
    }

    _product() {
        let value = this._power();
        while (value !== null && (this._peek() === '*' || this._peek() === '/' || this._peek() === '%')) {
            const op = this._tokens[this._at++];
            const right = this._power();
            if (right === null)
                return null;
            this.binary = true;
            value = op === '*' ? value * right : op === '/' ? value / right : value % right;
        }
        return value;
    }

    _power() {
        const base = this._unary();
        if (base === null || this._peek() !== '^')
            return base;
        this._at++;
        const exponent = this._power();
        if (exponent === null)
            return null;
        this.binary = true;
        return base ** exponent;
    }

    _unary() {
        const token = this._peek();
        if (token === '-' || token === '+') {
            this._at++;
            const value = this._unary();
            return value === null ? null : token === '-' ? -value : value;
        }
        if (token === '(') {
            this._at++;
            const value = this._sum();
            if (this._peek() !== ')')
                return null;
            this._at++;
            return value;
        }
        if (token === undefined || OPERATORS.includes(token))
            return null;
        this._at++;
        return Number(token);
    }
}

/** The value of `text` when it is a calculation, else null. */
export function evaluate(text) {
    const expression = text.replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').trim().replace(/=$/, '');
    const tokens = tokenize(expression);
    if (!tokens || tokens.length < 3)
        return null;
    const parser = new Parser(tokens);
    const value = parser.parse();
    return value !== null && parser.binary && Number.isFinite(value) ? value : null;
}

/** `value` with no more digits than a double holds reliably, and no exponent for everyday sizes. */
export function formatNumber(value) {
    const rounded = Number(value.toPrecision(12));
    return Object.is(rounded, -0) ? '0' : String(rounded);
}

const KEY = 'launcher-pinned';

export class PinStore {
    _settings;

    constructor(_settings) {
        this._settings = _settings;
    }

    all() {
        const stored = this._settings.get_value(KEY).deep_unpack();
        return stored.map(p => ({ provider: p.provider ?? '', id: p.id ?? '', name: p.name ?? '',
            description: p.description ?? '', icon: p.icon ?? '' })).filter(p => p.provider && p.id);
    }

    has(provider, id) {
        return this.all().some(p => p.provider === provider && p.id === id);
    }

    /** The ids pinned from one provider. */
    idsOf(provider) {
        return new Set(this.all().filter(p => p.provider === provider).map(p => p.id));
    }

    /** Pins `pin`, or unpins it if it is pinned already; true when it ends up pinned. */
    toggle(pin) {
        const pins = this.all();
        const kept = pins.filter(p => p.provider !== pin.provider || p.id !== pin.id);
        const pinned = kept.length === pins.length;
        this._write(pinned ? [...kept, pin] : kept);
        return pinned;
    }

    _write(pins) {
        this._settings.set_value(KEY, new GLib.Variant('aa{ss}', pins.map(p => ({ ...p }))));
    }
}

/**
 * The columns of the pinned page for a row `width` wide. A tile is as wide as its icon plus the room the pin in
 * its corner needs at each side, and the tiles grow to use up what is left over.
 */
export function pinnedGrid(width, iconSize, gap, sideRoom) {
    const least = iconSize + sideRoom * 2;
    const columns = Math.max(1, Math.floor((width + gap) / (least + gap)));
    return { columns, tile: Math.floor((width - gap * (columns - 1)) / columns) };
}

export const SOFTWARE_PROVIDER = 'org.gnome.Software.desktop';

/**
 * The desktop file that an application found by GNOME Software's search has once it is installed, from its result id
 * (scope/kind/origin/id/branch). Null for kinds whose desktop file is not named after the id.
 */
export function softwareDesktopId(resultId) {
    const [, kind, , appId] = resultId.split('/');
    if (!appId)
        return null;
    if (kind === 'flatpak')
        return appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
    if (kind === 'package' && appId.endsWith('.desktop'))
        return appId;
    return null;
}
