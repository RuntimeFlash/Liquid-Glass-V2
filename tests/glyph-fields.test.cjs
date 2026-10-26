const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const glyphs = loadModule(path.join(dist, 'desktop/glassText.js'), {});

// Anti-aliased coverage (0-255) of `inside(x, y)`, 16 x 16 samples per pixel.
function coverage(w, h, inside) {
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let j = 0; j < 16; j++)
        for (let i = 0; i < 16; i++) if (inside(x - 0.5 + (i + 0.5) / 16, y - 0.5 + (j + 0.5) / 16)) n++;
      alpha[y * w + x] = Math.round(n / 256 * 255);
    }
  }
  return alpha;
}

test('the distances round a circle follow the circle, not the pixels', () => {
  const [w, h, cx, cy, r] = [64, 64, 31.3, 32.6, 19.4];
  const field = glyphs.signedDistances(coverage(w, h, (x, y) => Math.hypot(x - cx, y - cy) < r), w, h);
  let worst = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const exact = Math.hypot(x - cx, y - cy) - r;
      if (Math.abs(exact) < 6) worst = Math.max(worst, Math.abs(field[y * w + x] - exact));
    }
  }
  assert.ok(worst < 0.1, `worst error ${worst.toFixed(3)} px`);
});

test('a straight edge between whole pixels is half a pixel from either side', () => {
  const field = glyphs.signedDistances(coverage(20, 8, x => x < 9.5), 20, 8);
  assert.ok(Math.abs(field[4 * 20 + 9] + 0.5) < 1e-6, String(field[4 * 20 + 9]));
  assert.ok(Math.abs(field[4 * 20 + 10] - 0.5) < 1e-6, String(field[4 * 20 + 10]));
  assert.ok(Math.abs(field[4 * 20 + 15] - 5.5) < 1e-6, String(field[4 * 20 + 15]));
});

test('softening keeps a straight edge where it is and rounds the fold in a corner', () => {
  const [w, h] = [80, 80];
  // A square from 20 to 60.
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const qx = Math.abs(x - 40) - 20, qy = Math.abs(y - 40) - 20;
      data[y * w + x] = Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    }
  const soft = glyphs.softened({ data, width: w, height: h }, 4).data;
  // Mid-side, the distance is still linear across the edge.
  for (const x of [17, 20, 23, 26]) assert.ok(Math.abs(soft[40 * w + x] - data[40 * w + x]) < 0.05, `x=${x}`);
  // On the corner's bisector the field was folded (its slope turned by 90
  // degrees); softened, its slope across the bisector turns gradually.
  const slope = (f, x, y) => [(f[y * w + x + 1] - f[y * w + x - 1]) / 2, (f[(y + 1) * w + x] - f[(y - 1) * w + x]) / 2];
  const [ax] = slope(soft, 27, 26), [bx] = slope(soft, 26, 27);
  assert.ok(Math.abs(ax - bx) < 0.5, `${ax} vs ${bx}`);
  assert.equal(glyphs.maxDepth({ data, width: w, height: h }), 20);
});

// Whether (x, y) is inside the polygon [[x, y], ...] (even-odd).
function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The longest run of ink (coverage counted as its fraction) along a line from (x, y) by (dx, dy) per step.
function run(alpha, w, h, x, y, dx, dy, steps) {
  let total = 0;
  for (let i = -steps; i <= steps; i++) {
    const px = Math.round(x + dx * i - 0.5), py = Math.round(y + dy * i - 0.5);
    if (px >= 0 && py >= 0 && px < w && py < h) total += alpha[py * w + px] / 255;
  }
  return total * Math.hypot(dx, dy);
}

test('an outline traced from coverage fills back to the same coverage', () => {
  const [w, h] = [80, 70];
  const alpha = coverage(w, h, (x, y) => {
    const d = Math.hypot(x - 40.3, y - 33.7);
    return d < 26.2 && d > 11.4;
  });
  const loops = glyphs.traceOutlines(alpha, w, h);
  assert.equal(loops.length, 2);
  const back = glyphs.fillOutlines(loops, w, h);
  let worst = 0, sum = 0;
  for (let i = 0; i < w * h; i++) {
    worst = Math.max(worst, Math.abs(back[i] - alpha[i]));
    sum += Math.abs(back[i] - alpha[i]);
  }
  assert.ok(worst <= 25 && sum / (w * h) < 0.5, `worst ${worst}, mean ${sum / (w * h)}`);
});

test('stroke widths are measured across upright and across flat strokes', () => {
  const [w, h] = [100, 130];
  // An L: an upright stem 10 px wide and a foot 6 px tall.
  const alpha = coverage(w, h, (x, y) => (x > 20 && x < 30 && y > 10 && y < 120) || (x > 20 && x < 85 && y > 114 && y < 120));
  const [across, tall] = glyphs.strokeWidths(alpha, w, h);
  assert.ok(Math.abs(across - 10) < 0.6 && Math.abs(tall - 6) < 0.6, `${across} x ${tall}`);
});

