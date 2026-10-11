// TEMPORARY DEVELOPMENT PROBE — not part of the extension.
// Installed from QuickSettingsManager.setup() behind a DEV-PROBE marker.
//
// Two channels, neither of which needs D-Bus or unsafe mode:
//   * global.__LGP, for interactive use from Looking Glass / Eval;
//   * a file command channel, so the harness can drive the shell from a
//     normal process. Commands are appended to CMD_PATH, one per line; the
//     probe runs them on the next idle and appends the JSON result to OUT_PATH.
//
// The file channel exists because org.gnome.Shell.Eval only runs while
// global.context.unsafe_mode is on, and the shell drops back out of unsafe
// mode on its own, which makes Eval unusable for a measurement run.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect } from './liquidEffect.js';
import { SubmenuPanel } from './submenuPanel.js?v=mv3llad7';
const PROBE_DIR = GLib.build_filenamev([GLib.get_home_dir(), 'liquid-glass', '.probe']);
const CMD_PATH = GLib.build_filenamev([PROBE_DIR, 'cmd.js']);
const OUT_PATH = GLib.build_filenamev([PROBE_DIR, 'out.jsonl']);
function walkAll(root) {
    const out = [];
    const walk = (a) => {
        out.push(a);
        let kids = [];
        try {
            kids = a.get_children?.() ?? [];
        }
        catch (e) { }
        for (const k of kids)
            walk(k);
    };
    try {
        walk(root);
    }
    catch (e) { }
    return out;
}
function cls(a) {
    try {
        return a?.get_style_class_name?.() ?? '';
    }
    catch (e) {
        return '';
    }
}
function rect(a) {
    try {
        const [x, y] = a.get_position();
        const [w, h] = a.get_size();
        return [x, y, w, h];
    }
    catch (e) {
        return [-1, -1, -1, -1];
    }
}
function sample(nowUs, lastUs, manager) {
    const s = {
        t: nowUs, dt: (nowUs - lastUs) / 1000,
        root: [-1, -1, -1, -1], rscale: 1, rop: 0,
        glass: [-1, -1, -1, -1], fbo: [-1, -1, -1, -1], fscale: 1,
        win: [-1, -1, -1, -1], wop: 0, sop: 0,
        blur: 0, clones: 0, actors: 0,
    };
    try {
        const all = walkAll(Main.layoutManager.uiGroup);
        s.actors = all.length;
        let root = null, glass = null, win = null, scrim = null, fbo = null;
        let clones = 0;
        for (const a of all) {
            const c = cls(a);
            if (!root && c.includes('transition-root'))
                root = a;
            else if (!glass && c.includes('floating-window-backing'))
                glass = a;
            else if (!win && c.includes('floating-window-container'))
                win = a;
            else if (!scrim && c.includes('liquid-glass-scrim'))
                scrim = a;
            if ((a.constructor?.name ?? '').includes('LiquidGlassUnpickableClone'))
                clones++;
            for (const eff of (() => { try {
                return a.get_effects?.() ?? [];
            }
            catch (e) {
                return [];
            } })()) {
                const n = eff.constructor?.name ?? '';
                if (n.includes('Blur') || n.includes('BlurEffect'))
                    s.blur++;
            }
        }
        if (!fbo && glass) {
            const find = (a) => {
                try {
                    for (const eff of a.get_effects?.() ?? [])
                        if ((eff.constructor?.name ?? '').includes('Blur')) {
                            fbo = a;
                            return true;
                        }
                }
                catch (e) { }
                for (const k of (() => { try {
                    return a.get_children?.() ?? [];
                }
                catch (e) {
                    return [];
                } })())
                    if (find(k))
                        return true;
                return false;
            };
            find(glass);
        }
        if (root) {
            s.root = rect(root);
            s.rscale = root.scale_x;
            s.rop = root.opacity;
        }
        if (glass)
            s.glass = rect(glass);
        if (fbo) {
            s.fbo = rect(fbo);
            s.fscale = fbo.scale_x;
        }
        if (win) {
            s.win = rect(win);
            s.wop = win.opacity;
        }
        if (scrim)
            s.sop = scrim.opacity;
        s.clones = clones;
        void manager;
    }
    catch (e) { }
    return s;
}
console.log('[LG-PROBE] module evaluated');
export function installDevProbe(manager) {
    console.log('[LG-PROBE] install called');
    const g = global;
    // DEV-PROBE-START: Eval refuses to run anything until unsafe mode is on, so
    // the probe has to flip it itself. Re-asserted on every install, because a
    // disable/enable cycle keeps this module (and global.__LGP) alive.
    try {
        global.context.unsafe_mode = true;
    }
    catch (e) {
        console.log(`[LG-PROBE] unsafe_mode failed: ${e}`);
    }
    // DEV-PROBE-END
    // Always replace: a rebuild stamps the import URL, so each reload evaluates a
    // fresh copy of this module, and the previous copy's closures would otherwise
    // keep pointing at the torn-down manager from before the reload.
    const P = {
        manager,
        tracing: false,
        samples: [],
        maxSamples: 600,
        tickId: 0,
        lastUs: 0,
        marks: [],
        mark(label) { this.marks.push({ t: GLib.get_monotonic_time(), label }); },
        clear() { this.samples.length = 0; this.marks.length = 0; this.resetCounts(); },
        _arm(fn) {
            const laters = global.compositor?.get_laters?.();
            if (laters)
                this.tickId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => { fn(); return GLib.SOURCE_REMOVE; });
            else
                this.tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8, () => { fn(); return GLib.SOURCE_REMOVE; });
        },
        start() {
            this.stop();
            this.clear();
            this.tracing = true;
            this.lastUs = GLib.get_monotonic_time();
            const tick = () => {
                if (!this.tracing)
                    return;
                const now = GLib.get_monotonic_time();
                this.samples.push(sample(now, this.lastUs, this.manager));
                this.lastUs = now;
                if (this.samples.length >= this.maxSamples) {
                    this.tracing = false;
                    this.tickId = 0;
                    return;
                }
                this._arm(tick);
            };
            this._arm(tick);
        },
        stop() {
            this.tracing = false;
            const laters = global.compositor?.get_laters?.();
            if (this.tickId) {
                try {
                    if (laters)
                        laters.remove(this.tickId);
                    else
                        GLib.source_remove(this.tickId);
                }
                catch (e) { }
                this.tickId = 0;
            }
        },
        summary() {
            const s = this.samples;
            if (!s.length)
                return { frames: 0 };
            const dts = s.slice(1).map((x) => x.dt).sort((a, b) => a - b);
            const pct = (p, arr) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))] ?? 0;
            const uniq = (f) => Array.from(new Set(s.map(f))).sort((a, b) => a - b);
            const u = (arr, cap = 12) => arr.length <= cap ? arr : [arr[0], '..', arr[arr.length - 1], `(${arr.length})`];
            return {
                frames: s.length,
                spanMs: Math.round((s[s.length - 1].t - s[0].t) / 1000),
                dtMin: +dts[0].toFixed(2), dtMed: +pct(0.5, dts).toFixed(2),
                dtP90: +pct(0.9, dts).toFixed(2), dtMax: +dts[dts.length - 1].toFixed(2),
                over20: dts.filter((d) => d > 20).length, over33: dts.filter((d) => d > 33).length,
                uniqRootX: u(uniq((x) => x.root[0])), uniqRootY: u(uniq((x) => x.root[1])),
                uniqRootW: u(uniq((x) => x.root[2])), uniqRootH: u(uniq((x) => x.root[3])),
                uniqGlassW: u(uniq((x) => x.glass[2])), uniqGlassH: u(uniq((x) => x.glass[3])),
                uniqFboW: u(uniq((x) => x.fbo[2])), uniqFboH: u(uniq((x) => x.fbo[3])),
                uniqWinW: u(uniq((x) => x.win[2])), uniqWinH: u(uniq((x) => x.win[3])),
                maxBlur: Math.max(...s.map((x) => x.blur)),
                maxClones: Math.max(...s.map((x) => x.clones)),
                maxActors: Math.max(...s.map((x) => x.actors)),
                marks: this.marks.map((m) => ({ label: m.label, ms: +((m.t - s[0].t) / 1000).toFixed(1) })),
                counts: { ...g.__LGCounts },
            };
        },
        changes() {
            const s = this.samples;
            if (!s.length)
                return [];
            const out = [];
            let prev = null;
            const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
            for (const x of s) {
                if (!prev || !same(prev.root, x.root) || !same(prev.glass, x.glass) || !same(prev.fbo, x.fbo) ||
                    !same(prev.win, x.win) || prev.fscale !== x.fscale) {
                    out.push({
                        t: +((x.t - s[0].t) / 1000).toFixed(1), dt: +x.dt.toFixed(1),
                        root: x.root, rootScale: +x.rscale.toFixed(4), rootOp: x.rop,
                        glass: x.glass, fbo: x.fbo.map((v, i) => i < 2 ? v : +v.toFixed(2)), fboScale: +x.fscale.toFixed(3),
                        win: x.win, winOp: x.wop, scrimOp: x.sop, blur: x.blur, clones: x.clones, actors: x.actors,
                    });
                }
                prev = x;
            }
            return out;
        },
        // Every distinct value of a single tracked field, with the frame it first appeared.
        field(name) {
            const s = this.samples;
            const pick = (x) => {
                switch (name) {
                    case 'root': return x.root.join(',');
                    case 'glass': return x.glass.join(',');
                    case 'fbo': return x.fbo.map((v) => +v.toFixed(2)).join(',');
                    case 'win': return x.win.join(',');
                    case 'rscale': return +x.rscale.toFixed(4);
                    case 'rop': return x.rop;
                    case 'wop': return x.wop;
                    case 'sop': return x.sop;
                    case 'blur': return x.blur;
                    case 'clones': return x.clones;
                    case 'actors': return x.actors;
                    case 'dt': return +x.dt.toFixed(1);
                    default: return '?';
                }
            };
            const seen = new Map();
            for (const x of s)
                if (!seen.has(pick(x)))
                    seen.set(pick(x), +((x.t - s[0].t) / 1000).toFixed(1));
            return Array.from(seen.entries()).map(([v, t]) => ({ v, t }));
        },
        report() {
            const manager = this.manager;
            const sub = manager?._submenuRenderer;
            const out = {
                submenuTransitioning: sub?._submenuTransitioning,
                hasFloatingWindow: !!sub?._floatingWindow,
                qsOverlay: null,
                floats: [],
            };
            try {
                const ov = manager?._qsBlurOverlay;
                if (ov)
                    out.qsOverlay = {
                        visible: !!ov.visible, opacity: ov.opacity, size: ov.get_size(), pos: ov.get_position(),
                        effects: (ov.get_effects?.() ?? []).length, children: ov.get_children?.().length ?? 0,
                        parent: ov.get_parent?.()?.constructor?.name ?? null,
                    };
            }
            catch (e) { }
            for (const a of walkAll(Main.layoutManager.uiGroup)) {
                const c = cls(a);
                if (!c.includes('liquid-glass-floating-window') && !c.includes('liquid-glass-scrim'))
                    continue;
                let eff = [];
                try {
                    eff = (a.get_effects?.() ?? []).map((e) => e.constructor?.name ?? '?');
                }
                catch (e) { }
                out.floats.push({
                    cls: c.replace('liquid-glass-', ''), name: a.constructor?.name,
                    pos: a.get_position(), size: a.get_size(), alloc: (() => { try {
                        return a.get_allocation?.();
                    }
                    catch (e) {
                        return null;
                    } })(),
                    opacity: a.opacity, visible: !!a.visible, mapped: !!a.mapped, reactive: !!a.reactive,
                    clip: !!a.clip_to_allocation, effects: eff, children: a.get_children?.().length ?? 0,
                    parent: a.get_parent?.()?.constructor?.name ?? null,
                });
            }
            out.counts = { ...g.__LGCounts };
            return out;
        },
        tree(filter = 'liquid-glass-floating-window') {
            const rows = [];
            const walk = (a, depth) => {
                if (depth > 9)
                    return;
                let eff = [];
                try {
                    eff = (a.get_effects?.() ?? []).map((e) => e.constructor?.name ?? '?');
                }
                catch (e) { }
                rows.push({
                    d: depth, cls: cls(a).replace('liquid-glass-', ''), name: a.constructor?.name,
                    pos: a.get_position(), size: a.get_size(), alloc: (() => { try {
                        return a.get_allocation?.();
                    }
                    catch (e) {
                        return null;
                    } })(),
                    op: a.opacity, vis: !!a.visible, map: !!a.mapped, clip: !!a.clip_to_allocation,
                    eff, kids: a.get_children?.().length ?? 0,
                });
                for (const k of (() => { try {
                    return a.get_children?.() ?? [];
                }
                catch (e) {
                    return [];
                } })())
                    walk(k, depth + 1);
            };
            const found = [];
            const find = (a) => { if (cls(a).includes(filter))
                found.push(a); for (const k of (() => { try {
                return a.get_children?.() ?? [];
            }
            catch (e) {
                return [];
            } })())
                find(k); };
            find(Main.layoutManager.uiGroup);
            for (const f of found)
                walk(f, 0);
            return rows;
        },
        cards() {
            const qs = Main.panel.statusArea?.quickSettings;
            const out = [];
            for (const key of ['_network', '_bluetooth', '_power', '_caffeine']) {
                for (const item of (qs?.[key]?.quickSettingsItems ?? [])) {
                    out.push({ key, title: item.title ?? item.label, cls: cls(item) });
                }
            }
            return out;
        },
        /** Card actor for a kind, as a reference the caller can hold. */
        card(kind, which = 0) {
            const qs = Main.panel.statusArea?.quickSettings;
            const map = { wifi: '_network', bluetooth: '_bluetooth', power: '_power', caffeine: '_caffeine' };
            const arr = Array.from(qs?.[map[kind] ?? '_network']?.quickSettingsItems ?? []);
            return arr[which] ?? null;
        },
        open(kind = 'wifi', which = 0) {
            const manager = this.manager;
            const card = this.card(kind, which);
            if (!card)
                return { ok: false };
            this.mark(`open:${kind}`);
            manager.showSubmenuInFloatingWindow(card, kind);
            return { ok: true, title: card.title ?? card.label };
        },
        closePanel(immediate = false) {
            this.mark('closePanel');
            this.manager._submenuRenderer?.close(false, immediate);
        },
        openQs() { this.mark('openQs'); this.manager.menu.toggle(); },
        unsafeOn() { global.context.unsafe_mode = true; return !!global.context.unsafe_mode; },
        /**
         * Times the synchronous open path piece by piece. Runs inside this module
         * so St/Clutter are in scope. The open blocks the shell while it builds the
         * panel, so this is where 'laggy' actually comes from.
         */
        timeOpen(kind = 'wifi') {
            const manager = this.manager;
            const sub = manager._submenuRenderer;
            const card = this.card(kind, 0);
            if (!card)
                return { error: 'no card' };
            if (sub._floatingWindow)
                sub.close(true, false);
            const res = {};
            const t = (label, fn) => {
                const a = GLib.get_monotonic_time();
                const r = fn();
                res[label] = +((GLib.get_monotonic_time() - a) / 1000).toFixed(2);
                return r;
            };
            t('fullOpen', () => manager.showSubmenuInFloatingWindow(card, kind));
            if (sub._floatingWindow)
                sub.close(true, false);
            t('fullOpenAgain', () => manager.showSubmenuInFloatingWindow(card, kind));
            if (sub._floatingWindow)
                sub.close(true, false);
            // Now the pieces, all of which run inside fullOpen.
            const rowsBox = t('newBoxLayout', () => new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL, style_class: 'liquid-glass-control-list'
            }));
            const scroll = t('newScrollView', () => {
                const sc = new St.ScrollView({ style_class: 'liquid-glass-control-scroll', overlay_scrollbars: true });
                sc.add_child(rowsBox);
                return sc;
            });
            const rows = t('buildWifiRows', () => sub._buildWifiRows(card));
            t('createRowWidgets', () => {
                for (const r of rows) {
                    if (r.section)
                        rowsBox.add_child(sub._createSectionLabel(r.title, !!r.scanning));
                    else
                        rowsBox.add_child(sub._createControlRow(r, () => { }));
                }
                rowsBox.add_child(sub._createDivider());
            });
            const panel = t('newSubmenuPanel', () => new SubmenuPanel({ manager }));
            t('attachScroll', () => panel.content.add_child(scroll));
            t('panelMeasure', () => panel.measure());
            t('panelDispose', () => panel.destroy(false));
            t('newLiquidEffect', () => {
                const e = new LiquidEffect({ extensionPath: manager.extensionPath, settings: manager._settings });
                e.cleanup();
                return e;
            });
            return res;
        },
        /** Records every frame the submenu animation actually applies. */
        animStart() { global.__LGAnim = { frames: [], ticks: [] }; return 'armed'; },
        animStop() { global.__LGAnim = null; return 'disarmed'; },
        animDump() {
            const a = global.__LGAnim;
            if (!a)
                return { frames: [] };
            const t0 = a.frames.length ? a.frames[0].us : 0;
            return {
                frames: a.frames.map((f) => ({
                    ms: t0 ? +((f.us - t0) / 1000).toFixed(1) : 0,
                    scale: f.scale, opacity: f.opacity, opening: f.opening, finished: f.finished,
                })),
                tickGapsMs: a.ticks.slice(1).map((t, i) => +((t - a.ticks[i]) / 1000).toFixed(1)),
            };
        },
        counts: () => ({ ...g.__LGCounts }),
        resetCounts() {
            g.__LGCounts = {
                overlaySync: 0, overlaySyncRebuild: 0, signature: 0, windowActors: 0,
                cloneCreate: 0, cloneDestroy: 0, cloneIndex: 0, cloneSync: 0,
                backingSync: 0, backingSyncRebuild: 0,
                refreshRows: 0, rowsRebuilt: 0, rowsCreated: 0, heightSync: 0,
                labelWalks: 0, nativeMenuWalk: 0, glibIdle: 0, glibTimeout: 0,
                effectCreate: 0, effectCleanup: 0, openEase: 0, closeEase: 0,
            };
        },
    };
    P.resetCounts();
    g.__LGP = P;
    manager._devProbe = P;
    startCommandChannel(P);
}
/**
 * Watches .probe/cmd.js and evaluates it in the shell. The harness writes the
 * file; the probe picks it up on the next idle, appends the JSON result to
 * .probe/out.jsonl, and truncates the command file so the next write is fresh.
 * A file monitor costs nothing while idle, unlike polling.
 */
