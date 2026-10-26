const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

function shellVersion(version, bindings = {}) {
  return loadModule(path.join(dist, 'shellVersion.js'), { Config: { PACKAGE_VERSION: version }, ...bindings });
}

function recordingPipeline() {
  const writes = [];
  return {
    writes,
    get_uniform_location: name => `loc:${name}`,
    set_uniform_float: (...args) => writes.push(['float', ...args]),
    set_uniform_1f: (...args) => writes.push(['1f', ...args]),
  };
}

test('from GNOME 48 vectors and arrays go through set_uniform_float unchanged', () => {
  const v = shellVersion('48.7');
  const pipeline = recordingPipeline();
  v.setUniformVector(pipeline, 'd_rect', [0.1, 0.2, 0.3, 0.4]);
  v.setUniformArray(pipeline, 'loc:region_x', 'region_x', [1, 2, 3]);
  assert.deepEqual(pipeline.writes, [
    ['float', 'loc:d_rect', 4, 1, [0.1, 0.2, 0.3, 0.4]],
    ['float', 'loc:region_x', 1, 3, [1, 2, 3]],
  ]);
  const decl = 'uniform vec2 inv_size; /* source texel */\nuniform float kernel_scale;\n';
  assert.equal(v.uniformDeclarations(decl), decl);
});

test('before GNOME 48 only set_uniform_1f is called, per component and per element', () => {
  for (const version of ['46.0', '47.10']) {
    const v = shellVersion(version);
    const pipeline = recordingPipeline();
    v.setUniformVector(pipeline, 'inv_size', [0.5, 0.25]);
    v.setUniformArray(pipeline, 'loc:region_x', 'region_x', [7, 8]);
    assert.deepEqual(pipeline.writes, [
      ['1f', 'loc:inv_size_0', 0.5],
      ['1f', 'loc:inv_size_1', 0.25],
      ['1f', 'loc:region_x[0]', 7],
      ['1f', 'loc:region_x[1]', 8],
    ], version);
  }
});

test('before GNOME 48 vector uniforms are declared as floats behind a macro', () => {
  const v = shellVersion('47.0');
  const decl = 'uniform vec2 inv_size; /* source texel */\nuniform float kernel_scale;\nuniform vec4 m_rect;\n';
  assert.equal(v.uniformDeclarations(decl),
    'uniform float inv_size_0, inv_size_1;\n#define inv_size vec2(inv_size_0, inv_size_1)\n /* source texel */\n' +
    'uniform float kernel_scale;\n' +
    'uniform float m_rect_0, m_rect_1, m_rect_2, m_rect_3;\n#define m_rect vec4(m_rect_0, m_rect_1, m_rect_2, m_rect_3)\n\n');
});

test('the root node, Cogl context and menu toggle class follow the version', () => {
  const calls = [];
  class Color { constructor() { this.kind = 'clutter'; } }
  class CoglColor { constructor() { this.kind = 'cogl'; } }
  const bindings = {
    Clutter: {
      Color,
      RootNode: { new: (...args) => { calls.push(args); return {}; } },
      get_default_backend: () => ({ get_cogl_context: () => 'default-backend' }),
    },
    Cogl: { Color: CoglColor },
    global: { stage: { context: { get_backend: () => ({ get_cogl_context: () => 'stage-context' }) } } },
  };
  const expected = {
    '46.0': [['fb', 'clutter', 0], 'default-backend', 'quick-menu-toggle'],
    '47.5': [['fb', 'cogl', 0], 'default-backend', 'quick-menu-toggle'],
    '48.0': [['fb', 'state', 'cogl', 0], 'stage-context', 'quick-toggle-has-menu'],
    '51.0': [['fb', 'state', 'cogl', 0], 'stage-context', 'quick-toggle-has-menu'],
  };
  for (const [version, [rootArgs, context, toggleClass]] of Object.entries(expected)) {
    calls.length = 0;
    const v = shellVersion(version, bindings);
    v.newRootNode('fb', 'state');
    assert.deepEqual(calls[0].map(a => a?.kind ?? a), rootArgs, version);
    assert.equal(v.coglContext(), context, version);
    assert.equal(v.QS_MENU_TOGGLE_CLASS, toggleClass, version);
  }
});

