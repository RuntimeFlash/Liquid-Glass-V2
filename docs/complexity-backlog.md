# Complexity backlog

SonarJS (`eslint-plugin-sonarjs` 4.2.1, `recommended`) no longer reports any function over the cognitive-complexity limit of 15 in `src/`, `extension.js`, `prefs.js` or `preferences/`. What is left is listed below.

## Rules for this work

- Do not change behaviour. Refactor one thing per commit, and build and run the tests after each one.
- Do not add comments to code.
- Keep `!(x > 0)`-style guards as they are. They are deliberate NaN/undefined guards, and Sonar's `no-inverted-boolean-check` suggestion (`x <= 0`) changes behaviour. All 35 remaining reports of that rule are this pattern.
- The statics in `GlassGeometry` are intentionally mutable (tuned through setters on `LiquidEffect`), so the 8 `public-static-readonly` reports stay.
- Where you can, extract pure helpers and add a test that compares the new helper with a copy of the old inline code (see `tests/menu-spring.test.cjs`). For code with no test harness, compare the output of the previous `dist/` (it is committed) with the new one on the same fake inputs.
- Changes only take effect after a full GNOME session restart. Copy `dist/` to `~/.local/share/gnome-shell/extensions/liquid-glass@thinkingcoding1231.gmail.com/` and restart once, after a whole batch of changes.

## Commands

```sh
cd liquid-glass@thinkingcoding1231.gmail.com && npm run build
cd .. && node --test tests/
```

SonarJS is not a project dependency. To run it without touching the repo, install `eslint@9 eslint-plugin-sonarjs typescript-eslint` in a scratch directory. Then point a flat config at `src/**/*.ts`, `extension.js` and `prefs.js`, and run ESLint from the extension directory with `--no-config-lookup -c <config>`.

## Open items

- **Per-frame allocations: measure before changing anything.** The splits added two small result objects per paint of each glass (`PaintCapture` and the `_blurReuse` result) and a few tuples per animation tick in the menu and quick-settings geometry helpers. Every Clutter/Cogl call on the same path (`get_transformed_position`, `get_size`, `get_scale`, texture getters) already returns fresh JS arrays or wrappers, so the added share is small. Reusing scratch objects is only worth its complexity if a live session shows GC pauses: compare `gjs` GC activity (`GJS_DEBUG_TOPICS=JS GC`) and frame times with menus animating over a video, before and after.
- **Order of `refresh()` and `syncGlassCaptureClip()`.** The menu refreshes the UI sampler before syncing the capture clip; quick settings does it after. The shared helpers keep each order as it was. Check on a live session whether the menu's order culls a clone one frame late before unifying them.

- **Remaining copies of shared helpers.** `NotificationManager._syncGeometry` and `OsdManager._syncGeometry` still inline the placement/clip sequence from `actors/glassBounds.ts`. `UIManager._addMeasureLater`, `_queueBackdropRefresh` (menu and quick settings) and `ApplicationManager._startFrameSync` re-implement `animation/frameLoops.ts`. `capture/glassExclusions.ts` duplicates the detector in `UILayerSampler._containsOtherLiquidGlassRoot`.
- **Frame loop ownership.** Managers pass `_frameSlot`/`_frameSignalSlot` getters and `this as any` origin memory into the shared helpers. A small loop object owned by each manager, and a typed origin field, would remove the adapters and the casts.

Done since the previous version of this list: the frame-sync loops and the glass exclusion scan are shared (`animation/frameLoops.ts`, `capture/glassExclusions.ts`), the bounds, origin and corner-scale helpers are shared (`actors/glassBounds.ts`), the quick-settings bounds cache is kept per coordinate space, the unused position spring is gone, and `showWindows` in `preferences/windows.js` is split into row builders.

## Other reports left on purpose

- `bitwise-operators` in `LiquidEffect.vfunc_paint`: `flags & ACTOR_DIRTY` is a bit test, not a typo.
- `no-invariant-returns` in `ApplicationManager._forceGlassReallocation`: a one-shot `later` callback always returns `false`.
- `no-nested-template-literals` in `src/applicationManager.ts`: diagnostic string only.
