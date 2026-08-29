import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export type TileMode = 'circle' | 'wide';

export type EditorTile = {
  key: string;
  title: string;
  iconName: string;
  mode: TileMode;
  slider?: boolean;
  hidden?: boolean;
  defaultMode?: TileMode;
  defaultHidden?: boolean;
};

type DragState = {
  tile: EditorTile;
  actor: St.Button;
  grabX: number;
  grabY: number;
  active: boolean;
  originIndex: number;
  gapIndex: number;
};

const DRAG_THRESHOLD = 8;

/**
 * A draft-only layout editor. Nothing is written to GSettings until Save, so
 * dismissing the dialog (including Escape) is always a true cancel.
 */
export class QuickSettingsLayoutEditor {
  private _settings: any;
  private _onSaved: () => void;
  private _dialog: any = null;
  private _tiles: EditorTile[] = [];
  private _actors = new Map<string, St.Button>();
  private _gridWidget: St.Widget | null = null;
  private _trayInner: St.Widget | null = null;
  private _selectionBar: St.BoxLayout | null = null;
  private _selectedKey: string | null = null;
  private _drag: DragState | null = null;
  private _ghost: St.Button | null = null;

  constructor(options: { settings: any; onSaved: () => void }) {
    this._settings = options.settings;
    this._onSaved = options.onSaved;
  }

  open(tiles: EditorTile[]) {
    this.close();
    this._tiles = tiles.map(tile => ({ ...tile }));
    this._selectedKey = this._tiles.find(tile => !tile.hidden)?.key ?? this._tiles[0]?.key ?? null;
    this._dialog = new ModalDialog.ModalDialog({ styleClass: 'liquid-glass-layout-editor-dialog' });

    const content = new St.BoxLayout({ vertical: true, style_class: 'liquid-glass-editor-content', x_expand: true });
    content.add_child(new St.Label({ text: 'Edit Controls', style_class: 'liquid-glass-editor-title', x_align: Clutter.ActorAlign.CENTER }));
    content.add_child(new St.Label({
      text: 'Select a control to resize or hide it · Drag the handle to reorder',
      style_class: 'liquid-glass-editor-hint', x_align: Clutter.ActorAlign.CENTER,
    }));

    const scroll = new St.ScrollView({ style_class: 'liquid-glass-editor-scroll', x_expand: true, y_expand: true });
    const page = new St.BoxLayout({ vertical: true, style_class: 'liquid-glass-editor-page', x_expand: true });
    scroll.set_child(page);
    this._gridWidget = new St.Widget({
      style_class: 'liquid-glass-editor-grid', x_expand: true,
      layout_manager: new Clutter.GridLayout({ column_homogeneous: true, column_spacing: 10, row_spacing: 10 }),
    });
    page.add_child(this._gridWidget);

    this._selectionBar = new St.BoxLayout({ style_class: 'liquid-glass-editor-selection-bar', x_expand: true });
    page.add_child(this._selectionBar);

    const tray = new St.BoxLayout({ vertical: true, style_class: 'liquid-glass-editor-tray', x_expand: true });
    tray.add_child(new St.Label({ text: 'Hidden controls', style_class: 'liquid-glass-editor-tray-label' }));
    this._trayInner = new St.Widget({
      style_class: 'liquid-glass-editor-tray-inner', x_expand: true,
      layout_manager: new Clutter.FlowLayout({ orientation: Clutter.Orientation.HORIZONTAL, homogeneous: false, row_spacing: 8, column_spacing: 8 }),
    });
    tray.add_child(this._trayInner);
    page.add_child(tray);
    content.add_child(scroll);

    const actions = new St.BoxLayout({ style_class: 'liquid-glass-editor-actions', x_align: Clutter.ActorAlign.CENTER, x_expand: true });
    actions.add_child(this._actionButton('Reset', 'liquid-glass-editor-action', () => this._reset()));
    actions.add_child(new St.Bin({ width: 12 }));
    actions.add_child(this._actionButton('Cancel', 'liquid-glass-editor-action', () => this.close()));
    actions.add_child(this._actionButton('Save', 'liquid-glass-editor-action liquid-glass-editor-action-primary', () => this._save()));
    content.add_child(actions);
    this._dialog.contentLayout.add_child(content);
    this._rebuild();
    this._dialog.open(global.get_current_time());
  }

  close() {
    this._endDrag();
    try { this._dialog?.close(global.get_current_time()); this._dialog?.destroy(); } catch (e) {}
    this._dialog = null;
    this._actors.clear();
    this._gridWidget = null;
    this._trayInner = null;
    this._selectionBar = null;
    this._selectedKey = null;
  }

  private _visibleTiles() { return this._tiles.filter(tile => !tile.hidden); }
  private _spanFor(tile: EditorTile) { return tile.mode === 'wide' ? 2 : 1; }
  private _selectedTile() { return this._tiles.find(tile => tile.key === this._selectedKey) ?? null; }

  private _actionButton(label: string, styleClass: string, callback: () => void, reactive = true) {
    const button = new St.Button({ label, style_class: styleClass, reactive, can_focus: reactive });
    if (reactive) button.connect('clicked', callback);
    return button;
  }

