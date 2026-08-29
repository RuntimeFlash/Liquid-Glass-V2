import re

# 1. Fix layoutEditor.ts
with open('/home/ayushpandey/liquid-glass/liquid-glass-v2@thinkingcoding1231.gmail.com/src/layoutEditor.ts', 'r') as f:
    le_content = f.read()

# Fix layout manager recreation
old_rebuild_start = """  private _rebuild() {
    if (!this._gridWidget || !this._footerWidget || !this._trayInner)
      return;

    this._gridWidget.destroy_all_children();
    this._footerWidget.destroy_all_children();
    this._trayInner.destroy_all_children();
    this._actors.clear();
    this._visibleActors = [];

    // ── Main grid ──────────────────────────────────────────────────────────
    let gridLayout = this._gridWidget.layout_manager as Clutter.GridLayout;"""

new_rebuild_start = """  private _rebuild() {
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
    page.insert_child_at_index(this._gridWidget, 0);

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
    footerSection.insert_child_at_index(this._footerWidget, 1);

    this._trayInner.destroy_all_children();
    this._actors.clear();
    this._visibleActors = [];

    // ── Main grid ──────────────────────────────────────────────────────────
    let gridLayout = this._gridWidget.layout_manager as Clutter.GridLayout;"""

le_content = le_content.replace(old_rebuild_start, new_rebuild_start)

# Fix insertion line logic
old_line_logic = """        // Between two tiles
        let rPrev = this._rect(mainActors[bestIdx - 1].actor);
        let rNext = this._rect(mainActors[bestIdx].actor);
        lineX = Math.round((rPrev.x + rPrev.w + rNext.x) / 2);
        lineY = Math.min(rPrev.y, rNext.y);
        lineH = Math.max(rPrev.h, rNext.h);"""

new_line_logic = """        // Between two tiles
        let rPrev = this._rect(mainActors[bestIdx - 1].actor);
        let rNext = this._rect(mainActors[bestIdx].actor);
        if (Math.abs(rPrev.y - rNext.y) > 10) {
            // Different rows
            lineX = rNext.x - 5;
            lineY = rNext.y;
            lineH = rNext.h;
        } else {
            lineX = Math.round((rPrev.x + rPrev.w + rNext.x) / 2);
            lineY = Math.min(rPrev.y, rNext.y);
            lineH = Math.max(rPrev.h, rNext.h);
        }"""

le_content = le_content.replace(old_line_logic, new_line_logic)

with open('/home/ayushpandey/liquid-glass/liquid-glass-v2@thinkingcoding1231.gmail.com/src/layoutEditor.ts', 'w') as f:
    f.write(le_content)


# 2. Fix customQuickSettings.ts (Slider discovery)
with open('/home/ayushpandey/liquid-glass/liquid-glass-v2@thinkingcoding1231.gmail.com/src/customQuickSettings.ts', 'r') as f:
    qs_content = f.read()

old_slider_discovery = """    // Sliders live directly in the native grid; expose them so layouts can
    // place them among the buttons.
    let sliderIndex = 0;
    for (let child of this.nativeGrid.get_children()) {
      if (!child.has_style_class_name?.('quick-slider'))
        continue;
      sliderIndex++;
      let title = `${this._labels(child).join(' ')}`;
      let icon = this._icon(child);"""

new_slider_discovery = """    // Sliders live directly in the native grid; expose them so layouts can
    // place them among the buttons.
    let sliderIndex = 0;
    let sliderContainers = [this.nativeGrid];
    if (this.root && this.root !== this.nativeGrid) sliderContainers.push(this.root);
    
    for (let container of sliderContainers) {
      if (!container) continue;
      for (let child of container.get_children()) {
        if (!child.has_style_class_name?.('quick-slider'))
          continue;
        sliderIndex++;
        let title = `${this._labels(child).join(' ')}`;
        let icon = this._icon(child);"""

# Replace the loop start
qs_content = qs_content.replace(old_slider_discovery, new_slider_discovery)

# Now we have an extra loop level, so we need to add a closing brace.
# Let's find the end of the slider discovery block.
old_slider_end = """        submenu: undefined,
      });
    }

    return controls;
  }"""

new_slider_end = """        submenu: undefined,
      });
      }
    }

    return controls;
  }"""
qs_content = qs_content.replace(old_slider_end, new_slider_end)

with open('/home/ayushpandey/liquid-glass/liquid-glass-v2@thinkingcoding1231.gmail.com/src/customQuickSettings.ts', 'w') as f:
    f.write(qs_content)

