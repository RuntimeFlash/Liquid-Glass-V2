// Native GTK smoke test. Memory backend is mandatory: never edit the user's profile.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {buildPreferences} from '../liquid-glass@thinkingcoding1231.gmail.com/preferences/pages.js';
import {PreferenceControls} from '../liquid-glass@thinkingcoding1231.gmail.com/preferences/controls.js';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw Error('Run with GSETTINGS_BACKEND=memory');
Adw.init();
const directory = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const extension = directory.get_child('liquid-glass@thinkingcoding1231.gmail.com');
const metadata = JSON.parse(new TextDecoder().decode(extension.get_child('metadata.json').load_contents(null)[1]));
const source = Gio.SettingsSchemaSource.new_from_directory(
  extension.get_child('schemas').get_path(),
  Gio.SettingsSchemaSource.get_default(), false);
const schema = source.lookup(metadata['settings-schema'], true);
const settings = new Gio.Settings({settings_schema: schema});
settings.set_int('dock-blur-radius', 3);
settings.set_int('menu-blur-radius', 21);
settings.set_double('menu-scale', 0.83);
const snapshot = () => JSON.stringify(schema.list_keys().sort().map(key => [key, settings.get_value(key).print(true)]));
const before = snapshot();
// Which keys the rows of each group write, to compare the two views.
const rowKeys = [];
for (const [method, keysOf] of [['toggle', a => [a[2]]], ['number', a => a[2]], ['color', a => a[2]],
  ['choice', a => a[2].flatMap(choice => Object.keys(choice.patch))]]) {
  const original = PreferenceControls.prototype[method];
  PreferenceControls.prototype[method] = function (...args) {
    rowKeys.push([args[0], keysOf(args)]);
    return original.apply(this, args);
  };
}
const window = new Adw.PreferencesWindow();
const controls = buildPreferences(window, settings);
if (snapshot() !== before) throw Error('Opening preferences changed the configuration');

function* walk(widget) {
  yield widget;
  for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) yield* walk(child);
}
const rows = [...walk(window)].filter(widget => widget instanceof Adw.PreferencesRow);
const find = title => rows.find(row => row.title === title);
if (!find('Blur').subtitle.includes('Custom')) throw Error('Mixed values not indicated');
const warning = find('Blur my Shell is blurring popups').get_ancestor(Adw.PreferencesGroup);
if (warning.visible) throw Error('Blur my Shell warning shown without the shell reporting it');
settings.set_boolean('blur-my-shell-popup-blur', true);
if (!warning.visible) throw Error('Blur my Shell warning not shown');
settings.set_boolean('blur-my-shell-popup-blur', false);
find('Blur').value = 12;
for (const surface of ['dock', 'menu', 'panel-menu', 'notification', 'quick-settings', 'osd', 'application', 'desktop-menu']) {
  if (settings.get_int(`${surface}-blur-radius`) !== 12) throw Error(`Shared blur did not reach ${surface}`);
}
find('Animations').selected = 1;
if (settings.get_double('menu-spring-damping') !== 22) throw Error('Smooth motion did not apply');
if (settings.get_double('menu-scale') !== 0.83) throw Error('An unrelated setting changed');
const effectsSnapshot = () => JSON.stringify(schema.list_keys().sort().filter(key => key !== 'preferences-advanced')
  .map(key => [key, settings.get_value(key).print(true)]));