  private _rebuild() {
    if (!this._gridWidget || !this._trayInner) return;
    this._gridWidget.destroy_all_children();
    this._trayInner.destroy_all_children();
    this._actors.clear();
    const layout = this._gridWidget.layout_manager as Clutter.GridLayout;
    let row = 0; let column = 0;
    for (const tile of this._visibleTiles()) {
      const span = this._spanFor(tile);
      if (column + span > 4) { column = 0; row++; }
      const actor = this._makeTile(tile, false);
      this._actors.set(tile.key, actor);
      layout.attach(actor, column, row, span, 1);
      column += span;
      if (column >= 4) { column = 0; row++; }
    }
    layout.attach(new St.Bin({ width: 0, height: 0, opacity: 0 }), 0, row + 1, 4, 1);
    for (const tile of this._tiles.filter(tile => tile.hidden)) {
      const actor = this._makeTile(tile, true);
      this._actors.set(tile.key, actor);
      this._trayInner.add_child(actor);
    }
    this._renderSelectionBar();
  }

  private _renderSelectionBar() {
    if (!this._selectionBar) return;
    this._selectionBar.destroy_all_children();
    const selected = this._selectedTile();
    if (!selected) return;
    this._selectionBar.add_child(new St.Label({ text: selected.title, style_class: 'liquid-glass-editor-selection-title', x_expand: true }));
    if (!selected.hidden) {
      const compact = this._actionButton('Compact', 'liquid-glass-editor-tool', () => this._setMode(selected, 'circle'), !selected.slider && selected.mode !== 'circle');
      const wide = this._actionButton('Wide', 'liquid-glass-editor-tool', () => this._setMode(selected, 'wide'), selected.mode !== 'wide');
      this._selectionBar.add_child(compact);
      this._selectionBar.add_child(wide);
      this._selectionBar.add_child(this._actionButton('Hide', 'liquid-glass-editor-tool liquid-glass-editor-tool-danger', () => this._setHidden(selected, true)));
    } else {
      this._selectionBar.add_child(this._actionButton('Show', 'liquid-glass-editor-tool liquid-glass-editor-tool-primary', () => this._setHidden(selected, false)));
    }
  }

  /** Reposition existing tile actors during drag without dropping their grab. */
  private _relayoutGrid() {
    if (!this._gridWidget) return;
    const layout = this._gridWidget.layout_manager as Clutter.GridLayout;
    let row = 0; let column = 0;
    for (const tile of this._visibleTiles()) {
      const span = this._spanFor(tile);
      if (column + span > 4) { column = 0; row++; }
      const actor = this._actors.get(tile.key);
      if (actor) {
        try { layout.attach(actor, column, row, span, 1); } catch (e) {}
      }
      column += span;
      if (column >= 4) { column = 0; row++; }
    }
  }

