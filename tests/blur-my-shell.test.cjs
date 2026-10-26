const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

class Signals {
  handlers = new Map();
  next = 1;
  connect(name, fn) { const id = this.next++; this.handlers.set(id, { name, fn }); return id; }
  disconnect(id) { assert.ok(this.handlers.delete(id), `unknown signal ${id}`); }
  emit(name, ...args) { for (const h of [...this.handlers.values()]) if (h.name === name) h.fn(this, ...args); }
}

class FakeSettings extends Signals {
  constructor(values) { super(); this.values = values; }
  get_boolean(key) { return this.values[key]; }
  set_boolean(key, value) { this.values[key] = value; this.emit(`changed::${key}`); }
}

// Blur my Shell installed at /ext with popup blur `blur`, in `state`.
function fixture({ state = 1, blur = true, hasPopupSchema = true } = {}) {
  const popup = new FakeSettings({ blur });
  const bms = { uuid: 'blur-my-shell@aunetx', path: '/ext', state };
  const manager = new Signals();
  manager.lookup = uuid => uuid === bms.uuid ? bms : null;
  const settings = new FakeSettings({ 'blur-my-shell-popup-blur': false });
  const warnings = [];
  const { BlurMyShellWatch } = loadModule(
    path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist/blurMyShell.js'), {
      Main: { extensionManager: manager },
      ExtensionState: { ACTIVE: 1, INACTIVE: 2 },
      GLib: { build_filenamev: parts => parts.join('/'), file_test: file => file === '/ext/schemas/gschemas.compiled',
        FileTest: { EXISTS: 16 } },
      Gio: {
        Settings: function ({ settings_schema }) { assert.equal(settings_schema, 'popup-schema'); return popup; },
        SettingsSchemaSource: {
          get_default: () => null,
          new_from_directory: dir => ({ lookup: id => dir === '/ext/schemas'
            && id === 'org.gnome.shell.extensions.blur-my-shell.popup' && hasPopupSchema ? 'popup-schema' : null }),
        },
      },
    });
  const watch = new BlurMyShellWatch(settings, { warn: message => warnings.push(message) });
  return { watch, settings, popup, bms, manager, warnings };
}

test('popup blur in an active Blur my Shell is published and logged', () => {
  const f = fixture();
  f.watch.setup();
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], true);
  assert.equal(f.warnings.length, 1);

  f.popup.set_boolean('blur', false);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], false);
  f.popup.set_boolean('blur', true);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], true);
  assert.equal(f.warnings.length, 2, 'turning it back on warns again');
});

test('disabling Blur my Shell clears the warning and drops its settings', () => {
  const f = fixture();
  f.watch.setup();
  f.bms.state = 2;
  f.manager.emit('extension-state-changed', f.bms);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], false);
  assert.equal(f.popup.handlers.size, 0);

  f.bms.state = 1;
  f.manager.emit('extension-state-changed', f.bms);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], true);
});

test('a Blur my Shell without popup blur, or an inactive one, is not reported', () => {
  for (const options of [{ hasPopupSchema: false }, { state: 2 }, { blur: false }]) {
    const f = fixture(options);
    f.watch.setup();
    assert.equal(f.settings.values['blur-my-shell-popup-blur'], false, JSON.stringify(options));
    assert.equal(f.warnings.length, 0, JSON.stringify(options));
  }
});

test('cleanup disconnects everything and leaves no warning behind', () => {
  const f = fixture();
  f.watch.setup();
  f.watch.cleanup();
  assert.equal(f.manager.handlers.size, 0);
  assert.equal(f.popup.handlers.size, 0);
  assert.equal(f.settings.values['blur-my-shell-popup-blur'], false);
});
