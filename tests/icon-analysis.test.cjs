const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { analyzeIcon, shapeDistance, oklabToSrgb, plateColor } = loadModule(path.join(dist, 'iconStyle/iconAnalysis.js'), {});

const S = 128;

// An icon drawn from layers, each a shape and a colour function, painted in
// order with anti-aliased edges.
function draw(layers) {
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let rgb = [0, 0, 0], a = 0;
      for (const layer of layers) {
        const cov = Math.min(Math.max(0.5 - layer.distance(x + 0.5, y + 0.5), 0), 1);
        if (!cov) continue;
        const c = layer.color(x, y);
        rgb = rgb.map((v, i) => (v * a * (1 - cov) + c[i] * cov) / (a * (1 - cov) + cov));
        a = a * (1 - cov) + cov;
      }
      data.set([...rgb.map(Math.round), Math.round(a * 255)], (y * S + x) * 4);
    }
  }
  return { width: S, height: S, data };
}

const shape = (kind, rx, ry, extra = {}) =>
  ({ kind, cx: 64, cy: 64, rx, ry, radius: 0, exponent: 2, ripple: null, fit: 0, ...extra });
const layer = (s, color) => ({ distance: (x, y) => shapeDistance(s, x, y), color: typeof color === 'function' ? color : () => color });
const bar = (x1, y1, x2, y2) => (x, y) => Math.max(x1 - x, x - x2, y1 - y, y - y2);

function symbolShare(result, inside) {
  let marked = 0, total = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      total++;
      if (result.symbol[y * S + x] > 0.5) marked++;
    }
  }
  return marked / total;
}

test('a rounded square with a symbol on it is one plain plate, and only the symbol is symbol', () => {
  const plate = shape('roundrect', 56, 56, { radius: 14 });
  const glyph = bar(56, 30, 72, 98);
  const icon = draw([layer(plate, [30, 120, 220]), { distance: glyph, color: () => [255, 255, 255] }]);
  const result = analyzeIcon(icon);
  assert.equal(result.plates.length, 1);
  const found = result.plates[0];
  assert.equal(found.shape.kind, 'roundrect');
  assert.ok(Math.abs(found.shape.radius - 14) <= 6, `radius ${found.shape.radius}`);
  assert.ok(found.shape.fit > 0.97);
  assert.equal(found.plain, true);
  assert.deepEqual(oklabToSrgb(...plateColor(found, 64, 20)).map(v => Math.round(v / 8)), [30, 120, 220].map(v => Math.round(v / 8)));
  assert.ok(symbolShare(result, (x, y) => glyph(x, y) < -1) > 0.95);
  assert.ok(symbolShare(result, (x, y) => shapeDistance(plate, x, y) < -2 && glyph(x, y) > 2) < 0.01);
});

test('a squircle with a vertical gradient is a superellipse with that gradient', () => {
  const plate = shape('superellipse', 56, 56, { exponent: 5 });
  const icon = draw([layer(plate, (_x, y) => [40 + (y / S) * 30, 200 - (y / S) * 90, 250])]);
  const [found] = analyzeIcon(icon).plates;
  assert.equal(found.shape.kind, 'superellipse');
  assert.ok(found.shape.exponent >= 4 && found.shape.exponent <= 6, `n ${found.shape.exponent}`);
  assert.equal(found.plain, true);
  const top = oklabToSrgb(...plateColor(found, 64, 16)), bottom = oklabToSrgb(...plateColor(found, 64, 112));
  assert.ok(top[1] - bottom[1] > 60, `${top} ${bottom}`);
});

test('a gear with regular teeth is a plate, its teeth counted', () => {
  const base = shape('superellipse', 46, 46, { exponent: 2 });
  const gear = { ...base, ripple: { count: 10, scale: 1, harmonics: [[0.08, 0], [0, 0], [0, 0]] } };
  const icon = draw([layer(gear, [90, 90, 100])]);
  const [found] = analyzeIcon(icon).plates;
  assert.ok(found, 'no plate');
  assert.equal(found.shape.ripple?.count, 10);
});

