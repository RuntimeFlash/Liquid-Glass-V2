// Phase 0 spike for the backdrop-readback glass. It runs a fixed scenario in
// the headless shell started by run-nested.sh and reports through the log
// ("[spike] ..." lines) and PNG screenshots in $LG_SPIKE_OUT.
//
// Probe: copies the stage pixels under itself (BlitNode inside a RootNode that
// never clears) and draws them back at half brightness. It only copies when
// the frame repaints its whole rect (redraw clip contains it: IN), and reuses
// the copy otherwise.
// Camera: copies the probe's screen rect every frame and draws that copy in
// screenshots. Screenshots are off-stage paints, where the probe cannot read
// the stage, so the camera is how the on-stage result is observed.
// Relay: an opacity-0 Clutter.Clone of something behind the probe, placed so
// its paint volume maps onto the probe. A redraw anywhere in the source queues
// a redraw of the relay, which puts the probe's whole rect into the clip.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT_DIR = GLib.getenv('LG_SPIKE_OUT') ?? GLib.get_tmp_dir();
const IN = Mtk.RegionOverlap.IN;
const PART = Mtk.RegionOverlap.PART;
const OUT = Mtk.RegionOverlap.OUT;
const Q_NAME = {[IN]: 'IN', [PART]: 'PART', [OUT]: 'OUT', [-1]: 'NOCLIP'};

let frameNo = 0;
let phase = 'setup';

function log(msg) {
  console.log(`[spike] f=${frameNo} phase=${phase} ${msg}`);
}

function coglContext() {
  return global.stage.context.get_backend().get_cogl_context();
}

function viewFor(actor, fb) {
  for (const view of actor.peek_stage_views()) {
    if (view.get_framebuffer() === fb)
      return view;
  }
  return null;
}

// Stage rect to framebuffer pixels, as _clutter_stage_maybe_setup_viewport()
// lays the stage out on a view.
function fbRect(view, x, y, w, h) {
  const layout = view.layout;
  const s = view.get_scale();
  const vx = Math.round(-layout.x * s);
  const vy = Math.round(-layout.y * s);
  return [Math.floor(x * s) + vx, Math.floor(y * s) + vy, Math.ceil(w * s), Math.ceil(h * s)];
}

// cogl_framebuffer_get_internal_format() is (skip); an offscreen's texture
// carries the format, and onscreens are fixed-point.
function fbFormat(fb) {
  return fb instanceof Cogl.Offscreen ? `offscreen:${fb.get_texture().get_format()}` : 'onscreen';
}

function stageRect(actor) {
  const ext = actor.get_transformed_extents();
  return [Math.round(ext.origin.x), Math.round(ext.origin.y),
    Math.round(ext.size.width), Math.round(ext.size.height)];
}

class Backdrop {
  constructor() {
    this.tex = null;
    this.off = null;
    this.w = 0;
    this.h = 0;
    this.valid = false;
    this.format = null;
  }

  ensure(w, h) {
    if (this.tex && this.w === w && this.h === h)
      return;
    this.tex = Cogl.Texture2D.new_with_size(coglContext(), w, h);
    this.off = Cogl.Offscreen.new_with_texture(this.tex);
    this.off.allocate();
    this.w = w;
    this.h = h;
    this.valid = false;
  }

  // The copy only happens when the node runs, after everything painted
  // before this actor is in the framebuffer.
  addBlit(root, fb, view, fx, fy, fw, fh) {
    const rootNode = Clutter.RootNode.new(this.off, view.color_state, new Cogl.Color(), 0);
    root.add_child(rootNode);
    const blit = Clutter.BlitNode.new(fb);
    blit.add_blit_rectangle(fx, fy, 0, 0, fw, fh);
    rootNode.add_child(blit);
    this.valid = true;
    this.format = fbFormat(fb);
  }

  addDraw(root, w, h, brightness) {
    const pipeline = Cogl.Pipeline.new(coglContext());
    pipeline.set_layer_texture(0, this.tex);
    const color = new Cogl.Color();
    color.init_from_4f(brightness, brightness, brightness, 1);
    pipeline.set_color(color);
    const node = Clutter.PipelineNode.new(pipeline);
    node.add_texture_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: w, y2: h}), 0, 0, 1, 1);
    root.add_child(node);
  }
}

