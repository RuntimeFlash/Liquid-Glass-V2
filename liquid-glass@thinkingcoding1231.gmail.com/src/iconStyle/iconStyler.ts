// Redraws application icons in the dock (Dash to Dock or Dhruva), the launcher and the
// overview's app grid as glass plates under a symbol (see iconEffect.ts), for
// the applications the settings pick. Clear icons read what is behind them
// from one backdrop per actor that holds them (IconBackdrop in iconEffect.ts).
import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import type { Logger } from '../logger.js';
import { hexToColorArray } from '../animation/colors.js';
import { accentColors, watchAccentColor } from '../shellVersion.js';
import { IconBackdrop, IconStyleEffect, type IconStyleTextures, iconStylePipeline, iconStyleTexture } from './iconEffect.js';
import { iconStyleColors, type IconStyleColors, type IconStyleMode } from './styleColors.js';
import { WorkerProcess } from '../workers/workerProcess.js';
import { LENS_SIZE, MAP_SIZE } from './styleMap.js';

export type IconSurface = 'dock' | 'launcher' | 'app-grid';

// The id the Show Apps button goes by in the application lists.
export const SHOW_APPS_ID = 'show-apps';
// Icons are looked up at the size their maps are taken from.
const LOOKUP_SIZE = 128;
const EFFECT_NAME = 'liquid-glass-icon-style';
// After the extension starts or what is styled changes, the icons not in the cache yet are made after this wait,
// so that the session's start is not slowed.
const PREPARE_DELAY_S = 5;
const FALLBACK_ICON = 'application-x-executable';
// How long a clear icons' backdrop is kept once its last icon has gone. Dhruva rebuilds every button whenever an
// indicator changes; a new backdrop would leave the new icons without glass until it has loaded and copied.
const HOST_KEEP_MS = 1000;

// A clear icons' backdrop and the icons that read it.
interface Host {
  backdrop: IconBackdrop;
  icons: Set<St.Icon>;
  destroyId: number;
  dropId: number;
}

// The actor a backdrop goes on for icons in `holder`. One painted into an ancestor's offscreen, which Dash to Dock
// keeps its dash in, cannot read the stage, so it goes above that ancestor. The offscreen keeps what was drawn
// until something in it changes, so `cached` says the icons have to be redrawn whenever the backdrop is copied again.
function backdropHost(holder: Clutter.Actor): { host: Clutter.Actor, cached: boolean } {
  let host = holder, cached = false;
  for (let actor: Clutter.Actor | null = holder; actor; actor = actor.get_parent()) {
    const parent = actor.get_parent();
    if (parent && actor.offscreen_redirect & Clutter.OffscreenRedirect.ALWAYS) {
      host = parent;
      cached = true;
    }
  }
  return { host, cached };
}

interface Styled {
  appId: string;
  surface: IconSurface;
  // The dock or app grid it was found in.
  root: Clutter.Actor | null;
  // The actor painted right over what a clear icon's glass shows: the dock, the app grid, a folder's view or the
  // launcher's panel.
  host: Clutter.Actor | null;
  // The actor its backdrop is on, while it reads one.
  backdropHost: Clutter.Actor | null;
  effect: IconStyleEffect | null;
  // Advanced on every restyle, so that a map that comes late for an older look is dropped.
  serial: number;
  ids: number[];
}

// Keys that decide which icons are styled, and keys that only change how they look.
const KEYS = ['icon-style-dock', 'icon-style-launcher', 'icon-style-app-grid', 'icon-style-all-apps', 'icon-style-whitelist', 'icon-style-blacklist'];
const COLOR_KEYS = ['icon-style-use-accent', 'icon-style-color', 'icon-style-tint-variant',
  'icon-style-tint-strength', 'icon-style-symbol-opacity', 'icon-style-tuning'];

