const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

function settings(values) {
  return {
    get_double: key => values[key] ?? 0,
    get_int: key => values[key] ?? 0,
    get_string: key => values[key] ?? '',
  };
}

function glass() {
  const calls = [];
  const record = name => (...args) => calls.push([name, ...args]);
  return {
    calls,
    setPadding: record('padding'),
    setIsDock: record('isDock'),
    setTintColor: record('tintColor'),
    setTintStrength: record('tintStrength'),
    setBlurRadius: record('blurRadius'),
    setCornerRadius: record('cornerRadius'),
    setShadowMaxRadius: record('shadowMaxRadius'),
    setMultiRegionMode: record('multiRegion'),
  };
}

function moduleWith(fake) {
  const mod = loadModule(path.join(dist, 'quickSettings/glassAppearance.js'), {
    BackdropGlass: function (params) {
      fake.params = params;
      return fake;
    },
    hexToColorArray: hex => [hex, 'g', 'b'],
  });
  return { mod };
}

test('shadow room follows the global shadow settings', () => {
  const { mod } = moduleWith(glass());
  assert.equal(mod.quickSettingsShadowRoom(settings({'shadow-radius': 0, 'shadow-intensity': 1})), 0);
  assert.equal(mod.quickSettingsShadowRoom(settings({'shadow-radius': 40, 'shadow-intensity': 0})), 0);
  assert.equal(mod.quickSettingsShadowRoom(settings({'shadow-radius': 40.2, 'shadow-intensity': 0.5})), 61);
});

test('the corner radius falls back to the Quick Settings default', () => {
  const { mod } = moduleWith(glass());
  assert.equal(mod.quickSettingsCornerRadius(settings({})), mod.QS_DEFAULT_CORNER_RADIUS);
  assert.equal(mod.quickSettingsCornerRadius(settings({'quick-settings-corner-radius': 26})), 26);
});

test('the appearance applies the Quick Settings tint, blur, radius and shadow room', () => {
  const { mod } = moduleWith(glass());
  const target = glass();
  const s = settings({
    'quick-settings-tint-color': '#123456',
    'quick-settings-tint-strength': 0.25,
    'quick-settings-blur-radius': 9,
    'quick-settings-corner-radius': 26,
    'shadow-radius': 40,
    'shadow-intensity': 1,
  });

  const room = mod.applyQuickSettingsGlassAppearance(target, s);
  assert.equal(room, 60);
  assert.deepEqual(target.calls, [
    ['padding', mod.QS_GLASS_PADDING],
    ['isDock', false],
    ['tintColor', '#123456', 'g', 'b'],
    ['tintStrength', 0.25],
    ['blurRadius', 9],
    ['cornerRadius', 26],
    ['shadowMaxRadius', 60],
  ]);
});

test('the factory forwards the owner and outline and can enable regions', () => {
  const target = glass();
  const { mod } = moduleWith(target);
  const manager = { extensionPath: '/ext', _settings: settings({}), _logger: null };

  const made = mod.createQuickSettingsGlass(manager, {
    owner: 'quick-settings-submenu',
    outline: 'quick-settings',
    multiRegion: true,
    cornerRadius: 28,
  });

  assert.equal(made, target);
  assert.equal(target.params.owner, 'quick-settings-submenu');
  assert.equal(target.params.outline, 'quick-settings');
  assert.equal(target.params.extensionPath, '/ext');
  assert.ok(target.calls.some(([name, value]) => name === 'multiRegion' && value === true));
  assert.ok(target.calls.some(([name, value]) => name === 'cornerRadius' && value === 28));
});
