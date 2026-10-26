// Writes the icon contact sheet: one row per application, and per icon theme
// the icon as drawn, the analysis over it, and the icon redrawn as glass plates
// under a one-colour symbol.
//
//   node build-sheet.cjs <out.html> <theme.json>...
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ext = path.join(__dirname, '../../liquid-glass@thinkingcoding1231.gmail.com');
// The extension's own shader and colours, so the sheet shows what the dock draws.
const shader = fs.readFileSync(path.join(ext, 'shaders/icon-style.frag'), 'utf8')
  .replace(/cogl_tex_coord_in\[0\]\.st/g, 'v_st')
  .replace(/cogl_color_out/g, 'gl_FragColor');
const colours = fs.readFileSync(path.join(ext, 'dist/iconStyle/styleColors.js'), 'utf8')
  .replace(/^export /gm, '');

const [out, ...inputs] = process.argv.slice(2);
const themes = inputs.map(path => JSON.parse(fs.readFileSync(path, 'utf8')));
const apps = new Map();
for (const theme of themes) {
  for (const icon of theme.icons) {
    if (!apps.has(icon.id)) apps.set(icon.id, { id: icon.id, name: icon.name, icon: icon.icon, themes: {} });
    apps.get(icon.id).themes[theme.theme] = icon;
  }
}
const data = {
  themes: themes.map(t => t.theme),
  size: themes[0]?.size ?? 128,
  apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name)),
};

const SHADER_JSON = JSON.stringify(shader);
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Icon Sheet</title>
<style>
:root {
  --bg: #16171b; --panel: #202127; --line: #30323a; --text: #e8e8ec; --muted: #9a9ca6; --accent: #3584e4;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.4 system-ui, sans-serif; }
header { position: sticky; top: 0; z-index: 2; background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); padding: 10px 16px;
  display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; }
