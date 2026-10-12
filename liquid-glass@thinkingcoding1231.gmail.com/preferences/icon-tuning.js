import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ICON_TUNING} from '../dist/iconStyle/styleColors.js';

const KEY = 'icon-style-tuning';
const LOOK_TITLES = {dark: 'Tinted, dark', light: 'Tinted, light', mono: 'Mono', clear: 'Clear'};

function currentLook(settings) {
  const mode = settings.get_string('icon-style-mode');
  return mode === 'tinted' ? settings.get_string('icon-style-tint-variant') : mode;
}

// A dialog of sliders for the numbers the current look is drawn with. A value left at its default is not stored.
export function presentIconTuning(parent, settings, controls) {
  const look = currentLook(settings);
  const dialog = new Adw.Dialog({title: 'Glass Tuning', content_width: 460, content_height: 560});
  const toolbar = new Adw.ToolbarView();
  const header = new Adw.HeaderBar();
  const reset = new Gtk.Button({label: 'Reset All', tooltip_text: 'Every look back to its defaults'});
  header.pack_start(reset);
  toolbar.add_top_bar(header);
  const page = new Adw.PreferencesPage();
  const group = new Adw.PreferencesGroup({title: LOOK_TITLES[look] ?? look,
    description: 'Changes show on the icons as you make them.'});
  page.add(group);
  toolbar.set_content(page);
  dialog.set_child(toolbar);

  let syncing = false;
  const rows = ICON_TUNING.filter(param => param.looks.includes(look)).map(param => {
    const step = param.max - param.min > 2 ? 0.5 : 0.01;
    const row = new Adw.SpinRow({title: param.title, digits: 2,
      adjustment: new Gtk.Adjustment({lower: param.min, upper: param.max, step_increment: step, page_increment: step * 10})});
    controls.addSlider(row, 2);
    group.add(row);
    row.connect('notify::value', () => {
      if (syncing) return;
      const values = settings.get_value(KEY).deep_unpack();
      const value = Number(row.value.toFixed(2));
      if (value === param.value) delete values[param.key];
      else values[param.key] = value;
      controls.write({[KEY]: values});
    });
    return {param, row};
  });

  const refresh = () => {
    const values = settings.get_value(KEY).deep_unpack();
    syncing = true;
    for (const {param, row} of rows) {
      row.value = values[param.key] ?? param.value;
      row.subtitle = param.key in values ? `Default ${param.value}` : '';
    }
    syncing = false;
  };
  const changedId = settings.connect(`changed::${KEY}`, refresh);
  dialog.connect('closed', () => settings.disconnect(changedId));
  refresh();
  reset.connect('clicked', () => settings.reset(KEY));
  dialog.present(parent);
  return dialog;
}
