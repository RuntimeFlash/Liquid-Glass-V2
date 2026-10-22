import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import GWeather from 'gi://GWeather';
import Soup from 'gi://Soup?version=3.0';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { formatTime } from 'resource:///org/gnome/shell/misc/dateUtils.js';

import { BackdropGlass } from '../rendering/backdropGlass.js';
import { ensureGlassAllocated, isActorValid } from '../actors.js';
import { hexToColorArray } from '../animation/colors.js';
import { AdaptiveTextColor, sanitizeColorPreference } from '../contrastSampler.js';
import type { Logger } from '../logger.js';
import { verticalBoxParams } from '../shellVersion.js';

// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
// Room around a card for its shadow.
const SHADOW_MARGIN = 40;
// A press that moves further than this (px) before it is let go is no click.
const CLICK_SLOP = 6;
// The text on the desktop stays in the preferred color down to this contrast
// ratio (WCAG's for large text), so a busy wallpaper does not keep flipping it.
export const PREFERRED_MIN_CONTRAST = 3;
export const CARD_WIDTH = 300;

export interface ItemEnv {
  path: string;
  settings: Gio.Settings;
  logger: Logger;
  // A right click on the item at (x, y), in stage coordinates.
  menu: (item: DesktopItem, x: number, y: number) => void;
  // The item changed size or was shown or hidden: lay the items out on the
  // next frame, and make sure there is one.
  relayout: () => void;
}

/** Something the desktop layer places and stacks, and the user can move. */
export interface DesktopItem {
  readonly id: string;
  readonly actor: St.Widget;
  // Whether it has anything to show; a hidden item leaves its place in the stack.
  readonly shown: boolean;
  // [width, height] as placed.
  size(): [number, number];
  // The part of the actor that shows, [x, y, width, height] in its own
  // coordinates: the edit frame goes round it.
  bounds(): [number, number, number, number];
  // Every frame. True when the size or `shown` changed, so the stack is laid out again.
  sync(): boolean;
  destroy(): void;
}

/**
 * A left click on `actor` calls `onClick` and a right click opens its menu.
 * Items move only in the menu's edit mode, so a stray drag does nothing.
 */