const Probe = GObject.registerClass(
class Probe extends Clutter.Actor {
  _init(name) {
    super._init({name, reactive: false});
    this.backdrop = new Backdrop();
    this.events = [];
  }

  vfunc_pick(_pickContext) {
  }

  vfunc_paint_node(root, paintContext) {
    const fb = paintContext.get_framebuffer();
    const view = viewFor(this, fb);
    const inClone = this.is_in_clone_paint();
    const [sx, sy, sw, sh] = stageRect(this);
    const clip = paintContext.get_redraw_clip();
    const q = clip
      ? clip.contains_rectangle(new Mtk.Rectangle({x: sx, y: sy, width: sw, height: sh}))
      : -1;
    const live = view !== null && !inClone;
    let blit = false;

    if (live) {
      const [fx, fy, fw, fh] = fbRect(view, sx, sy, sw, sh);
      this.backdrop.ensure(fw, fh);
      if (q === IN || q === -1) {
        this.backdrop.addBlit(root, fb, view, fx, fy, fw, fh);
        blit = true;
      }
    }

    const [w, h] = this.get_size();
    if (this.backdrop.valid)
      this.backdrop.addDraw(root, w, h, 0.5);

    this.events.push({f: frameNo, phase, q, live, inClone, blit});
    log(`paint ${this.name} q=${Q_NAME[q]} live=${live} clone=${inClone} blit=${blit} ` +
      `fbFormat=${fbFormat(fb)} ` +
      `stage=[${sx},${sy},${sw},${sh}]`);
  }
});

const Camera = GObject.registerClass(
class Camera extends Clutter.Actor {
  _init(source) {
    super._init({name: 'spike-camera', reactive: false});
    this.source = source;
    this.backdrop = new Backdrop();
    this.liveCopies = 0;
  }

  vfunc_pick(_pickContext) {
  }

  vfunc_paint_node(root, paintContext) {
    const fb = paintContext.get_framebuffer();
    const view = viewFor(this, fb);
    if (view && !this.is_in_clone_paint()) {
      const [fx, fy, fw, fh] = fbRect(view, ...this.source);
      this.backdrop.ensure(fw, fh);
      this.backdrop.addBlit(root, fb, view, fx, fy, fw, fh);
      this.liveCopies++;
    }
    const [w, h] = this.get_size();
    if (this.backdrop.valid)
      this.backdrop.addDraw(root, w, h, 1.0);
  }
});

