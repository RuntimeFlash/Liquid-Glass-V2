const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
const { centeredBarWidth } = loadModule(path.join(dist, 'topBarManager.js'), {
  Main: {}, St: {}, AdaptiveTextColor: class { },
});

// GNOME Shell's Panel.vfunc_allocate (ui/panel.js), left to right.
function allocate(width, left, center, right, centerOffset) {
  const sideWidth = Math.max(0, (width - center + centerOffset) / 2);
  const leftBox = [0, Math.min(Math.floor(sideWidth), left)];
  const centerBox = [Math.ceil(sideWidth), Math.ceil(sideWidth) + center];
  const rightBox = [Math.max(width - Math.min(Math.floor(sideWidth), right), 0), width];
  return { leftBox, centerBox, rightBox };
}

test('the shrunk bar gives every box its natural width without overlap, with or without a dock at a side', () => {
  // [left, center, right] natural widths, and the offset of a dock fixed to the left (+) or right (-) side.
  for (const [left, center, right] of [[250, 0, 260], [180, 120, 300], [301.5, 90, 40.25]]) {
    for (const centerOffset of [0, 64, -64]) {
      const width = centeredBarWidth(left, center, right, centerOffset);
      const { leftBox, centerBox, rightBox } = allocate(width, left, center, right, centerOffset);
      const label = `${left}/${center}/${right}, offset ${centerOffset}`;
      assert.ok(leftBox[1] - leftBox[0] >= Math.floor(left), `left box clipped: ${label}`);
      assert.ok(rightBox[1] - rightBox[0] >= Math.floor(right), `right box clipped: ${label}`);
      assert.ok(leftBox[1] <= centerBox[0] && centerBox[1] <= rightBox[0], `boxes overlap: ${label}`);
    }
  }
});
