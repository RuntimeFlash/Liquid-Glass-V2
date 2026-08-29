# Liquid Glass v2 for GNOME Shell

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![GNOME Shell](https://img.shields.io/badge/GNOME-49%20%7C%2050-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)

A next-generation GNOME Shell Extension that brings Apple's fluid "Liquid Glass" UI (introduced in iOS / macOS Tahoe) to your Linux desktop with true optical physics, dynamic refraction, and high-performance GPU shaders.

---

## ✨ What's New in Liquid Glass v2

Liquid Glass v2 is a comprehensive overhaul of the extension, featuring massive GPU and rendering pipeline optimizations, a completely reimagined Quick Settings experience, and refined desktop integration.

### ⚡ Massive Performance & GPU Optimizations
- **Ultra-Lightweight Resource Usage**: Engineered for maximum efficiency, consuming **only ~2–3% GPU** and **negligible CPU** even on entry-level / integrated hardware (tested on an Intel Core i3-1005G1 with Intel UHD Graphics).
- **GLSL Early Exit Discard**: The fragment shader now dynamically computes geometry margins and executes an immediate `discard` on pixels outside the glass boundary. This eliminates all heavy math (height gradients, refraction vectors, surface normals, lighting models, and multi-tap texture fetching) for background fragments.
- **Adaptive Texture Sampling & Fast Paths**:
  - **1-Tap Fast Path**: Single texture lookup when refraction displacement is negligible, reducing texture load by up to **90%**.
  - **3-Tap Fast Path**: Evaluates chromatic aberration directly when anti-aliasing feathering is not needed.
  - **RGSS (Rotated Grid Super-Sampling)**: Uses a 4-tap diamond sub-pixel sampling pattern strictly at active boundary zones for crisp, artifact-free anti-aliasing.
- **Render State Caching & Idle Sleep**: Static glass backings automatically detect visual stability and enter idle mode, halting redundant texture redraws during static desktop states.
- **Asynchronous Contrast Sampler**: Background stage luminance sampling is throttled with configurable intervals (100–2000 ms), eliminating main-thread stalls while keeping text contrast razor-sharp.
- **Actor & Memory Leak Prevention**: Streamlined Clutter clone lifecycle management, unpickable input-transparent overlays (`UnpickableActor` / `UnpickableClone`), and clean signal disconnects.

### 🎛️ Complete Quick Settings Overhaul
- **Custom Quick Settings Renderer**: Replaces the standard grid with modular squircle tiles, pill toggles, and integrated full-width brightness and volume sliders.
- **Built-in Interactive Layout Editor**:
  - Direct, launcher-style drag-and-drop tile reordering.
  - Switch individual controls between compact **Circle** and wide **Pill** modes.
  - Dedicated **Hidden controls tray** to stash unused controls.
  - Live draft preview with instant **Cancel**, **Reset to Defaults**, and **Save** directly to GSettings.
- **Interactive Floating Submenus**: Dedicated floating glass sheets for **Wi-Fi**, **Bluetooth**, **Power Modes**, **Caffeine**, and **System Controls** featuring real-time device scanning, spinners, and smooth spring animations.
- **Dual-Layer Backdrop Blur**: A custom GLSL feathered rounded mask shader (`backdropBlur.frag`) combines with GNOME's blur effect to prevent hard rectangular clipping and seamlessly blend frosted menus into any wallpaper.

### 🖥️ Full Desktop Glass Integration
- **Dash to Dock / Ubuntu Dock**: Boundary-aware feathering (`isDock` shader mode) to prevent edge cutoffs, with customizable bottom margins, corner radiuses, and tint colors.
- **Top Panel & Menus**: Native physics-based spring open/close animations, Snell's law refraction, and real-time adaptive text contrast.
- **Notifications**: Frosted liquid glass banners with adaptive text and icon luminosity.
- **On-Screen Display (OSD)**: Glass overlays for volume, brightness, and media status.

---

### Demo
Overview:

![GNOME Desktop Screenshot](demo1.png)

Dash to Dock:

![Dash to Dock Screenshot](demo2.png)

Notifications:

![Notifications Screenshot](demo3.png)

Panel Menus:

![Panel Menu Screenshot](demo4.png)

Quick Settings (v2):

![Quick Settings Screenshot](demo5.png)

OSD:

![OSD Screenshot](demo6.png)

---

## 📦 Installation

### Option 1: Quick Install (Terminal)
Clone and copy directly into your GNOME extensions directory:

```bash
git clone https://github.com/RuntimeFlash/Liquid-Glass-V2.git && \
mkdir -p ~/.local/share/gnome-shell/extensions/ && \
cp -r Liquid-Glass-V2/liquid-glass-v2@thinkingcoding1231.gmail.com ~/.local/share/gnome-shell/extensions/
```

### Option 2: Build from Source (TypeScript)
If you are developing or compiling from source:

```bash
git clone https://github.com/RuntimeFlash/Liquid-Glass-V2.git
cd Liquid-Glass-V2/liquid-glass-v2@thinkingcoding1231.gmail.com
npm install
npm run build
mkdir -p ~/.local/share/gnome-shell/extensions/
cp -r . ~/.local/share/gnome-shell/extensions/liquid-glass-v2@thinkingcoding1231.gmail.com
```

### Step 3: Restart & Enable
1. **Restart GNOME Shell**:
   - **Wayland**: Log out and log back in.
   - **X11**: Press `Alt` + `F2`, type `r`, and press `Enter`.
2. **Enable the Extension**:
   - Open the **Extensions** app or **Extension Manager** and toggle **Liquid Glass v2** on.

---

## 🔬 Under the Hood: Shader Processing & Optical Effects

Liquid Glass is not a simple static blur overlay. It utilizes a custom `Clutter.ShaderEffect` executing physics-based optical algorithms in GLSL:

- **Refraction via Snell's Law**: Accurately computes light bending through virtual glass using the Index of Refraction (IOR). It projects the refracted view ray onto the background plane to produce realistic spatial distortion.
- **Superellipse Volume Profiling**: Computes interior geometry depth using superellipse cross-section equations, generating organic curvature and natural height falloffs along edges.
- **Physical Lighting Model**: Evaluates true 3D surface normals to simulate directional rim highlights, fresnel edge falloff, specular highlights, and surface sheen.
- **Rotated Grid Super-Sampling (RGSS)**: Sub-pixel 4-tap diamond multi-sampling along high-contrast distortion edges prevents jagged aliasing artifacts.
- **Physics-Based Spring Engine**: Custom spring dynamics for menu opening/closing with configurable stiffness, damping, and mass.
- **Adaptive Text Contrast**: Real-time background luminance sampling adjusts foreground typography and icon colors for optimal legibility.

---

## ⚙️ Customization & Preferences

Liquid Glass v2 includes a comprehensive Libadwaita / GTK4 settings panel accessible via the extension preferences:

- **Dock**: Toggle effect, expand padding, bottom margin, blur radius, corner radius, and custom tint color/strength.
- **Menu & Popups**: Spring stiffness/damping/mass, animation intervals, glass expansion, offsets, adaptive text color, tint, and blur.
- **Notifications & OSD**: Dedicated glass, tint, and blur controls.
- **Quick Settings**: Animation settings, custom layout persistence, adaptive contrast, and blur configuration.
- **Advanced Glass Optics**:
  - **Physical**: Maximum Z Depth, Displacement Scale, Edge Smoothing, Profile Shape $N$, Index of Refraction (IOR), Chromatic Aberration strength.
  - **Lighting**: Specular Intensity, Shininess, Rim Width, Rim Intensity, Rim Fresnel Power, Light Angle, and Sheen Intensity.

---

## 🧪 WebGL / Three.js Prototype (The Lab)

Before implementing the shaders in GJS/Clutter, the core optics and math were prototyped in WebGL with Three.js.

![Three.js Prototype Preview](image.png)

You can run the web prototype locally:
```bash
cd prototypes/sandbox-threejs
npm install
npm run dev
```

---

## 🗺️ Roadmap
- [x] Perfect the WebGL/Three.js Prototype
- [x] Port GLSL shaders to GNOME Shell (`Clutter.ShaderEffect` / GJS)
- [x] Apply Liquid Glass to Top Panel Menus
- [x] Add Dash to Dock support with boundary-safe feathering
- [x] Add Notifications support
- [x] Comprehensive Libadwaita Settings UI
- [x] Real-time Adaptive Text Contrast
- [x] Complete Quick Settings Redesign (Modular Tiles, Layout Editor, Floating Submenus)
- [x] Add OSD Support
- [x] Rotated Grid Super-Sampling (RGSS) Anti-Aliasing
- [x] Shader Early Exit & GPU Fast-Path Optimizations
- [ ] Publish to extensions.gnome.org

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.