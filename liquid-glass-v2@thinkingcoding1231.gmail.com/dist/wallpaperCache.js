// src/wallpaperCache.ts
// Builds a wallpaper-only actor per monitor using GNOME's own BackgroundManager.
//
// The desktop background group (Main.layoutManager._backgroundGroup) is unmapped
// while overview is open, so cloning it (or any actor parented inside it) yields
// an empty clone. BackgroundManager instead owns a self-contained
// Meta.BackgroundActor that keeps painting the wallpaper with no windows, which
// is exactly what the dock needs to composite while in overview.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import { BackgroundManager } from 'resource:///org/gnome/shell/ui/background.js';
export class WallpaperCache {
    static _instance = null;
    static getDefault() {
        if (!WallpaperCache._instance)
            WallpaperCache._instance = new WallpaperCache();
        return WallpaperCache._instance;
    }
    _entries = new Map();
    _initialized = false;
    init() {
        // Idempotent: extension.js and the dock manager may both request init, and
        // the cache also self-initializes on first access (see
        // getWallpaperActorForMonitor).
        if (this._initialized)
            return;
        this._initialized = true;
        this._buildAllMonitors();
    }
    _buildAllMonitors() {
        for (const [, entry] of this._entries) {
            try {
                entry.manager.destroy();
            }
            catch (e) { }
            try {
                entry.actor.destroy();
            }
            catch (e) { }
        }
        this._entries.clear();
        const monitors = Main.layoutManager.monitors || [];
        for (let i = 0; i < monitors.length; i++) {
            const entry = this._buildActorForMonitor(i);
            if (entry)
                this._entries.set(i, entry);
        }
    }
    _buildActorForMonitor(monitorIndex) {
        const monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        if (!monitor)
            return null;
        try {
            const actor = new St.Widget({ name: `liquid-glass-wallpaper-${monitorIndex}` });
            actor.set_size(monitor.width, monitor.height);
            actor.set_position(monitor.x, monitor.y);
            const manager = new BackgroundManager({
                container: actor,
                monitorIndex,
                controlPosition: false,
            });
            // controlPosition is off, so BackgroundManager leaves the background
            // actor at the container origin; pin it there explicitly.
            try {
                manager.backgroundActor.set_position(0, 0);
            }
            catch (e) { }
            return { actor, manager };
        }
        catch (e) {
            console.log(`[Liquid Glass] WallpaperCache: monitor ${monitorIndex} build failed: ${e}`);
            return null;
        }
    }
    getWallpaperActorForMonitor(monitorIndex) {
        // Self-initialize on first use so the cache works even if the extension
        // entry point never called init().
        if (!this._initialized) {
            try {
                this.init();
            }
            catch (e) {
                console.log(`[Liquid Glass] WallpaperCache: lazy init failed: ${e}`);
            }
        }
        const entry = this._entries.get(monitorIndex)
            ?? this._entries.get(Main.layoutManager.primaryIndex ?? 0)
            ?? this._entries.values().next().value;
        return entry ? entry.actor : null;
    }
    destroy() {
        for (const [, entry] of this._entries) {
            try {
                entry.manager.destroy();
            }
            catch (e) { }
            try {
                entry.actor.destroy();
            }
            catch (e) { }
        }
        this._entries.clear();
        this._initialized = false;
    }
}
