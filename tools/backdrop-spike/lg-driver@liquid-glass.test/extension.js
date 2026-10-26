// Drives the real Liquid Glass extension (and Dash to Dock) in the headless
// shell started by run-glass.sh. Reports through "[drv] ..." log lines and
// PNGs in $LG_SPIKE_OUT, then terminates the shell.
//
// Scenarios ($LG_DRV_SCENARIO):
//   dock       the dock over windows, a changing background and UI actors
//   ui         the calendar menu, Quick Settings, a notification and the OSD
//              (LG_DRV_FEATURES=qsdrill adds a pointer click on a QS card)
//   toggles    Quick Settings in toggle mode
//   outline    the ui and toggles scenarios with every surface's outline on
//              (LG_DRV_OUTLINE_WIDTH, default 3, and LG_DRV_OUTLINE_COLOR, default #ff2020)
//   fullstage  how many frames redraw the whole stage while the calendar opens
//   monitor    global._lgGlass.monitor() while windows move and a menu opens
//   lifecycle  disables and enables Liquid Glass with every glass shown once
//   window     application glass on a foot window: drag, a busy window behind,
//              a change in front, minimise, resize and close
//   arcmenu    ArcMenu's menu in several layouts and locations, its context
//              menu, and ArcMenu disabled and enabled again (run-glass.sh with
//              LG_EXTRA_EXTENSIONS=arcmenu@arcmenu.com)
//   adaptive   adaptive text colour: the backdrop read against a bare screen,
//              the colours while a menu opens, hovered rows, and the OSD while
//              its level changes
//   features   the top bar, menus growing out of their buttons, the desktop
//              widgets, the glass clock and the launcher, on a photo wallpaper
//              ($LG_DRV_WALLPAPER); LG_DRV_FEATURES picks parts (comma
//              separated: morph, topbar, widgets, clock, launcher; default all;
//              also morphtrace, qssub, clockshot, media, guides, launcherpointer,
//              launchercolor, iconstyle, iconglass; both need LG_DTD_DIR);
//              also scale (the calendar and the launcher on a small logical screen:
//              run-glass.sh with LG_SPIKE_MONITOR=2256x1504 and
//              LG_MONITORS_XML=tools/backdrop-spike/monitors-200.xml; LG_DRV_LIGHT=1 for the
//              light shell theme) and widgetcolors (the weather card's text colours after rebuilds);
//              $LG_DRV_SETTINGS_DUMP (a dconf dump) and $LG_DRV_ICON_THEME set up the session first
//   bench      global._lgBench.run() (run-glass.sh with LG_BENCH=1); LG_DRV_BENCH
//              picks scenarios (comma separated, default all), LG_DRV_BENCH_SECONDS
//              the seconds per scenario (default 3), LG_DRV_BENCH_AB=1 adds a run without UI glass,
//              LG_DRV_BENCH_MODES the modes to run (comma separated: stage, none, outline)
//
// Screenshots are off-stage paints, where a stage-reading glass draws with
// its last on-screen copy. The camera shows what was really on screen: while
// armed it copies a stage rect out of the framebuffer on every frame and
// draws that copy, so a screenshot of the camera is the on-screen result.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT_DIR = GLib.getenv('LG_SPIKE_OUT') ?? GLib.get_tmp_dir();
const SCENARIO = GLib.getenv('LG_DRV_SCENARIO') ?? 'dock';
const LG_UUID_DEFAULT = 'liquid-glass@thinkingcoding1231.gmail.com';
// The fork ships the extension under its metadata uuid, which need not match
// the directory this checkout lives in; find the enabled Liquid Glass instead.
let LG_UUID = LG_UUID_DEFAULT;
function resolveLgUuid() {
  // GNOME 51's ExtensionManager has no public `extensions` array: it keeps its
  // Extension objects in a private map and exposes lookup()/getUuids().
  const manager = Main.extensionManager;
  for (const uuid of manager.getUuids?.() ?? []) {
    if (manager.lookup(uuid)?.metadata?.name === 'Liquid Glass')
      return uuid;
  }
  return LG_UUID_DEFAULT;
}
const ARCMENU_UUID = 'arcmenu@arcmenu.com';
const COLORS = ['rgb(255,0,255)', 'rgb(255,255,0)'];