export function connectClicks(actor: St.Widget, onClick: () => void, onMenu: (x: number, y: number) => void): void {
  let start: [number, number] | null = null;
  actor.connect('button-press-event', (_a: Clutter.Actor, event: Clutter.Event) => {
    const button = event.get_button();
    if (button === Clutter.BUTTON_SECONDARY) {
      onMenu(...(event.get_coords() as [number, number]));
      return Clutter.EVENT_STOP;
    }
    if (button !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
    // A button inside gets the press: stopping it here would also cancel the
    // button's click gesture.
    if (global.stage.get_event_actor(event) !== actor) return Clutter.EVENT_PROPAGATE;
    start = event.get_coords() as [number, number];
    return Clutter.EVENT_STOP;
  });
  actor.connect('button-release-event', (_a: Clutter.Actor, event: Clutter.Event) => {
    if (!start || event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
    const [x, y] = event.get_coords();
    const moved = Math.hypot(x - start[0], y - start[1]);
    start = null;
    if (moved < CLICK_SLOP) onClick();
    return Clutter.EVENT_STOP;
  });
}

/**
 * A desktop widget: content on a rounded card of glass. Subclasses fill
 * `box` and may hide the card (`shown`) when they have nothing to show.
 */
export abstract class GlassCard implements DesktopItem {
  readonly actor: St.Widget;
  protected readonly box: St.BoxLayout;
  protected readonly glass: BackdropGlass;
  protected env: ItemEnv;
  private _settingsIds: number[] = [];
  private _lastSize = '';
  private _lastShown = false;
  private _text: AdaptiveTextColor;
  private _shown = true;

  constructor(readonly id: string, env: ItemEnv, width: number) {
    this.env = env;
    this.actor = new St.Widget({ name: `liquid-glass-desktop-${id}`, reactive: true, track_hover: true });
    this.glass = new BackdropGlass({
      extensionPath: env.path, settings: env.settings, logger: env.logger, owner: `desktop-${id}`,
      outline: 'desktop-widget', underWindows: true,
    } as any);
    this.glass.setPadding(SHADER_PADDING);
    this.glass.setIsDock(false);
    this.glass.setShadowMaxRadius(SHADOW_MARGIN - 8);
    this.actor.add_child(this.glass);
    this.box = new St.BoxLayout({ style_class: 'liquid-glass-desktop-card', width, ...verticalBoxParams() } as any);
    this.actor.add_child(this.box);
    connectClicks(this.actor, () => this.activate(), (x, y) => env.menu(this, x, y));

    this._text = new AdaptiveTextColor(() => [this.box], () => [this.glass], env.logger, `desktop ${id}`);
    const watch = (key: string, fn: () => void) =>
      this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
    for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
      watch(`desktop-widget-${key}`, () => this._applyMaterial());
    for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
      watch(`desktop-widget-${key}`, () => this._syncText());
    this._applyMaterial();
    this._syncText();
  }

  protected activate(): void {
  }

  get shown(): boolean {
    return this._shown;
  }

  set shown(shown: boolean) {
    if (shown === this._shown) return;
    this._shown = shown;
    this.env.relayout(); // defined in desktopLayer.ts (connects to the _queueLayout() in the DesktopLayer)
  }

  private _applyMaterial(): void {
    const s = this.env.settings;
    const g = this.glass;
    g.setTintColor(...hexToColorArray(s.get_string('desktop-widget-tint-color')));
    g.setTintStrength(s.get_double('desktop-widget-tint-strength'));
    g.setBlurRadius(s.get_int('desktop-widget-blur-radius'));
    g.setCornerRadius(s.get_double('desktop-widget-corner-radius'));
    g.setBrightness(s.get_double('desktop-widget-brightness'));
    g.setContrast(s.get_double('desktop-widget-contrast'));
    g.setSaturation(s.get_double('desktop-widget-saturation'));
    this.box.set_style(`border-radius: ${s.get_double('desktop-widget-corner-radius')}px;`);
  }

  private _syncText(): void {
    const s = this.env.settings;
    if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
      this._text.clear();
      return;
    }
    this._text.start(s.get_int('desktop-widget-sample-interval-ms'),
      sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')), PREFERRED_MIN_CONTRAST);
  }

  // The content changed; measure the text color again.
  protected contentChanged(): void {
    this._text.invalidate();
    this.env.relayout();
  }

  size(): [number, number] {
    const [, natW] = this.box.get_preferred_width(-1);
    const [, natH] = this.box.get_preferred_height(natW);
    return [Math.ceil(Math.max(natW, this.box.width)), Math.ceil(natH)];
  }

  bounds(): [number, number, number, number] {
    return [0, 0, ...this.size()];
  }

  sync(): boolean {
    const shown = this.shown;
    this.actor.visible = shown;
    const [w, h] = this.size();
    const key = `${w}x${h}`;
    const changed = key !== this._lastSize || shown !== this._lastShown;
    this._lastShown = shown;
    if (key !== this._lastSize) {
      this._lastSize = key;
      const m = SHADOW_MARGIN;
      const p = SHADER_PADDING;
      this.glass.set_position(-m, -m);
      this.glass.set_size(w + m * 2, h + m * 2);
      this.glass.setResolution(w + m * 2, h + m * 2);
      this.glass.setGlassGeometry(m - p, m - p, w + p * 2, h + p * 2);
      this.actor.set_size(w, h);
      this._text.invalidate();
    }
    if (shown && this.actor.mapped) {
      ensureGlassAllocated(this.glass);
      this.glass.syncSources();
    }
    return changed;
  }

  destroy(): void {
    for (const id of this._settingsIds) this.env.settings.disconnect(id);
    this._settingsIds = [];
    this._text.clear();
    this.glass.cleanup();
    if (isActorValid(this.actor)) this.actor.destroy();
  }
}

const MAX_EVENTS = 4;
const CALENDAR_APP = 'org.gnome.Calendar.desktop';

function startOfDay(date: Date, days = 0): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * The rest of today's events and tomorrow's, from the calendars the shell's
 * calendar menu shows. It reads the events the menu has already loaded
 * rather than asking for its own range, which would change what the menu
 * shows.
 */
export class EventsWidget extends GlassCard {
  private _title: St.Label;
  private _list: St.BoxLayout;
  private _source: any = null;
  private _sourceId = 0;
  private _timerId = 0;

  constructor(env: ItemEnv) {
    super('events', env, CARD_WIDTH);
    this._title = new St.Label({ style_class: 'lg-title', text: 'Up Next' });
    this._list = new St.BoxLayout({ style_class: 'lg-list', ...verticalBoxParams() } as any);
    this.box.add_child(this._title);
    this.box.add_child(this._list);
    // The times move on even when the events do not.
    this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
      this._update();
      return GLib.SOURCE_CONTINUE;
    });
    this._update();
  }

  protected activate(): void {
    Shell.AppSystem.get_default().lookup_app(CALENDAR_APP)?.activate();
  }

  // The menu's event source, which the shell replaces when the session mode changes.
  private _eventSource(): any {
    const source = (Main.panel.statusArea as any).dateMenu._eventSource;
    if (source !== this._source) {
      if (this._source && this._sourceId) this._source.disconnect(this._sourceId);
      this._source = source;
      this._sourceId = source ? source.connect('changed', () => this._update()) : 0;
    }
    return source;
  }

  private _row(time: string, summary: string): St.BoxLayout {
    const row = new St.BoxLayout({ style_class: 'lg-event' });
    row.add_child(new St.Label({ text: time, style_class: 'lg-event-time', y_align: Clutter.ActorAlign.START }));
    const label = new St.Label({ text: summary, style_class: 'lg-event-summary', x_expand: true });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    row.add_child(label);
    return row;
  }

  private _update(): void {
    const source = this._eventSource();
    this._list.destroy_all_children();
    if (!source?.hasCalendars) {
      this._list.add_child(new St.Label({ text: 'No calendars', style_class: 'lg-dim' }));
      this.contentChanged();
      return;
    }
    const now = new Date();
    const today = startOfDay(now);
    const tomorrow = startOfDay(now, 1);
    const after = startOfDay(now, 2);
    const events = (source.getEvents(now, after) as any[]).slice(0, MAX_EVENTS);
    let day: Date | null = null;
    for (const event of events) {
      const starts: Date = event.date;
      const ends: Date = event.end;
      const heading = starts < tomorrow ? today : tomorrow;
      if (heading !== day && heading === tomorrow) {
        this._list.add_child(new St.Label({ text: 'Tomorrow', style_class: 'lg-small lg-heading' }));
      }
      day = heading;
      const dayStart = heading;
      const dayEnd = startOfDay(heading, 1);
      const allDay = starts <= dayStart && ends >= dayEnd;
      this._list.add_child(this._row(allDay ? 'All day' : formatTime(starts, { timeOnly: true }), event.summary));
    }
    if (events.length === 0)
      this._list.add_child(new St.Label({ text: 'Nothing else today or tomorrow', style_class: 'lg-dim' }));
    this.contentChanged();
  }

  destroy(): void {
    if (this._timerId) GLib.Source.remove(this._timerId);
    this._timerId = 0;
    if (this._source && this._sourceId) this._source.disconnect(this._sourceId);
    this._source = null;
    super.destroy();
  }
}