test('an irregular blob is no plate and is all symbol', () => {
  const blob = {
    distance: (x, y) => {
      const a = Math.atan2(y - 64, x - 64);
      return Math.hypot(x - 64, y - 64) - 40 * (1 + 0.25 * Math.sin(3 * a) + 0.15 * Math.cos(5 * a + 1));
    },
    color: () => [220, 120, 40],
  };
  const result = analyzeIcon(draw([blob]));
  assert.equal(result.plates.length, 0);
  assert.ok(symbolShare(result, (x, y) => blob.distance(x, y) < -1) > 0.95);
});

test('an outline drawn on nothing is a symbol, not a plate', () => {
  const ring = { distance: (x, y) => Math.abs(Math.hypot(x - 64, y - 64) - 44) - 4, color: () => [255, 255, 255] };
  const result = analyzeIcon(draw([ring]));
  assert.equal(result.plates.length, 0);
});

test('a circle on a rounded square is an inner plate on the outer one', () => {
  const outer = shape('roundrect', 56, 56, { radius: 16 });
  const inner = shape('superellipse', 30, 30, { exponent: 2 });
  const result = analyzeIcon(draw([layer(outer, [240, 240, 240]), layer(inner, [220, 40, 40])]));
  assert.equal(result.plates.length, 2);
  assert.equal(result.plates[0].parent, -1);
  assert.equal(result.plates[1].parent, 0);
  assert.ok(Math.abs(result.plates[1].shape.rx - 30) < 2);
});

test('grain on a plate is neither a picture nor symbol, and a line along its rim is not symbol', () => {
  const plate = shape('roundrect', 56, 56, { radius: 20 });
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 24;
  const rim = { distance: (x, y) => Math.abs(shapeDistance(plate, x, y) + 5) - 0.8, color: () => [150, 200, 255] };
  // An L, which no basic shape fits.
  const l1 = bar(48, 36, 60, 90), l2 = bar(48, 78, 82, 90);
  const glyph = (x, y) => Math.min(l1(x, y), l2(x, y));
  const result = analyzeIcon(draw([layer(plate, () => [200 + noise(), 90 + noise(), 60 + noise()]), rim,
    { distance: glyph, color: () => [255, 255, 255] }]));
  assert.equal(result.plates[0].plain, true);
  assert.ok(symbolShare(result, (x, y) => shapeDistance(plate, x, y) < -8 && glyph(x, y) > 2) < 0.03);
  assert.ok(symbolShare(result, (x, y) => Math.abs(shapeDistance(plate, x, y) + 5) < 0.4 && glyph(x, y) > 2) < 0.1);
  assert.ok(symbolShare(result, (x, y) => glyph(x, y) < -1) > 0.95);
});

test('a one-colour symbol is drawn at full strength, edges and all', () => {
  const plate = shape('roundrect', 56, 56, { radius: 14 });
  const result = analyzeIcon(draw([layer(plate, [30, 200, 90]), { distance: bar(40, 50, 88, 62), color: () => [10, 10, 10] }]));
  for (let y = 52; y < 61; y++) {
    for (let x = 42; x < 86; x++) assert.equal(result.intensity[y * S + x], 1);
  }
});

test('a gradient no quadratic follows is never symbol, and quarters in shades of the plate are its surface', () => {
  const plate = shape('roundrect', 56, 56, { radius: 14 });
  // Lighter to the right over a short stretch, and the top left quarter a little darker.
  const color = (x, y) => {
    const lift = 50 / (1 + Math.exp(-(x - 84) / 7));
    const dark = x < 64 && y < 64 ? 16 : 0;
    return [40 + lift - dark, 130 + lift - dark, 100 + lift - dark];
  };
  const glyph = bar(56, 56, 72, 72);
  const result = analyzeIcon(draw([layer(plate, color), { distance: glyph, color: () => [255, 255, 255] }]));
  assert.equal(result.plates.length, 1);
  assert.ok(symbolShare(result, (x, y) => shapeDistance(plate, x, y) < -3 && glyph(x, y) > 3) < 0.02);
  assert.ok(symbolShare(result, (x, y) => glyph(x, y) < -1) > 0.95);
});