function appIdOf(icon: St.Icon): string | null {
  // The shell's and Dash to Dock's Show Apps buttons, whatever icon they show.
  if (icon.has_style_class_name('show-apps-icon')) return SHOW_APPS_ID;
  for (let actor: Clutter.Actor | null = icon.get_parent(); actor; actor = actor.get_parent()) {
    // Dhruva keeps a button's app on its delegate.
    const app = (actor as any).app ?? (actor as any)._delegate?.app;
    if (app instanceof Shell.App) return app.get_id();
  }
  return folderAppIdOf(icon);
}

// A folder's icon shows its first apps in a grid of bins, one icon each, laid out in the folder's order.
function folderAppIdOf(icon: St.Icon): string | null {
  const bin = icon.get_parent();
  const grid = bin?.get_parent();
  if (!bin || !grid) return null;
  for (let actor = grid.get_parent(); actor; actor = actor.get_parent()) {
    const items = (actor as any).view?._orderedItems;
    if (!Array.isArray(items)) continue;
    const app = items[grid.get_children().indexOf(bin)]?.app;
    return app instanceof Shell.App ? app.get_id() : null;
  }
  return null;
}

export class IconStyler {
  private _maps: IconMaps;
  private _shader: Promise<string>;
  private _shaderSource: string | null = null;
  private _pipeline: Cogl.Pipeline | null = null;
  private _glassPipeline: Cogl.Pipeline | null = null;
  private _hosts = new Map<Clutter.Actor, Host>();
  // The views of the app grid's folders, which their dialogs show over the grid.
  private _folderViews = new WeakSet<Clutter.Actor>();
  private _theme = new St.IconTheme();
  private _styled = new Map<St.Icon, Styled>();
  // Per dock and app grid, the actors in it watched for children, by the handlers on each.
  private _roots = new Map<Clutter.Actor, { surface: IconSurface, watched: Map<Clutter.Actor, number[]> }>();
  private _scanId = 0;
  private _prepareId = 0;
  private _installedId = 0;
  private _notification: MessageTray.Notification | null = null;
  private _settingsIds: number[] = [];
  private _themeId = 0;
  private _unwatchAccent: () => void = () => {};
  private _cancellable = new Gio.Cancellable();

  constructor(private _extensionPath: string, private _settings: Gio.Settings, private _logger: Logger) {
    this._maps = new IconMaps(_extensionPath, _logger, busy => this._notify(busy));
    const file = Gio.File.new_for_path(`${_extensionPath}/shaders/icon-style.frag`);
    this._shader = new Promise((resolve, reject) => {
      file.load_contents_async(this._cancellable, (_f, res) => {
        try {
          resolve(new TextDecoder().decode(file.load_contents_finish(res)[1]));
        } catch (e) {
          reject(e);
        }
      });
    });
    this._shader.then(source => { this._shaderSource = source; }, () => {});
    this._shader.catch(e => {
      if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
        this._logger.error(`[Liquid Glass] Could not read the icon shader: ${e}`);
    });
  }