test('a glyph drawn taller gets back its bars\' and its slanted strokes\' width', () => {
  const s = 2;
  // A 7 with a bar 12 px thick and a slanted stroke, drawn twice as tall.
  const seven = [[20, 20], [100, 20], [100, 30], [58, 140], [45, 140], [86, 32], [20, 32]].map(([x, y]) => [x, y * s]);
  const [w, h] = [120, 300];
  const alpha = coverage(w, h, (x, y) => inPolygon(x, y, seven));
  const out = glyphs.keepStrokeWidths(alpha, w, h, [12, 12], s);
  // The bar: 24 px drawn, 12 px kept.
  for (const x of [30, 50, 70]) {
    const bar = run(out, w, h, x + 0.5, 52, 0, 1, 30);
    assert.ok(Math.abs(bar - 12) < 0.3, `bar at ${x}: ${bar}`);
  }
  // The slanted stroke, measured across it: as thick as the pen draws it at its new angle.
  const [ax, ay, bx, by] = [86, 64, 45, 280];
  const len = Math.hypot(bx - ax, by - ay);
  const [nx, ny] = [(by - ay) / len, -(bx - ax) / len];
  for (const t of [0.35, 0.55, 0.75]) {
    const across = run(out, w, h, ax + (bx - ax) * t + nx * 6, ay + (by - ay) * t + ny * 6, nx / 4, ny / 4, 120);
    const before = run(alpha, w, h, ax + (bx - ax) * t + nx * 6, ay + (by - ay) * t + ny * 6, nx / 4, ny / 4, 120);
    // The stretch made it thicker by 12 * (g - 1), g as it faces now.
    const g = Math.hypot(nx, s * ny);
    assert.ok(Math.abs(across - (before - 12 * (g - 1))) < 0.4, `slanted at ${t}: ${before} -> ${across}`);
  }
});

test('the inner corner of a 7 stays a corner where the bar and the slanted stroke meet', () => {
  const s = 2;
  const seven = [[20, 20], [100, 20], [100, 30], [58, 140], [45, 140], [86, 32], [20, 32]].map(([x, y]) => [x, y * s]);
  const [w, h] = [120, 300];
  const out = glyphs.keepStrokeWidths(coverage(w, h, (x, y) => inPolygon(x, y, seven)), w, h, [12, 12], s);
  // The bar's underside moves up 6 px; the slanted side moves in by what the
  // stretch added on it. The outline near the corner lies on those two lines.
  const move = (nx, ny) => (Math.hypot(12 * nx, s * 12 * ny) - 12) / 2;
  const [px, py, qx, qy] = [45, 280, 86, 64];
  const len = Math.hypot(qx - px, qy - py);
  const [nx, ny] = [(qy - py) / len, -(qx - px) / len];
  const e = move(nx, ny);
  // The outline's pixel (x, y) covers x to x + 1; the polygon's covers x - 0.5 to x + 0.5.
  // (nx, ny) points out of the ink there.
  const lines = [p => Math.abs(p[1] - 0.5 - (64 - 6)), p => Math.abs((p[0] - 0.5 - px) * nx + (p[1] - 0.5 - py) * ny + e)];
  const loops = glyphs.traceOutlines(out, w, h);
  // Where they cross; right at it, coverage cannot say how sharp the corner is.
  const cornerY = 58.5, cornerX = 0.5 + px + ((-e - (cornerY - 0.5 - py) * ny) / nx);
  let checked = 0;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i += 2) {
      const p = [loop[i], loop[i + 1]];
      if (p[1] < 54 || p[1] > 90 || p[0] < 50 || p[0] > 92 || Math.hypot(p[0] - cornerX, p[1] - cornerY) < 1.5) continue;
      // Points on the underside or on the slanted side, near the corner.
      if (p[1] < 60 || Math.abs(p[0] - 80) < 12) {
        const off = Math.min(...lines.map(f => f(p)));
        if (off < 3) {
          checked++;
          assert.ok(off < 0.2, `(${p}) is ${off} px off`);
        }
      }
    }
  }
  assert.ok(checked > 20, `${checked} points`);
});

test('a ring drawn taller keeps its width all round, and a dot stays round', () => {
  const s = 2.2;
  const [w, h] = [100, 200];
  const ring = coverage(w, h, (x, y) => {
    const d = Math.hypot(x - 50, (y - 100) / s);
    return d < 40 && d > 28;
  });
  const out = glyphs.keepStrokeWidths(ring, w, h, [12, 12], s);
  const top = run(out, w, h, 50.5, 100 - 34 * s, 0, 1, 40);
  const side = run(out, w, h, 50 - 34, 100.5, 1, 0, 40);
  assert.ok(Math.abs(top - 12) < 0.6 && Math.abs(side - 12) < 0.6, `top ${top}, side ${side}`);

  const dot = coverage(60, 80, (x, y) => Math.hypot(x - 30, (y - 40) / s) < 7);
  const round = glyphs.keepStrokeWidths(dot, 60, 80, [14, 14], s);
  const tall = run(round, 60, 80, 30.5, 40, 0, 1, 40), wide = run(round, 60, 80, 30, 40.5, 1, 0, 30);
  assert.ok(Math.abs(tall - 14) < 0.8 && Math.abs(wide - 14) < 0.8, `${wide} x ${tall}`);
});