const HOURS = 5;
// Open-Meteo is asked again after this long.
const REFRESH_S = 30 * 60;
const CONTACT = 'https://github.com/ryohsuke1231/liquid-glass';
const USER_AGENT = `Liquid Glass GNOME Shell extension (${CONTACT})`;

interface Hour { label: string; icon: string; temp: string; }

interface Report {
  place: string;
  temp: string;
  summary: string;
  icon: string;
  range: string;
  hours: Hour[];
  // The source's notice that has to be shown with its data.
  credit: string;
}

type Unit = 'auto' | 'celsius' | 'fahrenheit';

function sanitizeUnit(value: string): Unit {
  return value === 'celsius' || value === 'fahrenheit' ? value : 'auto';
}

function degrees(value: number): string {
  return `${Math.round(value)}°`;
}

// WMO weather codes, as Open-Meteo reports them.
const CODES: Record<number, [string, string, string?]> = {
  0: ['Clear', 'weather-clear-symbolic', 'weather-clear-night-symbolic'],
  1: ['Mostly Clear', 'weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'],
  2: ['Partly Cloudy', 'weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'],
  3: ['Cloudy', 'weather-overcast-symbolic'],
  45: ['Fog', 'weather-fog-symbolic'],
  48: ['Rime Fog', 'weather-fog-symbolic'],
  51: ['Light Drizzle', 'weather-showers-scattered-symbolic'],
  53: ['Drizzle', 'weather-showers-scattered-symbolic'],
  55: ['Heavy Drizzle', 'weather-showers-scattered-symbolic'],
  56: ['Freezing Drizzle', 'weather-showers-scattered-symbolic'],
  57: ['Freezing Drizzle', 'weather-showers-scattered-symbolic'],
  61: ['Light Rain', 'weather-showers-scattered-symbolic'],
  63: ['Rain', 'weather-showers-symbolic'],
  65: ['Heavy Rain', 'weather-showers-symbolic'],
  66: ['Freezing Rain', 'weather-showers-symbolic'],
  67: ['Freezing Rain', 'weather-showers-symbolic'],
  71: ['Light Snow', 'weather-snow-symbolic'],
  73: ['Snow', 'weather-snow-symbolic'],
  75: ['Heavy Snow', 'weather-snow-symbolic'],
  77: ['Snow Grains', 'weather-snow-symbolic'],
  80: ['Rain Showers', 'weather-showers-scattered-symbolic'],
  81: ['Rain Showers', 'weather-showers-symbolic'],
  82: ['Violent Showers', 'weather-showers-symbolic'],
  85: ['Snow Showers', 'weather-snow-symbolic'],
  86: ['Heavy Snow Showers', 'weather-snow-symbolic'],
  95: ['Thunderstorm', 'weather-storm-symbolic'],
  96: ['Thunderstorm, Hail', 'weather-storm-symbolic'],
  99: ['Thunderstorm, Hail', 'weather-storm-symbolic'],
};

