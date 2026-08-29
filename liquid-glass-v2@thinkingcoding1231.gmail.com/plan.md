## Goal Description
The current implementation has several visual bugs due to the difference between the website's WebGL environment and GNOME Shell's rendering environment. 
1. **Lighting Artifacts:** GNOME's Y-axis is inverted compared to standard WebGL. This caused the specular lighting (the shiny reflections) to appear on the bottom of elements instead of the top, creating ugly "ridges" on the Quick Settings buttons.
2. **Overblown Refraction:** The website's presets (`refraction: 1.2`, `zRadius: 60`) look great on massive 800px banners, but when applied to small 40px GNOME menus, they severely scramble and distort the background (making text unreadable on the OSD, and overly refracting the clock menu).
3. **Overblown Blur:** A `blurAmount` of 0.3 on the website was translated to a GNOME blur radius of 30, which is extremely strong and makes the glass look completely frosted.

We need to fix the lighting engine in the shader, and then apply carefully scaled-down, permanent overrides for each specific UI element so they look exactly like the website but mathematically proportioned for GNOME.

## User Review Required
> [!IMPORTANT]
> To make these settings permanent and immune to whatever sliders were previously tweaked, I will **hardcode** the perfect glass parameters for each specific UI element directly into the Typescript code. 
> This means the Clock Menu, OSD, Dock, and Quick Settings will have their distinct, flawless looks permanently locked in, and the global sliders in the extension settings won't accidentally break them anymore.

## Proposed Changes

---
### Shader Lighting Fix (`shaders/glass.frag`)
[MODIFY] `shaders/glass.frag`
I will invert the Y-axis of the 4 light sources and the environment reflection normal to match GNOME's coordinate system. This will move the specular highlight to the top edge and fix the dark/bright "crease" artifacts on the buttons.

```diff
-    vec3 L1 = normalize(vec3(0.4, 0.7, 1.0));
+    vec3 L1 = normalize(vec3(0.4, -0.7, 1.0));
-    vec3 L2 = normalize(vec3(-0.3, -0.5, 1.0));
+    vec3 L2 = normalize(vec3(-0.3, 0.5, 1.0));
-    vec3 L3 = normalize(vec3(0.1, 0.3, 1.0));
+    vec3 L3 = normalize(vec3(0.1, -0.3, 1.0));
-    vec3 L4 = normalize(vec3(0.0, 0.9, 0.4));
+    vec3 L4 = normalize(vec3(0.0, -0.9, 0.4));
-    float envRefl = (N.y * 0.5 + 0.5) * fres * 0.08;
+    float envRefl = (-N.y * 0.5 + 0.5) * fres * 0.08;
```

---
### Permanent Element Overrides

#### [MODIFY] `src/uiManager.ts` (Clock Menu)
I will reduce the `blurRadius` from 30 down to 8 (a subtle, premium blur) and lower the refraction to 0.4 so it bends light beautifully without scrambling the background.

#### [MODIFY] `src/osdManager.ts` (OSD Menu)
I will fix the chromatic aberration by lowering `chroma_strength` to `0.01` and `refract_amount` to `0.15`. This will keep the glass pure and clear (Regular Glass) without distorting the text underneath.

#### [MODIFY] `src/quickSettingsManager.ts` (Quick Settings)
I will leave the Dark Glass background intact but fix the individual buttons (cards). I will lower their `z_radius` to `5.0` (so they look like flat buttons with a bevel, rather than steep rounded pills) and set their refraction very low to prevent the horizontal artifacts.

## Verification Plan
### Automated Tests
Run `npm run build` to ensure the TypeScript compiles with the new permanent overrides.

### Manual Verification
1. Restart GNOME Shell.
2. Open Quick Settings: Verify the buttons no longer have weird horizontal creases (thanks to the lighting fix and lower `z_radius`).
3. Open Clock Menu: Verify it is no longer heavily frosted, but looks like premium, clear refractive glass.
4. Trigger Volume OSD: Verify the background text is readable and not ruined by chromatic aberration.