test('a diamond is a plate with no teeth, and a hexagon is no plate with six', () => {
  const diamond = shape('superellipse', 50, 30, { exponent: 1 });
  const [found] = analyzeIcon(draw([layer(diamond, [90, 160, 60])])).plates;
  assert.ok(found, 'no plate');
  assert.equal(found.shape.exponent, 1);
  assert.equal(found.shape.ripple, null);
  // A hexagon with upright sides, as a cube is seen from a corner.
  const hexagon = (x, y) => Math.max(...[0, 60, 120].map(a => {
    const t = a * Math.PI / 180;
    return Math.abs((x - 64) * Math.cos(t) + (y - 64) * Math.sin(t)) - 44;
  }));
  const plates = analyzeIcon(draw([{ distance: hexagon, color: () => [120, 90, 60] }])).plates;
  assert.ok(plates.every(p => !p.shape.ripple), plates.map(p => p.shape.ripple?.count).join());
});

test('red and green of about one lightness in a symbol are drawn at different strengths', () => {
  const blob = (x, y) => {
    const a = Math.atan2(y - 64, x - 64);
    return Math.hypot(x - 64, y - 64) - 40 * (1 + 0.25 * Math.sin(3 * a) + 0.15 * Math.cos(5 * a + 1));
  };
  const sector = (from, to, color) => ({
    distance: (x, y) => {
      const a = (Math.atan2(y - 64, x - 64) + 2 * Math.PI) % (2 * Math.PI);
      return a >= from && a < to ? blob(x, y) : 1;
    },
    color: () => color,
  });
  const third = 2 * Math.PI / 3;
  const result = analyzeIcon(draw([sector(0, third, [225, 60, 50]), sector(third, 2 * third, [40, 160, 70]),
    sector(2 * third, 2 * Math.PI, [250, 200, 30])]));
  assert.equal(result.plates.length, 0);
  const at = (x, y) => result.intensity[y * S + x];
  const red = at(76, 76), green = at(48, 74), yellow = at(66, 44);
  assert.ok(Math.abs(red - green) > 0.1, `red ${red} green ${green}`);
  assert.ok(Math.abs(yellow - red) > 0.1 && Math.abs(yellow - green) > 0.1, `yellow ${yellow}`);
});

test('a stripe across a plate in a shade of its colour is part of its surface, not a plate on it', () => {
  const plate = shape('roundrect', 56, 56, { radius: 14 });
  const stripe = (x, y) => Math.max(shapeDistance(plate, x, y), Math.abs(x - 80) - 10);
  const result = analyzeIcon(draw([layer(plate, [110, 110, 120]), { distance: stripe, color: () => [128, 128, 138] }]));
  assert.equal(result.plates.length, 1);
  assert.ok(symbolShare(result, (x, y) => stripe(x, y) < -2) < 0.05);
});

test('a symbol fading out across a hole in its plate keeps its fade, less faint', () => {
  const plate = shape('superellipse', 56, 56);
  // An L, which no basic shape fits.
  const l1 = bar(40, 30, 58, 98), l2 = bar(40, 80, 88, 98);
  const glyph = (x, y) => Math.min(l1(x, y), l2(x, y));
  const icon = draw([layer(plate, [20, 50, 110]), { distance: glyph, color: () => [255, 255, 255] }]);
  // Opaque at the bottom, a quarter at the top, with no plate under it.
  for (let y = 30; y < 98; y++) {
    for (let x = 40; x < 88; x++) {
      if (glyph(x + 0.5, y + 0.5) < 0) icon.data[(y * S + x) * 4 + 3] = Math.round(255 * (0.25 + 0.75 * (y - 30) / 68));
    }
  }
  const result = analyzeIcon(icon);
  const top = result.symbol[33 * S + 48], bottom = result.symbol[95 * S + 48];
  assert.ok(top > 0.35 && top < 0.6, `top ${top}`);
  assert.ok(bottom > 0.9, `bottom ${bottom}`);
});