header h1 { font-size: 15px; margin: 0 8px 0 0; }
header label { display: flex; gap: 6px; align-items: center; color: var(--muted); }
select, input[type=text] { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
.summary { padding: 8px 16px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 24px; }
table { border-collapse: collapse; margin: 0 16px 40px; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 10px; vertical-align: top; }
th { position: sticky; top: 52px; background: var(--bg); text-align: left; color: var(--muted); font-weight: 600; z-index: 1; }
td.name { width: 190px; }
td.name b { display: block; }
td.name small { color: var(--muted); word-break: break-all; }
.cell { display: flex; gap: 6px; }
.cell canvas { border-radius: 6px; background: #000; }
.info { color: var(--muted); font-size: 11px; max-width: 320px; margin-top: 3px; }
.info .fallback { color: #e5a50a; }
.info .error { color: #ff7b63; }
.legend { color: var(--muted); padding: 0 16px 6px; font-size: 12px; }
#tuning { padding: 6px 16px; color: var(--muted); }
#tuning-rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 4px 18px; margin: 6px 0; }
#tuning-rows label { display: grid; grid-template-columns: 1fr 120px 40px; gap: 6px; align-items: center; }
</style>
</head>
<body>
<header>
  <h1>Icon Sheet</h1>
  <label>Mode <select id="mode"><option value="tinted">Tinted</option><option value="mono">Mono</option><option value="clear">Clear</option></select></label>
  <label>Variant <select id="variant"><option value="light">Light</option><option value="dark">Dark</option></select></label>
  <label>Accent <input id="accent" type="color" value="#3584e4"></label>
  <label>Tint <input id="strength" type="range" min="0" max="1" step="0.05" value="0"></label>
  <label>Symbol <input id="opacity" type="range" min="0" max="1" step="0.05" value="1"></label>
  <label>Size <select id="size"><option>48</option><option selected>64</option><option>96</option><option>128</option></select></label>
  <label><input id="launch" type="checkbox"> Launch animation column</label>
  <label><input id="debug" type="checkbox" checked> Analysis column</label>
  <label><input id="info" type="checkbox" checked> Details</label>
  <label>Filter <input id="filter" type="text" placeholder="name or id, a|b for either"></label>
</header>
<details id="tuning"><summary>Glass tuning (the current look's numbers, as in the preferences)</summary>
<div id="tuning-rows"></div><button id="tuning-reset" type="button">Reset</button></details>
<div class="summary" id="summary"></div>
<div class="legend">Columns: the icon, the analysis, the icon as the dock draws it (over a blurred wallpaper, as on the dock's glass;
an icon whose plate carries a picture is shown as it is), and optionally the launch animation's colours.
Analysis: plates outlined outermost first (white, yellow, cyan, magenta, ...); dashed = carries a picture
(its content is kept as symbol); red tint = what is taken as the symbol. "theme" = the icon came from the theme itself,
"hicolor" = from the fallback every theme shares, "other theme" / "file" = from elsewhere.</div>
<table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table>
<script>
const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const SIZE = DATA.size;
const COLORS = ['#ffffff', '#f6d32d', '#33d17a', '#62a0ea', '#f66151', '#c061cb', '#ffa348'];
const images = new Map();
function image(b64) {
  if (!images.has(b64)) {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    images.set(b64, img.decode().then(() => img));
  }
  return images.get(b64);
}

// A wallpaper for the glass to be over, sharp and blurred.
const wall = document.createElement('canvas');
wall.width = 1024; wall.height = 512;
{
  const g = wall.getContext('2d');
  const base = g.createLinearGradient(0, 0, 1024, 512);
  base.addColorStop(0, '#1d3557'); base.addColorStop(0.5, '#6a4c93'); base.addColorStop(1, '#0b6e4f');
  g.fillStyle = base; g.fillRect(0, 0, 1024, 512);
  const blobs = [[120, 100, '#ff9f1c'], [380, 380, '#2ec4b6'], [640, 120, '#e71d36'], [860, 340, '#ffd166'], [520, 260, '#8ecae6']];
  for (const [x, y, c] of blobs) {
    const r = g.createRadialGradient(x, y, 0, x, y, 170);
    r.addColorStop(0, c); r.addColorStop(1, c + '00');
    g.fillStyle = r; g.fillRect(0, 0, 1024, 512);
  }
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 3;
  for (let x = 0; x < 1024; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 200, 512); g.stroke(); }
}
const wallBlur = document.createElement('canvas');
wallBlur.width = wall.width; wallBlur.height = wall.height;
{ const g = wallBlur.getContext('2d'); g.filter = 'blur(14px)'; g.drawImage(wall, 0, 0); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, 0, wall.width, wall.height); }

function hexRgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }

function path(points) {
  const p = new Path2D();
  points.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}

${colours}

// One WebGL canvas draws every icon, which is then copied out.
const gl = (() => {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('webgl', {premultipliedAlpha: true, alpha: true});
  const compile = (type, src) => {
    const sh = g.createShader(type);
    g.shaderSource(sh, src);
    g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(sh));
    return sh;
  };
  const program = g.createProgram();
  g.attachShader(program, compile(g.VERTEX_SHADER,
    'attribute vec2 pos; varying vec2 v_st; void main() { v_st = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5); gl_Position = vec4(pos, 0.0, 1.0); }'));
  g.attachShader(program, compile(g.FRAGMENT_SHADER, 'precision highp float;\\nvarying vec2 v_st;\\n' + ${SHADER_JSON}));
  g.linkProgram(program);
  if (!g.getProgramParameter(program, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(program));
  g.useProgram(program);
  const buf = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
  const loc = g.getAttribLocation(program, 'pos');
  g.enableVertexAttribArray(loc);
  g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
  g.uniform1i(g.getUniformLocation(program, 'cogl_sampler0'), 0);
  g.uniform1i(g.getUniformLocation(program, 'cogl_sampler1'), 1);
  g.uniform1i(g.getUniformLocation(program, 'cogl_sampler2'), 2);
  return {g, canvas, program, set: (name, v) => g.uniform1f(g.getUniformLocation(program, name), v)};
})();

const textures = new Map();
function texture(img, mipmap) {
  if (textures.has(img)) return textures.get(img);
  const g = gl.g;
  const t = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, t);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !mipmap);
  g.pixelStorei(g.UNPACK_COLORSPACE_CONVERSION_WEBGL, g.NONE);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, img);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  if (mipmap) g.generateMipmap(g.TEXTURE_2D);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, mipmap ? g.LINEAR_MIPMAP_LINEAR : g.LINEAR);
  textures.set(img, t);
  return t;
}

