import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {presentIconTuning} from './icon-tuning.js';

// The id the Show Apps button goes by in the lists (see src/iconStyle/iconStyler.ts).
const SHOW_APPS_ID = 'show-apps';

const ANY_ICON_STYLE = ['icon-style-dock', 'icon-style-launcher', 'icon-style-app-grid'];

// A dark dock keeps the clear look's white symbols readable over a light wallpaper.
const CLEAR_DOCK = {'dock-tint-color': '#000000', 'dock-tint-strength': 0.16};

// Installed applications as the lists show them, and the Show Apps button.
function applications() {
  const apps = Gio.AppInfo.get_all()
    .filter(app => app.should_show() && app.get_id())
    .map(app => ({id: app.get_id(), name: app.get_display_name(), icon: app.get_icon()}))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{id: SHOW_APPS_ID, name: 'Show Apps', icon: new Gio.ThemedIcon({name: 'view-app-grid-symbolic'})}, ...apps];
}

function appIcon(app) {
  const image = new Gtk.Image({pixel_size: 32, valign: Gtk.Align.CENTER});
  if (app?.icon)
    image.set_from_gicon(app.icon);
  else
    image.set_from_icon_name('application-x-executable-symbolic');
  return image;
}

export class IconStyleRules {
  constructor(settings, controls) {
    this.settings = settings;
    this.controls = controls;
  }

  add(page) {
    const group = this.controls.group(page, 'Application icons',
      'Redraws icons as glass plates under a one-color symbol. An icon that carries a picture is left as it is.');
    this.controls.toggle(group, 'Dock', 'icon-style-dock', 'Dash to Dock');
    this.controls.toggle(group, 'Launcher', 'icon-style-launcher');
    this.controls.toggle(group, 'App grid', 'icon-style-app-grid', 'In the overview, folders included');
    const look = this.controls.choice(group, 'Look', [
      {title: 'Tinted', patch: {'icon-style-mode': 'tinted'}},
      {title: 'Mono', patch: {'icon-style-mode': 'mono'}},
      {title: 'Clear', patch: {'icon-style-mode': 'clear'}},
    ], '', false);
    const clearHint = this._addClearHint(group);
    const variantRow = this.controls.choice(group, 'Variant', [
      {title: 'Dark', patch: {'icon-style-tint-variant': 'dark'}},
      {title: 'Light', patch: {'icon-style-tint-variant': 'light'}},
    ], 'Dark glass under a colored symbol, or colored glass under a white one', false);
    const accentRow = this.controls.toggle(group, 'Accent color', 'icon-style-use-accent',
      'The system accent color, from GNOME 47 on');
    const colorRow = this.controls.color(group, 'Color', ['icon-style-color']);
    const strengthRow = this.controls.number(group, 'Tint strength', ['icon-style-tint-strength'], 0, 1, 0.05,
      'From dark glass to the full color', {slider: true});
    const rows = [look,
      this.controls.number(group, 'Size', ['icon-style-size'], 0.8, 1.3, 0.05,
        'As a share of the size each place gives them', {slider: true}),
      this.controls.number(group, 'Symbol opacity', ['icon-style-symbol-opacity'], 0, 1, 0.05, '', {slider: true}),
      this._addTuningRow(group),
      this.controls.toggle(group, 'Include all applications', 'icon-style-all-apps')];
    this.controls.watch([...ANY_ICON_STYLE, 'icon-style-mode', 'icon-style-tint-variant', 'icon-style-use-accent'], () => {
      const on = ANY_ICON_STYLE.some(key => this.settings.get_boolean(key));
      const tinted = on && this.settings.get_string('icon-style-mode') === 'tinted';
      for (const row of rows) row.visible = on;
      clearHint.visible = on && this.settings.get_string('icon-style-mode') === 'clear';
      variantRow.visible = accentRow.visible = tinted;
      strengthRow.visible = tinted && this.settings.get_string('icon-style-tint-variant') === 'dark';
      colorRow.visible = tinted && !this.settings.get_boolean('icon-style-use-accent');
    });
    for (const [all, key, title] of [
      [false, 'icon-style-whitelist', 'Icons to redraw'],
      [true, 'icon-style-blacklist', 'Icons to leave as they are'],
    ])
      this._addList(page, key, title, all);
  }