test('only GNOME 46 keeps the notification banner border', () => {
  assert.equal(shellVersion('46.0').BANNER_TRANSPARENT_CLASS, 'liquid-glass-transparent-keep-border');
  assert.equal(shellVersion('47.0').BANNER_TRANSPARENT_CLASS, 'liquid-glass-transparent');
  assert.equal(shellVersion('50.1').BANNER_TRANSPARENT_CLASS, 'liquid-glass-transparent');
});

test('GNOME 46 has no St accent colour and falls back', () => {
  assert.equal(shellVersion('46.0').accentColors(), null);
});

test('the accent colour is watched from GNOME 47 on, and the watch can be undone', () => {
  const connected = [];
  const context = {
    connect: (signal, callback) => { connected.push(signal); return 7; },
    disconnect: id => connected.push(`off:${id}`),
  };
  const St = { ThemeContext: { get_for_stage: () => context } };
  shellVersion('46.0', { St }).watchAccentColor(() => {})();
  assert.deepEqual(connected, []);
  shellVersion('47.0', { St, global: { stage: {} } }).watchAccentColor(() => {})();
  assert.deepEqual(connected, ['notify::accent-color', 'off:7']);
});

test('from GNOME 50 the stage is painted to content with a colour state argument', () => {
  for (const [version, expected] of [['49.4', 3], ['50.1', 4], ['51.0', 4]]) {
    let args = null;
    const stage = { paint_to_content: (...a) => { args = a; return 'content'; } };
    const v = shellVersion(version, { global: { stage }, Clutter: { PaintFlag: { NO_CURSORS: 4 } } });
    assert.equal(v.paintStageToContent('rect', 0.5), 'content');
    assert.equal(args.length, expected, version);
    assert.deepEqual([args[0], args[1], args[args.length - 1]], ['rect', 0.5, 4], version);
    if (expected === 4) assert.equal(args[2], null);
  }
});

test('a vertical box uses orientation from GNOME 48 on and vertical before', () => {
  const Clutter = { Orientation: { VERTICAL: 1 } };
  assert.deepEqual(shellVersion('46.0', { Clutter }).verticalBoxParams(), { vertical: true });
  assert.deepEqual(shellVersion('47.10', { Clutter }).verticalBoxParams(), { vertical: true });
  assert.deepEqual(shellVersion('48.0', { Clutter }).verticalBoxParams(), { orientation: 1 });
  assert.deepEqual(shellVersion('51.0', { Clutter }).verticalBoxParams(), { orientation: 1 });
});

test('a menu opens animated with {animate} from GNOME 51 on and PopupAnimation.FULL before', () => {
  assert.equal(shellVersion('46.0').MENU_ANIMATION, ~0);
  assert.equal(shellVersion('50.1').MENU_ANIMATION, ~0);
  assert.deepEqual(shellVersion('51.0').MENU_ANIMATION, { animate: true });
});

test('a hover cursor is the actor\'s own from GNOME 50 on and the display\'s before', () => {
  const Clutter = { CursorType: { E_RESIZE: 'clutter-e', MOVE: 'clutter-move' }, EVENT_PROPAGATE: false };
  const Meta = { Cursor: { EAST_RESIZE: 'meta-e', MOVE_OR_RESIZE_WINDOW: 'meta-move', DEFAULT: 'meta-default' } };
  for (const version of ['50.1', '51.0']) {
    const actor = { set_cursor_type(type) { this.type = type; }, connect: () => assert.fail('no signals needed') };
    shellVersion(version, { Clutter, Meta }).setHoverCursor(actor, 'e');
    assert.equal(actor.type, 'clutter-e', version);
  }
  for (const version of ['46.0', '49.4']) {
    const set = [];
    const handlers = {};
    const actor = { connect: (signal, fn) => { handlers[signal] = fn; } };
    const v = shellVersion(version, { Clutter, Meta, global: { display: { set_cursor: c => set.push(c) } } });
    v.setHoverCursor(actor, 'move');
    handlers['enter-event']();
    handlers['leave-event']();
    v.resetHoverCursor();
    assert.deepEqual(set, ['meta-move', 'meta-default', 'meta-default'], version);
  }
});