// Rows (from the top) where column x is covered at least half.
function coveredRows(alpha, w, h, x) {
  const rows = [];
  for (let y = 0; y < h; y++) if (alpha[y * w + x] >= 128) rows.push(y);
  return rows;
}

test('grown along its upright strokes, an I lengthens its stem and keeps its bars as thick', () => {
  // Bars across rows 10-14 and 50-54, a stem in columns 20-29 between them.
  const [w, h] = [50, 70];
  const alpha = coverage(w, h, (x, y) => (y >= 9.5 && y < 54.5 && x >= 19.5 && x < 29.5) ||
    (((y >= 9.5 && y < 14.5) || (y >= 49.5 && y < 54.5)) && x >= 9.5 && x < 39.5));
  const tall = glyphs.growUpright(alpha, w, h, 10, 55, 20, [10, 5]);
  const bar = coveredRows(tall, w, h + 20, 12);
  assert.equal(bar.length, 10, String(bar));
  assert.ok(bar[0] === 10 && bar[9] === 74, String(bar));
  assert.equal(coveredRows(tall, w, h + 20, 25).length, 65);
});

test('the added height goes to the rows where the outline runs upright', () => {
  // An O: the rows round its top and bottom curve, the middle ones run upright.
  const [w, h] = [60, 60];
  const alpha = coverage(w, h, (x, y) => {
    const d = Math.hypot((x - 30) / 20, Math.max(Math.abs(y - 30) - 10, 0) / 20);
    return d < 1 && Math.hypot((x - 30) / 10, Math.max(Math.abs(y - 30) - 10, 0) / 10) >= 1;
  });
  const shares = glyphs.rowShares(alpha, w, 10, 50);
  const perRow = (a, b) => shares.slice(a, b).reduce((s, v) => s + v, 0) / (b - a);
  const middle = perRow(15, 25), curves = (perRow(0, 8) + perRow(32, 40)) / 2;
  assert.ok(middle > curves * 2, `middle ${middle.toFixed(4)} curves ${curves.toFixed(4)}`);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('grown along its upright strokes, a colon keeps its dots round', () => {
  const [w, h] = [40, 100];
  const alpha = coverage(w, h, (x, y) => Math.hypot(x - 20, y - 30) < 8 || Math.hypot(x - 20, y - 80) < 8);
  const tall = glyphs.growUpright(alpha, w, h, 10, 95, 50, [16, 16]);
  const rows = coveredRows(tall, w, h + 50, 20);
  const runs = [];
  rows.forEach((y, i) => (i === 0 || rows[i - 1] !== y - 1 ? runs.push([y]) : runs[runs.length - 1].push(y)));
  assert.equal(runs.length, 2);
  for (const run of runs) assert.ok(Math.abs(run.length - 16) <= 1, `a dot ${run.length} rows tall`);
});

test('the parts above and below the join in the middle of a 3 grow alike', () => {
  // A 3 of two bowls (open on the left) on a join at row 48: the upper bowl
  // 36 rows tall, the lower 46.
  const [w, h] = [70, 110];
  const bowl = (x, y, cy, ry) => {
    const d = Math.hypot((x - 30) / 25, (y - cy) / ry), d2 = Math.hypot((x - 30) / 15, (y - cy) / (ry - 10));
    return x > 22 && d < 1 && d2 >= 1;
  };
  const alpha = coverage(w, h, (x, y) => bowl(x, y, 30, 18) || bowl(x, y, 71, 23));
  const top = 12, bottom = 94, extra = 82;
  const tall = glyphs.growUpright(alpha, w, h, top, bottom, extra, [10, 10]);
  // Where the join and the bottom land, on the bowls' right sides.
  const rows = coveredRows(tall, w, h + extra, 30);
  const runs = [];
  rows.forEach((y, i) => (i === 0 || rows[i - 1] !== y - 1 ? runs.push([y]) : runs[runs.length - 1].push(y)));
  // Column 30 crosses the upper bowl's top, the join (the upper bowl's
  // bottom on the lower one's top) and the lower bowl's bottom.
  assert.equal(runs.length, 3);
  const join = (runs[1][0] + runs[1][runs[1].length - 1] + 1) / 2;
  const upper = (join - runs[0][0]) / (48 - 12), lower = (runs[2][runs[2].length - 1] + 1 - join) / (94 - 48);
  assert.ok(Math.abs(upper / lower - 1) < 0.12, `upper x${upper.toFixed(2)}, lower x${lower.toFixed(2)}`);
});