function wmo(code: number, isDay: boolean): [string, string] {
  const [text, icon, night] = CODES[code] ?? ['Unknown', 'weather-severe-alert-symbolic'];
  return [text, !isDay && night ? night : icon];
}

// A summary for the weather an icon stands for, where libgweather gives no
// conditions or sky (MET Norway's forecasts have neither).
const ICON_SUMMARIES: [string, string][] = [
  ['weather-clear', 'Clear'], ['weather-few-clouds', 'Partly Cloudy'], ['weather-overcast', 'Cloudy'],
  ['weather-fog', 'Fog'], ['weather-showers-scattered', 'Showers'], ['weather-showers', 'Rain'],
  ['weather-snow', 'Snow'], ['weather-storm', 'Thunderstorm'],
];

function iconSummary(icon: string): string {
  return ICON_SUMMARIES.find(([prefix]) => icon.startsWith(prefix))?.[1] ?? '';
}

// The place chosen in the preferences, or null for GNOME Weather's.
interface Place { name: string; lat: number; lon: number; }

function placeOf(settings: Gio.Settings): Place | null {
  const [name, lat, lon] = settings.get_value('weather-place').deepUnpack() as [string, number, number];
  return name ? { name, lat, lon } : null;
}

/**
 * Today's weather and the next hours, for the place chosen in the
 * preferences or else the location GNOME Weather has set up (the one the
 * shell's calendar menu shows the weather for). With GNOME Weather installed
 * the forecasts come from libgweather, as in GNOME Weather; without it, from
 * Open-Meteo.
 */
export class WeatherWidget extends GlassCard {
  private _place: St.Label;
  private _icon: St.Icon;
  private _temp: St.Label;
  private _summary: St.Label;
  private _hours: St.BoxLayout;
  private _credit: St.Label;
  // The shell's weather client: GNOME Weather's location.
  private _client: any = null;
  private _clientId = 0;
  // Our own libgweather forecasts, for a chosen place.
  private _info: any = null;
  private _infoId = 0;
  private _weatherSettingsIds: number[] = [];
  private _session: any = null;
  private _cancellable: Gio.Cancellable | null = null;
  private _timerId = 0;