function startCommandChannel(P) {
    const g = global;
    if (g.__LGPChannel)
        return;
    g.__LGPChannel = true;
    try {
        GLib.mkdir_with_parents(PROBE_DIR, 0o755);
    }
    catch (e) { }
    const file = Gio.File.new_for_path(CMD_PATH);
    try {
        if (!file.query_exists(null))
            file.replace_contents('', null, false, Gio.FileCreateFlags.NONE, null);
    }
    catch (e) { }
    let pending = false;
    const run = () => {
        pending = false;
        let code = '';
        try {
            const [, bytes] = file.load_contents(null);
            code = new TextDecoder().decode(bytes).trim();
        }
        catch (e) {
            return;
        }
        if (!code)
            return;
        // Consume first: a command that throws must not be retried forever.
        try {
            file.replace_contents('', null, false, Gio.FileCreateFlags.NONE, null);
        }
        catch (e) { }
        let result;
        try {
            // eslint-disable-next-line no-eval
            const value = eval(code);
            result = JSON.stringify(value === undefined ? null : value);
        }
        catch (e) {
            result = JSON.stringify({ error: String(e), stack: e?.stack ?? null });
        }
        try {
            const out = Gio.File.new_for_path(OUT_PATH);
            const stream = out.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(`${result}\n`, null);
            stream.close(null);
        }
        catch (e) { }
    };
    try {
        const monitor = file.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
        monitor.connect('changed', () => {
            if (pending)
                return;
            pending = true;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { run(); return GLib.SOURCE_REMOVE; });
        });
        g.__LGPChannelMonitor = monitor;
    }
    catch (e) {
        console.log(`[LG-PROBE] monitor failed: ${e}`);
    }
}
export function bump(name, by = 1) {
    const g = global;
    if (g.__LGCounts && g.__LGCounts[name] !== undefined)
        g.__LGCounts[name] += by;
}