// Draws the icon as the dock does, or as the launch animation's clone does.
async function drawStyled(canvas, rec, opts, wallX, wallY, launch) {
  const g2 = canvas.getContext('2d');
  const px = canvas.width;
  g2.clearRect(0, 0, px, px);
  g2.drawImage(wallBlur, wallX, wallY, SIZE, SIZE, 0, 0, px, px);
  if (!rec.original) return;
  const original = await image(rec.original);
  if (!rec.map && !launch) {
    g2.drawImage(original, 0, 0, px, px);
    return;
  }
  // Decoded before any GL call: the icons are drawn concurrently, and the GL state between awaits is anyone's.
  const map = rec.map ? await image(rec.map) : null;
  const tone = rec.tone ? await image(rec.tone) : null;
  const {g, canvas: glc, set} = gl;
  glc.width = glc.height = px;
  g.viewport(0, 0, px, px);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, texture(original, false));
  g.activeTexture(g.TEXTURE1);
  g.bindTexture(g.TEXTURE_2D, map ? texture(map, true) : texture(original, false));
  g.activeTexture(g.TEXTURE2);
  g.bindTexture(g.TEXTURE_2D, tone ? texture(tone, false) : texture(original, false));
  const c = iconStyleColors(opts.mode, opts.accent.map(v => v / 255), opts.strength, opts.opacity, opts.variant, tuning);
  for (const [name, v] of [['box_x0', 0], ['box_y0', 0], ['box_x1', 1], ['box_y1', 1], ['map_px', 256 / px],
    ['clone', launch ? 1 : 0], ['opacity', 1], ...iconStyleUniforms(c)]) set(name, v);
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  g2.drawImage(glc, 0, 0);
}

async function drawDebug(canvas, rec) {
  const g = canvas.getContext('2d');
  g.fillStyle = '#7f7f7f';
  g.fillRect(0, 0, SIZE, SIZE);
  if (!rec.original) return;
  g.globalAlpha = 0.55;
  g.drawImage(await image(rec.original), 0, 0);
  g.globalAlpha = 1;
  const sym = await image(rec.symbol);
  const off = new OffscreenCanvas(SIZE, SIZE);
  const o = off.getContext('2d');
  o.drawImage(sym, 0, 0);
  o.globalCompositeOperation = 'source-in';
  o.fillStyle = 'rgba(255,40,40,0.85)';
  o.fillRect(0, 0, SIZE, SIZE);
  g.drawImage(off, 0, 0);
  rec.plates.forEach((plate, i) => {
    g.save();
    g.lineWidth = 2;
    g.strokeStyle = COLORS[i % COLORS.length];
    if (!plate.plain) g.setLineDash([5, 4]);
    g.stroke(path(plate.outline));
    g.restore();
  });
}

async function drawOriginal(canvas, rec) {
  const g = canvas.getContext('2d');
  g.fillStyle = '#2a2b31';
  g.fillRect(0, 0, SIZE, SIZE);
  if (rec.original) g.drawImage(await image(rec.original), 0, 0);
}

function describe(rec) {
  if (rec.error) return '<span class="error">' + rec.error + '</span>';
  const source = rec.fromTheme ? 'theme' : rec.file.includes('/hicolor/') ? 'hicolor'
    : '<span class="fallback">' + (rec.file.includes('/icons/') ? 'other theme' : 'file') + '</span>';
  const plates = rec.plates.map(p => {
    const s = p.shape;
    const kind = s.kind === 'roundrect' ? 'rect r' + Math.round(s.radius) : 'superellipse n' + s.exponent;
    const ripple = s.ripple ? ' ~' + s.ripple.count + ' teeth' : '';
    const colour = p.from === p.to ? p.centre : p.from + '→' + p.to;
    return kind + ripple + ' (fit ' + s.fit.toFixed(2) + (p.plain ? '' : ', picture') + ', area ' + p.share + ' err ' + p.error + ' grain ' + p.noise +
      ', ' + colour + ')';
  });
  const look = !rec.map ? 'shown as it is' : rec.ownPlate ? 'own rounded square' : 'set on a rounded square';
  const missing = rec.missing ? '<span class="error">missing, the generic icon</span> · ' : '';
  return missing + source + ' · ' + rec.ms + ' ms · ' + look + ' · ' + (plates.length ? plates.join('; ') : 'no plate');
}

function options() {
  return {
    mode: document.getElementById('mode').value,
    accent: hexRgb(document.getElementById('accent').value),
    variant: document.getElementById('variant').value,
    strength: +document.getElementById('strength').value,
    opacity: +document.getElementById('opacity').value,
    launch: document.getElementById('launch').checked,
    debug: document.getElementById('debug').checked,
    info: document.getElementById('info').checked,
    size: +document.getElementById('size').value,
    filter: document.getElementById('filter').value.toLowerCase(),
    start: +(hash.get('start') ?? 0),
    count: +(hash.get('count') ?? Infinity),
  };
}

