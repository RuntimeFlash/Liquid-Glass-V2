import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { formatTime } from 'resource:///org/gnome/shell/misc/dateUtils.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { GlassCard, type ItemEnv } from './desktopItem.js';
import { verticalBoxParams } from '../shellVersion.js';

const CARD_WIDTH = 300;
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