  constructor(env: ItemEnv) {
    super('weather', env, CARD_WIDTH);
    this._place = new St.Label({ style_class: 'lg-title' });
    const row = new St.BoxLayout({ style_class: 'lg-row' });
    this._icon = new St.Icon({ icon_size: 44, y_align: Clutter.ActorAlign.CENTER });
    this._temp = new St.Label({ style_class: 'lg-big', y_align: Clutter.ActorAlign.CENTER });
    this._summary = new St.Label({ style_class: 'lg-dim', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
    row.add_child(this._icon);
    row.add_child(this._temp);
    row.add_child(this._summary);
    this._hours = new St.BoxLayout({ style_class: 'lg-hours', x_expand: true });
    this._credit = new St.Label({ style_class: 'lg-small', visible: false });
    for (const child of [this._place, row, this._hours, this._credit]) this.box.add_child(child);

    for (const key of ['weather-place', 'weather-temperature-unit'])
      this._weatherSettingsIds.push(env.settings.connect(`changed::${key}`, () => this._refresh()));
    this._refresh();
  }

  private _unit(): Unit {
    return sanitizeUnit(this.env.settings.get_string('weather-temperature-unit'));
  }

  // The shell's weather client, or null without GNOME Weather.
  private _shellClient(): any {
    const client = (Main.panel.statusArea as any).dateMenu._weatherItem._weatherClient;
    return client.available ? client : null;
  }

  private _stopSources(): void {
    if (this._client && this._clientId) this._client.disconnect(this._clientId);
    this._client = null;
    this._clientId = 0;
    if (this._info) {
      this._info.disconnect(this._infoId);
      this._info.abort();
    }
    this._info = null;
    this._infoId = 0;
    this._cancellable?.cancel();
    this._cancellable = null;
    if (this._timerId) GLib.Source.remove(this._timerId);
    this._timerId = 0;
  }

  private _refresh(): void {
    this._stopSources();
    const place = placeOf(this.env.settings);
    const client = this._shellClient();
    if (place && client) {
      this._startOwnGWeather(place);
    } else if (place) {
      this._startOpenMeteo(place);
    } else if (client) {
      this._client = client;
      this._clientId = client.connect('changed', () => this._showShellWeather());
      client.update();
      this._showShellWeather();
    } else {
      this._show('Install GNOME Weather, or choose a place in the Liquid Glass preferences');
    }
  }

  protected activate(): void {
    this._shellClient()?.activateApp();
  }

  // Asks again every REFRESH_S.
  private _every(fn: () => void): void {
    fn();
    if (this._timerId) GLib.Source.remove(this._timerId);
    this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_S, () => {
      fn();
      return GLib.SOURCE_CONTINUE;
    });
  }

  private _show(report: Report | string): void {
    if (typeof report === 'string') {
      this._place.text = 'Weather';
      this._icon.icon_name = 'weather-severe-alert-symbolic';
      this._temp.text = '';
      this._summary.text = report;
      this._summary.clutter_text.line_wrap = true;
      this._hours.destroy_all_children();
      this._credit.visible = false;
      this.contentChanged();
      return;
    }
    this._place.text = report.place;
    this._icon.icon_name = report.icon;
    this._temp.text = report.temp;
    this._summary.text = report.range ? `${report.summary}\n${report.range}` : report.summary;
    this._hours.destroy_all_children();
    for (const hour of report.hours) {
      const column = new St.BoxLayout({ style_class: 'lg-hour', x_expand: true, ...verticalBoxParams() } as any);
      column.add_child(new St.Label({ text: hour.label, style_class: 'lg-small', x_align: Clutter.ActorAlign.CENTER }));
      column.add_child(new St.Icon({ icon_name: hour.icon, icon_size: 18, x_align: Clutter.ActorAlign.CENTER }));
      column.add_child(new St.Label({ text: hour.temp, style_class: 'lg-small', x_align: Clutter.ActorAlign.CENTER }));
      this._hours.add_child(column);
    }
    this._credit.text = report.credit;
    this._credit.visible = !!report.credit;
    this.contentChanged();
  }

  private _gweatherUnit(): number {
    const unit = this._unit();
    return unit === 'celsius' ? GWeather.TemperatureUnit.CENTIGRADE
      : unit === 'fahrenheit' ? GWeather.TemperatureUnit.FAHRENHEIT : GWeather.TemperatureUnit.DEFAULT;
  }

  private _gweatherTemp(info: any): number | null {
    const [ok, value] = info.get_value_temp(this._gweatherUnit());
    return ok ? value : null;
  }

  // A report from libgweather's `info`, for `place` (its own name when null).
  private _gweatherReport(info: any, place: string | null, credit: string): Report {
    const icon = info.get_symbolic_icon_name();
    const conditions = info.get_conditions();
    const [hasSky] = info.get_value_sky();
    const summary = conditions && conditions !== '-' ? conditions : hasSky ? info.get_sky() : iconSummary(icon);
    const now = GLib.DateTime.new_now_local();
    const today = now.format('%F');
    let last = GLib.DateTime.new_from_unix_local(0);
    let high = -Infinity, low = Infinity;
    const hours: Hour[] = [];
    for (const forecast of info.get_forecast_list()) {
      const [valid, timestamp] = forecast.get_value_update();
      if (!valid || timestamp === 0) continue;
      const time = GLib.DateTime.new_from_unix_local(timestamp);
      const temp = this._gweatherTemp(forecast);
      if (temp !== null && time.format('%F') === today) {
        high = Math.max(high, temp);
        low = Math.min(low, temp);
      }
      // Only the hours to come, at least an hour apart.
      if (now.difference(time) > 0 || time.difference(last) < GLib.TIME_SPAN_HOUR || hours.length === HOURS) continue;
      last = time;
      hours.push({
        label: formatTime(new Date(timestamp * 1000), { timeOnly: true }),
        icon: forecast.get_symbolic_icon_name(),
        temp: temp === null ? '' : degrees(temp),
      });
    }
    const temp = this._gweatherTemp(info);
    return {
      place: place ?? info.get_location_name(), temp: temp === null ? '' : degrees(temp), summary, icon, hours,
      range: Number.isFinite(high) ? `H ${degrees(high)}  L ${degrees(low)}` : '', credit,
    };
  }

  private _showShellWeather(): void {
    const client = this._client;
    if (!client) return;
    const info = client.info;
    if (!client.hasLocation) {
      this._show('Choose a location in GNOME Weather, or a place in the Liquid Glass preferences');
      return;
    }
    if (!info.is_valid()) {
      this._show(client.loading ? 'Loading…' : 'Weather is not available right now');
      return;
    }
    this._show(this._gweatherReport(info, null, ''));
  }

  // libgweather's forecasts for exactly `place`, which GNOME Weather may not
  // know: its own locations are the larger cities with weather stations.
  private _startOwnGWeather(place: Place): void {
    const info = new GWeather.Info({
      application_id: 'org.gnome.Shell', contact_info: CONTACT, enabled_providers: GWeather.Provider.MET_NO,
    });
    info.set_location(GWeather.Location.new_detached(place.name, null, place.lat, place.lon));
    this._info = info;
    this._infoId = info.connect('updated', () => {
      if (!info.is_valid()) {
        this._show('Weather is not available right now');
        return;
      }
      this._show(this._gweatherReport(info, place.name, 'Weather data by MET Norway'));
    });
    this._show('Loading…');
    this._every(() => info.update());
  }

  private _startOpenMeteo(place: Place): void {
    this._session ??= new Soup.Session({ user_agent: USER_AGENT, timeout: 20 });
    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;
    this._every(() => this._fetchOpenMeteo(place, cancellable));
  }

  private _getJson(url: string, cancellable: Gio.Cancellable): Promise<any> {
    const message = Soup.Message.new('GET', url);
    return new Promise((resolve, reject) => {
      this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session: any, res: any) => {
        try {
          const bytes = session.send_and_read_finish(res);
          if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()}`);
          resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private async _fetchOpenMeteo(place: Place, cancellable: Gio.Cancellable): Promise<void> {
    try {
      const fahrenheit = this._unit() === 'fahrenheit' ||
        (this._unit() === 'auto' && /_US\b/.test(GLib.get_language_names()[0] ?? ''));
      const json = await this._getJson('https://api.open-meteo.com/v1/forecast' +
        `?latitude=${place.lat}&longitude=${place.lon}&timezone=auto&forecast_days=2` +
        '&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day' +
        `&daily=temperature_2m_max,temperature_2m_min${fahrenheit ? '&temperature_unit=fahrenheit' : ''}`,
      cancellable);
      const current = json.current;
      const [summary, icon] = wmo(current.weather_code, current.is_day === 1);
      // The hourly times are local to the place, as is current.time.
      const start = (json.hourly.time as string[]).findIndex(t => t > current.time);
      const hours: Hour[] = [];
      for (let i = Math.max(start, 0); i < json.hourly.time.length && hours.length < HOURS; i++) {
        const [, hourIcon] = wmo(json.hourly.weather_code[i], json.hourly.is_day[i] === 1);
        hours.push({ label: (json.hourly.time[i] as string).slice(11, 16), icon: hourIcon,
          temp: degrees(json.hourly.temperature_2m[i]) });
      }
      this._show({
        place: place.name, temp: degrees(current.temperature_2m), summary, icon, hours,
        range: `H ${degrees(json.daily.temperature_2m_max[0])}  L ${degrees(json.daily.temperature_2m_min[0])}`,
        credit: 'Weather data by Open-Meteo.com',
      });
    } catch (e) {
      if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
      this.env.logger.log(`[Liquid Glass] Open-Meteo request failed: ${e}`);
      this._show('Weather is not available right now');
    }
  }

  destroy(): void {
    this._stopSources();
    for (const id of this._weatherSettingsIds) this.env.settings.disconnect(id);
    this._weatherSettingsIds = [];
    this._session?.abort();
    this._session = null;
    super.destroy();
  }
}
