const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

// The stamp steps from the shared frame ticker, so the fixture is the ticker's:
// a frame is one pump of the later queue with the clock advanced.
function fixture() {
  let now = 0;
  const pending = new Map();
  let next = 1;
  const laters = {
    add(_type, fn) { const id = next++; pending.set(id, fn); return id; },
    remove(id) { pending.delete(id); },
  };
  const bindings = {
    Meta: { LaterType: { BEFORE_REDRAW: 0 } },
    GLib: { get_monotonic_time: () => now, SOURCE_REMOVE: false, PRIORITY_DEFAULT: 0 },
    global: { compositor: { get_laters: () => laters } },
    reportFrameLoopError: () => {},
  };
  const mod = loadModule(path.join(dist, 'quickSettings/quickSettingsAnimation.js'), bindings);
  const frame = (ms = 16.667) => {
    now += Math.round(ms * 1000);
    const due = [...pending.entries()];
    pending.clear();
    for (const [, fn] of due) fn();
  };
  return { mod, frame };
}

function hostFor(applied, frames) {
  let opacity = 255;
  return {
    getPopup: () => ({ set_scale: s => applied.push(['scale', s]), set_pivot_point: () => {} }),
    getContent: () => ({ get opacity() { return opacity; }, set opacity(v) { opacity = v; } }),
    onFrame: (scale, op, opening) => frames.push([opening, scale, op]),
    onStart: () => {},
    onSettled: () => {},
    isAlive: () => true,
  };
}

test('the open eases out and the close eases in', () => {
  const { mod } = fixture();
  // An ease-out covers more than its share of the road early; an ease-in less.
  assert.equal(mod.easeOutQuad(0), 0);
  assert.equal(mod.easeOutQuad(1), 1);
  assert.ok(mod.easeOutQuad(0.25) > 0.25, 'ease-out is front-loaded');
  assert.equal(mod.easeInQuad(0), 0);
  assert.equal(mod.easeInQuad(1), 1);
  assert.ok(mod.easeInQuad(0.25) < 0.25, 'ease-in is back-loaded');
});

test('the stamp runs from the born scale down to 1 and then fades out to 0', () => {
  const { mod, frame } = fixture();
  const applied = [];
  const frames = [];
  const anim = new mod.QuickSettingsStampAnimation(hostFor(applied, frames), {
    springStiffness: 120, springDamping: 22, springMass: 1, openScale: 1.08, pivotX: 0.5, pivotY: 0,
  });

  anim.start(true);
  const first = applied[0][1];
  for (let i = 0; i < 200 && anim.isRunning; i++) frame();
  assert.ok(Math.abs(first - 1.08) < 1e-6, `born at the open scale, got ${first}`);
  assert.ok(!anim.isRunning, 'the open settles');
  assert.equal(applied[applied.length - 1][1], 1);
  const scales = applied.filter(([what]) => what === 'scale').map(([, v]) => v);
  for (let i = 1; i < scales.length; i++) assert.ok(scales[i] <= scales[i - 1] + 1e-9, 'the scale only shrinks');

  applied.length = 0;
  anim.start(false);
  for (let i = 0; i < 200 && anim.isRunning; i++) frame();
  assert.ok(!anim.isRunning, 'the close settles');
  const opacities = frames.filter(([opening]) => !opening).map(([, , op]) => op);
  assert.equal(opacities[opacities.length - 1], 0);
  assert.ok(opacities[0] > 0, 'the close starts from the open opacity');
});