function summary() {
  const parts = DATA.themes.map(theme => {
    const recs = DATA.apps.map(a => a.themes[theme]).filter(Boolean);
    const ok = recs.filter(r => !r.error);
    const withPlate = ok.filter(r => r.plates.length);
    const fromTheme = ok.filter(r => r.fromTheme);
    return '<b>' + theme + '</b>: ' + recs.length + ' icons, ' + fromTheme.length + ' from the theme, ' +
      withPlate.length + ' with plates, ' + (recs.length - ok.length) + ' failed';
  });
  document.getElementById('summary').innerHTML = parts.join('');
}

let drawId = 0;
async function render() {
  const opts = options();
  const id = ++drawId;
  document.getElementById('head').innerHTML = '<th>Application</th>' + DATA.themes.map(t => '<th>' + t + '</th>').join('');
  const body = document.getElementById('rows');
  body.innerHTML = '';
  let row = 0, index = -1;
  for (const app of DATA.apps) {
    const text = (app.name + ' ' + app.id).toLowerCase();
    if (opts.filter && !opts.filter.split('|').some(part => part && text.includes(part))) continue;
    index++;
    if (index < opts.start || index >= opts.start + opts.count) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="name"><b>' + app.name + '</b><small>' + app.id + '</small></td>';
    const jobs = [];
    DATA.themes.forEach((theme, t) => {
      const td = document.createElement('td');
      const rec = app.themes[theme];
      if (rec) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        const make = (px = SIZE) => {
          const c = document.createElement('canvas');
          c.width = c.height = px;
          c.style.width = c.style.height = opts.size + 'px';
          cell.appendChild(c);
          return c;
        };
        jobs.push(drawOriginal(make(), rec));
        if (opts.debug) jobs.push(drawDebug(make(), rec));
        const wx = (row * 137 + t * 251) % (wall.width - SIZE), wy = (row * 59 + t * 97) % (wall.height - SIZE);
        const px = Math.round(opts.size * devicePixelRatio);
        jobs.push(drawStyled(make(px), rec, opts, wx, wy, false));
        if (opts.launch) jobs.push(drawStyled(make(px), rec, opts, wx, wy, true));
        td.appendChild(cell);
        if (opts.info) {
          const info = document.createElement('div');
          info.className = 'info';
          info.innerHTML = describe(rec);
          td.appendChild(info);
        }
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
    row++;
    if (row % 20 === 0) {
      await Promise.all(jobs);
      if (id !== drawId) return;
    }
  }
}

// Controls can be set from the address, e.g. #mode=mono&size=128&filter=calc&debug=0, and a range of rows
// with start and count.
const hash = new URLSearchParams(location.hash.slice(1));
for (const [key, value] of hash) {
  const control = document.getElementById(key);
  if (!control) continue;
  if (control.type === 'checkbox') control.checked = value !== '0';
  else control.value = value;
}
for (const id of ['mode', 'variant', 'accent', 'strength', 'opacity', 'launch', 'size', 'debug', 'info', 'filter'])
  document.getElementById(id).addEventListener('input', render);
// Values that differ from ICON_TUNING's, as the preferences store them; the rows show the current look's.
const tuning = {};
function tuningRows() {
  const look = document.getElementById('mode').value === 'tinted' ? document.getElementById('variant').value
    : document.getElementById('mode').value;
  const rows = document.getElementById('tuning-rows');
  rows.innerHTML = '';
  for (const param of ICON_TUNING.filter(p => p.looks.includes(look))) {
    const label = document.createElement('label');
    const value = tuning[param.key] ?? param.value;
    label.innerHTML = '<span>' + param.title + '</span><input type="range" min="' + param.min + '" max="' + param.max +
      '" step="0.01" value="' + value + '"><output>' + value + '</output>';
    const input = label.querySelector('input'), output = label.querySelector('output');
    input.addEventListener('input', () => {
      tuning[param.key] = +input.value;
      output.textContent = input.value;
      render();
    });
    rows.appendChild(label);
  }
}
for (const id of ['mode', 'variant']) document.getElementById(id).addEventListener('input', tuningRows);
document.getElementById('tuning-reset').addEventListener('click', () => {
  for (const key of Object.keys(tuning)) delete tuning[key];
  tuningRows();
  render();
});
tuningRows();
summary();
render();
</script>
</body>
</html>
`;
fs.writeFileSync(out, html);
console.log(`${out}: ${data.apps.length} applications, ${data.themes.join(', ')}`);
