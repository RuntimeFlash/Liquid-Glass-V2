// scripts/stamp-modules.mjs
//
// GNOME Shell loads an extension's entry point with `import(path)` and caches it
// by resolved URL. Disabling and re-enabling an extension re-runs the entry
// point, but every *relative* import inside it resolves to the same URL as
// before and is therefore served from the module cache. The practical effect is
// that editing any module other than extension.js silently does nothing on
// reload, which is why this project's entry point already imports its top-level
// modules with a `?v=<timestamp>` query.
//
// This step extends that to the nested imports: after `tsc`, relative import
// specifiers in dist/*.js are given the same build stamp, so a reload after a
// rebuild picks up the new code everywhere without a shell restart.
//
// One class of module must be excluded. Anything that registers a GObject type
// (GObject.registerClass with a fixed GTypeName) can only exist once per shell
// process: a second module instance re-registers the same type name and throws
// "Type name ... is already registered", which aborts the extension's enable().
// Those modules keep their single, unstamped URL -- and yes, that means edits to
// them still need a shell restart to take effect.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const stamp = Date.now().toString(36);

const jsFiles = readdirSync(distDir).filter((name) => name.endsWith('.js'));

// Single-instance modules: those that register a GType.
const singletons = new Set();
for (const name of jsFiles) {
  const source = readFileSync(join(distDir, name), 'utf8');
  if (source.includes('GTypeName'))
    singletons.add(name);
}

const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+\.js)\2/g;

let files = 0;
let rewrites = 0;
let skipped = 0;

for (const name of jsFiles) {
  const path = join(distDir, name);
  const source = readFileSync(path, 'utf8');
  const stamped = source.replace(RELATIVE_IMPORT, (match, prefix, quote, specifier) => {
    const target = specifier.slice(specifier.lastIndexOf('/') + 1);
    if (singletons.has(target)) {
      skipped++;
      return match;
    }
    rewrites++;
    return `${prefix}${quote}${specifier}?v=${stamp}${quote}`;
  });

  if (stamped !== source)
    writeFileSync(path, stamped);
  files++;
}

const kept = singletons.size
  ? `; left ${skipped} import(s) to single-instance module(s): ${[...singletons].join(', ')}`
  : '';
console.log(`[stamp-modules] stamped ${rewrites} import(s) across ${files} file(s) with v=${stamp}${kept}`);
