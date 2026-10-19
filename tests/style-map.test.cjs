const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { analyzeIcon, shapeDistance } = loadModule(path.join(dist, 'iconStyle/iconAnalysis.js'), {});
const { buildStyleMap, MAP_SIZE, MAP_RANGE, LENS_SIZE, LENS_RANGE } = loadModule(path.join(dist, 'iconStyle/styleMap.js'), {});

// An icon of `size` px drawn from layers of a distance (in units of a 128 px icon) and a colour.
function draw(size, layers) {
  const k = 128 / size;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rgb = [0, 0, 0], a = 0;
      for (const layer of layers) {
        const cov = Math.min(Math.max(0.5 - layer.distance((x + 0.5) * k, (y + 0.5) * k) / k, 0), 1);
        if (!cov) continue;
        const c = typeof layer.color === 'function' ? layer.color((x + 0.5) * k, (y + 0.5) * k) : layer.color;
        rgb = rgb.map((v, i) => (v * a * (1 - cov) + c[i] * cov) / (a * (1 - cov) + cov));
        a = a * (1 - cov) + cov;
      }
      data.set([...rgb.map(Math.round), Math.round(a * 255)], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

const shape = (kind, r, extra = {}) => ({ kind, cx: 64, cy: 64, rx: r, ry: r, radius: 0, exponent: 2, ripple: null, fit: 0, ...extra });
const of = s => (x, y) => shapeDistance(s, x, y);
const bar = (x1, y1, x2, y2) => (x, y) => Math.max(x1 - x, x - x2, y1 - y, y - y2);

function mapOf(layers) {
  return buildStyleMap(analyzeIcon(draw(128, layers)), draw(256, layers));
}

// The stored distance (map px) at a point given in 128 px icon units.
function field(map, channel, x, y) {
  const s = MAP_SIZE / 128;
  const v = map.data[(Math.floor(y * s) * MAP_SIZE + Math.floor(x * s)) * 4 + channel] / 255;
  return (0.5 - v) * 2 * MAP_RANGE;
}

// The lens map's distance (map px) in a plate slot (0: outer, 1: on it, 2: deeper) at a point in 128 px icon units,
// and the half width stored for slots 1 and 2.
function lensAt(map, slot, x, y) {
  const s = LENS_SIZE / 128;
  const row = Math.floor(y * s) + (slot === 2 ? LENS_SIZE : 0);
  const at = (row * LENS_SIZE + Math.floor(x * s)) * 4 + (slot === 1 ? 2 : 0);
  return ((map.lens[at] * 256 + map.lens[at + 1]) / 65535) * 2 * LENS_RANGE - LENS_RANGE;
}

function lensHalf(map, slot, x, y) {
  const s = LENS_SIZE / 128;
  return map.lens[((Math.floor(y * s) + LENS_SIZE) * LENS_SIZE + Math.floor(x * s)) * 4 + 1 + slot] / 255 * LENS_RANGE;
}

test('the lens map holds the plates\' distances deep inside them, where the style map stops', () => {
  const circle = shape('superellipse', 60);
  const map = mapOf([{ distance: of(circle), color: [30, 200, 90] }, { distance: bar(44, 58, 84, 70), color: [0, 0, 0] }]);
  assert.equal(map.lens.length, LENS_SIZE * LENS_SIZE * 2 * 4);
  // The outer plate fills 0.46 of the icon each way from the middle: 118 map px deep there.
  assert.ok(Math.abs(lensAt(map, 0, 64.5, 64.5) + 0.46 * MAP_SIZE) < 4, `${lensAt(map, 0, 64.5, 64.5)}`);
  // Near the edges it agrees with the style map.
  for (const [x, y] of [[64, 6], [7, 64], [64, 124]])
    assert.ok(Math.abs(lensAt(map, 0, x, y) - field(map, 0, x, y)) < 2.5, `${x},${y}: ${lensAt(map, 0, x, y)} ${field(map, 0, x, y)}`);
  // The circle on it is a plate of its own, with its half width beside it.
  const inner = lensAt(map, 1, 64.5, 64.5);
  assert.ok(inner < -MAP_RANGE, `${inner}`);
  assert.ok(Math.abs(lensHalf(map, 1, 64.5, 64.5) + inner) < 6, `${lensHalf(map, 1, 64.5, 64.5)} ${inner}`);
  // Nothing is deeper.
  assert.ok(lensAt(map, 2, 64, 64) > LENS_RANGE - 1);
});

test('a rounded square stays the outer plate, brought to the size every outer plate has', () => {
  const plate = shape('roundrect', 56, { radius: 14 });
  const map = mapOf([{ distance: of(plate), color: [30, 120, 220] }, { distance: bar(56, 30, 72, 98), color: [255, 255, 255] }]);
  assert.equal(map.ownPlate, true);
  assert.ok(field(map, 0, 64, 64) < -MAP_RANGE + 1);
  // Its edge moved out from 8 px to 0.04 of the icon off the icon's edge.
  assert.ok(Math.abs(field(map, 0, 64, 5.1)) < 2, `edge ${field(map, 0, 64, 5.1)}`);
  // Nothing else is a plate.
  assert.ok(field(map, 1, 64, 64) > MAP_RANGE - 1);
});

test('a circle gets a rounded square around it and shrinks onto it', () => {
  const circle = shape('superellipse', 60);
  const map = mapOf([{ distance: of(circle), color: [30, 200, 90] }, { distance: bar(44, 58, 84, 70), color: [0, 0, 0] }]);
  assert.equal(map.ownPlate, false);
  // The square reaches the corners' diagonal further than the shrunk circle.
  assert.ok(field(map, 0, 22, 22) < 0, 'outer plate in the corner region');
  assert.ok(field(map, 1, 22, 22) > 0, 'circle not in the corner');
  assert.ok(field(map, 1, 64, 64) < 0, 'circle in the middle');
  // The circle's edge moved in from 4 px off the icon's edge.
  assert.ok(field(map, 1, 64, 8) > 0);
});

test('a plate that carries a picture is drawn as symbol, not as glass', () => {
  let seed = 3;
  const noise = () => (seed = (seed * 16807) % 2147483647) % 256;
  const plate = shape('roundrect', 56, { radius: 14 });
  const map = mapOf([{ distance: of(plate), color: () => [noise(), noise(), noise()] }]);
  assert.ok(field(map, 1, 64, 64) > 0, 'a plate on the outer one');
  assert.ok(map.data[(128 * 256 + 128) * 4 + 3] > 200, 'the picture is not symbol');
});

test("the symbol's anti-aliased edge stays partly covered", () => {
  const plate = shape('roundrect', 56, { radius: 14 });
  // A thick diagonal stroke across the plate, whose edges cross pixels at every fraction.
  const stroke = (x, y) => Math.max(Math.abs((x - y) / Math.SQRT2) - 8, of(plate)(x, y) + 4);
  const map = mapOf([{ distance: of(plate), color: [240, 240, 240] }, { distance: stroke, color: [20, 20, 20] }]);
  const values = new Set();
  for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) values.add(map.data[i * 4 + 3]);
  const partial = [...values].filter(v => v > 25 && v < 230).length;
  assert.ok(partial > 40, `only ${partial} partial levels`);
  assert.ok(field(map, 0, 64, 64) < 0);
  assert.equal(map.data[(MAP_SIZE / 2 * MAP_SIZE + MAP_SIZE / 2) * 4 + 3], 255);
});

// The tone stored at a point given in 128 px icon units (channel 0: the plates on the outer one).
function tone(map, x, y) {
  const s = MAP_SIZE / 128;
  return map.tone[(Math.floor(y * s) * MAP_SIZE + Math.floor(x * s)) * 4] / 255;
}

test('plates side by side in different colours get different tones, a plate alone the neutral one', () => {
  const plate = shape('roundrect', 56, { radius: 14 });
  const halves = mapOf([
    { distance: of(plate), color: [240, 240, 240] },
    { distance: bar(14, 14, 62, 114), color: [70, 70, 75] },
    { distance: bar(66, 14, 114, 114), color: [230, 90, 30] },
  ]);
  assert.ok(field(halves, 1, 38, 64) < 0 && field(halves, 1, 90, 64) < 0, 'both halves are plates');
  assert.ok(tone(halves, 90, 64) - tone(halves, 38, 64) > 0.3, `${tone(halves, 38, 64)} ${tone(halves, 90, 64)}`);
  const single = mapOf([{ distance: of(plate), color: [240, 240, 240] }, { distance: bar(30, 30, 98, 98), color: [30, 120, 220] }]);
  assert.equal(Math.round(tone(single, 64, 64) * 10) / 10, 0.5);
});

test('alike squares a little too small to be plates on their own are plates beside one that is', () => {
  const plate = shape('roundrect', 56, { radius: 14 });
  // 36 px is a plate on its own (over a tenth of the plate it is on), 32 px is not.
  const squares = [[12, 36], [52, 32], [86, 32]].map(([x, side]) => ({ distance: bar(x, 46, x + side, 46 + side),
    color: [230, 90, 30] }));
  const map = mapOf([{ distance: of(plate), color: [240, 240, 240] }, ...squares]);
  for (const x of [30, 68, 102]) assert.ok(field(map, 1, x, 62) < 0, `square at ${x}`);
});

test('a plate cut into three pieces of different colours has all of them as symbol', () => {
  const disc = shape('superellipse', 56);
  const sector = (from, to) => (x, y) => {
    const a = (Math.atan2(y - 64, x - 64) + 2 * Math.PI) % (2 * Math.PI);
    return a >= from && a < to ? of(disc)(x, y) : 1;
  };
  const third = 2 * Math.PI / 3;
  const analysis = analyzeIcon(draw(128, [
    { distance: sector(0, third), color: [220, 50, 40] },
    { distance: sector(third, 2 * third), color: [40, 160, 80] },
    { distance: sector(2 * third, 2 * Math.PI), color: [250, 190, 20] },
  ]));
  assert.equal(analysis.plates[0].pieces.length, 3);
  // A point well inside each sector.
  for (const [x, y] of [[80, 84], [40, 76], [70, 36]]) assert.ok(analysis.symbol[y * 128 + x] > 0.8, `sector at ${x},${y}`);
});

test('a toggle whose knob sits on its edge is a plate, knob and all', () => {
  const plate = shape('roundrect', 56, { radius: 14 });
  const pill = shape('roundrect', 34, { cx: 64, cy: 64, ry: 17, radius: 17 });
  const knob = shape('superellipse', 15, { cx: 82, cy: 64 });
  const map = mapOf([{ distance: of(plate), color: [240, 240, 240] }, { distance: of(pill), color: [228, 82, 32] },
    { distance: of(knob), color: [255, 255, 255] }]);
  assert.ok(field(map, 1, 44, 64) < 0, 'the pill is a plate');
  assert.ok(field(map, 1, 82, 64) < 0, 'with the knob in it');
});

test('a disc in a ring takes its own tone, and a darker part of a plate a lower one', () => {
  // Circle, ring and disc: the ring and the disc are both deeper than the plates on the base, so they share a channel.
  const circle = shape('superellipse', 56);
  const ring = shape('superellipse', 30);
  const disc = shape('superellipse', 18);
  const map = mapOf([{ distance: of(circle), color: [220, 60, 50] }, { distance: of(ring), color: [255, 255, 255] },
    { distance: of(disc), color: [30, 110, 230] }]);
  const row = [];
  for (let x = MAP_SIZE / 2; x < MAP_SIZE; x++) {
    const at = (MAP_SIZE / 2 * MAP_SIZE + x) * 4;
    if (map.data[at + 2] > 128) row.push(map.tone[at + 1] / 255);
  }
  assert.ok(row[0] < Math.max(...row) - 0.2, `disc ${row[0]} ring ${Math.max(...row)}`);

  // A square plate with a little darker L shape on it (no plate's shape), too little darker to be symbol.
  const plate = shape('roundrect', 56, { radius: 14 });
  const quarter = (x, y) => Math.max(of(plate)(x, y), Math.min(Math.max(x - 64, y - 64), Math.max(x - 100, y - 40)));
  const shaded = mapOf([{ distance: of(plate), color: [94, 94, 94] }, { distance: quarter, color: [84, 84, 84] }]);
  const outer = (x, y) => shaded.tone[(Math.floor(y * 2) * MAP_SIZE + Math.floor(x * 2)) * 4 + 2] / 255;
  assert.equal(shaded.ownPlate, true);
  assert.ok(outer(36, 36) < outer(92, 92) - 0.1, `dark ${outer(36, 36)} light ${outer(92, 92)}`);
});