  setup(): void {
    this._settingsIds = [
      ...KEYS.map(key => this._settings.connect(`changed::${key}`, () => {
        this._restyleAll();
        this._prepareSoon();
      })),
      ...COLOR_KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._recolorAll())),
      this._settings.connect('changed::icon-style-size', () => this._resizeAll()),
      this._settings.connect('changed::icon-style-mode', () => this._restyleAll()),
    ];
    this._themeId = St.TextureCache.get_default().connect('icon-theme-changed', () => {
      this._theme = new St.IconTheme();
      this._restyleAll();
      this._prepareSoon();
    });
    this._installedId = Shell.AppSystem.get_default().connect('installed-changed', () => this._prepareSoon());
    this._unwatchAccent = watchAccentColor(() => this._recolorAll());
    this._watch(Main.overview._overview.controls._appDisplay, 'app-grid');
    this._prepareSoon();
  }

  cleanup(): void {
    this._cancellable.cancel();
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
    if (this._themeId) St.TextureCache.get_default().disconnect(this._themeId);
    this._themeId = 0;
    if (this._installedId) Shell.AppSystem.get_default().disconnect(this._installedId);
    this._installedId = 0;
    if (this._prepareId) GLib.Source.remove(this._prepareId);
    this._prepareId = 0;
    this._notification?.destroy();
    this._notification = null;
    this._unwatchAccent();
    if (this._scanId) global.compositor.get_laters().remove(this._scanId);
    this._scanId = 0;
    for (const root of [...this._roots.keys()]) this.unwatchDock(root);
    for (const icon of [...this._styled.keys()]) this._forget(icon);
    for (const host of [...this._hosts.keys()]) this._dropHost(host);
    this._maps.destroy();
    this._pipeline = null;
    this._glassPipeline = null;
  }

  /** Styles the application icons in a Dash to Dock or Dhruva dock, and those it adds later. */
  watchDock(dock: Clutter.Actor): void {
    this._watch(dock, 'dock');
  }

  unwatchDock(root: Clutter.Actor): void {
    const entry = this._roots.get(root);
    if (!entry) return;
    this._roots.delete(root);
    for (const [actor, ids] of entry.watched) ids.forEach(id => actor.disconnect(id));
    for (const [icon, styled] of [...this._styled]) {
      if (styled.root === root) this._forget(icon);
    }
  }

  private _watch(root: Clutter.Actor, surface: IconSurface): void {
    if (this._roots.has(root)) return;
    this._roots.set(root, { surface, watched: new Map() });
    this._scanSoon();
  }

  /**
   * Styles a launcher result's icon, which goes away with its row; `host` is painted just before the rows, over the
   * glass, and covers them.
   */
  styleLauncherIcon(icon: St.Icon, appId: string, host: Clutter.Actor): void {
    this._style(icon, appId, 'launcher', null, host);
  }

  // Before the next frame, so that icons a dock adds are not drawn as they are first.
  private _scanSoon(): void {
    if (this._scanId) return;
    this._scanId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      this._scanId = 0;
      for (const [root, { surface, watched }] of this._roots) this._scan(root, root, surface, watched);
      return GLib.SOURCE_REMOVE;
    });
  }

  private _scan(actor: Clutter.Actor, root: Clutter.Actor, surface: IconSurface, watched: Map<Clutter.Actor, number[]>): void {
    if (actor instanceof St.Icon) {
      const appId = appIdOf(actor);
      if (appId && !this._styled.has(actor)) this._style(actor, appId, surface, root);
      return;
    }
    if (!watched.has(actor)) {
      watched.set(actor, [
        actor.connect('child-added', () => this._scanSoon()),
        actor.connect('destroy', () => watched.delete(actor)),
      ]);
    }
    for (const child of actor.get_children()) this._scan(child, root, surface, watched);
    // A folder's apps are laid out in a view of their own, which goes into a dialog over the overview once it opens.
    const folder = (actor as any).view;
    if (surface === 'app-grid' && folder instanceof Clutter.Actor) {
      this._folderViews.add(folder);
      this._scan(folder, root, surface, watched);
    }
  }

  private _style(icon: St.Icon, appId: string, surface: IconSurface, root: Clutter.Actor | null = null,
    host: Clutter.Actor | null = root): void {
    if (!this._styled.has(icon)) {
      const restyle = () => this._apply(icon);
      // A folder's icons sit in its dialog, over the grid.
      for (let actor = icon.get_parent(); actor && actor !== root; actor = actor.get_parent()) {
        if (this._folderViews.has(actor)) {
          host = actor;
          break;
        }
      }
      this._styled.set(icon, {
        appId, surface, root, host, backdropHost: null, effect: null, serial: 0,
        ids: [icon.connect('destroy', () => this._dropIcon(icon)), icon.connect('notify::gicon', restyle),
          icon.connect('notify::fallback-gicon', restyle)],
      });
    }
    this._apply(icon);
  }

  private _forget(icon: St.Icon): void {
    const styled = this._styled.get(icon);
    if (!styled) return;
    this._styled.delete(icon);
    styled.ids.forEach(id => icon.disconnect(id));
    this._unstyle(icon, styled);
  }

  private _dropIcon(icon: St.Icon): void {
    const styled = this._styled.get(icon);
    if (!styled) return;
    this._styled.delete(icon);
    this._leaveHost(icon, styled);
  }

  /**
   * Makes the backdrop of the clear icons the launcher is about to show over `host`, so that its shaders are loaded
   * by the first frame they are shown in.
   */
  prepareLauncherHost(host: Clutter.Actor): void {
    if (this._settings.get_boolean('icon-style-launcher') && this._settings.get_string('icon-style-mode') === 'clear')
      this._hostFor(host, 'launcher');
  }

  // The backdrop of `host`'s clear icons, made with its first.
  private _backdropFor(icon: St.Icon, styled: Styled): IconBackdrop | null {
    if (!styled.host) return null;
    const { host, entry } = this._hostFor(styled.host, styled.surface);
    styled.backdropHost = host;
    entry.icons.add(icon);
    return entry.backdrop;
  }

  private _hostFor(holder: Clutter.Actor, surface: IconSurface): { host: Clutter.Actor, entry: Host } {
    const { host, cached } = backdropHost(holder);
    let entry = this._hosts.get(host);
    if (!entry) {
      const icons = new Set<St.Icon>();
      const backdrop = new IconBackdrop({
        extensionPath: this._extensionPath, settings: this._settings, logger: this._logger,
        prefix: surface === 'launcher' ? 'launcher' : 'dock', rect: () => this._extentsOf(icons),
        copied: () => {
          if (cached) for (const icon of icons) icon.queue_redraw();
        },
      } as any);
      backdrop.attach(host);
      entry = { backdrop, icons, destroyId: host.connect('destroy', () => this._dropHost(host)), dropId: 0 };
      this._hosts.set(host, entry);
    }
    return { host, entry };
  }

  private _leaveHost(icon: St.Icon, styled: Styled): void {
    const host = styled.backdropHost;
    styled.backdropHost = null;
    const entry = host ? this._hosts.get(host) : null;
    if (!entry) return;
    entry.icons.delete(icon);
    if (entry.icons.size) return;
    if (entry.dropId) GLib.Source.remove(entry.dropId);
    entry.dropId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOST_KEEP_MS, () => {
      entry.dropId = 0;
      if (!entry.icons.size) this._dropHost(host!);
      return GLib.SOURCE_REMOVE;
    });
  }

  private _dropHost(host: Clutter.Actor): void {
    const entry = this._hosts.get(host);
    if (!entry) return;
    this._hosts.delete(host);
    if (entry.dropId) GLib.Source.remove(entry.dropId);
    host.disconnect(entry.destroyId);
    entry.backdrop.cleanup();
  }

  // The stage rect [x0, y0, x1, y1] the shown icons of a backdrop cover, as drawn (scaled) now.
  private _extentsOf(icons: Set<St.Icon>): number[] | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const icon of icons) {
      if (!icon.mapped) continue;
      const r = icon.get_transformed_extents();
      x0 = Math.min(x0, r.get_x());
      y0 = Math.min(y0, r.get_y());
      x1 = Math.max(x1, r.get_x() + r.get_width());
      y1 = Math.max(y1, r.get_y() + r.get_height());
    }
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
  }

  private _wanted(styled: Styled): boolean {
    return this._settings.get_boolean(`icon-style-${styled.surface}`) && this._wantedApp(styled.appId);
  }

  private _wantedApp(appId: string): boolean {
    const s = this._settings;
    return s.get_boolean('icon-style-all-apps') ? !s.get_strv('icon-style-blacklist').includes(appId)
      : s.get_strv('icon-style-whitelist').includes(appId);
  }

  private _file(icon: St.Icon): string | null {
    const named = (name: string | null) => (name ? new Gio.ThemedIcon({ name }) : null);
    return this._fileOf([icon.gicon ?? named(icon.icon_name), icon.fallback_gicon ?? named(icon.fallback_icon_name)]);
  }

  // The file an icon is drawn from, falling back the way St.Icon does when its own icon is not in the theme.
  private _fileOf(gicons: (Gio.Icon | null)[]): string | null {
    for (const gicon of gicons) {
      if (gicon instanceof Gio.FileIcon) return gicon.get_file().get_path();
      const file = gicon ? this._theme.lookup_by_gicon(gicon, LOOKUP_SIZE, 0)?.get_filename() : null;
      if (file) return file;
    }
    return null;
  }

  private _prepareSoon(): void {
    if (this._prepareId) GLib.Source.remove(this._prepareId);
    this._prepareId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, PREPARE_DELAY_S, () => {
      this._prepareId = 0;
      this._prepare();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Makes the maps of every installed application's icon that will be styled, before any is shown.
  private _prepare(): void {
    const s = this._settings;
    if (!['dock', 'launcher', 'app-grid'].some(surface => s.get_boolean(`icon-style-${surface}`))) {
      this._maps.prepare([]);
      return;
    }
    const fallback = new Gio.ThemedIcon({ name: FALLBACK_ICON });
    const files = Shell.AppSystem.get_default().get_installed()
      .filter(info => info.should_show() && this._wantedApp(info.get_id() ?? ''))
      .map(info => this._fileOf([info.get_icon(), fallback]))
      .filter((file): file is string => !!file);
    this._maps.prepare(files);
  }

  private _notify(busy: boolean): void {
    this._notification?.destroy();
    this._notification = null;
    const notification = new MessageTray.Notification({
      source: MessageTray.getSystemSource(),
      title: busy ? 'Making glass icons' : 'Glass icons are ready',
      body: busy ? 'Liquid Glass is making glass versions of your application icons. They are kept in a cache, so you will not have to wait for them next time.'
        : null,
      isTransient: true,
    });
    if (busy) {
      this._notification = notification;
      notification.connect('destroy', () => {
        if (this._notification === notification) this._notification = null;
      });
    }
    notification.source!.addNotification(notification);
  }

  private _colors(): IconStyleColors {
    const s = this._settings;
    const accent = s.get_boolean('icon-style-use-accent') ? accentColors() : null;
    const tint = accent ? [accent[0].red / 255, accent[0].green / 255, accent[0].blue / 255]
      : hexToColorArray(s.get_string('icon-style-color'));
    const mode = s.get_string('icon-style-mode');
    const variant = s.get_string('icon-style-tint-variant') === 'light' ? 'light' : 'dark';
    const tuning = s.get_value('icon-style-tuning').deep_unpack() as Record<string, number>;
    return iconStyleColors((['mono', 'clear'].includes(mode) ? mode : 'tinted') as IconStyleMode, tint,
      s.get_double('icon-style-tint-strength'), s.get_double('icon-style-symbol-opacity'), variant, tuning);
  }

  private _apply(icon: St.Icon): void {
    const styled = this._styled.get(icon);
    if (!styled) return;
    const serial = ++styled.serial;
    const file = this._wanted(styled) ? this._file(icon) : null;
    if (!file) {
      this._unstyle(icon, styled);
      return;
    }
    // A dock that rebuilds its buttons (Dhruva does whenever an indicator changes) would show each new icon
    // unstyled for a frame if styling waited for the promises, which resolve after the frame is drawn.
    const textures = this._maps.loaded(file);
    if (textures && this._shaderSource) {
      this._applyMaps(icon, styled, textures, this._shaderSource);
      return;
    }
    Promise.all([this._maps.get(file), this._shader]).then(([maps, shader]) => {
      if (this._styled.get(icon) !== styled || styled.serial !== serial) return;
      this._applyMaps(icon, styled, maps, shader);
    }).catch(e => {
      if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
        this._logger.log(`[Liquid Glass] Could not style the icon of ${styled.appId}: ${e}`);
    });
  }

  private _applyMaps(icon: St.Icon, styled: Styled, textures: IconStyleTextures, shader: string): void {
    const clear = this._settings.get_string('icon-style-mode') === 'clear';
    let pipeline: Cogl.Pipeline;
    if (clear) pipeline = this._glassPipeline ??= iconStylePipeline(shader, true);
    else pipeline = this._pipeline ??= iconStylePipeline(shader);
    const backdrop = clear ? this._backdropFor(icon, styled) : null;
    if (!clear) this._leaveHost(icon, styled);
    const effect = styled.effect ?? new IconStyleEffect();
    effect.prepare(pipeline.copy(), textures, this._colors(), backdrop);
    if (!styled.effect) {
      styled.effect = effect;
      icon.add_effect_with_name(EFFECT_NAME, effect);
    }
    this._resize(icon);
  }

  // Scaled as an actor rather than drawn past its box, so that Clutter keeps what it redraws and culls right.
  private _resize(icon: St.Icon): void {
    const size = this._settings.get_double('icon-style-size');
    icon.set_pivot_point(0.5, 0.5);
    icon.set_scale(size, size);
  }

  private _resizeAll(): void {
    for (const [icon, styled] of this._styled) {
      if (styled.effect) this._resize(icon);
    }
  }

  private _unstyle(icon: St.Icon, styled: Styled): void {
    this._leaveHost(icon, styled);
    if (!styled.effect) return;
    icon.remove_effect(styled.effect);
    icon.set_scale(1, 1);
    styled.effect = null;
  }

  private _restyleAll(): void {
    for (const icon of [...this._styled.keys()]) this._apply(icon);
  }

  private _recolorAll(): void {
    const colors = this._colors();
    for (const styled of this._styled.values()) styled.effect?.setColors(colors);
  }
}

// The style maps of icon files, made by the icon worker (iconWorker.ts) and
// kept in the user's cache directory, so that an icon is taken apart once.

// Changes whenever the maps would come out differently, so that older ones are made again.
const MAP_VERSION = 10;
// Workers that take icons apart side by side; one more starts only while the others are all busy.
const MAX_WORKERS = 4;
// Icons asked for one after another (an app grid page, a folder) make one run of work, not one each.
const IDLE_DELAY_MS = 1500;

function loadFile(file: Gio.File, cancellable: Gio.Cancellable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    file.load_contents_async(cancellable, (_f, res) => {
      try {
        resolve(file.load_contents_finish(res)[1]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function modified(file: Gio.File, cancellable: Gio.Cancellable): Promise<number> {
  return new Promise((resolve, reject) => {
    file.query_info_async('time::modified', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (_f, res) => {
      try {
        resolve(file.query_info_finish(res).get_attribute_uint64('time::modified'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function exists(file: Gio.File, cancellable: Gio.Cancellable): Promise<boolean> {
  return new Promise((resolve, reject) => {
    file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (_f, res) => {
      try {
        file.query_info_finish(res);
        resolve(true);
      } catch (e) {
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) resolve(false);
        else reject(e);
      }
    });
  });
}

function isCancelled(e: unknown): boolean {
  return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class IconMaps {
  private _workers: WorkerProcess[];
  // By icon file: its map's, tones' and lens map's textures.
  private _maps = new Map<string, Promise<IconStyleTextures>>();
  // The maps already loaded, for an icon that has to be drawn styled in the frame it appears in.
  private _loaded = new Map<string, IconStyleTextures>();
  // By cache file: the map being made into it.
  private _making = new Map<string, Promise<void>>();
  private _jobs = 0;
  private _busy = false;
  private _idleId = 0;
  private _prepareSerial = 0;
  private _cancellable = new Gio.Cancellable();
  private _dir = `${GLib.get_user_cache_dir()}/liquid-glass/icon-maps`;

  /** @param _onBusy Called when maps start being made, and once they all are. */
  constructor(extensionPath: string, private _logger: Logger, private _onBusy: (busy: boolean) => void) {
    const count = Math.max(1, Math.min(MAX_WORKERS, GLib.get_num_processors() - 1));
    this._workers = Array.from({ length: count },
      () => new WorkerProcess(`${extensionPath}/dist/iconStyle/iconWorker.js`, 'icon worker', _logger));
  }

  /** The map of the icon in `path`. Rejects when it cannot be made. */
  get(path: string): Promise<IconStyleTextures> {
    let map = this._maps.get(path);
    if (!map) {
      map = this._load(path);
      map.then(textures => this._loaded.set(path, textures),
        // A failure is not kept: the file may be readable later.
        () => this._maps.delete(path));
      this._maps.set(path, map);
    }
    return map;
  }

  /** The map of the icon in `path` if it is loaded already. */
  loaded(path: string): IconStyleTextures | null {
    return this._loaded.get(path) ?? null;
  }

  /**
   * Makes the maps of the icons in `paths` that are not in the cache yet, without loading them, one per worker at
   * a time so that icons asked for meanwhile wait little. A later call takes the place of this one.
   */
  prepare(paths: string[]): void {
    const serial = ++this._prepareSerial;
    const queue = [...new Set(paths)];
    const next = async () => {
      while (serial === this._prepareSerial && queue.length) {
        const path = queue.shift()!;
        try {
          await this._cached(path);
        } catch (e) {
          if (isCancelled(e)) return;
          this._logger.log(`[Liquid Glass] Could not make the glass icon of ${path}: ${e}`);
        }
      }
    };
    this._workers.forEach(() => next());
  }

  // The cache file of the icon in `path`, made first if it is not there.
  private async _cached(path: string): Promise<Gio.File> {
    const time = await modified(Gio.File.new_for_path(path), this._cancellable);
    const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, `${MAP_VERSION}|${MAP_SIZE}|${path}|${time}`, -1)!;
    const cache = Gio.File.new_for_path(`${this._dir}/${key}`);
    if (await exists(cache, this._cancellable)) return cache;
    let making = this._making.get(key);
    if (!making) {
      making = this._make(path, cache).finally(() => this._making.delete(key));
      this._making.set(key, making);
    }
    await making;
    return cache;
  }

  private async _make(path: string, cache: Gio.File): Promise<void> {
    if (this._idleId) GLib.Source.remove(this._idleId);
    this._idleId = 0;
    this._jobs++;
    if (!this._busy) {
      this._busy = true;
      this._onBusy(true);
    }
    // The least busy worker, the first of equals, so that a second one starts only when the first has work.
    const usable = this._workers.filter(worker => worker.available);
    const worker = (usable.length ? usable : this._workers).reduce((a, b) => (b.pending < a.pending ? b : a));
    try {
      await worker.request({ file: path, cache: cache.get_path() });
    } finally {
      if (--this._jobs === 0) {
        if (this._idleId) GLib.Source.remove(this._idleId);
        this._idleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IDLE_DELAY_MS, () => {
          this._idleId = 0;
          this._busy = false;
          this._onBusy(false);
          return GLib.SOURCE_REMOVE;
        });
      }
    }
  }

  private async _load(path: string): Promise<IconStyleTextures> {
    const cache = await this._cached(path);
    const bytes = await loadFile(cache, this._cancellable);
    const length = MAP_SIZE * MAP_SIZE * 4;
    if (bytes.length !== length * 2 + LENS_SIZE * LENS_SIZE * 2 * 4) throw new Error(`${cache.get_path()} is not a style map`);
    return { map: iconStyleTexture(bytes.subarray(0, length)), tone: iconStyleTexture(bytes.subarray(length, length * 2)),
      lens: iconStyleTexture(bytes.subarray(length * 2), LENS_SIZE, LENS_SIZE * 2) };
  }

  destroy(): void {
    this._cancellable.cancel();
    if (this._idleId) GLib.Source.remove(this._idleId);
    this._idleId = 0;
    for (const worker of this._workers) worker.destroy();
    this._maps.clear();
    this._loaded.clear();
    this._making.clear();
  }
}
