// src/wallpaperCache.ts
// Extracts wall paper from the empty workspace (last workspace) at startup
// and exposes a per-monitor static wallpaper actor for the dock's overview mode.
// The dock will composite this static wallpaper (with its normal blur + shader)
// instead of cloning Main.layoutManager._backgroundGroup (which dims/moves in overview)
// and avoids 60Hz window polling while overview is visible.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
export class WallpaperCache {
    static _instance = null;
    static getDefault() {
        if (!WallpaperCache._instance)
            WallpaperCache._instance = new WallpaperCache();
        return WallpaperCache._instance;
    }
    _wallpaperActors = new Map();
    _settings = null;
    _interfaceSettings = null;
    _settingsIds = [];
    _emptyWorkspaceIndex = -1;
    _initialized = false;
    init() {
        // Idempotent: extension.js and the dock manager may both request init, and
        // the cache also self-initializes on first access (see getWallpaperActorForMonitor).
        if (this._initialized)
            return;
        this._initialized = true;
        this._wallpaperActors.clear();
        this._emptyWorkspaceIndex = this._findEmptyWorkspaceIndex();
        console.log(`[Liquid Glass] WallpaperCache: empty workspace index = ${this._emptyWorkspaceIndex}`);
        try {
            this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        }
        catch (e) {
            console.log(`[Liquid Glass] WallpaperCache: Gio.Settings init failed: ${e}`);
        }
        this._buildAllMonitors();
        // Refresh if user changes wallpaper or toggles dark mode (no polling)
        if (this._settings) {
            for (const key of ['picture-uri', 'picture-uri-dark', 'primary-color', 'color-shading-type', 'picture-options']) {
                try {
                    const id = this._settings.connect(`changed::${key}`, () => {
                        console.log(`[Liquid Glass] WallpaperCache: background ${key} changed, rebuilding`);
                        this._buildAllMonitors();
                    });
                    this._settingsIds.push(id);
                }
                catch (e) { }
            }
        }
        if (this._interfaceSettings) {
            try {
                const id = this._interfaceSettings.connect('changed::color-scheme', () => {
                    console.log(`[Liquid Glass] WallpaperCache: color-scheme changed, rebuilding`);
                    this._buildAllMonitors();
                });
                this._settingsIds.push(id);
            }
            catch (e) { }
        }
    }
    _findEmptyWorkspaceIndex() {
        try {
            const wm = global.workspace_manager;
            const n = wm.n_workspaces;
            if (n <= 0)
                return -1;
            // Last workspace is conventionally the empty one; verify
            for (let i = n - 1; i >= 0; i--) {
                const ws = wm.get_workspace_by_index(i);
                if (!ws)
                    continue;
                // Meta.Workspace.list_windows() is not available, use get_window_actors filtered
                // or Meta.Workspace.list_windows() if present (GNOME 49/50)
                let wins = [];
                try {
                    if (ws.list_windows)
                        wins = ws.list_windows();
                    else
                        wins = global.get_window_actors().filter((a) => {
                            try {
                                return a.get_meta_window()?.get_workspace() === ws;
                            }
                            catch (e) {
                                return false;
                            }
                        });
                }
                catch (e) { }
                if (wins.length === 0)
                    return i;
            }
            return n - 1;
        }
        catch (e) {
            console.log(`[Liquid Glass] WallpaperCache: _findEmptyWorkspaceIndex failed: ${e}`);
            return -1;
        }
    }
    _buildAllMonitors() {
        // Clean previous actors
        for (const [, actor] of this._wallpaperActors) {
            try {
                actor.destroy();
            }
            catch (e) { }
        }
        this._wallpaperActors.clear();
        const monitors = Main.layoutManager.monitors || [];
        for (let i = 0; i < monitors.length; i++) {
            const actor = this._buildActorForMonitor(i);
            if (actor)
                this._wallpaperActors.set(i, actor);
        }
        // Ensure at least primary monitor has an actor (fallback)
        if (this._wallpaperActors.size === 0) {
            const fallback = this._buildFallbackActor();
            if (fallback)
                this._wallpaperActors.set(Main.layoutManager.primaryIndex ?? 0, fallback);
        }
    }
    _buildActorForMonitor(monitorIndex) {
        const monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        if (!monitor)
            return null;
        // Strategy 1: try Shell's own BackgroundManager (handles dark/light, slideshow, per-monitor)
        let filePath = this._resolveViaBackgroundManager(monitorIndex);
        // Strategy 2: GSettings picture-uri / picture-uri-dark with color-scheme awareness
        if (!filePath)
            filePath = this._resolveViaGSettings();
        if (filePath) {
            const actor = this._actorFromFile(filePath, monitor);
            if (actor) {
                console.log(`[Liquid Glass] WallpaperCache: monitor ${monitorIndex} file=${filePath}`);
                return actor;
            }
            console.log(`[Liquid Glass] WallpaperCache: _actorFromFile failed for monitor ${monitorIndex} path=${filePath}, trying next fallback`);
        }
        // Strategy 3: live BackgroundGroup clone (wallpaper-only, paints fine as source is on-stage)
        const bgActor = this._cloneBackgroundGroupForMonitor(monitorIndex, monitor);
        if (bgActor) {
            console.log(`[Liquid Glass] WallpaperCache: monitor ${monitorIndex} using BackgroundGroup clone fallback`);
            return bgActor;
        }
        // Strategy 4: solid primary-color (e.g. picture-uri is color:// or none)
        const solid = this._buildSolidColorActor(monitor);
        if (solid) {
            console.log(`[Liquid Glass] WallpaperCache: monitor ${monitorIndex} using solid color fallback`);
            return solid;
        }
        return null;
    }
    // Extracts a filesystem path from a Shell.Background / Meta.Background-like
    // object. Shell.Background (GNOME 50) stores the resolved Gio.File in `_file`,
    // which already accounts for light/dark, slideshow and GSettings quoting.
    _fileFromBackgroundObject(bg) {
        if (!bg)
            return null;
        const toPath = (v) => {
            if (!v)
                return null;
            if (typeof v === 'string')
                return v.length > 0 ? v : null;
            try {
                if (typeof v.get_path === 'function') {
                    const p = v.get_path();
                    if (p)
                        return p;
                }
            }
            catch (e) { }
            try {
                if (typeof v.get_uri === 'function') {
                    const uri = v.get_uri();
                    if (uri)
                        return Gio.File.new_for_uri(uri).get_path();
                }
            }
            catch (e) { }
            return null;
        };
        const normalize = (s) => {
            if (!s)
                return null;
            if (s.endsWith('.xml'))
                return this._firstImageFromSlideshow(s);
            return s;
        };
        // Direct value properties (Gio.File objects first, then plain strings).
        for (const prop of ['_file', 'file', 'filename', '_filename', 'imageFile', '_imageFile']) {
            const p = normalize(toPath(bg[prop]));
            if (p)
                return p;
        }
        // Getter methods on some Shell/Meta versions.
        for (const fn of ['get_file', 'get_filename', 'getFile', '_getFilename']) {
            if (typeof bg[fn] === 'function') {
                try {
                    const p = normalize(toPath(bg[fn]()));
                    if (p)
                        return p;
                }
                catch (e) { }
            }
        }
        return null;
    }
    _resolveViaBackgroundManager(monitorIndex) {
        try {
            const lm = Main.layoutManager;
            // GNOME 49/50 exposes _bgManagers (BackgroundManager instances)
            const managers = lm._bgManagers || lm._backgroundManagers || null;
            if (Array.isArray(managers)) {
                const m = managers[monitorIndex] || managers[0];
                if (m) {
                    // Preferred: the exact Shell.Background the compositor is painting.
                    // BackgroundManager.backgroundActor.content.background.
                    const actor = m.backgroundActor || m._backgroundActor || null;
                    const contentBg = actor?.content?.background
                        || actor?._content?.background
                        || null;
                    const fromContent = this._fileFromBackgroundObject(contentBg);
                    if (fromContent)
                        return fromContent;
                    // Fallbacks for other private layouts.
                    const bg = m.background || m._background || m._bg || m;
                    const fromManager = this._fileFromBackgroundObject(bg);
                    if (fromManager)
                        return fromManager;
                }
            }
            // Also try _backgroundGroup children (Meta.BackgroundActor)
            const bgGroup = lm._backgroundGroup;
            if (bgGroup && typeof bgGroup.get_children === 'function') {
                const children = bgGroup.get_children();
                const actor = children[monitorIndex] || children[0];
                if (actor && actor.content) {
                    // content is a Meta.BackgroundContent: .background is the Shell.Background
                    const content = actor.content;
                    const fromContent = this._fileFromBackgroundObject(content.background);
                    if (fromContent)
                        return fromContent;
                    const fromContentItself = this._fileFromBackgroundObject(content);
                    if (fromContentItself)
                        return fromContentItself;
                }
            }
        }
        catch (e) {
            console.log(`[Liquid Glass] WallpaperCache: BackgroundManager resolve failed: ${e}`);
        }
        return null;
    }
    _resolveViaGSettings() {
        if (!this._settings)
            return null;
        try {
            let isDark = false;
            try {
                const cs = this._interfaceSettings?.get_string('color-scheme') || '';
                // GNOME 42+ color-scheme: 'default' | 'prefer-dark' (also style variants)
                isDark = cs.includes('prefer-dark') || cs.includes('dark');
            }
            catch (e) { }
            const uriDark = this._settings.get_string('picture-uri-dark');
            const uriLight = this._settings.get_string('picture-uri');
            let uri = (isDark && uriDark && uriDark.length > 2) ? uriDark : uriLight;
            if (!uri || uri.length < 2)
                return null;
            // strip quotes that gsettings sometimes returns (handled by Gio.Settings already, but be safe)
            if ((uri.startsWith("'") && uri.endsWith("'")) || (uri.startsWith('"') && uri.endsWith('"'))) {
                uri = uri.slice(1, -1);
            }
            if (uri.startsWith('file://')) {
                const path = Gio.File.new_for_uri(uri).get_path();
                if (path && path.endsWith('.xml'))
                    return this._firstImageFromSlideshow(path);
                return path;
            }
            // Not a file (e.g. color:// or none)
            if (uri.startsWith('xml:') || uri.endsWith('.xml')) {
                const p = uri.replace('file://', '');
                return this._firstImageFromSlideshow(p);
            }
            return null;
        }
        catch (e) {
            console.log(`[Liquid Glass] WallpaperCache: GSettings resolve failed: ${e}`);
            return null;
        }
    }
    _firstImageFromSlideshow(xmlPath) {
        try {
            const file = Gio.File.new_for_path(xmlPath);
            if (!file.query_exists(null))
                return null;
            const [ok, bytes] = file.load_contents(null);
            if (!ok || !bytes)
                return null;
            const text = new TextDecoder().decode(bytes);
            // Very small XML parse: find first <static> or <file> or <path>
            const m = text.match(/<(?:static|file|path)>([^<]+\.(?:jpg|jpeg|png|webp|bmp))<\/(?:static|file|path)>/i)
                || text.match(/<(?:filename)>([^<]+)<\/filename>/i);
            if (m && m[1]) {
                const p = m[1].trim();
                if (p.startsWith('file://'))
                    return Gio.File.new_for_uri(p).get_path();
                if (p.startsWith('/'))
                    return p;
                // relative to xml dir
                const dir = GLib.path_get_dirname(xmlPath);
                return GLib.build_filenamev([dir, p]);
            }
        }
        catch (e) { }
        return null;
    }
    _actorFromFile(filePath, monitor) {
        try {
            const file = Gio.File.new_for_path(filePath);
            if (!file.query_exists(null)) {
                console.log(`[Liquid Glass] WallpaperCache: file not found ${filePath}`);
                return null;
            }
            // Texture-backed actor via GdkPixbuf + Clutter.Image — paints offstage so
            // Clutter.Clone source works without staging/ensure_style. HiDPI-correct:
            // load at monitor.width*scale pixels, display at logical size.
            let scaleFactor = 1;
            try {
                const themeCtx = St.ThemeContext.get_for_stage(global.stage);
                scaleFactor = themeCtx?.scale_factor ?? 1;
                if (!Number.isFinite(scaleFactor) || scaleFactor < 1)
                    scaleFactor = 1;
            }
            catch (e) { }
            const targetW = Math.max(1, Math.floor(monitor.width * scaleFactor));
            const targetH = Math.max(1, Math.floor(monitor.height * scaleFactor));
            // Load scale-to-cover and center-crop so the cached wallpaper matches the
            // compositor's default "zoom" picture-options. Intrinsic size is queried
            // without decoding pixels, keeping memory bounded for 4K/8K wallpapers.
            let pixbuf = null;
            try {
                const info = GdkPixbuf.Pixbuf.get_file_info(filePath);
                const origW = info?.[1] ?? 0;
                const origH = info?.[2] ?? 0;
                if (origW > 0 && origH > 0) {
                    const coverScale = Math.max(targetW / origW, targetH / origH);
                    const scaledW = Math.max(1, Math.ceil(origW * coverScale));
                    const scaledH = Math.max(1, Math.ceil(origH * coverScale));
                    const scaled = GdkPixbuf.Pixbuf.new_from_file_at_scale(filePath, scaledW, scaledH, false);
                    const offX = Math.max(0, Math.floor((scaledW - targetW) / 2));
                    const offY = Math.max(0, Math.floor((scaledH - targetH) / 2));
                    if (offX > 0 || offY > 0) {
                        const cropW = Math.min(targetW, scaled.get_width() - offX);
                        const cropH = Math.min(targetH, scaled.get_height() - offY);
                        pixbuf = scaled.new_subpixbuf(offX, offY, cropW, cropH);
                    }
                    else {
                        pixbuf = scaled;
                    }
                }
            }
            catch (e) { }
            if (!pixbuf) {
                try {
                    pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(filePath, targetW, targetH, false);
                }
                catch (e) {
                    // Fallback: load without scale (e.g. for very large images)
                    try {
                        pixbuf = GdkPixbuf.Pixbuf.new_from_file(filePath);
                    }
                    catch (e2) {
                        console.log(`[Liquid Glass] WallpaperCache: pixbuf load failed for ${filePath}: ${e2}`);
                        return null;
                    }
                }
            }
            const w = pixbuf.get_width();
            const h = pixbuf.get_height();
            const rowstride = pixbuf.get_rowstride();
            const hasAlpha = pixbuf.get_has_alpha();
            const nChannels = pixbuf.get_n_channels();
            const pixels = pixbuf.get_pixels();
            // GdkPixbuf is 8-bit per channel. Pick the matching Cogl format.
            let format = Cogl.PixelFormat.RGB_888;
            if (hasAlpha && nChannels === 4)
                format = Cogl.PixelFormat.RGBA_8888;
            else if (!hasAlpha && nChannels === 3)
                format = Cogl.PixelFormat.RGB_888;
            const image = new Clutter.Image();
            image.set_data(pixels, format, w, h, rowstride);
            const actor = new Clutter.Actor({
                content: image,
                content_gravity: Clutter.ContentGravity.CENTER,
            });
            actor.set_size(monitor.width, monitor.height);
            actor.set_position(monitor.x, monitor.y);
            actor.set_content_box?.(new Clutter.ActorBox({ x1: 0, y1: 0, x2: monitor.width, y2: monitor.height }));
            // Keep content scaled to actor (cover): content_gravity CENTER + scale handles it.
            // For exact cover behavior we let the image fill via content_box; HiDPI handled by pixbuf scale above.
            return actor;
        }
        catch (e) {
            console.log(`[Liquid Glass] WallpaperCache: actorFromFile failed for ${filePath}: ${e}`);
            return null;
        }
    }
    _buildSolidColorActor(monitor) {
        try {
            const settings = this._settings ?? new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            const hex = (settings.get_string('primary-color') || '#0a0a0a').trim();
            // Parse #RRGGBB or #RGB
            let r = 10, g = 10, b = 10;
            if (hex.startsWith('#')) {
                const h = hex.slice(1);
                if (h.length === 6) {
                    r = parseInt(h.slice(0, 2), 16);
                    g = parseInt(h.slice(2, 4), 16);
                    b = parseInt(h.slice(4, 6), 16);
                }
                else if (h.length === 3) {
                    r = parseInt(h[0] + h[0], 16);
                    g = parseInt(h[1] + h[1], 16);
                    b = parseInt(h[2] + h[2], 16);
                }
            }
            const color = new Clutter.Color({ red: r, green: g, blue: b, alpha: 255 });
            const actor = new Clutter.Actor({ background_color: color });
            actor.set_size(monitor.width, monitor.height);
            actor.set_position(monitor.x, monitor.y);
            return actor;
        }
        catch (e) {
            console.log(`[Liquid Glass] WallpaperCache: solid color fallback failed: ${e}`);
            return null;
        }
    }
    _cloneBackgroundGroupForMonitor(monitorIndex, monitor) {
        try {
            const bgGroup = Main.layoutManager._backgroundGroup;
            if (!bgGroup || typeof bgGroup.get_children !== 'function')
                return null;
            const children = bgGroup.get_children();
            const source = children[monitorIndex] || children[0] || bgGroup;
            if (!source)
                return null;
            // Create a container sized to monitor that holds a scaled clone.
            // For fallback we just clone the source actor directly; dock's _syncGeometry
            // will position it correctly. Caller will clone this again for FBO.
            const container = new St.Widget({ clip_to_allocation: false });
            container.set_size(monitor.width, monitor.height);
            container.set_position(monitor.x, monitor.y);
            // Use UnpickableClone via direct Clutter.Clone to avoid import cycle
            const clone = new Clutter.Clone({ source });
            // Fit clone to monitor
            clone.set_size(monitor.width, monitor.height);
            clone.set_position(0, 0);
            container.add_child(clone);
            return container;
        }
        catch (e) {
            console.log(`[Liquid Glass] WallpaperCache: _cloneBackgroundGroupForMonitor failed: ${e}`);
            return null;
        }
    }
    _buildFallbackActor() {
        try {
            const monitor = Main.layoutManager.primaryMonitor;
            if (!monitor)
                return null;
            const bgGroup = Main.layoutManager._backgroundGroup;
            if (bgGroup) {
                const clone = new Clutter.Clone({ source: bgGroup });
                const container = new St.Widget();
                container.set_size(monitor.width, monitor.height);
                container.add_child(clone);
                return container;
            }
        }
        catch (e) { }
        return null;
    }
    getWallpaperActorForMonitor(monitorIndex) {
        // Self-initialize on first use so the cache works even if the extension
        // entry point never called init() (e.g. an older cached extension.js).
        if (!this._initialized) {
            try {
                this.init();
            }
            catch (e) {
                console.log(`[Liquid Glass] WallpaperCache: lazy init failed: ${e}`);
            }
        }
        if (this._wallpaperActors.has(monitorIndex))
            return this._wallpaperActors.get(monitorIndex);
        if (this._wallpaperActors.has(Main.layoutManager.primaryIndex))
            return this._wallpaperActors.get(Main.layoutManager.primaryIndex);
        // fallback to any
        for (const [, a] of this._wallpaperActors)
            return a;
        return null;
    }
    // For dockManager's overview mode: expose empty workspace index for diagnostics
    getEmptyWorkspaceIndex() {
        return this._emptyWorkspaceIndex;
    }
    destroy() {
        for (const id of this._settingsIds) {
            try {
                this._settings?.disconnect(id);
                this._interfaceSettings?.disconnect(id);
            }
            catch (e) { }
        }
        this._settingsIds = [];
        for (const [, actor] of this._wallpaperActors) {
            try {
                actor.destroy();
            }
            catch (e) { }
        }
        this._wallpaperActors.clear();
        this._settings = null;
        this._interfaceSettings = null;
        this._initialized = false;
    }
}