function findSurfaceActor(actor) {
  const stack = [actor];
  while (stack.length > 0) {
    const a = stack.pop();
    // MetaSurfaceActor is not in the typelib; the GType name is.
    const desc = GObject.Object.prototype.toString.call(a);
    if (/MetaSurfaceActor(Wayland|X11)/.test(desc))
      return a;
    stack.push(...a.get_children());
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

// An off-stage paint of the rect, saved as PNG.
function shot(name, x, y, w, h) {
  return new Promise(resolve => {
    const path = `${OUT_DIR}/${name}.png`;
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    new Shell.Screenshot().screenshot_area(x, y, w, h, stream, (obj, res) => {
      try {
        obj.screenshot_area_finish(res);
      } catch (e) {
        log(`shot ${name} failed: ${e}`);
      }
      stream.close(null);
      log(`shot ${name} -> ${path}`);
      resolve();
    });
  });
}

function widget(name, x, y, w, h, color) {
  const actor = new St.Widget({name, reactive: false, style: `background-color: ${color};`});
  actor.set_position(x, y);
  actor.set_size(w, h);
  return actor;
}

// Places an opacity-0 clone of `source` inside `glass` so that the clone's
// paint volume (the source's, scaled by the clone) covers the glass exactly.
function addRelay(glass, source) {
  const box = source.get_allocation_box();
  const aw = box.get_width();
  const ah = box.get_height();
  let px = 0, py = 0, pw = aw, ph = ah;
  const pv = source.get_paint_volume();
  if (pv) {
    const origin = pv.get_origin();
    px = origin.x;
    py = origin.y;
    pw = pv.get_width();
    ph = pv.get_height();
  }
  const [gw, gh] = glass.get_size();
  const kx = gw / pw;
  const ky = gh / ph;
  // ClutterClone applies its allocation-to-source scale only while painting
  // (cogl_framebuffer_scale() in clutter_clone_paint()), so its paint volume
  // stays the source's size. The actor's own scale is part of its transform,
  // and therefore of the paint volume used for the redraw clip.
  const relay = new Clutter.Clone({source, opacity: 0, reactive: false, name: `relay:${source.name}`});
  relay.set_size(aw, ah);
  relay.set_scale(kx, ky);
  relay.set_position(-px * kx, -py * ky);
  glass.add_child(relay);
  log(`relay for ${source.name}: alloc=${aw}x${ah} pv=[${px},${py},${pw},${ph}] ` +
    `relay pos=[${-px * kx},${-py * ky}] scale=[${kx},${ky}]`);
  return relay;
}

const SCENE = {
  pattern: [200, 150, 800, 500],
  probe: [400, 300, 500, 300],
  ticker: [650, 520, 120, 60],
  front: [420, 320, 40, 40],
  camera: [1300, 300, 500, 300],
};

export default class BackdropSpike extends Extension {
  enable() {
    this._actors = [];
    this._signals = [];
    this._procs = [];
    this._marks = [];
    this._forceProbeFrames = 0;
    this._cameraArmed = false;
    this._damageFrames = [];

    this._signals.push([global.stage, global.stage.connect('before-update', () => {
      frameNo++;
      if (this._cameraArmed)
        this._camera.queue_redraw();
      if (this._forceProbeFrames > 0) {
        this._forceProbeFrames--;
        this._mark('force');
        this._probe.queue_redraw();
      }
    })]);

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

  _mark(kind) {
    this._marks.push({phase, kind, f: frameNo});
  }

  _add(actor) {
    Main.layoutManager.uiGroup.add_child(actor);
    this._actors.push(actor);
    return actor;
  }

  async _waitStartup() {
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
    log(`monitors=${JSON.stringify(Main.layoutManager.monitors.map(m => [m.x, m.y, m.width, m.height, m.geometry_scale]))}`);
    for (const view of global.stage.peek_stage_views()) {
      const l = view.layout;
      const fb = view.get_framebuffer();
      log(`view layout=[${l.x},${l.y},${l.width},${l.height}] scale=${view.get_scale()} ` +
        `fb=${fb.constructor.name} offscreen=${fb instanceof Cogl.Offscreen} ` +
        `onscreenSame=${fb === view.get_onscreen()} format=${fbFormat(fb)} ` +
        `shadowfb=${view.has_shadowfb()}`);
    }
  }

  _buildScene() {
    const [px, py, pw, ph] = SCENE.pattern;
    const pattern = this._add(new St.Widget({name: 'spike-pattern', reactive: false}));
    pattern.set_position(px, py);
    pattern.set_size(pw, ph);
    const hw = pw / 2, hh = ph / 2;
    pattern.add_child(widget('tl', 0, 0, hw, hh, 'rgb(255,0,0)'));
    pattern.add_child(widget('tr', hw, 0, hw, hh, 'rgb(0,255,0)'));
    pattern.add_child(widget('bl', 0, hh, hw, hh, 'rgb(0,0,255)'));
    pattern.add_child(widget('br', hw, hh, hw, hh, 'rgb(255,255,255)'));

    const [tx, ty, tw, th] = SCENE.ticker;
    this._tickerRoot = this._add(new St.Widget({name: 'spike-ticker-root', reactive: false}));
    this._tickerRoot.set_position(tx, ty);
    this._tickerRoot.set_size(tw, th);
    this._ticker = widget('spike-ticker', 0, 0, tw, th, 'rgb(255,255,0)');
    this._tickerLabel = new St.Label({text: '0', style: 'color: rgb(0,0,0); font-size: 30px;'});
    this._ticker.add_child(this._tickerLabel);
    this._tickerRoot.add_child(this._ticker);
    this._tickerOn = false;

    const [qx, qy, qw, qh] = SCENE.probe;
    this._probe = this._add(new Probe('spike-probe'));
    this._probe.set_position(qx, qy);
    this._probe.set_size(qw, qh);

    const [fx, fy, fw, fh] = SCENE.front;
    this._front = this._add(widget('spike-front', fx, fy, fw, fh, 'rgb(0,255,255)'));
    this._frontOn = false;

    const [cx, cy, cw, ch] = SCENE.camera;
    this._camera = this._add(new Camera(SCENE.probe));
    this._camera.set_position(cx, cy);
    this._camera.set_size(cw, ch);
  }

  _toggleTicker() {
    this._tickerOn = !this._tickerOn;
    this._ticker.set_style(`background-color: ${this._tickerOn ? 'rgb(255,0,255)' : 'rgb(255,255,0)'};`);
    this._mark('ticker');
  }

  _toggleFront() {
    this._frontOn = !this._frontOn;
    this._front.set_style(`background-color: ${this._frontOn ? 'rgb(255,128,0)' : 'rgb(0,255,255)'};`);
    this._mark('front');
  }

  async _shots(tag) {
    await shot(`${tag}-display`, ...SCENE.camera);
    await shot(`${tag}-probe`, ...SCENE.probe);
  }

  _relayState(relay, source) {
    const pv = relay.get_paint_volume();
    const tpv = relay.get_transformed_paint_volume(global.stage);
    const fmt = v => v ? `[${v.get_origin().x},${v.get_origin().y},${v.get_width()},${v.get_height()}]` : 'null';
    return `relay mapped=${relay.mapped} visible=${relay.visible} alloc=${relay.has_allocation()} ` +
      `opacity=${relay.opacity} pv=${fmt(pv)} stagePv=${fmt(tpv)} ` +
      `sourceMappedClones=${source.has_mapped_clones()} sourceMapped=${source.mapped}`;
  }

  async _relayDiag() {
    phase = 'R0-baseline';
    for (let i = 0; i < 2; i++) {
      this._toggleTicker();
      await sleep(250);
    }
    phase = 'R1-relay-added';
    const relay = addRelay(this._probe, this._tickerRoot);
    await sleep(300);
    log(this._relayState(relay, this._tickerRoot));
    phase = 'R2-ticker-toggle';
    for (let i = 0; i < 3; i++) {
      this._toggleTicker();
      await sleep(250);
    }
    log(this._relayState(relay, this._tickerRoot));
    phase = 'R3-direct-relay-redraw';
    for (let i = 0; i < 3; i++) {
      relay.queue_redraw();
      this._mark('relay-redraw');
      await sleep(250);
    }
    phase = 'R4-root-redraw';
    for (let i = 0; i < 3; i++) {
      this._tickerRoot.queue_redraw();
      this._mark('root-redraw');
      await sleep(250);
    }
    phase = 'R5-opacity1-ticker-toggle';
    relay.opacity = 1;
    await sleep(300);
    for (let i = 0; i < 3; i++) {
      this._toggleTicker();
      await sleep(250);
    }
    log(this._relayState(relay, this._tickerRoot));
    relay.opacity = 0;
    await sleep(300);
    this._summarize();
  }

  async _run() {
    await this._waitStartup();
    if (GLib.getenv('LG_SPIKE_SCENARIO') === 'relaydiag') {
      this._buildScene();
      this._cameraArmed = true;
      await sleep(600);
      await this._relayDiag();
      return;
    }
    this._buildScene();
    this._cameraArmed = true;
    await sleep(600);

    phase = 'T1-initial';
    await this._shots('t1');

    // Odd toggle counts, so the stale and the fresh ticker colour differ in
    // the shots: after A the ticker is magenta but the probe should still
    // show yellow; after B it is magenta again and the probe should show it.
    phase = 'A-ticker-no-relay';
    for (let i = 0; i < 1; i++) {
      this._toggleTicker();
      await sleep(250);
    }
    await this._shots('a');

    phase = 'B-ticker-relay';
    this._relayTicker = addRelay(this._probe, this._tickerRoot);
    await sleep(250);
    for (let i = 0; i < 2; i++) {
      this._toggleTicker();
      await sleep(250);
    }
    await this._shots('b');

    phase = 'C-move-source';
    for (let i = 0; i < 3; i++) {
      this._tickerRoot.translation_x += 10;
      this._mark('move');
      await sleep(250);
    }
    await this._shots('c');

    phase = 'D-descendant-text';
    for (let i = 0; i < 3; i++) {
      this._tickerLabel.text = String(i + 1);
      this._mark('text');
      await sleep(250);
    }
    await this._shots('d');

    phase = 'E-front-damage';
    for (let i = 0; i < 3; i++) {
      this._toggleFront();
      await sleep(250);
    }
    await this._shots('e');

    phase = 'F-force-before-update';
    this._forceProbeFrames = 3;
    await sleep(300);

    phase = 'G-clone-paint';
    const clone = this._add(new Clutter.Clone({source: this._probe, name: 'spike-probe-clone'}));
    clone.set_position(1300, 700);
    clone.set_size(250, 150);
    await sleep(300);
    await shot('g-clone', 1300, 700, 250, 150);
    clone.destroy();

    await this._windowPhase('H-wayland-window', ['foot', '-o', 'cursor.blink=yes', '-T', 'lgspikefoot'], 'lgspikefoot', 3000);
    await this._windowPhase('I-x11-window', ['glxgears'], 'glxgears', 3000);

    this._summarize();
  }

  // Puts a client window behind the probe, relays it, and records the frames
  // where the window reported damage.
  async _windowPhase(name, argv, title, ms) {
    phase = name;
    let proc;
    try {
      proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
      log(`spawn ${argv[0]} failed: ${e}`);
      return;
    }
    this._procs.push(proc);
    let actor = null;
    for (let i = 0; i < 40 && !actor; i++) {
      await sleep(250);
      actor = global.get_window_actors().find(a => (a.get_meta_window()?.get_title() ?? '').includes(title)) ?? null;
    }
    if (!actor) {
      log(`no window for ${title}`);
      return;
    }
    const win = actor.get_meta_window();
    win.move_frame(true, 450, 330);
    await sleep(500);
    const damagedId = actor.connect('damaged', () => this._damageFrames.push({phase, f: frameNo}));
    const surface = findSurfaceActor(actor);
    const repaintId = surface
      ? surface.connect('repaint-scheduled', () => this._damageFrames.push({phase, f: frameNo, kind: 'repaint'}))
      : 0;
    const r = win.get_frame_rect();
    log(`window ${title} client=${win.get_client_type()} rect=[${r.x},${r.y},${r.width},${r.height}] actor=${actor.constructor.name}`);
    const relay = addRelay(this._probe, actor);
    await sleep(ms);
    await this._shots(name.slice(0, 1).toLowerCase());
    relay.destroy();
    actor.disconnect(damagedId);
    if (repaintId)
      surface.disconnect(repaintId);
    proc.force_exit();
    await sleep(300);
  }

  _summarize() {
    phase = 'summary';
    const byPhase = {};
    for (const e of this._probe.events) {
      const p = (byPhase[e.phase] ??= {IN: 0, PART: 0, OUT: 0, NOCLIP: 0, fallback: 0, blits: 0});
      if (!e.live)
        p.fallback++;
      else
        p[Q_NAME[e.q]]++;
      if (e.blit)
        p.blits++;
    }
    log(`SUMMARY ${JSON.stringify(byPhase)}`);

    // For each change made between frames, the probe's paint in the next frame.
    const liveAt = new Map();
    for (const e of this._probe.events) {
      if (e.live && !liveAt.has(e.f))
        liveAt.set(e.f, e);
    }
    const marks = [...this._marks, ...this._damageFrames.map(d => ({phase: d.phase, kind: d.kind ?? 'damaged', f: d.f}))];
    for (const m of marks) {
      // A change made between frames lands in frame f+1; one made inside
      // before-update ('force') lands in frame f itself.
      const target = m.kind === 'force' ? m.f : m.f + 1;
      const e = liveAt.get(target);
      const same = m.kind === 'force' ? null : liveAt.get(m.f);
      log(`MARK ${m.phase} ${m.kind} at f=${m.f} -> paint f=${target}: ${e ? Q_NAME[e.q] : 'no live paint'}` +
        (same ? ` (paint f=${m.f}: ${Q_NAME[same.q]})` : ''));
    }
    log(`camera live copies=${this._camera.liveCopies}`);
  }

  _finish() {
    log('DONE');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
      global.context.terminate();
      return GLib.SOURCE_REMOVE;
    });
  }
}
