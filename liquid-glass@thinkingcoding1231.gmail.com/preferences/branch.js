import Gtk from 'gi://Gtk';

// Rows that depend on a setting hang below its row, set in from the left. With
// `fold`, an arrow at the end of that row (`parent`) hides and shows them again.
export class Branch {
  constructor(parent, {fold = true} = {}) {
    this._rows = [];
    this._open = true;
    this._enabled = true;
    this._arrow = null;
    if (!fold) return;
    this._arrow = new Gtk.Button({valign: Gtk.Align.CENTER, css_classes: ['flat']});
    this._arrow.connect('clicked', () => {
      this._open = !this._open;
      this._update();
    });
    parent.add_suffix(this._arrow);
    this._update();
  }

  add(row) {
    row.add_css_class('lg-branch');
    this._rows.push(row);
    this._update();
    return row;
  }

  // Whether the switch row's setting is on: the rows and the arrow go away when it is not.
  set enabled(on) {
    this._enabled = on;
    this._update();
  }

  _update() {
    const shown = this._enabled && this._open;
    for (const row of this._rows) row.visible = shown;
    if (!this._arrow) return;
    this._arrow.visible = this._enabled;
    this._arrow.icon_name = this._open ? 'pan-down-symbolic' : 'pan-end-symbolic';
    this._arrow.tooltip_text = this._open ? 'Fold' : 'Unfold';
  }
}
