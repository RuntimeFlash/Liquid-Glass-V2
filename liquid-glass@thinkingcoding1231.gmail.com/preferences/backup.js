import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

// The settings as `dconf dump` writes them, so a file can also be loaded with
// `dconf load /org/gnome/shell/extensions/liquid-glass/`.
export function dumpSettings(settings) {
  const lines = settings.settings_schema.list_keys().sort()
    .map(key => `${key}=${settings.get_value(key).print(false)}`);
  return `[/]\n${lines.join('\n')}\n`;
}

// The values in `text` that are keys of the schema, of the right type and in range. `skipped` counts the lines that are not.
export function parseSettings(settings, text) {
  const schema = settings.settings_schema;
  const changes = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at < 1 || line.startsWith('[')) continue;
    const key = line.slice(0, at).trim();
    if (!schema.has_key(key) || !settings.is_writable(key)) {
      skipped++;
      continue;
    }
    let value;
    try {
      value = GLib.Variant.parse(new GLib.VariantType(settings.get_value(key).get_type_string()), line.slice(at + 1).trim(), null, null);
    } catch {
      skipped++;
      continue;
    }
    if (schema.get_key(key).range_check(value)) changes.push([key, value]);
    else skipped++;
  }
  return {changes, skipped};
}

export function addBackup(page, controls, window) {
  const group = controls.group(page, 'Backup', 'Keep your settings in a file, or move them to another computer.');
  const toast = title => window.add_toast(new Adw.Toast({title}));
  const row = (title, subtitle, label, run) => {
    const action = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.Button({label, valign: Gtk.Align.CENTER});
    button.connect('clicked', run);
    action.add_suffix(button);
    action.activatable_widget = button;
    group.add(action);
  };
  const dialog = title => new Gtk.FileDialog({title, initial_name: 'liquid-glass-settings.txt'});

  row('Export settings', 'Saves every setting to a file', 'Export…', () => {
    dialog('Export Settings').save(window, null, (self, result) => {
      let file;
      try {
        file = self.save_finish(result);
      } catch (error) {
        if (!error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)) toast(`Could not export: ${error.message}`);
        return;
      }
      try {
        file.replace_contents(new TextEncoder().encode(dumpSettings(controls.settings)), null, false,
          Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        toast('Settings exported');
      } catch (error) {
        toast(`Could not export: ${error.message}`);
      }
    });
  });

  row('Import settings', 'Loads a file saved with Export; settings it does not hold stay as they are', 'Import…', () => {
    dialog('Import Settings').open(window, null, (self, result) => {
      let text;
      try {
        const [, bytes] = self.open_finish(result).load_contents(null);
        text = new TextDecoder().decode(bytes);
      } catch (error) {
        if (!error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)) toast(`Could not import: ${error.message}`);
        return;
      }
      const {changes, skipped} = parseSettings(controls.settings, text);
      if (changes.length === 0) {
        toast('Nothing to import in that file');
        return;
      }
      controls.commit(changes);
      toast(skipped ? `Imported ${changes.length} settings, skipped ${skipped}` : `Imported ${changes.length} settings`);
    });
  });
}
