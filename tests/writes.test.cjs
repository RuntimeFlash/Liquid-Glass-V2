const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

const writes = loadModule(path.join(__dirname,
  '../liquid-glass@thinkingcoding1231.gmail.com/dist/actors/writes.js'));

test('opacity writes are skipped when a frame sync repeats its current value', () => {
  let assignments = 0;
  const actor = {};
  Object.defineProperty(actor, 'opacity', {
    set(value) { assignments++; this._opacity = value; },
    get() { return this._opacity; },
  });

  assert.equal(writes.setOpacityIfChanged(actor, 255), true);
  assert.equal(writes.setOpacityIfChanged(actor, 255), false);
  assert.equal(assignments, 1);
  assert.equal(writes.setOpacityIfChanged(actor, 128), true);
  assert.equal(assignments, 2);
});

test('opacity writes can be forced by the diagnostics switch', () => {
  let assignments = 0;
  const actor = {};
  Object.defineProperty(actor, 'opacity', { set(_value) { assignments++; } });
  writes.setDiffWritesEnabled(false);
  try {
    writes.setOpacityIfChanged(actor, 255);
    writes.setOpacityIfChanged(actor, 255);
  } finally {
    writes.setDiffWritesEnabled(true);
  }
  assert.equal(assignments, 2);
});