function log(msg) {
  console.log(`[drv] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);

// The same version split as the extension's shellVersion.ts.
function coglContext() {
  const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
  return backend.get_cogl_context();
}

// GNOME 46 calls paint_node without the paint context; see paintNodeWithContext()
// in the extension's shellVersion.ts.
function paintNodeWithContext(klass) {
  if (SHELL_MAJOR >= 47)
    return klass;
  const proto = klass.prototype;
  const paintNode = proto.vfunc_paint_node;
  delete proto.vfunc_paint_node;
  const parentPaint = Object.getPrototypeOf(proto).vfunc_paint;
  proto.vfunc_paint = function (paintContext) {
    const root = Clutter.ClipNode.new();
    paintNode.call(this, root, paintContext);
    root.paint(paintContext);
    parentPaint.call(this, paintContext);
  };
  return klass;
}

function newRootNode(framebuffer, colorState) {
  if (SHELL_MAJOR >= 48)
    return Clutter.RootNode.new(framebuffer, colorState, new Cogl.Color(), 0);
  return Clutter.RootNode.new(framebuffer, SHELL_MAJOR >= 47 ? new Cogl.Color() : new Clutter.Color(), 0);
}

function shot(name, [x, y, w, h]) {
  return new Promise(resolve => {
    const path = `${OUT_DIR}/${name}.png`;
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    new Shell.Screenshot().screenshot_area(x, y, w, h, stream, (obj, res) => {
      try {
        obj.screenshot_area_finish(res);
      } catch (e) {
        log(`shot ${name} failed: ${e}`);
      }
      stream.close(null);
      resolve();
    });
  });
}

const Camera = GObject.registerClass(paintNodeWithContext(
class Camera extends Clutter.Actor {
  _init(rect) {
    super._init({name: 'drv-camera', reactive: false});
    this.rect = rect;
    this.tex = null;
    this.off = null;
    this.armed = false;
  }

  vfunc_pick(_pickContext) {
  }

  vfunc_paint_node(root, paintContext) {
    const fb = paintContext.get_framebuffer();
    const view = this.peek_stage_views().find(v => v.get_framebuffer() === fb);
    if (this.armed && view && !this.is_in_clone_paint()) {
      const s = view.get_scale();
      const l = view.layout;
      const [x, y, w, h] = this.rect;
      const fx = Math.floor(x * s) + Math.round(-l.x * s);
      const fy = Math.floor(y * s) + Math.round(-l.y * s);
      const fw = Math.ceil(w * s);
      const fh = Math.ceil(h * s);
      if (!this.tex || this.tex.get_width() !== fw || this.tex.get_height() !== fh) {
        this.tex = Cogl.Texture2D.new_with_size(coglContext(), fw, fh);
        this.off = Cogl.Offscreen.new_with_texture(this.tex);
        this.off.allocate();
      }
      const target = newRootNode(this.off, view.color_state);
      root.add_child(target);
      const blit = Clutter.BlitNode.new(fb);
      blit.add_blit_rectangle(fx, fy, 0, 0, fw, fh);
      target.add_child(blit);
    }
    if (!this.tex)
      return;
    const pipeline = Cogl.Pipeline.new(coglContext());
    pipeline.set_layer_texture(0, this.tex);
    const node = Clutter.PipelineNode.new(pipeline);
    const [w, h] = this.get_size();
    node.add_texture_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: w, y2: h}), 0, 0, 1, 1);
    root.add_child(node);
  }
}));

// Paints nothing; records whether each frame redrew the whole stage.
const ClipProbe = GObject.registerClass(paintNodeWithContext(
class ClipProbe extends Clutter.Actor {
  _init(rect) {
    super._init({name: 'drv-clip-probe', reactive: false});
    this.set_position(rect[0], rect[1]);
    this.set_size(rect[2], rect[3]);
    this.rect = rect;
    this.last = null;
  }

  vfunc_pick(_pickContext) {
  }

  vfunc_paint_node(_root, paintContext) {
    const clip = paintContext.get_redraw_clip();
    const [x, y, width, height] = this.rect;
    this.last = clip
      ? ['OUT', 'IN', 'PART'][clip.contains_rectangle(new Mtk.Rectangle({x, y, width, height}))]
      : 'NOCLIP';
  }
}));

function lg() {
  return global._lgGlass;
}

function glassRows() {
  const out = lg()?.dump() ?? '';
  const rows = [];
  for (const line of out.split('\n')) {
    try {
      rows.push(JSON.parse(line));
    } catch {
    }
  }
  return rows;
}

function glassRow(owner) {
  return glassRows().find(r => r.owner === owner) ?? null;
}

function findActors(root, test) {
  const out = test(root) ? [root] : [];
  for (const child of root.get_children())
    out.push(...findActors(child, test));
  return out;
}

function findActor(root, name) {
  return findActors(root, a => a.get_name() === name)[0] ?? null;
}

function delta(a, b) {
  if (!a || !b)
    return 'n/a';
  return Object.keys(a).filter(k => typeof a[k] === 'number').map(k => `${k}=${b[k] - a[k]}`).join(' ');
}

export default class LgDriver extends Extension {
  enable() {
    LG_UUID = resolveLgUuid();
    this._actors = [];
    this._procs = [];
    this._signals = [];
    this._frames = 0;
    this._camera = null;
    this._cameraAway = false;
    this._signals.push([global.stage, global.stage.connect('after-paint', () => this._frames++)]);
    this._signals.push([global.stage, global.stage.connect('before-update', () => {
      if (this._camera?.armed)
        this._camera.queue_redraw();
    })]);
    // Disabling Liquid Glass makes the shell disable and enable the
    // extensions enabled after it, possibly this one: run the scenario once.
    if (globalThis._lgDriverStarted)
      return;
    globalThis._lgDriverStarted = true;
    this._run().catch(e => log(`FAILED ${e}\n${e.stack}`)).finally(() => this._finish());
  }

  disable() {
    for (const [obj, id] of this._signals)
      obj.disconnect(id);
    this._signals = [];
    for (const actor of this._actors)
      actor.destroy();
    this._actors = [];
    for (const proc of this._procs)
      proc.force_exit();
    this._procs = [];
  }

  async _run() {
    if (Main.layoutManager._startingUp) {
      await new Promise(resolve => {
        const id = Main.layoutManager.connect('startup-complete', () => {
          Main.layoutManager.disconnect(id);
          resolve();
        });
      });
    }
    if (Main.overview.visible)
      Main.overview.hide();
    await sleep(1500);
    // A banner's glass redraws while it is shown; the scenarios want a quiet stage.
    for (const source of Main.messageTray.getSources())
      source.destroy();
    await sleep(1500);
    for (const view of global.stage.peek_stage_views()) {
      const l = view.layout;
      log(`view layout=[${l.x},${l.y},${l.width},${l.height}] scale=${view.get_scale()}`);
    }
    this._camera = this._add(new Camera([0, 0, 10, 10]));
    this._camera.set_position(20, 60);
    // Wait for the dock glass to exist *and* to have geometry: it is created a
    // frame or two before its first paint, and a scenario that starts in
    // between bails as if there were no glass at all.
    for (let i = 0; i < 160 && !(this._glass('dock') && this._region('dock')); i++)
      await sleep(250);
    if (!lg()) {
      const states = Main.extensionManager.getUuids().map(uuid => `${uuid}=${Main.extensionManager.lookup(uuid).state}`);
      log(`Liquid Glass is not running: ${states.join(' ')}`);
    }

    if (SCENARIO === 'dock')
      await this._dockScenario();
    else if (SCENARIO === 'ui')
      await this._uiScenario();
    else if (SCENARIO === 'toggles')
      await this._togglesScenario();
    else if (SCENARIO === 'outline')
      await this._outlineScenario();
    else if (SCENARIO === 'fullstage')
      await this._fullStageScenario();
    else if (SCENARIO === 'monitor')
      await this._monitorScenario();
    else if (SCENARIO === 'lifecycle')
      await this._lifecycleScenario();
    else if (SCENARIO === 'window')
      await this._windowScenario();
    else if (SCENARIO === 'bench')
      await this._benchScenario();
    else if (SCENARIO === 'arcmenu')
      await this._arcMenuScenario();
    else if (SCENARIO === 'adaptive')
      await this._adaptiveScenario();
    else if (SCENARIO === 'features')
      await this._featuresScenario();
    log(`dump\n${lg().dump()}`);
  }

  _add(actor, below = null) {
    if (below)
      Main.layoutManager.uiGroup.insert_child_below(actor, below);
    else
      Main.layoutManager.uiGroup.add_child(actor);
    this._actors.push(actor);
    return actor;
  }

  _drop(actor) {
    actor.destroy();
    this._actors = this._actors.filter(a => a !== actor);
  }

  _lgSettings() {
    return Extension.lookupByUUID(LG_UUID).getSettings();
  }

  // The driver is enabled in the same pass as Liquid Glass, and extensions load
  // one at a time, so a scenario that starts straight away can run before LG is
  // in the manager. Wait for it before touching its settings. The default uuid
  // above is only a guess: the shell loads whatever metadata.json declares, so
  // re-resolve while waiting instead of polling the wrong uuid.
  async _waitForLg() {
    for (let i = 0; i < 80; i++) {
      const byName = resolveLgUuid();
      if (byName !== LG_UUID_DEFAULT)
        LG_UUID = byName;
      if (Extension.lookupByUUID?.(LG_UUID))
        return;
      await sleep(250);
    }
    log(`waitForLg: gave up with LG_UUID=${LG_UUID} loaded=` +
      JSON.stringify((Main.extensionManager.extensions ?? []).map(e => e.uuid)));
  }

  // Rebuilds one surface's glass by switching it off and on.
  async _rebuild(key) {
    const settings = this._lgSettings();
    settings.set_boolean(key, false);
    await sleep(300);
    settings.set_boolean(key, true);
    await sleep(2500);
  }

  _glass(owner) {
    return lg()?.glassObjects().find(g => g._owner === owner) ?? null;
  }

  _stats(owner) {
    return this._glass(owner)?.stats ?? null;
  }

  // A glass's rect plus room for its shadow, in stage coordinates.
  _region(owner) {
    let g = lg()?.geom(owner)[0];
    // Toggle mode draws regions; its composite rect covers them.
    if (!(g?.w > 0)) {
      const r = glassRow(owner)?.compositeRect ?? glassRow(owner)?.u?.compositeRect;
      g = r ? {x: r[0], y: r[1], w: r[2], h: r[3]} : null;
    }
    if (!g || !(g.w > 0))
      return null;
    const m = Main.layoutManager.primaryMonitor;
    const x = Math.max(0, Math.floor(m.x + g.x - 40));
    const y = Math.max(0, Math.floor(m.y + g.y - 40));
    const w = Math.min(m.width - x, Math.ceil(g.w + 80));
    const h = Math.min(m.height - y, Math.ceil(g.h + 80));
    return [x, y, w, h];
  }

  async _shots(tag, rect, owner) {
    // Menus at the top left would cover the camera's usual place.
    if (this._cameraAway) {
      const m = Main.layoutManager.primaryMonitor;
      this._camera.set_position(rect[0] + rect[2] / 2 < m.width / 2 ? m.width - rect[2] : 0, 60);
    }
    this._camera.rect = rect;
    this._camera.set_size(rect[2], rect[3]);
    this._camera.armed = true;
    // On a quiet stage nothing else asks for a frame.
    this._camera.queue_redraw();
    await sleep(200);
    const name = tag.replace(/ /g, '-');
    await shot(`${name}-screen`, rect);
    await shot(`${name}-camera`, [this._camera.x, this._camera.y, rect[2], rect[3]]);
    this._camera.armed = false;
    const row = glassRow(owner);
    if (!row) {
      log(`${tag}: no ${owner} glass row`);
      return;
    }
    const keys = ['mode', 'paints', 'copies', 'reuses', 'offStage', 'misses', 'materialCopies', 'blurRuns',
      'blurSkips', 'relayChanges', 'copy', 'desktop', 'material', 'blurRect', 'composited'];
    const picked = Object.fromEntries(keys.filter(k => k in row).map(k => [k, row[k]]));
    log(`${tag} frames=${this._frames} ${JSON.stringify(picked)} relays=${JSON.stringify(row.relays ?? null)}`);
  }

  // A window that redraws every frame. glxgears needs an X server, which the
  // shell in a distrobox runs without; there a terminal printing without
  // pause stands in.
  _spawnGears() {
    if (GLib.getenv('DISPLAY') && GLib.find_program_in_path('glxgears'))
      return this._spawn(['glxgears'], 'gears');
    return this._spawn(['foot', '-T', 'lgdrv-gears', 'sh', '-c', 'while :; do echo $RANDOM$RANDOM$RANDOM; done'], 'gears');
  }

  async _spawn(argv, title) {
    let proc;
    try {
      proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
      log(`spawn ${argv[0]} failed: ${e}`);
      return null;
    }
    this._procs.push(proc);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const actor = global.get_window_actors().find(a => (a.get_meta_window()?.get_title() ?? '').includes(title));
      if (actor)
        return {proc, actor, win: actor.get_meta_window()};
    }
    log(`no window for ${title}`);
    return null;
  }

  // Runs `step` between frames and checks the frame after each step: with
  // the backdrop changing behind the glass, that frame must take a new copy.
  // With `expectCopy` false (a change in front of the glass), it must not.
  async _audit(tag, owner, steps, intervalMs, step, expectCopy = true) {
    const glass = typeof owner === 'string' ? this._glass(owner) : owner;
    if (!glass) {
      log(`${tag} audit: no stage-reading ${owner} glass`);
      return;
    }
    const rec = [];
    let prev = glass.stats;
    let pending = false;
    const id = global.stage.connect('after-paint', () => {
      const cur = glass.stats;
      if (pending) {
        rec.push({painted: cur.paints > prev.paints, copied: cur.copies > prev.copies,
          reused: cur.reuses > prev.reuses, missed: cur.misses > prev.misses});
      }
      pending = false;
      prev = cur;
    });
    for (let i = 0; i < steps; i++) {
      step(i);
      pending = true;
      await sleep(intervalMs);
    }
    await sleep(100);
    global.stage.disconnect(id);
    const count = f => rec.filter(f).length;
    const bad = expectCopy ? count(r => !r.copied || !r.painted) : count(r => r.copied);
    log(`${tag} audit steps=${steps} frames=${rec.length} painted=${count(r => r.painted)} ` +
      `copied=${count(r => r.copied)} reused=${count(r => r.reused)} missed=${count(r => r.missed)} ` +
      `${expectCopy ? 'stale' : 'needless-copy'}=${bad} ${bad === 0 ? 'OK' : 'NG'}`);
  }

  // Frames and glass counters over a quiet period; both should stay put.
  async _idle(tag, owner, ms) {
    const before = this._stats(owner);
    const frames = this._frames;
    await sleep(ms);
    log(`${tag} idle ${ms}ms frames=${this._frames - frames} ${delta(before, this._stats(owner))}`);
  }

  // A plain widget behind a glass in paint order, inside `rect`.
  _behind(owner, rect, w = 120, h = 60) {
    const glass = this._glass(owner);
    const anchor = glass?.reader ?? glass;
    const widget = new St.Widget({name: `drv-behind-${owner}`, reactive: false, style: `background-color: ${COLORS[1]};`});
    widget.set_position(rect[0] + 60, rect[1] + 60);
    widget.set_size(w, h);
    return this._add(widget, anchor?.get_parent() === Main.layoutManager.uiGroup ? anchor : null);
  }

  // Counts whole-stage redraws while `run` runs.
  async _countFullStage(run) {
    const m = Main.layoutManager.primaryMonitor;
    const probe = this._add(new ClipProbe([m.x, m.y, m.width, m.height]));
    let frames = 0, full = 0;
    const id = global.stage.connect('after-paint', () => {
      frames++;
      if (probe.last === 'IN')
        full++;
      probe.last = null;
    });
    await run();
    global.stage.disconnect(id);
    this._drop(probe);
    return `frames=${frames} full-stage=${full}`;
  }

  async _dockScenario() {
    const region = this._region('dock');
    if (!region) {
      log('no dock glass');
      return;
    }
    log(`dock region=${JSON.stringify(region)}`);
    await this._shots('d0 baseline', region, 'dock');
    await this._idle('d0', 'dock', 2000);

    // An actor behind the glass and one in front of it.
    const [rx, ry, rw] = region;
    const behind = this._behind('dock', region);
    const front = this._add(new St.Widget({name: 'drv-front', reactive: false, style: 'background-color: rgb(0,255,255);'}));
    front.set_position(rx + rw - 140, ry + 50);
    front.set_size(30, 30);
    await sleep(500);
    await this._audit('d0a behind-colour', 'dock', 10, 120, i => behind.set_style(`background-color: ${COLORS[i % 2]};`));
    await this._audit('d0b behind-move', 'dock', 10, 120, i => { behind.translation_x = (i + 1) * 12; });
    await this._audit('d0c front-colour', 'dock', 10, 120, i => front.set_style(`background-color: ${COLORS[i % 2]};`), false);
    this._drop(behind);
    this._drop(front);
    await sleep(300);

    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-o', 'cursor.blink=no', '-T', 'lgdrv-a'], 'lgdrv-a');
    if (a) {
      a.win.move_resize_frame(true, rx + 80, ry - 300, 420, 380);
      await sleep(1200);
      await this._shots('d1 window', region, 'dock');
      await this._idle('d1', 'dock', 2000);
      await this._audit('d2 window-drag', 'dock', 20, 50, i => a.win.move_frame(true, rx + 80 + (i + 1) * 15, ry - 300));
      await sleep(300);
      await this._shots('d2 moved', region, 'dock');
    }

    const g = await this._spawnGears();
    if (g) {
      g.win.move_frame(true, rx + rw - 350, ry - 150);
      await sleep(800);
      await this._audit('d3 gears', 'dock', 30, 40, () => {});
      g.proc.force_exit();
      await sleep(800);
      await this._shots('d3b gears-gone', region, 'dock');
    }

    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    bg.set_string('picture-uri', '');
    bg.set_string('picture-uri-dark', '');
    bg.set_string('picture-options', 'none');
    bg.set_string('color-shading-type', 'solid');
    bg.set_string('primary-color', '#2050c0');
    await sleep(1500);
    await this._shots('d5 background', region, 'dock');

    if (a) {
      a.win.move_frame(true, rx + 200, ry - 200);
      await sleep(800);
    }
    await this._shots('d6 backdrop', region, 'dock');
    await this._rebuild('enable-dock-glass');
    await this._shots('d7 rebuilt', region, 'dock');
  }

  // Opens, checks and closes one menu-like surface.
  async _surface(tag, owner, open, close, keepOpen = () => {}) {
    const dockBefore = this._stats('dock');
    const full = await this._countFullStage(async () => {
      open();
      await sleep(1200);
    });
    const opening = `${full}, dock ${delta(dockBefore, this._stats('dock'))}`;
    const region = this._region(owner) ?? this._menuRegion();
    if (!region) {
      log(`${tag} no ${owner} glass`);
      close();
      await sleep(800);
      return;
    }
    log(`${tag} region=${JSON.stringify(region)} opening: ${opening}`);
    await this._shots(`${tag} open`, region, owner);
    await this._idle(tag, owner, 1500);
    await keepOpen();
    await sleep(200);
    const behind = this._behind(owner, region);
    await sleep(300);
    await this._audit(`${tag} behind-colour`, owner, 10, 120, i => behind.set_style(`background-color: ${COLORS[i % 2]};`));
    keepOpen();
    await sleep(200);
    await this._audit(`${tag} behind-move`, owner, 10, 120, i => { behind.translation_x = (i + 1) * 8; });
    keepOpen();
    await sleep(200);
    await this._shots(`${tag} behind`, region, owner);
    this._drop(behind);
    const dockBeforeClose = this._stats('dock');
    close();
    await sleep(1200);
    log(`${tag} closing: dock ${delta(dockBeforeClose, this._stats('dock'))}`);
  }

  // Quick Settings' menu on screen, for toggle mode, whose glass has regions
  // rather than one rect.
  _menuRegion() {
    const actor = Main.panel.statusArea.quickSettings.menu.actor;
    const ext = actor.get_transformed_extents();
    if (!(ext.size.width > 0))
      return null;
    return [Math.floor(ext.origin.x), Math.floor(ext.origin.y), Math.ceil(ext.size.width), Math.ceil(ext.size.height)];
  }

  async _uiScenario() {
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    const qs = Main.panel.statusArea.quickSettings.menu;
    const drill = (GLib.getenv('LG_DRV_FEATURES') ?? '').split(',').includes('qsdrill');
    let pointer = null;
    if (drill) {
      pointer = (SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend())
        .get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
      // A fresh virtual pointer starts in the hot corner, which opens the
      // overview and would dismiss every menu below; park it in the middle and
      // turn hot corners off first.
      new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
      const m = Main.layoutManager.primaryMonitor;
      pointer.notify_absolute_motion(GLib.get_monotonic_time(), m.x + m.width / 2, m.y + m.height / 2);
      await sleep(300);
      if (Main.overview.visible) {
        Main.overview.hide();
        await sleep(1200);
      }
    }
    await this._surface('m1 calendar', 'menu', () => dateMenu.open(true), () => dateMenu.close(true));
    await this._surface('q1 quick-settings', 'quick-settings', () => qs.open(true), () => qs.close(true),
      drill ? () => this._qsDrill(qs, pointer) : () => {});
    await this._surface('n1 notification', 'notification',
      () => Main.notify('Liquid Glass driver', 'A banner over the desktop'),
      () => {
        for (const source of Main.messageTray.getSources())
          source.destroy();
      });
    const icon = Gio.ThemedIcon.new('audio-volume-high-symbolic');
    // showAll() is GNOME 49's; before, show() with no monitor index.
    const showOsd = () => SHELL_MAJOR >= 49
      ? Main.osdWindowManager.showAll(icon, 'Volume', 0.6, 1)
      : Main.osdWindowManager.show(-1, icon, 'Volume', 0.6, 1);
    await this._surface('o1 osd', 'osd', showOsd, () => Main.osdWindowManager.hideAll(), showOsd);

    await this._menuShot('m2 calendar-again', dateMenu, 'menu');
  }

  // A real pointer click on a Quick Settings card has to open Liquid Glass's
  // floating submenu. The click goes through St's captured-event handling and
  // the extension's drill-down, which the qssub feature part does not exercise
  // (it opens the native menu directly). Called while the ui scenario's Quick
  // Settings surface is open and laid out.
  async _qsDrill(qs, pointer) {
    const m = Main.layoutManager.primaryMonitor;
    const lgExt = Extension.lookupByUUID(LG_UUID);
    const qsm = lgExt.stateObj?._quickSettingsManager ?? lgExt._quickSettingsManager;
    const t = () => GLib.get_monotonic_time();
    const brief = c => `${c.constructor.name}[${(c.get_style_class_name?.() ?? '').split(/\s+/).filter(s => s.startsWith('liquid-glass-card')).join('|')}]`;
    const all = [...(qsm._cardActors ?? [])];
    log(`qsdrill: qs.isOpen=${qs.isOpen} mapped=${qs.actor.mapped} children=${all.length} glass=${!!qsm._glass}`);
    for (const c of all) {
      const [p0, p1] = c.get_transformed_position();
      const [s0, s1] = c.get_transformed_size();
      log(`qsdrill:   ${brief(c)} menu=${!!(c.menu || c._menu)} mapped=${c.mapped} visible=${c.visible} ` +
        `reactive=${c.reactive} at=${Math.round(p0)},${Math.round(p1)} size=${Math.round(s0)}x${Math.round(s1)} ` +
        `drill=${!!c._liquidGlassDrilldownConnected} keep=${!!c._liquidGlassKeepNativeMenuButton}`);
    }
    const hasCardClass = c => (c.get_style_class_name?.() ?? '').split(/\s+/).includes('liquid-glass-card');
    // Prefer a card with the LG drill-down, then one whose card class is the
    // wide (submenu-carrying) shape, then anything the glass owns.
    const card = all.find(c => c._liquidGlassDrilldownConnected && c.visible && c.mapped) ??
      all.find(c => c.menu?.actor && c.visible && c.mapped) ??
      all.find(c => hasCardClass(c) && c.get_style_class_name().includes('squircle') && c.visible && c.mapped) ??
      all.find(c => hasCardClass(c) && c.visible && c.mapped);
    if (!card) {
      log('qsdrill: no card to click');
      return;
    }
    const [x, y, w, h] = [...card.get_transformed_position(), ...card.get_transformed_size()].map(Math.round);
    let hit = null;
    try { card.connect('clicked', () => { hit = 'clicked'; }); } catch (e) {}
    const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x + w / 2, y + h / 2);
    log(`qsdrill: clicking ${card.title ?? card.label ?? card.constructor.name} ${brief(card)} at ${x + w / 2},${y + h / 2} ` +
      `pick=${picked?.constructor?.name ?? 'null'} "${(picked?.get_style_class_name?.() ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('|')}"`);
    pointer.notify_absolute_motion(t(), x + w / 2, y + h / 2);
    await sleep(150);
    pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(80);
    pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await sleep(2000);
    const panel = qsm._submenuRenderer?._floatingWindow;
    const rows = panel?.content?.get_n_children?.() ?? -1;
    const glass = panel?._glass;
    const glassOk = glass?.constructor?.name === 'BackdropGlass' &&
      glass?._owner === 'quick-settings-submenu';
    log(`qsdrill: swayEvent=${hit ?? 'none'} floatingWindow=${!!panel} panelChildren=${rows} ` +
      `glass=${glass?.constructor?.name ?? 'none'} owner=${glass?._owner ?? '-'} paints=${glass?.paintCount ?? 0} ` +
      `qsOpen=${qs.isOpen} nativeMenuOpen=${!!card.menu?.isOpen}`);
    // The regression this part exists for: the card's click reached the LG
    // renderer but the floating window never came up, so the click looked dead.
    log(`qsdrill: ${hit === 'clicked' && panel && glassOk ? 'RESULT ok' : 'RESULT FAILED'} — ` +
      `clicked=${hit ?? 'none'} submenu=${!!panel} glass=${!!glassOk}`);
    await shot('qs-drilldown', [m.x + m.width - 700, m.y, 700, 900]);
    try { panel?.close?.(true); } catch (e) {}
    await sleep(1500);
  }

  async _outlineScenario() {
    const settings = this._lgSettings();
    for (const surface of ['dock', 'menu', 'panel-menu', 'notification', 'quick-settings', 'osd', 'application',
      'desktop-menu', 'top-bar', 'desktop-widget', 'launcher']) {
      settings.set_boolean(`${surface}-outline-enabled`, true);
      settings.set_double(`${surface}-outline-width`, Number(GLib.getenv('LG_DRV_OUTLINE_WIDTH') ?? 3));
      settings.set_string(`${surface}-outline-color`, GLib.getenv('LG_DRV_OUTLINE_COLOR') ?? '#ff2020');
    }
    await sleep(800);
    const dock = this._region('dock');
    if (dock)
      await this._shots('d1 dock', dock, 'dock');
    await this._uiScenario();
    await this._togglesScenario();
  }

  async _togglesScenario() {
    const settings = this._lgSettings();
    await sleep(1500);
    const qs = Main.panel.statusArea.quickSettings.menu;
    qs.open(true);
    await sleep(1200);
    const ext = qs.actor.get_transformed_extents();
    log(`t0 menu extents=${ext.origin.x},${ext.origin.y},${ext.size.width}x${ext.size.height} ` +
      `mapped=${qs.actor.mapped} glass=${JSON.stringify(this._glass('quick-settings-toggles')?.describe() ?? null)}`);
    qs.close(true);
    await sleep(1000);
    await this._surface('t1 toggles', 'quick-settings-toggles', () => qs.open(true), () => qs.close(true));
    await this._menuShot('t2 toggles-again', qs, 'quick-settings-toggles');
  }

  async _menuShot(tag, menu, owner) {
    menu.open(false);
    await sleep(1200);
    const region = this._region(owner) ?? this._menuRegion();
    if (region)
      await this._shots(tag, region, owner);
    else
      log(`${tag}: no region`);
    menu.close(false);
    await sleep(600);
  }

  async _fullStageScenario() {
    const settings = this._lgSettings();
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    const open = async () => {
      dateMenu.open(true);
      await sleep(1200);
    };
    log(`calendar first open: ${await this._countFullStage(open)}`);
    dateMenu.close(true);
    await sleep(1000);
    log(`calendar second open: ${await this._countFullStage(open)}`);
    dateMenu.close(true);
    await sleep(1000);
    settings.set_boolean('enable-menu-glass', false);
    await sleep(500);
    log(`calendar without glass: ${await this._countFullStage(open)}`);
    dateMenu.close(true);
    await sleep(1000);
  }

  async _arcMenuButton() {
    for (let i = 0; i < 40; i++) {
      const button = Main.panel.statusArea.ArcMenu;
      if (button?.arcMenu && button._menuLayout)
        return button;
      await sleep(250);
    }
    return null;
  }

  _arcMenuGlasses() {
    return lg().glassObjects().filter(g => g._owner.startsWith('menu:ArcMenu')).map(g => g._owner);
  }

  async _arcMenuScenario() {
    this._cameraAway = true;
    let button = await this._arcMenuButton();
    if (!button) {
      log('a0 no ArcMenu button');
      return;
    }
    const detected = this._lgSettings().get_strv('detected-extra-menus');
    log(`a0 detected=${JSON.stringify(detected)} glasses=${JSON.stringify(this._arcMenuGlasses())}`);
    const arcSettings = Extension.lookupByUUID(ARCMENU_UUID).getSettings();
    const toggle = () => button.toggleMenu();

    await this._surface('a1 arcmenu', 'menu:ArcMenu', toggle, toggle);
    for (const layout of ['11', 'raven', 'runner', 'plasma']) {
      arcSettings.set_string('menu-layout', layout);
      await sleep(2000);
      await this._menuShotWith(`a2 layout-${layout}`, toggle, toggle, 'menu:ArcMenu');
    }
    arcSettings.set_string('menu-layout', 'arcmenu');
    await sleep(2000);

    arcSettings.set_string('force-menu-location', 'BottomCentered');
    await sleep(1000);
    await this._menuShotWith('a3 bottom-centered', toggle, toggle, 'menu:ArcMenu');
    arcSettings.reset('force-menu-location');
    await sleep(1000);

    const context = button.arcMenuContextMenu;
    await this._surface('a4 context', 'menu:ArcMenuContextMenu', () => context.open(true), () => context.close(true));

    // Moving the button recreates it, and with it both menus.
    arcSettings.set_string('position-in-panel', 'Right');
    await sleep(2500);
    button = await this._arcMenuButton();
    log(`a5 moved glasses=${JSON.stringify(this._arcMenuGlasses())} leftovers=${this._leftovers().length}`);
    if (button)
      await this._menuShotWith('a5 moved', () => button.toggleMenu(), () => button.toggleMenu(), 'menu:ArcMenu');
    arcSettings.reset('position-in-panel');
    await sleep(2500);

    Main.extensionManager.disableExtension(ARCMENU_UUID);
    await sleep(1500);
    log(`a6 arcmenu disabled glasses=${JSON.stringify(this._arcMenuGlasses())} ` +
      `detected=${JSON.stringify(this._lgSettings().get_strv('detected-extra-menus'))}`);
    Main.extensionManager.enableExtension(ARCMENU_UUID);
    button = await this._arcMenuButton();
    await sleep(1500);
    log(`a7 arcmenu enabled glasses=${JSON.stringify(this._arcMenuGlasses())}`);
    if (button)
      await this._surface('a7 arcmenu-again', 'menu:ArcMenu', () => button.toggleMenu(), () => button.toggleMenu());

    this._lgSettings().set_strv('disabled-extra-menus', ['ArcMenu']);
    await sleep(1000);
    log(`a8 switched off glasses=${JSON.stringify(this._arcMenuGlasses())}`);
    this._lgSettings().reset('disabled-extra-menus');
    await sleep(1000);
    log(`a9 switched on glasses=${JSON.stringify(this._arcMenuGlasses())}`);
  }

  async _menuShotWith(tag, open, close, owner) {
    open();
    await sleep(1200);
    const region = this._region(owner);
    if (region)
      await this._shots(tag, region, owner);
    else
      log(`${tag}: no region`);
    close();
    await sleep(800);
  }

  async _setBackground(color) {
    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    bg.set_string('picture-uri', '');
    bg.set_string('picture-uri-dark', '');
    bg.set_string('picture-options', 'none');
    bg.set_string('color-shading-type', 'solid');
    bg.set_string('primary-color', color);
    await sleep(1500);
  }

  // Counts the sampler's measurements by path: the glass's backdrop, the
  // screen before the glass is drawn (with the glass tone), or the screen.
  _countPaths(sampler) {
    const counts = {backdrop: 0, bare: 0, screen: 0};
    const screen = sampler.sampleLuminance.bind(sampler);
    const backdrop = sampler.sampleBackdropLuminance.bind(sampler);
    sampler.sampleLuminance = (rect, tone) => {
      counts[tone ? 'bare' : 'screen']++;
      return screen(rect, tone);
    };
    sampler.sampleBackdropLuminance = (...args) => {
      counts.backdrop++;
      return backdrop(...args);
    };
    return counts;
  }

  _fg(actor) {
    const c = actor.get_theme_node().get_foreground_color();
    return `#${[c.red, c.green, c.blue].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }

  _stageRect(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return {x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h)};
  }

  async _adaptiveScenario() {
    const ext = Extension.lookupByUUID(LG_UUID);
    const mod = await import(`file://${ext.path}/dist/contrastSampler.js`);
    const ui = ext.stateObj?._uiManager ?? ext._uiManager;
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    const fresh = () => new mod.StageContrastSampler();
    const f3 = v => v === null ? 'null' : v.toFixed(3);

    // e1: the backdrop read through the glass's copy against a screenshot of
    // the same rect with the menu closed, for plain colours and for a
    // backdrop that is bright only in its top half.
    for (const color of ['#f0f0f0', '#202020', '#7a7a7a', '#3060c0']) {
      await this._setBackground(color);
      dateMenu.open(true);
      await sleep(1800);
      const rect = this._stageRect(ui.menu.actor);
      const copy = ui.glass.backdropCopy();
      const tone = mod.glassToneOf(ui.glass.uniformValues);
      const read = copy ? await fresh().sampleBackdropLuminance(copy, rect, tone) : null;
      const onScreen = await fresh().sampleLuminance(rect);
      dateMenu.close(true);
      await sleep(1500);
      const bare = await fresh().sampleLuminance(rect, tone);
      const ok = read !== null && bare !== null && Math.abs(read - bare) < 0.02;
      log(`e1 ${color} rect=${JSON.stringify(rect)} copy=${copy ? JSON.stringify(copy.rect.map(Math.round)) : null} ` +
        `backdrop=${f3(read)} bare=${f3(bare)} screen-with-glass=${f3(onScreen)} ${ok ? 'OK' : 'NG'}`);
    }
    await this._setBackground('#202020');
    dateMenu.open(true);
    await sleep(1800);
    const rect = this._stageRect(ui.menu.actor);
    dateMenu.close(true);
    await sleep(1200);
    const top = {...rect, height: Math.round(rect.height / 2)};
    const bottom = {...rect, y: rect.y + top.height, height: rect.height - top.height};
    const bright = this._behind('menu', [rect.x - 60, rect.y - 60, 0, 0], rect.width, top.height);
    bright.set_style('background-color: rgb(240,240,240);');
    await sleep(500);
    dateMenu.open(true);
    await sleep(1800);
    const tone = mod.glassToneOf(ui.glass.uniformValues);
    const copy = ui.glass.backdropCopy();
    const readTop = await fresh().sampleBackdropLuminance(copy, top, tone);
    const readBottom = await fresh().sampleBackdropLuminance(copy, bottom, tone);
    dateMenu.close(true);
    await sleep(1500);
    const bareTop = await fresh().sampleLuminance(top, tone);
    const bareBottom = await fresh().sampleLuminance(bottom, tone);
    const halvesOk = Math.abs(readTop - bareTop) < 0.03 && Math.abs(readBottom - bareBottom) < 0.03 && readTop > readBottom;
    log(`e1 halves top backdrop=${f3(readTop)} bare=${f3(bareTop)} bottom backdrop=${f3(readBottom)} bare=${f3(bareBottom)} ` +
      `${halvesOk ? 'OK' : 'NG'}`);
    this._drop(bright);

    // e2: the text colour from the moment a menu opens, after it last opened
    // over the other background.
    const timeline = async (tag, manager, open, close) => {
      const counts = this._countPaths(manager._contrastSampler);
      for (const color of ['#101010', '#f0f0f0', '#101010']) {
        await this._setBackground(color);
        for (const k of Object.keys(counts))
          counts[k] = 0;
        const t0 = GLib.get_monotonic_time();
        const applied = [];
        const apply = manager._applyAdaptiveColorMap;
        manager._applyAdaptiveColorMap = function (map, skip) {
          applied.push(`${Math.round((GLib.get_monotonic_time() - t0) / 1000)}ms:${map.size}${skip ? 's' : ''}` +
            `${label && map.has(label) ? `:${map.get(label)}` : ''}`);
          return apply.call(this, map, skip);
        };
        // A label on the glass itself, not on a card of its own. Picked again
        // at every mark: some menus (Kiwi Menu) rebuild their items on open.
        const pick = () => {
          const onGlass = manager._collectAdaptiveTextTargets()
            .filter(a => a instanceof St.Label && a.text && mod.backdropLuminance(a, manager.menu.actor) === null);
          return onGlass.find(a => a.mapped) ?? onGlass[0];
        };
        let label = pick();
        // Frames drawn with the label in another colour than the one it ends up with.
        const painted = [];
        const paintId = global.stage.connect('after-paint', () => {
          const l = pick();
          if (l?.mapped && GLib.get_monotonic_time() - t0 < 1500e3)
            painted.push(this._fg(l));
        });
        open();
        const marks = [];
        for (const at of [0, 30, 60, 100, 200, 400, 700, 1000, 1400, 2000]) {
          const wait = at - (GLib.get_monotonic_time() - t0) / 1000;
          if (wait > 0)
            await sleep(wait);
          label = pick() ?? label;
          marks.push(`${at}:${label ? this._fg(label) : '-'}`);
        }
        global.stage.disconnect(paintId);
        const final = label ? this._fg(label) : null;
        const wrongFrames = painted.filter(c => c !== final).length;
        const settledAt = marks.findIndex(m => m.endsWith(final));
        const steady = marks.slice(settledAt).every(m => m.endsWith(final));
        const want = color === '#f0f0f0' ? '#1a1a1a' : '#f2f2f2';
        // The first colours applied are the final ones, without a tween.
        const first = applied.find(a => !/:0s?(:#[0-9a-f]+)?$/.test(a)) ?? '';
        manager._applyAdaptiveColorMap = apply;
        // From the 30 ms mark on, the label shows the final colour.
        log(`e2 ${tag} ${color} ${marks.join(' ')} paths=${JSON.stringify(counts)} applied=${applied.join(',')} ` +
          `first=${first.split(':')[0]} frames=${painted.length} wrong-frames=${wrongFrames} ` +
          `${final === want && steady && settledAt <= 3 ? 'OK' : 'NG'}`);
        close();
        await sleep(1500);
      }
    };
    await timeline('calendar', ui, () => dateMenu.open(true), () => dateMenu.close(true));

    const button = new PanelMenu.Button(0.0, 'lgdrv-menu', false);
    button.add_child(new St.Label({text: 'Drv', y_align: Clutter.ActorAlign.CENTER}));
    const items = [];
    for (let i = 0; i < 6; i++) {
      const item = new PopupMenu.PopupMenuItem(`Row ${i}`);
      button.menu.addMenuItem(item);
      items.push(item);
    }
    Main.panel.addToStatusArea('lgdrvMenu', button);
    let panelManager = null;
    for (let i = 0; i < 20 && !panelManager; i++) {
      await sleep(250);
      const pmm = ext.stateObj?._panelMenuManager ?? ext._panelMenuManager;
      panelManager = [...(pmm?._menus?.values() ?? [])].find(e => e.name === 'lgdrvMenu')?.manager ?? null;
    }
    if (!panelManager) {
      log('e2 no glass for the driver menu');
      button.destroy();
      return;
    }
    await timeline('panel-menu', panelManager, () => button.menu.open(true), () => button.menu.close(true));

    // e3: hovered rows take the highlight's colour, and the others keep theirs.
    // A row can stay highlighted after it is left, through its key focus
    // (GNOME 46).
    const hoverCheck = async (tag, rows) => {
      const labelsOf = row => {
        const found = [];
        const walk = a => {
          if (a instanceof St.Label && a.mapped && a.text)
            found.push(a);
          a.get_children().forEach(walk);
        };
        walk(row);
        return found;
      };
      const lit = row => row.get_theme_node().get_background_color().alpha >= 190;
      const shared = this._fg(labelsOf(rows[rows.length - 1])[0]);
      const check = () => {
        const plain = [...new Set(rows.filter(r => !lit(r)).flatMap(r => labelsOf(r).map(l => this._fg(l))))];
        const highlighted = rows.filter(lit).flatMap(r => labelsOf(r).map(l => this._fg(l)));
        return {plain, highlighted, ok: plain.length === 1 && plain[0] === shared && highlighted.every(c => c !== shared)};
      };
      rows[0].active = true;
      await sleep(60);
      const hovered = check();
      rows[0].active = false;
      await sleep(60);
      const left = check();
      log(`e3 ${tag} hover shared=${shared} hovered=${JSON.stringify(hovered)} left=${JSON.stringify(left)} ` +
        `${hovered.ok && left.ok ? 'OK' : 'NG'}`);
      for (let round = 0; round < 3; round++) {
        for (const row of rows) {
          row.active = true;
          await sleep(25);
          row.active = false;
        }
      }
      await sleep(60);
      const swept = check();
      log(`e3 ${tag} sweep ${JSON.stringify(swept)} ${swept.ok ? 'OK' : 'NG'}`);
      await sleep(1000);
      const later = check();
      log(`e3 ${tag} sweep+1s ${JSON.stringify(later)} ${later.ok ? 'OK' : 'NG'}`);
    };
    await this._setBackground('#f0f0f0');
    button.menu.open(true);
    await sleep(1800);
    await hoverCheck('panel-menu', items);
    button.menu.close(true);
    await sleep(1200);
    button.destroy();
    await sleep(500);

    // ArcMenu, when the run enables it (LG_EXTRA_EXTENSIONS=arcmenu@arcmenu.com).
    const arcButton = Main.panel.statusArea.ArcMenu;
    const pmm = ext.stateObj?._panelMenuManager ?? ext._panelMenuManager;
    const arcManager = [...(pmm?._menus?.values() ?? [])].find(e => e.name === 'ArcMenu')?.manager ?? null;
    if (arcButton && arcManager) {
      this._cameraAway = true;
      await timeline('arcmenu', arcManager, () => arcButton.toggleMenu(), () => arcButton.toggleMenu());
      await this._setBackground('#f0f0f0');
      arcButton.toggleMenu();
      await sleep(1800);
      const rows = [];
      const walk = a => {
        if (typeof a._setSelectedStyle === 'function' && a.mapped && a.reactive)
          rows.push(a);
        a.get_children().forEach(walk);
      };
      walk(arcButton.arcMenu.box);
      log(`e3 arcmenu rows=${rows.length}`);
      if (rows.length > 1)
        await hoverCheck('arcmenu', rows.slice(0, 8));
      arcButton.toggleMenu();
      await sleep(1500);
    }

    // Kiwi Menu, when the run enables it (LG_EXTRA_EXTENSIONS=kiwimenu@kemma). It
    // rebuilds its items every time it opens.
    const kiwiButton = Main.panel.statusArea.KiwiMenuButton;
    const kiwiManager = [...(pmm?._menus?.values() ?? [])].find(e => e.name === 'KiwiMenuButton')?.manager ?? null;
    if (kiwiButton && kiwiManager) {
      this._cameraAway = true;
      await timeline('kiwimenu', kiwiManager, () => kiwiButton.menu.open(true), () => kiwiButton.menu.close(true));
    } else if (kiwiButton) {
      log('e2 kiwimenu has no glass');
    }

    const qs = ext.stateObj?._quickSettingsManager ?? ext._quickSettingsManager;
    if (qs) {
      this._lgSettings().set_boolean('quick-settings-enable-adaptive-text-color', true);
      await sleep(500);
      const qsMenu = Main.panel.statusArea.quickSettings.menu;
      await timeline('quick-settings', qs, () => qsMenu.open(true), () => qsMenu.close(true));
    }

    // e4: the OSD's text while its level bar moves.
    const osd = ext.stateObj?._osdManager ?? ext._osdManager;
    const icon = Gio.ThemedIcon.new('audio-volume-high-symbolic');
    const showOsd = level => SHELL_MAJOR >= 49
      ? Main.osdWindowManager.showAll(icon, 'Volume', level, 1)
      : Main.osdWindowManager.show(-1, icon, 'Volume', level, 1);
    for (const color of ['#f0f0f0', '#101010', '#8a8a8a']) {
      await this._setBackground(color);
      const counts = this._countPaths(osd._contrastSampler);
      const seen = [];
      for (let i = 0; i < 14; i++) {
        showOsd(i % 2 ? 1.0 : 0.0);
        await sleep(250);
        const label = osd._collectAdaptiveTextTargets().find(a => a instanceof St.Label);
        if (label && i > 1)
          seen.push(this._fg(label));
      }
      const distinct = [...new Set(seen)];
      log(`e4 osd ${color} colours=${JSON.stringify(distinct)} paths=${JSON.stringify(counts)} ` +
        `${distinct.length === 1 && counts.screen === 0 ? 'OK' : 'NG'}`);
      Main.osdWindowManager.hideAll();
      await sleep(1500);
    }
  }

  async _monitorScenario() {
    lg().monitor(0);
    await sleep(2200);
    const region = this._region('dock');
    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-T', 'lgdrv-a'], 'lgdrv-a');
    const g = await this._spawnGears();
    if (a && region) {
      a.win.move_frame(true, region[0] + 80, region[1] - 300);
      g?.win.move_frame(true, region[0] + region[2] - 350, region[1] - 150);
      for (let i = 0; i < 30; i++) {
        a.win.move_frame(true, region[0] + 80 + i * 10, region[1] - 300);
        await sleep(50);
      }
    }
    await sleep(1500);
    g?.proc.force_exit();
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    dateMenu.open(true);
    await sleep(2000);
    dateMenu.close(true);
    await sleep(2000);
    lg().monitorStop();
  }

  async _benchScenario() {
    const which = GLib.getenv('LG_DRV_BENCH') ?? 'all';
    const seconds = Number(GLib.getenv('LG_DRV_BENCH_SECONDS') ?? 3);
    const modes = GLib.getenv('LG_DRV_BENCH_MODES')?.split(',');
    log(global._lgBench.run(which === 'all' ? 'all' : which.split(','),
      {seconds, settle: 2, ab: GLib.getenv('LG_DRV_BENCH_AB') === '1', ...(modes ? {modes} : {})}));
    await sleep(1000);
    while (global._lgBench.running)
      await sleep(500);
    log(`after bench: leftovers=${JSON.stringify(this._leftovers())} windows=${global.get_window_actors().length}`);
  }

  // Our own actors left anywhere on the stage.
  _leftovers() {
    const names = [];
    const walk = a => {
      const name = a.get_name() ?? '';
      if (/^liquid-(glass|box)|^clone-container|^optimization-breaker/.test(name))
        names.push(name);
      if (a.get_effect('liquid-glass-icon-style'))
        names.push(`icon-style:${a.icon_name ?? a.gicon?.to_string() ?? '?'}`);
      for (const c of a.get_children())
        walk(c);
    };
    walk(global.stage);
    return names;
  }

  // The glass inside a window actor.
  _windowGlass(actor) {
    return lg()?.glassObjects().find(g => g.get_parent() === actor) ?? null;
  }

  _windowRegion(win, margin = 90) {
    const r = win.get_frame_rect();
    const m = Main.layoutManager.primaryMonitor;
    const x = Math.max(0, r.x - margin), y = Math.max(0, r.y - margin);
    return [x, y, Math.min(m.width - x, r.width + margin * 2), Math.min(m.height - y, r.height + margin * 2)];
  }

  async _windowScenario() {
    // A white desktop, where a drop shadow's banding shows most.
    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    bg.set_string('picture-uri', '');
    bg.set_string('picture-uri-dark', '');
    bg.set_string('picture-options', 'none');
    bg.set_string('color-shading-type', 'solid');
    bg.set_string('primary-color', '#ffffff');
    const settings = this._lgSettings();
    settings.set_strv('application-window-whitelist', ['foot']);
    settings.set_boolean('enable-application-glass', true);
    await sleep(500);
    const b = await this._spawn(['foot', '-o', 'colors.background=20a040', '-o', 'cursor.blink=no', '-T', 'lgdrv-b'], 'lgdrv-b');
    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-o', 'cursor.blink=no', '-T', 'lgdrv-a'], 'lgdrv-a');
    if (!a || !b) {
      log('window: no windows');
      return;
    }
    b.win.move_resize_frame(true, 300, 200, 500, 400);
    a.win.move_resize_frame(true, 600, 300, 500, 400);
    a.win.activate(global.get_current_time());
    await sleep(1500);
    const glass = this._windowGlass(a.actor);
    log(`w0 glass=${glass ? JSON.stringify(glass.describe()) : 'none'} wmclass=${a.win.get_wm_class()}`);
    if (!glass)
      return;
    await this._shots('w0 window', this._windowRegion(a.win), 'application');
    await this._idle('w0', 'application', 2000);

    // The window behind moves under the glass.
    await this._audit('w1 behind-move', glass, 15, 80, i => b.win.move_frame(true, 300 + (i + 1) * 10, 200));
    // The glass's own window is dragged.
    await this._audit('w2 window-drag', glass, 20, 50, i => a.win.move_frame(true, 600 + (i + 1) * 12, 300));
    await sleep(300);
    await this._shots('w2 moved', this._windowRegion(a.win), 'application');

    // A window behind that redraws every frame.
    const g = await this._spawnGears();
    if (g) {
      const r = a.win.get_frame_rect();
      g.win.move_frame(true, r.x - 150, r.y + 100);
      a.win.activate(global.get_current_time());
      await sleep(1000);
      await this._audit('w3 gears-behind', glass, 30, 40, () => {});
      await this._shots('w3 gears', this._windowRegion(a.win), 'application');
      g.proc.force_exit();
      await sleep(800);
    }

    // A change in front of the window is not behind its glass.
    const r = a.win.get_frame_rect();
    const front = this._add(new St.Widget({name: 'drv-front', reactive: false, style: 'background-color: rgb(0,255,255);'}));
    front.set_position(r.x + 100, r.y + 100);
    front.set_size(60, 60);
    await sleep(500);
    await this._audit('w4 front-colour', glass, 10, 120, i => front.set_style(`background-color: ${COLORS[i % 2]};`), false);
    this._drop(front);

    // Resize, then minimise and restore.
    a.win.move_resize_frame(true, r.x, r.y, 640, 460);
    await sleep(1200);
    log(`w5 resized glass=${JSON.stringify({size: glass.get_size(), pos: [glass.x, glass.y]})}`);
    await this._shots('w5 resized', this._windowRegion(a.win), 'application');
    a.win.minimize();
    await sleep(1200);
    a.win.unminimize();
    a.win.activate(global.get_current_time());
    await sleep(1500);
    log(`w6 restored mapped=${glass.mapped} alloc=${glass.has_allocation()} stats=${JSON.stringify(glass.stats)}`);
    await this._shots('w6 restored', this._windowRegion(a.win), 'application');

    // Closing the window takes its glass along.
    a.proc.force_exit();
    await sleep(1500);
    log(`w7 closed glasses=${lg().glassObjects().filter(x => x._owner === 'application').length}`);
    settings.set_boolean('enable-application-glass', false);
    await sleep(800);
    log(`w8 disabled glasses=${lg().glassObjects().filter(x => x._owner === 'application').length} ` +
      `windowActorChildren=${b.actor.get_n_children()}`);
  }

  async _lifecycleScenario() {
    const settings = this._lgSettings();
    await sleep(1500);
    const qs = Main.panel.statusArea.quickSettings.menu;
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    for (const menu of [qs, dateMenu]) {
      menu.open(true);
      await sleep(800);
      menu.close(true);
      await sleep(600);
    }
    Main.notify('Liquid Glass driver', 'lifecycle');
    await sleep(800);
    // Disabling has to stop a running monitor and take its probes along.
    lg().monitor(0);
    await sleep(1200);
    log(`before disable: glasses=${lg().glassObjects().length} actors=${this._leftovers().length}`);
    Main.extensionManager.disableExtension(LG_UUID);
    await sleep(1000);
    log(`after disable: _lgGlass=${global._lgGlass === undefined ? 'gone' : 'present'} leftovers=${JSON.stringify(this._leftovers())}`);
    Main.extensionManager.enableExtension(LG_UUID);
    await sleep(4000);
    const dock = this._glass('dock');
    log(`after enable: glasses=${lg()?.glassObjects().length} dock=${dock ? JSON.stringify(dock.stats) : 'none'}`);
    qs.open(true);
    await sleep(800);
    log(`toggles after enable: ${JSON.stringify(this._glass('quick-settings-toggles')?.stats ?? null)}`);
    qs.close(true);
    await sleep(600);
  }

  async _lgModule(path) {
    return import(`file://${Extension.lookupByUUID(LG_UUID).path}/dist/${path}`);
  }

  // Runs the menus' morphs `factor` times slower, so shots catch them midway.
  async _slowMorph(factor) {
    const {MenuMorphMotion} = await this._lgModule('animation/menuMorph.js');
    const step = MenuMorphMotion.prototype._drvStep ?? MenuMorphMotion.prototype.step;
    MenuMorphMotion.prototype._drvStep = step;
    MenuMorphMotion.prototype.step = function (elapsed) {
      return step.call(this, elapsed / factor);
    };
  }

  async _timedShots(tag, rect, times) {
    const start = GLib.get_monotonic_time();
    for (const t of times) {
      const wait = t - (GLib.get_monotonic_time() - start) / 1000;
      if (wait > 0)
        await sleep(wait);
      await shot(`${tag}-${t}`, rect);
    }
  }

  // Moves the weather card through its menu until its centre is a few px
  // off the clock's, and reports the guides shown while it is held there.
  async _editGuides(settings, m) {
    settings.set_string('desktop-item-positions', '{}');
    settings.set_boolean('enable-glass-clock', true);
    settings.set_string('glass-clock-position', 'center');
    settings.set_strv('desktop-widgets', ['weather', 'events']);
    settings.set_boolean('enable-desktop-widgets', true);
    await sleep(4000);
    const clock = findActor(global.window_group, 'liquid-glass-desktop-clock');
    const weather = findActor(global.window_group, 'liquid-glass-desktop-weather');
    if (!clock || !weather?.mapped) {
      log(`guides: clock=${!!clock} weather=${weather?.mapped}`);
      return;
    }
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
    const pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    await sleep(300);
    if (Main.overview.visible) {
      Main.overview.hide();
      await sleep(1500);
    }
    const t = () => GLib.get_monotonic_time();
    const move = async (x, y) => {
      pointer.notify_absolute_motion(t(), x, y);
      await sleep(60);
    };
    const button = async state => {
      pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, state);
      await sleep(60);
    };
    const rectOf = a => [...a.get_transformed_position(), ...a.get_transformed_size()].map(Math.round);
    const [wx, wy, ww, wh] = rectOf(weather);
    await move(wx + 40, wy + 40);
    pointer.notify_button(t(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
    await sleep(60);
    pointer.notify_button(t(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
    await sleep(500);
    const entry = Main.layoutManager.uiGroup.get_children()
      .flatMap(c => findActors(c, a => a instanceof PopupMenu.PopupMenuItem && a.mapped)).find(i => i.label.text === 'Move');
    if (!entry) return;
    const [ex, ey] = entry.get_transformed_position();
    await move(ex + 20, ey + 10);
    await button(Clutter.ButtonState.PRESSED);
    await button(Clutter.ButtonState.RELEASED);
    await sleep(500);
    const layer = Main.layoutManager.uiGroup.get_children().find(c => c.get_name() === 'liquid-glass-edit');
    if (!layer) return;
    const [cx, cy, cw] = rectOf(clock);
    const guides = () => layer.get_children().filter(c => c.has_style_class_name('liquid-glass-edit-guide') && c.visible)
      .map(c => `[${rectOf(c)}]`).join(',');
    // The weather card's shown part is the card itself; its centre goes 4 px right of the clock's.
    const start = [wx + ww / 2, wy + wh / 2];
    const to = [cx + cw / 2 + 4, Math.max(m.y + 60 + wh / 2, cy - wh)];
    await move(...start);
    await button(Clutter.ButtonState.PRESSED);
    for (let i = 1; i <= 12; i++) await move(start[0] + (to[0] - start[0]) * i / 12, start[1] + (to[1] - start[1]) * i / 12);
    await sleep(300);
    const [nx, , nw] = rectOf(weather);
    log(`guides: clock centre=${cx + cw / 2} weather centre=${nx + nw / 2} (pointer +4) guides=${guides()}`);
    await shot('guides-centre', [m.x, m.y, m.width, m.height]);
    await button(Clutter.ButtonState.RELEASED);
    await sleep(300);
    log(`guides: after release guides=${guides() || 'none'} positions=${settings.get_string('desktop-item-positions')}`);
    await move(m.x + 40, m.y + m.height - 60);
    await button(Clutter.ButtonState.PRESSED);
    await button(Clutter.ButtonState.RELEASED);
    await sleep(300);
  }

  // Moves and resizes the clock through its menu and edit frame, with a
  // virtual pointer. With Desktop Icons (run-glass.sh with
  // LG_EXTRA_EXTENSIONS=ding@rastersoft.com) the clock has to be above its window.
  async _editClock(settings, m) {
    const clock = findActor(global.window_group, 'liquid-glass-desktop-clock');
    if (!clock) {
      log('edit: no clock');
      return;
    }
    // A new pointer starts in the hot corner and would open the overview.
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    await sleep(300);
    const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
    const pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    await sleep(300);
    if (Main.overview.visible) {
      Main.overview.hide();
      await sleep(1500);
    }
    const t = () => GLib.get_monotonic_time();
    const move = async (x, y) => {
      pointer.notify_absolute_motion(t(), x, y);
      await sleep(60);
    };
    const click = async (x, y, button = Clutter.BUTTON_PRIMARY) => {
      await move(x, y);
      pointer.notify_button(t(), button, Clutter.ButtonState.PRESSED);
      await sleep(60);
      pointer.notify_button(t(), button, Clutter.ButtonState.RELEASED);
      await sleep(300);
    };
    const drag = async ([x, y], [dx, dy]) => {
      await move(x, y);
      pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
      for (let i = 1; i <= 10; i++)
        await move(x + dx * i / 10, y + dy * i / 10);
      pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
      await sleep(300);
    };
    const pickChain = (x, y) => {
      const chain = [];
      for (let a = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y); a; a = a.get_parent())
        chain.push(a.get_name() || a.constructor.name);
      return chain.slice(0, 4).join(' < ');
    };
    const container = clock.get_parent();
    const below = container.get_previous_sibling();
    log(`edit: container parent=${container.get_parent().constructor.name} ` +
      `below=${below?.get_meta_window?.()?.get_title() ?? below?.constructor.name}`);

    const [cx, cy] = clock.get_transformed_position();
    const [cw, ch] = clock.get_transformed_size();
    const centre = [cx + cw / 2, cy + ch * 0.7];
    log(`edit: pick on the clock: ${pickChain(...centre)}`);
    // A plain drag must not move it.
    await drag(centre, [-200, 0]);
    log(`edit: plain drag moved it by ${Math.round(clock.get_transformed_position()[0] - cx)}`);

    await click(...centre, Clutter.BUTTON_SECONDARY);
    await sleep(500);
    const menuItems = Main.layoutManager.uiGroup.get_children()
      .flatMap(c => findActors(c, a => a instanceof PopupMenu.PopupMenuItem && a.mapped));
    log(`edit: menu items=${menuItems.map(i => i.label.text).join(',')}`);
    await shot('clock-menu', [m.x, m.y, m.width, m.height]);
    const editItem = menuItems.find(i => i.label.text === 'Move and Resize');
    if (!editItem) return;
    const [ix, iy] = editItem.get_transformed_position();
    await click(ix + 20, iy + 10);
    await sleep(500);
    const layer = Main.layoutManager.uiGroup.get_children().find(c => c.get_name() === 'liquid-glass-edit');
    log(`edit: frame=${!!layer} modal=${Main.modalCount}`);
    await shot('clock-edit', [m.x, m.y, m.width, m.height]);
    if (!layer) return;

    // Down onto the dock: the Done button moves off it.
    const doneButton = layer.get_children().find(c => c.has_style_class_name('liquid-glass-edit-done'));
    const rectOf = a => [...a.get_transformed_position(), ...a.get_transformed_size()].map(Math.round);
    const frameActor = layer.get_children().find(c => c.has_style_class_name('liquid-glass-edit-frame'));
    const lower = m.y + m.height - 40 - (frameActor.get_transformed_position()[1] + frameActor.height);
    await drag(centre, [0, lower]);
    await sleep(800);
    const docks = Main.layoutManager.uiGroup.get_children().filter(c => c.get_name() === 'dashtodockContainer');
    log(`edit: low frame=${rectOf(frameActor)} done=${rectOf(doneButton)} docks=${docks.map(d => `[${rectOf(d)}]`).join(',')}`);
    await shot('clock-edit-low', [m.x, m.y, m.width, m.height]);
    const [lx, ly] = clock.get_transformed_position();
    await drag([centre[0] + lx - cx, centre[1] + ly - cy], [cx - lx, cy - ly]);
    await sleep(800);
    log(`edit: back frame=${rectOf(frameActor)} done=${rectOf(doneButton)}`);

    await drag(centre, [-300, -100]);
    await sleep(800);
    log(`edit: moved by ${Math.round(clock.get_transformed_position()[0] - cx)},` +
      `${Math.round(clock.get_transformed_position()[1] - cy)} positions=${settings.get_string('desktop-item-positions')}`);

    // The right edge's handle, then the bottom's.
    const handles = layer.get_children().filter(c => c.has_style_class_name('liquid-glass-edit-handle'));
    const handleCentre = h => {
      const [hx, hy] = h.get_transformed_position();
      return [hx + h.width / 2, hy + h.height / 2];
    };
    const sizeBefore = [settings.get_int('glass-clock-size'), settings.get_double('glass-clock-stretch')];
    await drag(handleCentre(handles[3]), [200, 0]);
    await sleep(2500);
    log(`edit: wider: size,stretch ${sizeBefore} -> ${settings.get_int('glass-clock-size')},` +
      `${settings.get_double('glass-clock-stretch')}`);
    await shot('clock-wider', [m.x, m.y, m.width, m.height]);
    await drag(handleCentre(handles[5]), [0, 120]);
    await sleep(2500);
    log(`edit: taller: size,stretch,height ${settings.get_int('glass-clock-size')},` +
      `${settings.get_double('glass-clock-stretch')},${settings.get_double('glass-clock-height')}`);
    await shot('clock-taller', [m.x, m.y, m.width, m.height]);

    // A click outside ends it.
    await click(m.x + 40, m.y + m.height - 60);
    await sleep(500);
    log(`edit: ended frame=${!!Main.layoutManager.uiGroup.get_children().find(c => c.get_name() === 'liquid-glass-edit')} ` +
      `modal=${Main.modalCount}`);
    await shot('clock-edited', [m.x, m.y, m.width, m.height]);

    // Position > Top Left puts it back at a corner.
    const [ex, ey] = clock.get_transformed_position();
    const [ew, eh] = clock.get_transformed_size();
    await click(ex + ew / 2, ey + eh * 0.7, Clutter.BUTTON_SECONDARY);
    await sleep(500);
    const items = () => Main.layoutManager.uiGroup.get_children()
      .flatMap(c => findActors(c, a => a instanceof PopupMenu.PopupBaseMenuItem && a.mapped));
    const label = i => i.label?.text ?? '';
    const sub = items().find(i => label(i) === 'Position');
    if (!sub) return;
    const [sx, sy] = sub.get_transformed_position();
    await click(sx + 20, sy + 10);
    await sleep(600);
    await shot('clock-position-menu', [m.x, m.y, m.width, m.height]);
    const topLeft = items().find(i => label(i) === 'Top Left');
    log(`edit: position items=${items().map(label).join(',')}`);
    if (!topLeft) return;
    const [tx, ty] = topLeft.get_transformed_position();
    await click(tx + 20, ty + 10);
    await sleep(1500);
    log(`edit: placed position=${settings.get_string('glass-clock-position')} ` +
      `moved=${settings.get_string('desktop-item-positions')} at=${clock.get_transformed_position().map(Math.round)}`);

    // A widget goes to a corner of its own the same way.
    const weather = findActor(global.window_group, 'liquid-glass-desktop-weather');
    if (!weather?.mapped) return;
    const [wx, wy] = weather.get_transformed_position();
    await click(wx + 40, wy + 40, Clutter.BUTTON_SECONDARY);
    await sleep(500);
    const wsub = items().find(i => label(i) === 'Position');
    if (!wsub) return;
    const [wsx, wsy] = wsub.get_transformed_position();
    await click(wsx + 20, wsy + 10);
    await sleep(600);
    const bottomLeft = items().find(i => label(i) === 'Bottom Left');
    if (!bottomLeft) return;
    const [bx, by] = bottomLeft.get_transformed_position();
    await click(bx + 20, by + 10);
    await sleep(1500);
    log(`edit: weather placed anchors=${settings.get_string('desktop-widget-anchors')} ` +
      `at=${weather.get_transformed_position().map(Math.round)}`);
    await shot('widget-position', [m.x, m.y, m.width, m.height]);
  }

  // The launcher's results with a virtual pointer: rows that appear under a
  // pointer that does not move get hover, a click activates a row, and hover
  // still follows the pointer after a click; from the desktop and the overview,
  // and with a slow glass on an otherwise idle stage.
  async _launcherPointer(settings, m) {
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    settings.set_boolean('enable-launcher', true);
    await sleep(500);
    const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
    const pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    await sleep(300);
    if (Main.overview.visible) {
      Main.overview.hide();
      await sleep(1500);
    }
    const t = () => GLib.get_monotonic_time();
    const {Launcher} = await this._lgModule('launcher/launcher.js');
    const launcher = Launcher.instance;
    const activated = [];
    launcher._activateResult = result => {
      activated.push(launcher._results.indexOf(result));
      launcher.close();
    };
    const rows = () => (launcher._items ?? []).map(item => item.actor);
    const hovered = () => rows().map(r => (r.hover ? 1 : 0)).join('');
    // LG_DRV_LAUNCHER_QUERY: what to search for (default "set").
    const query = GLib.getenv('LG_DRV_LAUNCHER_QUERY') ?? 'set';
    const press = async button => {
      pointer.notify_button(t(), button, Clutter.ButtonState.PRESSED);
      await sleep(60);
      pointer.notify_button(t(), button, Clutter.ButtonState.RELEASED);
      await sleep(400);
    };
    for (const where of ['desktop', 'overview', 'slow']) {
      if (where === 'slow') {
        settings.set_boolean('launcher-enable-adaptive-text-color', false);
        launcher._shape._durationMs = 1500;
      }
      if (where === 'overview') {
        Main.overview.show();
        await sleep(1500);
      }
      launcher.open();
      launcher.setText(query);
      await sleep(1500);
      const centre = row => {
        const [x, y] = row.get_transformed_position();
        const [w, h] = row.get_transformed_size();
        return [x + w / 2, y + h / 2];
      };
      const last = centre(rows()[rows().length - 1]);
      const first = centre(rows()[0]);
      launcher.setText('');
      await sleep(600);
      // Where the last row will be, before there are any rows.
      pointer.notify_absolute_motion(t(), ...last);
      await sleep(300);
      launcher.setText(query);
      await sleep(400);
      log(`launcher pointer ${where}: early hover=${hovered()}`);
      await sleep(where === 'slow' ? 2000 : 1200);
      // The glass has landed; nothing should ask for frames now.
      let updates = 0;
      const updateId = global.stage.connect('before-update', () => updates++);
      await sleep(1000);
      global.stage.disconnect(updateId);
      const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...last);
      const describe = a => {
        const chain = [];
        for (let x = a; x && chain.length < 5; x = x.get_parent())
          chain.push(`${x.constructor.name}.${x.style_class ?? x.name ?? ''}${x.reactive ? '*' : ''}`);
        return chain.join(' < ');
      };
      log(`launcher pointer ${where}: picked ${describe(picked)} open=${!!launcher._root} last=${last.map(Math.round)} modal=${Main.modalCount}`);
      log(`launcher pointer ${where}: rows=${rows().length} hover=${hovered()} under the pointer: row ${rows().indexOf(picked)} ` +
        `clip=${launcher._panel.get_clip().map(Math.round)} panel=${launcher._panel.get_allocation_box().get_size().map(Math.round)} ` +
        `idle updates=${updates}`);
      await shot(`launcher-pointer-${where}`, [m.x, m.y, m.width, m.height]);
      // A secondary click does nothing; then hover has to follow the pointer.
      await press(Clutter.BUTTON_SECONDARY);
      pointer.notify_absolute_motion(t(), ...first);
      await sleep(300);
      log(`launcher pointer ${where}: after a click, moved up: hover=${hovered()} selected=${launcher._selected} open=${!!launcher._root}`);
      await press(Clutter.BUTTON_PRIMARY);
      log(`launcher pointer ${where}: activated=${JSON.stringify(activated)} open=${!!launcher._root}`);
      if (launcher._root) {
        pointer.notify_absolute_motion(t(), ...last);
        await sleep(300);
        log(`launcher pointer ${where}: still open, moved down: hover=${hovered()} selected=${launcher._selected}`);
      }
      launcher.close();
      activated.length = 0;
      await sleep(500);
      if (where === 'overview') {
        Main.overview.hide();
        await sleep(1500);
      }
    }
    delete launcher._activateResult;
    launcher._shape._durationMs = 220;
    settings.reset('launcher-enable-adaptive-text-color');
    // One more letter with the same number of results: the glass keeps its height.
    const [before, after] = (GLib.getenv('LG_DRV_LAUNCHER_STEADY') ?? 'weat,weath').split(',');
    launcher.open();
    launcher.setText(before);
    await sleep(2500);
    const heights = [];
    const traceId = global.stage.connect('before-update', () => {
      if (launcher._panel)
        heights.push(Math.round(launcher._shape.rect(GLib.get_monotonic_time())[3]));
    });
    const firstCount = rows().length;
    launcher.setText(after);
    await sleep(2500);
    global.stage.disconnect(traceId);
    log(`launcher steady: '${before}' ${firstCount} rows -> '${after}' ${rows().length} rows, glass height ` +
      `${Math.min(...heights)}..${Math.max(...heights)} over ${heights.length} frames`);
    launcher.close();
    await sleep(500);
    // The field keeps it open, a click outside closes it, and a row really activates.
    launcher.open();
    launcher.setText(query);
    await sleep(1500);
    const [ex, ey] = launcher._entry.get_transformed_position();
    const [, eh] = launcher._entry.get_transformed_size();
    const click = async (x, y) => {
      pointer.notify_absolute_motion(t(), x, y);
      await sleep(200);
      await press(Clutter.BUTTON_PRIMARY);
    };
    await click(ex + 300, ey + eh / 2);
    log(`launcher pointer: field clicked: open=${!!launcher._root}`);
    await click(m.x + 40, m.y + m.height - 200);
    log(`launcher pointer: outside clicked: open=${!!launcher._root}`);
    launcher.open();
    launcher.setText('keyboard');
    await sleep(1500);
    const name = launcher._results[0]?.meta.name;
    const [rx, ry] = launcher._rows[0]?.get_transformed_position() ?? [0, 0];
    await click(rx + 100, ry + 10);
    await sleep(1500);
    log(`launcher pointer: '${name}' clicked: open=${!!launcher._root} modal=${Main.modalCount}`);
  }

  // The launcher's text colour over a dark top and a white bottom: the field
  // alone is over dark, the results reach the white. Every painted frame is
  // traced: the field and the rows have to share one colour, and the colour
  // for a new size has to be there without a tween.
  async _launcherColor(settings, m) {
    settings.set_boolean('enable-launcher', true);
    await sleep(500);
    const {Launcher} = await this._lgModule('launcher/launcher.js');
    const launcher = Launcher.instance;
    const dark = new St.Widget({style: 'background-color: #202020;', x: m.x, y: m.y, width: m.width, height: m.height});
    const splitY = Math.round(m.height * 0.2) + 110;
    const white = new St.Widget({style: 'background-color: #f4f4f4;', x: m.x, y: m.y + splitY, width: m.width, height: m.height - splitY});
    Main.layoutManager.uiGroup.insert_child_above(dark, global.window_group);
    Main.layoutManager.uiGroup.insert_child_above(white, dark);
    await sleep(800);
    const hex = c => [c.red, c.green, c.blue].map(v => v.toString(16).padStart(2, '0')).join('');
    const firstLabel = a => {
      if (a instanceof St.Label) return a;
      for (const c of a.get_children()) {
        const found = firstLabel(c);
        if (found) return found;
      }
      return null;
    };
    const frames = [];
    const traceId = global.stage.connect('after-paint', () => {
      const panel = launcher._panel;
      if (!panel) return;
      const row = launcher._rows[0];
      const label = row && firstLabel(row);
      frames.push({
        rows: launcher._rows.length,
        panel: hex(panel.get_theme_node().get_foreground_color()),
        entry: hex(launcher._entry.get_theme_node().get_foreground_color()),
        row: label ? hex(label.get_theme_node().get_foreground_color()) : '-',
        clipH: Math.round(panel.get_clip()[3]),
      });
    });
    const report = (what, from) => {
      const seen = frames.slice(from);
      // Runs of the same colours, as "frames x panel/entry/row rows".
      const runs = [];
      for (const f of seen) {
        const key = `${f.panel}/${f.entry}/${f.row} rows=${f.rows}`;
        if (runs.length && runs[runs.length - 1].key === key) runs[runs.length - 1].n++;
        else runs.push({key, n: 1, clipH: f.clipH});
      }
      const mismatched = seen.filter(f => f.panel !== f.entry || (f.row !== '-' && f.row !== f.panel)).length;
      log(`launcher color ${what}: ${runs.map(r => `${r.n}x ${r.key} clip=${r.clipH}`).join(' | ')} mismatched=${mismatched}`);
    };
    const t0 = GLib.get_monotonic_time();
    const ms = () => Math.round((GLib.get_monotonic_time() - t0) / 1000);
    const applied = [];
    const apply = launcher._text._apply;
    launcher._text._apply = function (actor, color, skip, batch) {
      applied.push(`${ms()}:${color}${skip ? '!' : ''}`);
      return apply.call(this, actor, color, skip, batch);
    };
    launcher.open();
    await sleep(2000);
    report('open', 0);
    // The hint over the white, in the panel's colour.
    white.y = m.y + Math.round(m.height * 0.2);
    await sleep(1500);
    await shot('launcher-color-hint', [m.x, m.y, m.width, m.height]);
    applied.push(`${ms()}:white-down`);
    white.y = m.y + splitY;
    await sleep(1500);
    applied.push(`${ms()}:typing`);
    const query = GLib.getenv('LG_DRV_LAUNCHER_QUERY') ?? 'set';
    let from = frames.length;
    launcher.setText(query);
    await sleep(3000);
    report(`'${query}'`, from);
    await shot('launcher-color-results', [m.x, m.y, m.width, m.height]);
    const box = launcher._panel.get_allocation_box();
    log(`launcher color: chosen for ${launcher._coloredFor} panel at ${Math.round(launcher._root.y + box.y1)},${Math.round(box.get_height())}`);
    from = frames.length;
    launcher.setText('');
    await sleep(3000);
    report('cleared', from);
    from = frames.length;
    launcher.setText(query);
    await sleep(1500);
    launcher.setText(`${query}t`);
    await sleep(3000);
    report(`'${query}' then '${query}t'`, from);
    global.stage.disconnect(traceId);
    delete launcher._text._apply;
    log(`launcher color applied: ${applied.join(' ')}`);
    await shot('launcher-color', [m.x, m.y, m.width, m.height]);
    launcher.close();
    dark.destroy();
    white.destroy();
    await sleep(500);
  }

  // The launcher's calculations and pinned items: a calculation comes first, a result is pinned and unpinned
  // with a click on its pin, a pinned result comes before the others, and Ctrl+P and the back button change
  // page, in both transitions.
  async _launcherPins(settings, m, launcher) {
    const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
    const seat = backend.get_default_seat();
    // The hot corner's barriers hold a pointer that starts in the corner.
    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    await sleep(300);
    const t = () => GLib.get_monotonic_time();
    const click = async actor => {
      const [x, y] = actor.get_transformed_position();
      const [w, h] = actor.get_transformed_size();
      pointer.notify_absolute_motion(t(), x + w / 2, y + h / 2);
      await sleep(250);
      pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
      await sleep(60);
      pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
      await sleep(250);
    };
    const ctrlP = async () => {
      keyboard.notify_keyval(t(), Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
      keyboard.notify_keyval(t(), Clutter.KEY_p, Clutter.KeyState.PRESSED);
      keyboard.notify_keyval(t(), Clutter.KEY_p, Clutter.KeyState.RELEASED);
      keyboard.notify_keyval(t(), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    };
    const names = () => launcher._results.map(r => `${r.meta.name}${launcher._isPinned(r) ? '*' : ''}`).join(' | ');
    const panelRect = () => [...launcher._panel.get_transformed_position(), ...launcher._panel.get_transformed_size()].map(Math.round);
    settings.reset('launcher-pinned');
    launcher.open();
    await sleep(800);
    for (const query of ['3*8=', '1-5', '2^10 / 4', '(1+2']) {
      launcher.setText(query);
      await sleep(900);
      log(`launcher calc "${query}": ${launcher._results[0]?.provider ? 'no calculation' : launcher._results[0]?.meta.name} first of ${launcher._results.length}`);
    }
    launcher.setText('set');
    await sleep(2500);
    log(`launcher pins before: ${names()}`);
    // The second application result and the first of another provider, each pinned by its pin.
    const pinnable = launcher._results.map((r, i) => [r, i]).filter(([r]) => r.provider);
    const picks = [pinnable.find(([r]) => r.provider.id === 'applications' && r !== pinnable[0][0]),
      pinnable.find(([r]) => r.provider.id !== 'applications')].filter(Boolean);
    for (const [, i] of picks) {
      const row = launcher._items[i].actor;
      const toggle = row.get_child().get_first_child();
      const [tx, ty] = toggle.get_transformed_position();
      const [tw, th] = toggle.get_transformed_size();
      const under = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, tx + tw / 2, ty + th / 2);
      log(`launcher pin toggle row ${i}: ${[tx, ty, tw, th].map(Math.round)} class=${toggle.style_class} under=${under?.constructor.name}.${under?.style_class ?? under?.name}`);
      await click(toggle);
      log(`launcher pin click row ${i}: open=${!!launcher._root} pins=${launcher._pins.all().map(p => `${p.provider}:${p.id}`).join(',')} ` +
        `toggle opacity=${toggle.opacity}`);
    }
    launcher.setText('se');
    await sleep(300);
    launcher.setText('set');
    await sleep(2500);
    log(`launcher pins after: ${names()}`);
    await shot('launcher-pins-results', [m.x, m.y, m.width, m.height]);
    for (const transition of ['morph', 'tween']) {
      settings.set_string('launcher-pinned-transition', transition);
      const before = panelRect();
      await ctrlP();
      await sleep(200);
      await shot(`launcher-pinned-${transition}-mid`, [m.x, m.y, m.width, m.height]);
      await sleep(1200);
      log(`launcher pinned ${transition}: view=${launcher._view} panel ${before} -> ${panelRect()} clip=${launcher._panel.get_clip().map(Math.round)} ` +
        `items=${launcher._items.length} tiles=${launcher._tileCount} lens=${!!launcher._lens} opacity=${launcher._panel.opacity}`);
      await shot(`launcher-pinned-${transition}`, [m.x, m.y, m.width, m.height]);
      const back = findActors(launcher._panel, a => a.has_style_class_name?.('lg-launcher-back'))[0];
      await click(back);
      await sleep(1200);
      log(`launcher back ${transition}: view=${launcher._view} panel=${panelRect()} focus=${global.stage.key_focus === launcher._entry.clutter_text}`);
    }
    // Unpinned on the pinned page, from the tile's corner.
    launcher.showView('pinned');
    await sleep(1200);
    const tile = launcher._items[0]?.actor;
    if (tile) {
      const toggle = findActors(tile, a => a.has_style_class_name?.('lg-launcher-pin'))[0];
      await click(toggle);
      await sleep(500);
      log(`launcher unpin from tile: pins=${launcher._pins.all().length} items=${launcher._items.length} tiles=${launcher._tileCount}`);
    }
    launcher.close();
    settings.reset('launcher-pinned');
    settings.reset('launcher-pinned-transition');
    await sleep(800);
  }

  // Application icons redrawn as glass plates under a symbol: in the dock
  // (and its Show Apps button), in each look, with an application left out
  // and with only one let in, while the launch animation's clone draws an
  // icon, and in the launcher's results; then nothing is left once switched off.
  async _iconStyle(settings, m) {
    const EFFECT = 'liquid-glass-icon-style';
    const dock = findActor(Main.layoutManager.uiGroup, 'dashtodockDashContainer');
    if (!dock) {
      log('icon style: no dock (LG_DTD_DIR?)');
      return;
    }
    const appOf = icon => {
      if (icon.has_style_class_name('show-apps-icon')) return 'show-apps';
      for (let a = icon.get_parent(); a; a = a.get_parent()) {
        if (a.app instanceof Shell.App) return a.app.get_id();
      }
      return null;
    };
    const icons = () => findActors(dock, a => a instanceof St.Icon && a.mapped && appOf(a));
    const styled = () => icons().filter(i => i.get_effect(EFFECT));
    const report = what => {
      const all = icons();
      const scales = [...new Set(all.map(i => `${i.get_effect(EFFECT) ? 's' : 'u'}${i.scale_x.toFixed(2)}`))].join(',');
      log(`icon style ${what}: ${styled().length}/${all.length} styled: ` +
        all.map(i => `${appOf(i)}${i.get_effect(EFFECT) ? '*' : ''}`).join(' ') + ` scales=${scales}`);
    };
    const [dx, dy] = dock.get_transformed_position();
    const [dw, dh] = dock.get_transformed_size();
    const dockRect = [Math.max(m.x, Math.floor(dx) - 20), Math.max(m.y, Math.floor(dy) - 20), Math.ceil(dw) + 40, Math.ceil(dh) + 40];
    // Why an icon is left as it is goes to the log.
    settings.set_boolean('output-logs', true);
    report('off');
    const started = GLib.get_monotonic_time();
    settings.set_boolean('icon-style-dock', true);
    // The first time, the worker takes every icon apart.
    for (let i = 0; i < 60 && styled().length < icons().length; i++) await sleep(500);
    log(`icon style: styled after ${Math.round((GLib.get_monotonic_time() - started) / 1000)} ms`);
    report('tinted');
    const theme = new St.IconTheme();
    for (const icon of icons().filter(i => !i.get_effect(EFFECT))) {
      const gicons = [icon.gicon, icon.fallback_gicon].filter(Boolean);
      log(`icon style unstyled ${appOf(icon)}: ${gicons.map(g => `${g.to_string()} -> ${theme.lookup_by_gicon(g, 128, 0)?.get_filename() ?? 'none'}`).join(', ')}`);
    }
    const probe = styled()[0];
    if (probe) {
      const {rectInOffscreen} = await this._lgModule('rendering/contentLens.js');
      const image = probe.get_first_child();
      const box = image?.get_allocation_box();
      const effect = probe.get_effect(EFFECT);
      const texture = effect.get_texture();
      log(`icon style probe: image=${image?.constructor.name} box=${box ? [box.x1, box.y1, box.get_width(), box.get_height()] : '-'} ` +
        `icon=${probe.width}x${probe.height} offscreen=${JSON.stringify(rectInOffscreen(probe, box ? [box.x1, box.y1, box.get_width(), box.get_height()] : [0, 0, probe.width, probe.height]))} ` +
        `texture=${texture ? `${texture.get_width()}x${texture.get_height()}` : 'none'} pipeline=${!!effect._pipeline}`);
    }
    await shot('icon-style-tinted', dockRect);
    for (const mode of ['mono', 'clear']) {
      settings.set_string('icon-style-mode', mode);
      await sleep(800);
      report(mode);
      await shot(`icon-style-${mode}`, dockRect);
    }
    settings.reset('icon-style-mode');
    settings.set_double('icon-style-tint-strength', 0.2);
    settings.set_double('icon-style-size', 1.25);
    await sleep(800);
    report('weak tint, size 1.25');
    await shot('icon-style-weak-large', dockRect);
    settings.reset('icon-style-tint-strength');
    settings.reset('icon-style-size');
    settings.set_string('icon-style-tint-variant', 'light');
    await sleep(800);
    report('light');
    await shot('icon-style-light', dockRect);
    settings.reset('icon-style-tint-variant');
    // A tuned number takes effect without the icons being styled again.
    settings.set_value('icon-style-tuning', new GLib.Variant('a{sd}', {darkGlass: 0.45, darkRimWidth: 2}));
    await sleep(800);
    report('tuned');
    await shot('icon-style-tuned', dockRect);
    settings.reset('icon-style-tuning');

    const first = icons().map(appOf).find(id => id !== 'show-apps');
    settings.set_strv('icon-style-blacklist', [first, 'show-apps']);
    await sleep(800);
    report(`without ${first} and show-apps`);
    settings.set_boolean('icon-style-all-apps', false);
    settings.set_strv('icon-style-whitelist', [first]);
    await sleep(800);
    report(`only ${first}`);
    for (const key of ['icon-style-all-apps', 'icon-style-whitelist', 'icon-style-blacklist']) settings.reset(key);
    await sleep(800);

    // The launch animation clones the icon and zooms it out; slowed down, so
    // that it is still there to be seen.
    const appIcon = findActors(dock, a => a.app instanceof Shell.App && typeof a.animateLaunch === 'function')[0];
    if (appIcon) {
      let clone = null, seen = false, styledSource = false;
      const addedId = Main.uiGroup.connect('child-added', (_g, child) => {
        if (!(child instanceof Clutter.Clone) || seen) return;
        seen = true;
        clone = child;
        styledSource = findActors(child.source, a => a.get_effect?.(EFFECT)).length > 0;
        child.connect('destroy', () => { clone = null; });
      });
      St.Settings.get().slow_down_factor = 10;
      appIcon.animateLaunch();
      Main.uiGroup.disconnect(addedId);
      await sleep(300);
      log(`icon style launch: clone=${seen} still there=${!!clone} source styled=${styledSource}`);
      if (clone) {
        const [cx, cy] = clone.get_transformed_position();
        const [cw, ch] = clone.get_transformed_size();
        await shot('icon-style-launch', [Math.max(m.x, Math.floor(cx) - 40), Math.max(m.y, Math.floor(cy) - 40), Math.ceil(cw) + 80, Math.ceil(ch) + 80]);
      }
      St.Settings.get().slow_down_factor = 1;
      await sleep(3000);
    }

    settings.set_boolean('enable-launcher', true);
    settings.set_boolean('icon-style-launcher', true);
    await sleep(500);
    const {Launcher} = await this._lgModule('launcher/launcher.js');
    const launcher = Launcher.instance;
    launcher.open();
    launcher.setText(GLib.getenv('LG_DRV_LAUNCHER_QUERY') ?? 'set');
    await sleep(2500);
    const rowIcons = launcher._rows.map(r => findActors(r, a => a instanceof St.Icon)[0]).filter(Boolean);
    log(`icon style launcher: ${rowIcons.filter(i => i.get_effect(EFFECT)).length}/${rowIcons.length} styled: ` +
      launcher._results.map((r, i) => `${r.meta.id}${rowIcons[i]?.get_effect(EFFECT) ? '*' : ''}`).join(' '));
    await shot('icon-style-launcher', [m.x, m.y, m.width, m.height]);
    launcher.close();
    await sleep(500);

    // Icons not shown yet are made in the background a few seconds after the dock's were switched on.
    const cached = () => {
      let count = 0;
      try {
        const files = Gio.File.new_for_path(`${GLib.get_user_cache_dir()}/liquid-glass/icon-maps`).enumerate_children('', 0, null);
        while (files.next_file(null)) count++;
      } catch {}
      return count;
    };
    const before = cached();
    await sleep(10000);
    log(`icon style cached before the app grid: ${before}, 10 s later ${cached()}`);
    settings.set_boolean('icon-style-app-grid', true);
    Main.overview.showApps();
    const grid = Main.overview._overview.controls._appDisplay;
    // Every icon in the grid and its folders is taken apart once, which takes a while on a fresh cache.
    const settle = async of => {
      let last = -1, still = 0;
      for (let waited = 0; waited < 90 && still < 4; waited++) {
        await sleep(1000);
        const count = findActors(of, a => a.get_effect?.(EFFECT)).length;
        still = count === last && count > 0 ? still + 1 : 0;
        last = count;
      }
    };
    await settle(grid);
    const gridIcons = findActors(grid, a => a instanceof St.Icon && appOf(a));
    log(`icon style app grid: ${gridIcons.filter(i => i.get_effect(EFFECT)).length}/${gridIcons.length} styled`);
    // The small icons on a folder's own icon have no app of their own.
    const previewIcons = findActors(grid, a => a instanceof St.Icon && a.mapped && !appOf(a) && a.get_parent() instanceof St.Bin && !(a.get_parent() instanceof St.Button));
    log(`icon style folder previews: ${previewIcons.filter(i => i.get_effect(EFFECT)).length}/${previewIcons.length} styled`);
    await shot('icon-style-app-grid', [m.x, m.y, m.width, m.height]);
    const folder = findActors(grid, a => a.view instanceof Clutter.Actor && typeof a.open === 'function')[0];
    if (folder) {
      folder.open();
      await settle(folder.view);
      const folderIcons = findActors(folder.view, a => a instanceof St.Icon && appOf(a));
      log(`icon style app folder: ${folderIcons.filter(i => i.get_effect(EFFECT)).length}/${folderIcons.length} styled`);
      await shot('icon-style-app-folder', [m.x, m.y, m.width, m.height]);
      folder._dialog.popdown();
      await sleep(800);
    } else {
      log('icon style app folder: none');
    }
    settings.set_boolean('icon-style-app-grid', false);
    await sleep(800);
    log(`icon style app grid off: ${gridIcons.filter(i => i.get_effect(EFFECT)).length} styled`);
    Main.overview.hide();
    await sleep(1000);
    settings.set_boolean('icon-style-dock', false);
    settings.set_boolean('icon-style-launcher', false);
    await sleep(800);
    report('switched off');
    settings.set_boolean('icon-style-dock', true);
    settings.set_boolean('icon-style-launcher', true);
    await sleep(1500);
    report('on again (from the cache)');
    settings.reset('output-logs');
  }

  async _featuresScenario() {
    const parts = (GLib.getenv('LG_DRV_FEATURES') ?? 'morph,topbar,widgets,clock,launcher').split(',');
    await this._waitForLg();
    const settings = this._lgSettings();
    const wallpaper = GLib.getenv('LG_DRV_WALLPAPER');
    if (wallpaper) {
      const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
      bg.set_string('picture-uri', `file://${wallpaper}`);
      bg.set_string('picture-uri-dark', `file://${wallpaper}`);
      bg.set_string('picture-options', 'zoom');
      await sleep(2000);
    }
    const m = Main.layoutManager.primaryMonitor;
    // Menus grow from their button only when asked to.
    if (parts.some(p => p.startsWith('morph'))) {
      for (const surface of ['menu', 'panel-menu']) settings.set_boolean(`${surface}-grow-from-button`, true);
      await sleep(500);
    }
    if (parts.includes('morph')) {
      await this._slowMorph(12);
      const dateMenu = Main.panel.statusArea.dateMenu.menu;
      dateMenu.open(true);
      await this._timedShots('morph-open', [m.x + m.width / 4, m.y, m.width / 2, 700],
        [150, 700, 1300, 1800, 2400, 3000, 4500, 7000, 9500]);
      await sleep(1000);
      dateMenu.close(true);
      await this._timedShots('morph-close', [m.x + m.width / 4, m.y, m.width / 2, 700],
        [150, 1600, 3000, 4500, 6000, 7000, 8000, 9000, 10000, 11500]);
      await sleep(2000);
      await this._slowMorph(1);
    }
    if (parts.includes('morphtrace')) {
      // Every frame of the calendar's glass at full speed.
      const {MenuMorphMotion} = await this._lgModule('animation/menuMorph.js');
      const step = MenuMorphMotion.prototype.step;
      const t0 = GLib.get_monotonic_time();
      MenuMorphMotion.prototype.step = function (elapsed) {
        const f = step.call(this, elapsed);
        const r = n => n.map(v => v.toFixed(1)).join(',');
        log(`trace t=${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)} opening=${this.opening} ` +
          `body=${r(f.body)} radius=${f.bodyRadius.toFixed(1)} ` +
          `content=${f.contentScale.toFixed(2)}/${f.contentOpacity.toFixed(2)} lens=${f.lens.toFixed(2)} ` +
          `glass=${f.glassOpacity.toFixed(2)}`);
        return f;
      };
      const retarget = MenuMorphMotion.prototype.retarget;
      MenuMorphMotion.prototype.retarget = function (button, menu, radius) {
        const key = menu ? menu.map(v => v.toFixed(1)).join(',') : 'null';
        if (key !== this._drvMenuKey) {
          log(`trace t=${((GLib.get_monotonic_time() - t0) / 1000).toFixed(0)} menu=${key}`);
          this._drvMenuKey = key;
        }
        return retarget.call(this, button, menu, radius);
      };
      // $LG_DRV_TRACE_NOTIFY: a few notifications in the calendar's list first.
      for (let i = 0; i < Number(GLib.getenv('LG_DRV_TRACE_NOTIFY') ?? 0); i++)
        Main.notify(`Driver ${i}`, 'A notification for the calendar menu');
      await sleep(1500);
      const dateMenu = Main.panel.statusArea.dateMenu.menu;
      const clock = Main.panel.statusArea.dateMenu._clockDisplay;
      log(`trace clock label at ${clock.get_transformed_position().map(Math.round)} size ${clock.get_transformed_size().map(Math.round)}`);
      dateMenu.open(true);
      await sleep(2500);
      dateMenu.close(true);
      await sleep(1500);
      MenuMorphMotion.prototype.step = step;
      MenuMorphMotion.prototype.retarget = retarget;
    }
    if (parts.includes('qssub')) {
      // A Quick Settings submenu stays centred under the panel when the shell
      // moves it after the last frame that would have noticed.
      const qs = Main.panel.statusArea.quickSettings.menu;
      qs.open(true);
      // The shell reads the submenus' offset with the panel's opening scale on it.
      await sleep(60);
      log(`qssub: panel scale while opening ${qs.box.scale_x.toFixed(2)}`);
      qs._grid.notify('x');
      await sleep(1500);
      const toggle = qs._grid.get_children().find(c => c.menu?.actor && c.visible && c.reactive);
      const centres = () => {
        const sub = toggle.menu.box;
        const [bx] = qs.box.get_transformed_position();
        const [sx] = sub.get_transformed_position();
        return `${Math.round(sx + sub.get_transformed_size()[0] / 2 - bx - qs.box.get_transformed_size()[0] / 2)}`;
      };
      if (toggle) {
        toggle.menu.open(true);
        await sleep(1500);
        const before = centres();
        const xConstraint = qs._overlay.get_constraints().find(c => c.coordinate === Clutter.BindCoordinate.X);
        xConstraint.offset += 30;
        await sleep(1000);
        log(`qssub: ${toggle.constructor.name} submenu off centre by ${before}, after the shell moved it by 30: ${centres()}`);
        await shot('qs-submenu', [m.x + m.width - 700, m.y, 700, 900]);
        xConstraint.offset -= 30;
        toggle.menu.close(false);
      } else {
        log('qssub: no toggle with a submenu');
      }
      qs.close(false);
      await sleep(1000);
    }
    if (parts.includes('media')) {
      // A player of our own on the session bus, and its card's buttons clicked
      // with a virtual pointer.
      const calls = [];
      const xml = `<node><interface name="org.mpris.MediaPlayer2.Player">
        <method name="Previous"/><method name="PlayPause"/><method name="Next"/>
        <property name="PlaybackStatus" type="s" access="read"/>
        <property name="Metadata" type="a{sv}" access="read"/></interface></node>`;
      const player = Gio.DBusExportedObject.wrapJSObject(xml, {
        Previous: () => calls.push('Previous'),
        PlayPause: () => calls.push('PlayPause'),
        Next: () => calls.push('Next'),
        get PlaybackStatus() { return 'Playing'; },
        get Metadata() {
          return {'xesam:title': new GLib.Variant('s', 'Driver Song'),
            'xesam:artist': new GLib.Variant('as', ['Driver']),
            'mpris:artUrl': new GLib.Variant('s', `file://${GLib.getenv('LG_DRV_WALLPAPER') ?? '/usr/share/pixmaps/debian-logo.png'}`)};
        },
      });
      player.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
      let owner = 0;
      await new Promise(resolve => {
        owner = Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.mpris.MediaPlayer2.lgdrv',
          Gio.BusNameOwnerFlags.NONE, resolve, null);
      });
      settings.set_boolean('output-logs', true);
      settings.set_strv('desktop-widgets', GLib.getenv('LG_DRV_MEDIA_WITH')?.split(',') ?? ['media']);
      settings.set_boolean('media-visualizer', true);
      // Settings to measure under, as "key=gvariant;key=gvariant".
      for (const pair of (GLib.getenv('LG_DRV_MEDIA_SETTINGS') ?? '').split(';').filter(Boolean)) {
        const at = pair.indexOf('=');
        settings.set_value(pair.slice(0, at), GLib.Variant.parse(null, pair.slice(at + 1), null, null));
      }
      settings.set_boolean('enable-desktop-widgets', true);
      let card = null;
      for (let i = 0; i < 40 && !card?.mapped; i++) {
        await sleep(250);
        card = findActor(global.window_group, 'liquid-glass-desktop-media');
      }
      log(`media: card shown=${card?.visible} mapped=${card?.mapped}`);
      if (card?.mapped) {
        new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_boolean('enable-hot-corners', false);
        const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
        const pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        await sleep(300);
        if (Main.overview.visible) {
          Main.overview.hide();
          await sleep(1500);
        }
        const t = () => GLib.get_monotonic_time();
        const buttons = findActors(card, a => a instanceof St.Button);
        for (const button of buttons) {
          const [bx, by] = button.get_transformed_position();
          const [bw, bh] = button.get_transformed_size();
          pointer.notify_absolute_motion(t(), bx + bw / 2, by + bh / 2);
          await sleep(100);
          pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
          await sleep(60);
          pointer.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
          await sleep(500);
        }
        log(`media: ${buttons.length} buttons clicked, the player got: ${calls.join(',') || 'nothing'}`);
        const [cx, cy] = card.get_transformed_position();
        const [cw, ch] = card.get_transformed_size();
        if (GLib.getenv('LG_DRV_MEDIA_BARS')) {
          // Bars that jump between silent and loudest, without a sound server.
          const {MediaWidget} = await this._lgModule('desktop/media.js');
          const draw = MediaWidget.prototype._drawBars;
          let loud = false;
          MediaWidget.prototype._drawBars = function () {
            this._levels = this._levels.map(() => loud ? 1 : 0);
            draw.call(this);
          };
          const bars = findActors(card, a => a instanceof St.DrawingArea)[0];
          for (let i = 0; i < 40; i++) {
            loud = i % 8 < 4;
            for (let f = 0; f < 6; f++) {
              bars.queue_repaint();
              await sleep(16);
            }
            if (i % 4 === 0) log(`media: bars ${loud ? 'loud' : 'silent'} title colour=${findActors(card, a => a instanceof St.Label)[0].get_theme_node().get_foreground_color().to_string()}`);
          }
          MediaWidget.prototype._drawBars = draw;
        }
        // With PULSE_SERVER set to a running sound server, the bars follow what it plays.
        for (let i = 0; i < 4; i++) {
          await shot(`media-${i}`, [cx - 20, cy - 20, cw + 40, ch + 40]);
          await sleep(350);
        }
      }
      settings.set_boolean('enable-desktop-widgets', false);
      Gio.bus_unown_name(owner);
      player.unexport();
      await sleep(500);
    }
    if (parts.includes('clocktick')) {
      // How long the main loop stalls when the clock's minute changes, once
      // its digits are drawn ($LG_DRV_CLOCK_SIZE, $LG_DRV_CLOCK_HEIGHT, $LG_DRV_CLOCK_FONT).
      settings.set_boolean('output-logs', true);
      settings.set_int('glass-clock-size', Number(GLib.getenv('LG_DRV_CLOCK_SIZE') ?? 240));
      settings.set_double('glass-clock-height', Number(GLib.getenv('LG_DRV_CLOCK_HEIGHT') ?? 1));
      settings.set_double('glass-clock-stretch', Number(GLib.getenv('LG_DRV_CLOCK_STRETCH') ?? 1));
      settings.set_string('glass-clock-tall-style', GLib.getenv('LG_DRV_CLOCK_STYLE') ?? 'even');
      const font = GLib.getenv('LG_DRV_CLOCK_FONT');
      if (font !== null) settings.set_string('glass-clock-font', font);
      const {GlassClock} = await this._lgModule('desktop/clock.js');
      let text = '10:00';
      let clock = null;
      const timeText = GlassClock.prototype._timeText;
      const tick = GlassClock.prototype._tick;
      GlassClock.prototype._timeText = () => text;
      GlassClock.prototype._tick = function () {
        clock = this;
        return tick.call(this);
      };
      // The longest the main loop stops from now until `done` resolves.
      const stalls = async done => {
        let last = GLib.get_monotonic_time(), worst = 0;
        const probe = GLib.timeout_add(GLib.PRIORITY_HIGH, 2, () => {
          const now = GLib.get_monotonic_time();
          worst = Math.max(worst, now - last);
          last = now;
          return GLib.SOURCE_CONTINUE;
        });
        await done;
        GLib.Source.remove(probe);
        return (worst / 1000).toFixed(0);
      };
      // Every digit drawn once, as a clock that has run for a while has them.
      log(`clocktick: first digits, longest stall ${await stalls((async () => {
        settings.set_boolean('enable-glass-clock', true);
        for (const t of ['01:23', '45:67', '89:00']) {
          text = t;
          clock?._tick();
          await sleep(6000);
        }
      })())} ms`);
      log(`clocktick: resized, longest stall ${await stalls((async () => {
        settings.set_int('glass-clock-size', settings.get_int('glass-clock-size') - 20);
        await sleep(8000);
      })())} ms`);
      for (const t of ['10:01', '10:02', '17:38', '23:59']) {
        let last = GLib.get_monotonic_time(), worst = 0;
        const probe = GLib.timeout_add(GLib.PRIORITY_HIGH, 2, () => {
          const now = GLib.get_monotonic_time();
          worst = Math.max(worst, now - last);
          last = now;
          return GLib.SOURCE_CONTINUE;
        });
        text = t;
        const start = GLib.get_monotonic_time();
        clock?._tick();
        await sleep(3000);
        GLib.Source.remove(probe);
        log(`clocktick: ${t} longest stall ${(worst / 1000).toFixed(0)} ms (from ${((GLib.get_monotonic_time() - start) / 1000).toFixed(0)} ms)`);
      }
      GlassClock.prototype._timeText = timeText;
      GlassClock.prototype._tick = tick;
      settings.set_boolean('enable-glass-clock', false);
      await sleep(500);
    }
    if (parts.includes('clockshot')) {
      // The clock alone, large, for a close look at its glass ($LG_DRV_CLOCK_SIZE,
      // $LG_DRV_CLOCK_HEIGHT, $LG_DRV_CLOCK_FONT, $LG_DRV_CLOCK_TEXT).
      settings.set_boolean('output-logs', true);
      settings.set_string('glass-clock-position', 'center');
      settings.set_int('glass-clock-size', Number(GLib.getenv('LG_DRV_CLOCK_SIZE') ?? 240));
      settings.set_double('glass-clock-height', Number(GLib.getenv('LG_DRV_CLOCK_HEIGHT') ?? 1));
      const font = GLib.getenv('LG_DRV_CLOCK_FONT');
      if (font !== null) settings.set_string('glass-clock-font', font);
      settings.set_boolean('glass-clock-show-date', false);
      // $LG_DRV_CLOCK_TEXT shows that instead of the time.
      const text = GLib.getenv('LG_DRV_CLOCK_TEXT');
      if (text) (await this._lgModule('desktop/clock.js')).GlassClock.prototype._timeText = () => text;
      settings.set_boolean('enable-glass-clock', true);
      await sleep(Number(GLib.getenv('LG_DRV_CLOCK_WAIT') ?? 4000));
      const clock = findActor(global.window_group, 'liquid-glass-desktop-clock');
      log(`clockshot: font=${settings.get_string('glass-clock-font')} size=${clock.get_transformed_size()}`);
      const [x, y] = clock.get_transformed_position();
      const [w, h] = clock.get_transformed_size();
      await shot('clock-alone', [x, y, w, h]);
    }
    if (parts.includes('topbar')) {
      for (const style of ['pill', 'islands']) {
        settings.set_string('top-bar-style', style);
        await sleep(1500);
        await shot(`topbar-${style}`, [m.x, m.y, m.width, 80]);
        const dateMenu = Main.panel.statusArea.dateMenu.menu;
        dateMenu.open(true);
        await sleep(1500);
        await shot(`topbar-${style}-menu`, [m.x, m.y, m.width, 700]);
        dateMenu.close(true);
        await sleep(1000);
        const sides = ['top', 'bottom', 'left', 'right'];
        const before = Main.panel.height;
        sides.forEach((side, i) => {
          settings.set_int(`top-bar-margin-${side}`, [10, 6, 24, 24][i]);
          settings.set_int(`top-bar-padding-${side}`, [4, 4, 12, 12][i]);
        });
        await sleep(1500);
        const boxes = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
        log(`topbar ${style} spacing: panel ${before} -> ${Main.panel.height}, ` +
          `boxes ${boxes.map(b => `${b.get_allocation_box().x1},${b.get_allocation_box().x2}`).join(' ')}, ` +
          `first button ${boxes[0].get_first_child()?.get_allocation_box().y1}..${boxes[0].get_first_child()?.get_allocation_box().y2}, ` +
          `workarea y ${Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex).y}`);
        await shot(`topbar-${style}-spacing`, [m.x, m.y, m.width, 80]);
        for (const side of sides) {
          settings.reset(`top-bar-margin-${side}`);
          settings.reset(`top-bar-padding-${side}`);
        }
        await sleep(1000);
      }
      settings.set_string('top-bar-style', 'off');
      await sleep(1000);
      log(`topbar off: panel ${Main.panel.height}, styles ${[Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox].map(b => b.get_style()).join('|')}`);
    }
    if (parts.includes('widgets')) {
      // A town GNOME Weather has no location for.
      settings.set_value('weather-place', new GLib.Variant('(sdd)', ['喜多方市', 37.65, 139.86667]));
      settings.set_boolean('enable-desktop-widgets', true);
      await sleep(8000);
      const weather = findActor(global.window_group, 'liquid-glass-desktop-weather');
      const texts = weather ? findActors(weather, a => a instanceof St.Label).map(l => l.text).filter(Boolean) : [];
      log(`weather: ${texts.join(' | ').replace(/\n/g, ' / ')}`);
      await shot('widgets', [m.x, m.y, m.width, m.height]);
    }
    if (parts.includes('clock')) {
      settings.set_boolean('enable-glass-clock', true);
      await sleep(3000);
      await shot('clock', [m.x, m.y, m.width, m.height]);
      for (const position of ['top-left', 'bottom-right']) {
        settings.set_string('glass-clock-position', position);
        await sleep(1500);
        await shot(`clock-${position}`, [m.x, m.y, m.width, m.height]);
      }
      await this._editClock(settings, m);
    }
    if (parts.includes('guides'))
      await this._editGuides(settings, m);
    if (parts.includes('widgetcolors')) {
      // The text colours of the weather card after its content was rebuilt
      // again and again: every label should have the same colour.
      settings.set_boolean('output-logs', true);
      settings.set_value('weather-place', new GLib.Variant('(sdd)', ['Hua Hin', 12.57, 99.96]));
      settings.set_boolean('enable-desktop-widgets', true);
      await sleep(7000);
      const weather = findActor(global.window_group, 'liquid-glass-desktop-weather');
      const colours = () => [...new Set(findActors(weather, a => a instanceof St.Label || a instanceof St.Icon)
        .map(a => a.get_theme_node().get_foreground_color().to_string()))].join(' ');
      log(`widgetcolors: first ${colours()}`);
      for (let i = 0; i < Number(GLib.getenv('LG_DRV_ROUNDS') ?? 10); i++) {
        settings.set_string('weather-temperature-unit', i % 2 ? 'celsius' : 'fahrenheit');
        await sleep(2500 + (i * 137) % 700);
        log(`widgetcolors: round ${i} ${colours()}`);
      }
      await shot('widgetcolors', [m.x, m.y, m.width, m.height]);
    }
    if (parts.includes('scale')) {
      // The calendar and Quick Settings on a small logical screen (a laptop at
      // 200 %, with run-glass.sh's LG_MONITORS_XML): do they fit, and how do
      // the slider rows and the cards look. The headless shell has no audio or
      // brightness device, so the three slider rows and some toggles are added.
      settings.set_boolean('output-logs', true);
      // LG_DRV_LIGHT=1: the light shell theme; =default: the default colour scheme, under which the shell stays dark.
      const light = GLib.getenv('LG_DRV_LIGHT');
      if (light) {
        new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_string('color-scheme', light === '1' ? 'prefer-light' : light);
        await sleep(2000);
      }
      // LG_DRV_QS_BASE: how much of each toggle's own colour the glass keeps.
      if (GLib.getenv('LG_DRV_QS_BASE')) settings.set_double('quick-settings-toggle-tint-strength', Number(GLib.getenv('LG_DRV_QS_BASE')));
      this._cameraAway = true;
      const dateMenu = Main.panel.statusArea.dateMenu.menu;
      const qs = Main.panel.statusArea.quickSettings.menu;
      const sliders = ['audio-volume-high-symbolic', 'audio-input-microphone-symbolic', 'display-brightness-symbolic']
        .map(iconName => new QuickSettings.QuickSlider({iconName}));
      const toggles = ['Wired', 'Bluetooth', 'Power Mode', 'Night Light', 'Keyboard', 'Airplane Mode', 'Caffeine', 'Auto Brightness']
        .map((title, i) => new QuickSettings.QuickToggle({title, iconName: 'network-wired-symbolic', checked: i % 2 === 0}));
      for (const slider of sliders) qs.addItem(slider, 2);
      for (const toggle of toggles) qs.addItem(toggle);
      const sliderRows = () => sliders.map(a => `${Math.round(a.get_height())}`).join(' ');
      for (let i = 0; i < 3; i++)
        Main.notify(`Driver ${i}`, 'A notification for the calendar menu');
      await sleep(1500);
      dateMenu.open(false);
      await sleep(2500);
      await this._shots('scale-calendar', [m.x, m.y, m.width, m.height], 'menu');
      dateMenu.close(false);
      await sleep(800);
      for (const mode of [0, 1]) {
        settings.set_int('quick-settings-apply-to', mode);
        await sleep(1500);
        qs.open(false);
        await sleep(2500);
        const [bx, by] = qs.box.get_transformed_position();
        const [bw, bh] = qs.box.get_transformed_size();
        log(`scale: quick settings mode=${mode} box=${[bx, by, bw, bh].map(Math.round)} ` +
          `monitor=${m.width}x${m.height} bottom overflow=${Math.round(by + bh - m.height)} slider heights=${sliderRows()}`);
        qs.close(false);
        await sleep(800);
        await this._menuShot(`scale-qs-${mode}`, qs, mode === 0 ? 'quick-settings' : 'quick-settings-toggles');
      }
      settings.set_int('quick-settings-apply-to', 0);
      this._cameraAway = false;
      await sleep(1000);
      // The launcher against the desktop widgets (LG_DRV_LAUNCHER_WIDTH sets its width).
      if (GLib.getenv('LG_DRV_LAUNCHER_WIDTH')) settings.set_int('launcher-width', Number(GLib.getenv('LG_DRV_LAUNCHER_WIDTH')));
      settings.set_boolean('enable-launcher', true);
      settings.set_boolean('enable-desktop-widgets', true);
      await sleep(5000);
      const {Launcher} = await this._lgModule('launcher/launcher.js');
      Launcher.instance?.open();
      await sleep(1500);
      const rect = a => a.get_transformed_extents();
      const panel = findActors(global.stage, a => a.has_style_class_name?.('liquid-glass-launcher'))[0];
      const cards = findActors(global.window_group, a => (a.get_name() ?? '').startsWith('liquid-glass-desktop-') && a.mapped);
      const overlaps = cards.filter(c => {
        const [p, q] = [rect(panel), rect(c)];
        return p.origin.x < q.origin.x + q.size.width && q.origin.x < p.origin.x + p.size.width &&
          p.origin.y < q.origin.y + q.size.height && q.origin.y < p.origin.y + p.size.height;
      }).map(c => c.get_name());
      log(`scale: launcher at ${[panel.x, panel.y, panel.width, panel.height].map(Math.round)} on ${m.width}x${m.height}, ` +
        `overlapping widgets: ${overlaps.join(',') || 'none'}`);
      await this._shots('scale-launcher', [m.x, m.y, m.width, m.height], 'launcher');
      Launcher.instance?.close();
      await sleep(800);
    }
    if (parts.includes('launcher')) {
      settings.set_boolean('enable-launcher', true);
      await sleep(1000);
      const {Launcher} = await this._lgModule('launcher/launcher.js');
      const launcher = Launcher.instance;
      launcher?.open();
      await sleep(1200);
      await shot('launcher-empty', [m.x, m.y, m.width, m.height]);
      launcher?.setText('set');
      await sleep(2500);
      await shot('launcher-results', [m.x, m.y, m.width, m.height]);
      launcher?.close();
      await sleep(1000);
      await this._launcherPins(settings, m, launcher);
    }
    if (parts.includes('launcherlayout'))
      await this._launcherLayout(settings, m);
    if (parts.includes('launcherpointer'))
      await this._launcherPointer(settings, m);
    if (parts.includes('launchercolor'))
      await this._launcherColor(settings, m);
    if (parts.includes('iconstyle'))
      await this._iconStyle(settings, m);
    // Everything switched on, the launcher open: disabling has to leave nothing.
    (await this._lgModule('launcher/launcher.js')).Launcher.instance?.open();
    await sleep(500);
    Main.extensionManager.disableExtension(LG_UUID);
    await sleep(1000);
    log(`features disabled: leftovers=${JSON.stringify(this._leftovers())} ` +
      `panel transparent=${Main.panel.has_style_class_name('liquid-glass-transparent')} modal=${Main.modalCount}`);
    Main.extensionManager.enableExtension(LG_UUID);
    await sleep(4000);
    log(`features enabled again: glasses=${lg()?.glassObjects().map(g => g._owner).join(',')}`);
  }

  // The pinned page at several widths and icon sizes (no tile may be crowded: the pin clear of the icon, the name
  // inside the tile), and a search taller than the screen (the results scroll, and the panel stays on it), with a
  // stand-in for GNOME Software's provider that finds one application that is installed and one that is not.
  async _launcherLayout(settings, m) {
    const {Launcher} = await this._lgModule('launcher/launcher.js');
    settings.set_boolean('enable-launcher', true);
    await sleep(1000);
    const launcher = Launcher.instance;
    const apps = Shell.AppSystem.get_default().get_installed().filter(a => a.should_show()).slice(0, 14);
    settings.reset('launcher-pinned');
    launcher.open();
    await sleep(500);
    for (const info of apps) {
      launcher._pins.toggle({provider: 'applications', id: info.get_id(), name: info.get_name(), description: '',
        icon: info.get_icon()?.to_string() ?? ''});
    }
    launcher.close();
    await sleep(500);
    const within = (a, b) => a.origin.x >= b.origin.x - 0.5 && a.origin.y >= b.origin.y - 0.5 &&
      a.origin.x + a.size.width <= b.origin.x + b.size.width + 0.5 && a.origin.y + a.size.height <= b.origin.y + b.size.height + 0.5;
    const apart = (a, b) => a.origin.x + a.size.width <= b.origin.x + 0.5 || b.origin.x + b.size.width <= a.origin.x + 0.5 ||
      a.origin.y + a.size.height <= b.origin.y + 0.5 || b.origin.y + b.size.height <= a.origin.y + 0.5;
    for (const width of [320, 680]) {
      for (const size of [32, 56, 96]) {
        settings.set_int('launcher-width', width);
        settings.set_int('launcher-pinned-icon-size', size);
        launcher.open();
        await sleep(800);
        launcher.showView('pinned');
        await sleep(1500);
        const tiles = findActors(launcher._panel, a => a.has_style_class_name?.('lg-launcher-tile'));
        let crowded = 0, rows = new Set(), outside = 0;
        for (const tile of tiles) {
          const t = tile.get_transformed_extents();
          rows.add(Math.round(t.origin.y));
          const pin = findActors(tile, a => a.has_style_class_name?.('lg-launcher-pin'))[0];
          const icon = findActors(tile, a => a instanceof St.Icon && !pin.contains(a))[0];
          const name = findActors(tile, a => a.has_style_class_name?.('lg-launcher-tile-name'))[0];
          if (!apart(pin.get_transformed_extents(), icon.get_transformed_extents())) crowded++;
          if (!within(name.get_transformed_extents(), t) || !within(icon.get_transformed_extents(), t)) outside++;
        }
        const [pw] = launcher._panel.get_transformed_size();
        log(`launcher layout: width=${width} icon=${size} panel=${Math.round(pw)} columns=${launcher._columns} tiles=${tiles.length} ` +
          `tile=${Math.round(tiles[0].width)}x${Math.round(tiles[0].height)} rows=${rows.size} pin over icon=${crowded} content outside tile=${outside}`);
        await shot(`launcher-layout-${width}-${size}`, [m.x, m.y, m.width, m.height]);
        launcher.close();
        await sleep(500);
      }
    }
    settings.reset('launcher-pinned-icon-size');
    const stand = {
      id: 'org.gnome.Software.desktop', isRemoteProvider: true, appInfo: {get_name: () => 'Software', get_icon: () => null},
      getInitialResultSet: async () => ['system/flatpak/flathub/com.example.NotThere/stable', 'system/flatpak/flathub/org.gnome.Settings/stable'],
      filterResults: ids => ids,
      getResultMetas: async ids => ids.map(id => ({id, name: id.split('/')[3], description: 'The browser built to be yours',
        createIcon: size => new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: size})})),
      activateResult() {},
    };
    const providers = Main.overview.searchController._searchResults._providers;
    providers.push(stand);
    for (const width of [680]) {
      settings.set_int('launcher-width', width);
      launcher.open();
      await sleep(800);
      for (const query of ['a', 'set', 'zzq']) {
        launcher.setText(query);
        await sleep(2500);
        const box = launcher._resultsBox;
        const [px, py] = launcher._panel.get_transformed_position();
        const [pw, ph] = launcher._panel.get_transformed_size();
        const badges = findActors(launcher._panel, a => a.has_style_class_name?.('lg-launcher-badge')).length;
        log(`launcher search "${query}": results=${launcher._items.length} panel=${[px, py, pw, ph].map(Math.round)} ` +
          `bottom gap=${Math.round(m.height - py - ph)} scrolls=${box.get_vadjustment().upper > box.get_vadjustment().page_size + 0.5} badges=${badges}`);
        await shot(`launcher-search-${query}`, [m.x, m.y, m.width, m.height]);
      }
      launcher.setText('a');
      await sleep(2000);
      const last = launcher._items.length - 1;
      for (let i = 0; i < last; i++) launcher._select(i + 1);
      await sleep(500);
      log(`launcher search last row selected: scrolled to ${Math.round(launcher._resultsBox.get_vadjustment().value)}`);
      await shot('launcher-search-last', [m.x, m.y, m.width, m.height]);
      launcher.close();
      await sleep(500);
    }
    providers.splice(providers.indexOf(stand), 1);
    settings.reset('launcher-width');
    settings.reset('launcher-pinned');
  }

  _finish() {
    log('DONE');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
      global.context.terminate();
      return GLib.SOURCE_REMOVE;
    });
  }
}