  _addClearHint(group) {
    const row = new Adw.ActionRow({title: 'Hard to see?',
      subtitle: 'Clear icons show what is behind them. On a light wallpaper, a black dock tint at 0.16 strength keeps them readable.'});
    const button = new Gtk.Button({label: 'Apply', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => this.controls.write(CLEAR_DOCK));
    row.add_suffix(button);
    group.add(row);
    this.controls.watch(Object.keys(CLEAR_DOCK), () => {
      const applied = this.settings.get_string('dock-tint-color').toLowerCase() === CLEAR_DOCK['dock-tint-color'] &&
        Math.abs(this.settings.get_value('dock-tint-strength').deep_unpack() - CLEAR_DOCK['dock-tint-strength']) < 0.005;
      button.sensitive = !applied;
      button.label = applied ? 'Applied' : 'Apply';
    });
    return row;
  }

  _addTuningRow(group) {
    const row = new Adw.ActionRow({title: 'Glass tuning', subtitle: 'The finer numbers of the current look',
      activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    row.connect('activated', () => presentIconTuning(row, this.settings, this.controls));
    group.add(row);
    return row;
  }

  _addList(page, key, title, activeWhen) {
    const group = new Adw.PreferencesGroup({title});
    page.add(group);
    this.controls.watch([...ANY_ICON_STYLE, 'icon-style-all-apps'], () => {
      group.visible = ANY_ICON_STYLE.some(k => this.settings.get_boolean(k)) &&
        this.settings.get_boolean('icon-style-all-apps') === activeWhen;
    });

    const addButton = new Gtk.Button({valign: Gtk.Align.CENTER, css_classes: ['flat'], icon_name: 'list-add-symbolic',
      tooltip_text: 'Choose an application'});
    addButton.connect('clicked', () => this._presentPicker(addButton, key));
    group.set_header_suffix(addButton);

    const listBox = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
    listBox.add_css_class('boxed-list');
    group.add(listBox);
    let known = null;
    this.controls.watch([key], () => {
      known ??= new Map(applications().map(app => [app.id, app]));
      for (let child = listBox.get_first_child(); child; child = listBox.get_first_child())
        listBox.remove(child);
      const ids = this.settings.get_strv(key);
      for (const id of ids) {
        const app = known.get(id);
        const row = new Adw.ActionRow({title: app?.name ?? id, subtitle: app ? id : 'Not installed', use_markup: false});
        row.add_prefix(appIcon(app));
        const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
          css_classes: ['flat', 'error'], tooltip_text: 'Remove'});
        remove.connect('clicked', () => this.settings.set_strv(key, this.settings.get_strv(key).filter(v => v !== id)));
        row.add_suffix(remove);
        listBox.append(row);
      }
      if (ids.length === 0) {
        const empty = new Adw.ActionRow({title: 'No applications added'});
        empty.add_css_class('dim-label');
        listBox.append(empty);
      }
    });
  }

  _presentPicker(parent, key) {
    const dialog = new Adw.Dialog({title: 'Choose an application', content_width: 460, content_height: 560});
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    const search = new Gtk.SearchEntry({placeholder_text: 'Search', margin_start: 12, margin_end: 12, margin_top: 6});
    toolbar.add_top_bar(search);
    const listBox = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, margin_start: 12, margin_end: 12,
      margin_top: 12, margin_bottom: 12, valign: Gtk.Align.START});
    listBox.add_css_class('boxed-list');
    toolbar.set_content(new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: listBox}));
    dialog.set_child(toolbar);

    const current = new Set(this.settings.get_strv(key));
    const rows = applications().map(app => {
      const row = new Adw.ActionRow({title: app.name, subtitle: app.id, use_markup: false});
      row.add_prefix(appIcon(app));
      if (current.has(app.id)) {
        const added = new Gtk.Image({icon_name: 'object-select-symbolic', valign: Gtk.Align.CENTER,
          tooltip_text: 'Already in the list'});
        row.add_suffix(added);
        row.sensitive = false;
      } else {
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
          tooltip_text: 'Add'});
        add.connect('clicked', () => {
          if (!this.settings.get_strv(key).includes(app.id))
            this.settings.set_strv(key, [...this.settings.get_strv(key), app.id]);
          dialog.close();
        });
        row.add_suffix(add);
        row.activatable_widget = add;
      }
      listBox.append(row);
      return {row, text: `${app.name} ${app.id}`.toLowerCase()};
    });
    search.connect('search-changed', () => {
      const words = search.text.toLowerCase().split(/\s+/).filter(Boolean);
      for (const {row, text} of rows) row.visible = words.every(word => text.includes(word));
    });
    dialog.present(parent);
  }
}