const beforeMode = effectsSnapshot();
find('Settings view').selected = 1;
if (effectsSnapshot() !== beforeMode) throw Error('Switching mode changed effect values');
const groupTitles = [...walk(window)].filter(widget => widget instanceof Adw.PreferencesGroup && widget.visible).map(widget => widget.title);
for (const [first, later] of [['Individual effects', 'Application windows'], ['Shadows', 'Troubleshooting']]) {
  if (groupTitles.lastIndexOf(first) > groupTitles.indexOf(later)) throw Error(`${first} is below ${later}: ${groupTitles.join(' | ')}`);
}
const surface = [...walk(window)].find(row => row instanceof Adw.ComboRow && row.title === 'Surface');
// Every key the simple view sets must be reachable in the advanced one.
const shownKeys = () => rowKeys.filter(([group]) => group.visible).flatMap(([, keys]) => keys);
const advancedKeys = new Set();
for (let i = 0; i < surface.model.get_n_items(); i++) {
  surface.selected = i;
  for (const key of shownKeys()) advancedKeys.add(key);
}
find('Settings view').selected = 0;
const missing = [...new Set(shownKeys())].filter(key => key !== 'preferences-advanced' && !advancedKeys.has(key));
if (missing.length) throw Error(`Only the simple view sets ${missing.join(', ')}`);
find('Settings view').selected = 1;
for (let i = 0; i < 8; i++) surface.selected = i;
for (const [index, title, prefix] of [[1, 'Calendar', 'menu'], [2, 'Other top bar menus', 'panel-menu'],
  [4, 'Quick settings', 'quick-settings']]) {
  surface.selected = index;
  const group = [...walk(window)].find(widget => widget instanceof Adw.PreferencesGroup && widget.title === title);
  const interval = [...walk(group)].find(widget => widget instanceof Adw.SpinRow && widget.title === 'Animation interval (ms)');
  const key = `${prefix}-animation-interval-ms`;
  if (!schema.get_key(key).range_check(new GLib.Variant('i', interval.adjustment.upper)))
    throw Error(`${key} offers an invalid upper bound`);
  interval.value = interval.adjustment.upper + 1;
  if (interval.value !== interval.adjustment.upper || settings.get_int(key) !== interval.adjustment.upper)
    throw Error(`${key} did not clamp and save the edit`);
}
surface.selected = 1;
const calendar = [...walk(window)].find(widget => widget instanceof Adw.PreferencesGroup && widget.title === 'Calendar');
const calendarBlur = [...walk(calendar)].find(widget => widget instanceof Adw.SpinRow && widget.title === 'Blur');
const blurSlider = [...walk(calendarBlur)].find(widget => widget instanceof Gtk.Scale);
if (!blurSlider || blurSlider.adjustment !== calendarBlur.adjustment) throw Error('Blur has no slider on its adjustment');
if (calendarBlur.get_first_child().get_last_child().get_first_child() !== blurSlider)
  throw Error('The slider is not in front of the number');
blurSlider.set_value(16.6);
if (settings.get_int('menu-blur-radius') !== 17) throw Error('Dragging the slider did not store the rounded value');
calendarBlur.value = 17;
if (settings.get_int('menu-blur-radius') !== 17 || settings.get_int('dock-blur-radius') !== 12)
  throw Error('Individual blur changed the wrong surface');
find('Settings view').selected = 0;
if (!find('Blur').subtitle.includes('Custom')) throw Error('Simple view lost individual differences');
const fontRow = find('Font'), weightRow = find('Weight');
if (settings.get_string('glass-clock-font') !== 'Sofia Sans Extra Condensed SemiBold' || !weightRow.visible ||
  weightRow.selected !== 2) throw Error('The default clock font is not shown as Sofia Sans SemiBold');
fontRow.selected = 0;
weightRow.selected = 3;
if (settings.get_string('glass-clock-font') !== 'Antonio Bold') throw Error(`Picked ${settings.get_string('glass-clock-font')}`);
fontRow.selected = 4;
if (settings.get_string('glass-clock-font') !== '' || weightRow.visible) throw Error('The interface font was not picked');
settings.set_string('glass-clock-font', 'Barlow Condensed Light');
if (fontRow.selected !== 1 || weightRow.selected !== 0) throw Error('A bundled font set elsewhere is not shown');
settings.set_string('glass-clock-font', 'Cantarell Bold');
if (fontRow.selected !== 5 || weightRow.visible) throw Error('An installed font is not shown as one');
const widgetPlace = rows.filter(row => row.title === 'Place')[1];
settings.set_string('desktop-widget-anchors', '{"weather":"bottom-left"}');
if (widgetPlace.selected !== 5) throw Error('A widget placed on its own is not reported');
widgetPlace.selected = 0;
if (settings.get_string('desktop-widget-anchors') !== '{}' || settings.get_string('desktop-widgets-position') !== 'top-left')
  throw Error('Picking a place for the widgets kept a widget\'s own place');
settings.set_boolean('icon-style-dock', true);
settings.set_string('icon-style-mode', 'clear');
find('Glass tuning').emit('activated');
const tuning = window.visible_dialog;
const tuningRows = [...walk(tuning)].filter(widget => widget instanceof Adw.SpinRow);
if (tuningRows.length !== 5) throw Error(`Clear has ${tuningRows.length} tuning rows`);
tuningRows.find(row => row.title === 'Symbol: shadow under it').value = 0.7;
if (settings.get_value('icon-style-tuning').deep_unpack().clearSymbolShadow !== 0.7) throw Error('Tuning did not store its value');
tuning.close();
settings.reset('icon-style-tuning');
controls.dispose();
window.destroy();
print(JSON.stringify({nativeGtk: 'passed', rows: rows.length, tuning: tuningRows.length, openingWrites: 0, sharedBlur: 'passed', smoothMotion: 'passed', advanced: 'passed'}));