  private _makeTile(tile: EditorTile, hidden: boolean): St.Button {
    const isCompact = hidden || tile.mode === 'circle';
    let style = hidden ? 'liquid-glass-editor-tile liquid-glass-editor-tile-hidden' :
      isCompact ? 'liquid-glass-editor-tile liquid-glass-editor-tile-single' : 'liquid-glass-editor-tile liquid-glass-editor-tile-wide';
    if (tile.key === this._selectedKey) style += ' liquid-glass-editor-tile-selected';
    const button = new St.Button({ style_class: style, reactive: true, can_focus: true, x_expand: !isCompact, x_align: isCompact ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL });
    if (isCompact) button.set_size(68, 68);
    const content = new St.BoxLayout({ style_class: 'liquid-glass-editor-tile-content', x_expand: true });
    const icon = new St.Icon({ icon_name: tile.iconName || 'emblem-system-symbolic', style_class: 'liquid-glass-editor-tile-icon' });
    content.add_child(icon);
    if (!isCompact) {
      const labels = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'liquid-glass-editor-tile-labels' });
      labels.add_child(new St.Label({ text: tile.title, style_class: 'liquid-glass-editor-tile-title' }));
      if (tile.slider) labels.add_child(new St.Label({ text: 'Slider', style_class: 'liquid-glass-editor-tile-subtitle' }));
      content.add_child(labels);
    } else {
      content.x_align = Clutter.ActorAlign.CENTER;
      content.x_expand = false;
    }
    if (!hidden) {
      const handle = new St.Button({ label: '⠿', style_class: 'liquid-glass-editor-drag-handle', reactive: true, can_focus: false });
      this._bindDrag(handle, button, tile);
      content.add_child(handle);
    }
    button.set_child(content);
    button.connect('clicked', () => { this._selectedKey = tile.key; this._rebuild(); });
    return button;
  }

  private _bindDrag(handle: St.Button, actor: St.Button, tile: EditorTile) {
    handle.connect('button-press-event', () => {
      const [x, y] = global.get_pointer();
      this._drag = { tile, actor, grabX: x, grabY: y, active: false, originIndex: -1, gapIndex: -1 };
      return Clutter.EVENT_STOP;
    });
    handle.connect('motion-event', () => {
      if (!this._drag || this._drag.actor !== actor) return Clutter.EVENT_PROPAGATE;
      const [x, y] = global.get_pointer();
      if (!this._drag.active) {
        if (Math.abs(x - this._drag.grabX) < DRAG_THRESHOLD && Math.abs(y - this._drag.grabY) < DRAG_THRESHOLD) return Clutter.EVENT_STOP;
        this._drag.active = true;
        this._drag.originIndex = this._visibleTiles().findIndex(candidate => candidate.key === tile.key);
        this._drag.gapIndex = this._drag.originIndex;
        this._startGhost(actor);
      }
      this._moveGhost(x, y);
      this._updateGap();
      return Clutter.EVENT_STOP;
    });
    handle.connect('button-release-event', () => {
      if (!this._drag || this._drag.actor !== actor) return Clutter.EVENT_PROPAGATE;
      const active = this._drag.active;
      const drop = active ? this._ghostCenter() : null;
      const origin = this._drag.originIndex;
      this._endDrag();
      if (active && drop) this._finishDrop(tile, drop[0], drop[1], origin);
      return Clutter.EVENT_STOP;
    });
  }

  private _setMode(tile: EditorTile, mode: TileMode) { if (tile.slider && mode === 'circle') return; tile.mode = mode; this._rebuild(); }
  private _setHidden(tile: EditorTile, hidden: boolean) { tile.hidden = hidden; this._selectedKey = tile.key; this._rebuild(); }

  private _updateGap() {
    if (!this._drag || !this._drag.active) return;
    const center = this._ghostCenter();
    if (!center) return;
    const others = this._visibleTiles().filter(tile => tile.key !== this._drag!.tile.key);
    let gap = others.length;
    for (let index = 0; index < others.length; index++) {
      const actor = this._actors.get(others[index].key);
      if (!actor) continue;
      const rect = this._rect(actor);
      if (this._contains(rect, center[0], center[1])) { gap = center[0] < rect.x + rect.w / 2 ? index : index + 1; break; }
    }
    if (gap === this._drag.gapIndex) return;
    this._drag.gapIndex = gap;
    const dragged = this._drag.tile;
    const ordered = [...others.slice(0, gap), dragged, ...others.slice(gap)];
    let index = 0;
    this._tiles = this._tiles.map(tile => tile.hidden ? tile : ordered[index++]);
    this._relayoutGrid();
  }

  private _finishDrop(tile: EditorTile, x: number, y: number, origin: number) {
    if (this._gridWidget && !this._contains(this._rect(this._gridWidget), x, y)) {
      const others = this._visibleTiles().filter(candidate => candidate.key !== tile.key);
      const ordered = [...others.slice(0, origin), tile, ...others.slice(origin)];
      let index = 0;
      this._tiles = this._tiles.map(candidate => candidate.hidden ? candidate : ordered[index++]);
    }
    this._rebuild();
  }

  private _startGhost(source: St.Button) {
    this._destroyGhost();
    const ghost = new St.Button({ style_class: `${source.style_class} liquid-glass-editor-ghost`, reactive: false });
    const [width, height] = source.get_size();
    ghost.set_size(width, height);
    global.stage.add_child(ghost);
    try { global.stage.set_child_above_sibling(ghost, null); source.opacity = 0; } catch (e) {}
    this._ghost = ghost;
  }
  private _moveGhost(x: number, y: number) { if (!this._ghost) return; const [w, h] = this._ghost.get_size(); this._ghost.set_position(Math.round(x - w / 2), Math.round(y - h / 2)); }
  private _ghostCenter(): [number, number] | null { if (!this._ghost) return null; const [x, y] = this._ghost.get_transformed_position(); const [w, h] = this._ghost.get_transformed_size(); return [x + w / 2, y + h / 2]; }
  private _endDrag() { if (this._drag) { try { this._drag.actor.opacity = 255; } catch (e) {} } this._drag = null; this._destroyGhost(); }
  private _destroyGhost() { try { this._ghost?.destroy(); } catch (e) {} this._ghost = null; }
  private _rect(actor: any) { const [x, y] = actor.get_transformed_position(); const [w, h] = actor.get_transformed_size(); return { x, y, w, h }; }
  private _contains(rect: any, x: number, y: number) { return rect.w > 0 && rect.h > 0 && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h; }

  private _save() {
    const items = this._tiles.filter(tile => !tile.hidden).map(tile => ({ key: tile.key, span: this._spanFor(tile) }));
    const hidden = this._tiles.filter(tile => tile.hidden).map(tile => tile.key);
    try { this._settings.set_string('quick-settings-layout', JSON.stringify({ version: 3, items, hidden })); } catch (e) {}
    this.close();
    this._onSaved();
  }

  private _reset() {
    for (const tile of this._tiles) {
      tile.mode = tile.defaultMode ?? (tile.slider ? 'wide' : 'circle');
      tile.hidden = !!tile.defaultHidden;
    }
    this._selectedKey = this._tiles.find(tile => !tile.hidden)?.key ?? this._tiles[0]?.key ?? null;
    this._rebuild();
  }
}
