import re

# Fix layoutEditor.ts
with open('/home/ayushpandey/liquid-glass/liquid-glass-v2@thinkingcoding1231.gmail.com/src/layoutEditor.ts', 'r') as f:
    le_content = f.read()

# 1. Fix grid overlap by populating BEFORE adding to parent
old_rebuild_start = """  private _rebuild() {
    if (!this._gridWidget || !this._footerWidget || !this._trayInner)
      return;

    // Destroy and recreate grids to force correct sizing
    let page = this._gridWidget.get_parent();
    let footerSection = this._footerWidget.get_parent();
    
    this._gridWidget.destroy();
    this._gridWidget = new St.Widget({
      style_class: 'liquid-glass-editor-grid',
      layout_manager: new Clutter.GridLayout({
        column_homogeneous: true,
        column_spacing: 10,
        row_spacing: 10,
      }),
      x_expand: true,
    });
    // Insert at top of page (index 0)
    page!.insert_child_at_index(this._gridWidget, 0);

    this._footerWidget.destroy();
    this._footerWidget = new St.Widget({
      style_class: 'liquid-glass-editor-grid liquid-glass-editor-footer-grid',
      layout_manager: new Clutter.GridLayout({
        column_homogeneous: true,
        column_spacing: 10,
        row_spacing: 10,
      }),
      x_expand: true,
    });
    footerSection!.insert_child_at_index(this._footerWidget, 1);

    this._trayInner.destroy_all_children();
    this._actors.clear();
    this._visibleActors = [];

    // ── Main grid ──────────────────────────────────────────────────────────
    let gridLayout = this._gridWidget.layout_manager as Clutter.GridLayout;"""

new_rebuild_start = """  private _rebuild() {
    if (!this._gridWidget || !this._footerWidget || !this._trayInner)
      return;

    let page = this._gridWidget.get_parent();
    let footerSection = this._footerWidget.get_parent();
    
    this._gridWidget.destroy();
    this._gridWidget = new St.Widget({
      style_class: 'liquid-glass-editor-grid',
      layout_manager: new Clutter.GridLayout({
        column_homogeneous: true,
        column_spacing: 10,
        row_spacing: 10,
      }),
      x_expand: true,
    });

    this._footerWidget.destroy();
    this._footerWidget = new St.Widget({
      style_class: 'liquid-glass-editor-grid liquid-glass-editor-footer-grid',
      layout_manager: new Clutter.GridLayout({
        column_homogeneous: true,
        column_spacing: 10,
        row_spacing: 10,
      }),
      x_expand: true,
    });

    this._trayInner.destroy_all_children();
    this._actors.clear();
    this._visibleActors = [];

    // ── Main grid ──────────────────────────────────────────────────────────
    let gridLayout = this._gridWidget.layout_manager as Clutter.GridLayout;"""

# Need to append the add_child logic at the end of _rebuild
old_rebuild_end = """        this._actors.set(tile.key, chip);
        this._trayInner.add_child(chip);
      }
    }
  }"""

new_rebuild_end = """        this._actors.set(tile.key, chip);
        this._trayInner.add_child(chip);
      }
    }
    
    // Add grids to parents AFTER populating to ensure correct height calculation
    if (page) page.insert_child_at_index(this._gridWidget, 0);
    if (footerSection) footerSection.insert_child_at_index(this._footerWidget, 1);
  }"""

le_content = le_content.replace(old_rebuild_start, new_rebuild_start)
le_content = le_content.replace(old_rebuild_end, new_rebuild_end)

# 2. Fix insertion line jumping to next row
old_line_logic = """        if (Math.abs(rPrev.y - rNext.y) > 10) {
            // Different rows
            lineX = rNext.x - 5;
            lineY = rNext.y;
            lineH = rNext.h;
        } else {"""

new_line_logic = """        if (Math.abs(rPrev.y - rNext.y) > 10) {
            // Different rows
            if (py < rNext.y - 10) {
                // Aiming at the end of the previous row
                lineX = rPrev.x + rPrev.w + 5;
                lineY = rPrev.y;
                lineH = rPrev.h;
            } else {
                // Aiming at the start of the next row
                lineX = rNext.x - 5;
                lineY = rNext.y;
                lineH = rNext.h;
            }
        } else {"""

le_content = le_content.replace(old_line_logic, new_line_logic)

with open('/home/ayushpandey/liquid-glass/liquid-glass-v2@thinkingcoding1231.gmail.com/src/layoutEditor.ts', 'w') as f:
    f.write(le_content)
