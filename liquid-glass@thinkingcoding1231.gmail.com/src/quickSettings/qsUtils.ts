// utils.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { isOwnActor } from '../diagnostics/glass.js';
import { undoCloneScale } from '../shellVersion.js';

/**
 * A Clutter.Clone the Looking Glass picker passes through.
 *
 * Its paint volume is its own box, not its source's: a clone of the whole
 * background group or of a maximised window would otherwise make every redraw
 * of it damage the whole monitor, and a frame that damages the whole monitor
 * recaptures every glass on it.
 */
export const UnpickableClone = GObject.registerClass(
  {
    GTypeName: 'LiquidGlassQsUnpickableClone',
  },
  class UnpickableClone extends Clutter.Clone {
    vfunc_pick(_pickContext: any): void {
      // Picks fall through to the actors behind.
    }

    vfunc_get_paint_volume(volume: Clutter.PaintVolume): boolean {
      if (!volume.set_from_allocation(this)) return false;
      undoCloneScale(this, volume);
      return true;
    }
  }
);
/**
 * A container the picker passes through, along with all of its children.
 */
export const UnpickableActor = GObject.registerClass(
  {
    GTypeName: 'LiquidGlassQsUnpickableActor',
  },
  class UnpickableActor extends Clutter.Actor {
    vfunc_pick(_pickContext: any): void {
      // Picks fall through to the actors behind.
    }

    // Same reason as the clone's: the children are clipped to this box by their
    // parent, so the box is all a redraw of this actor can reach.
    vfunc_get_paint_volume(volume: Clutter.PaintVolume): boolean {
      return volume.set_from_allocation(this);
    }
  }
);

// The shell's background group holds the wallpaper and, while the desktop
// widgets are on, Liquid Glass's own desktop layer. Cloning the group as a
// whole re-renders every widget's glass inside the clone, and the Quick
// Settings paints one clone per card and panel, so the widget glasses end up
// composited a dozen times a frame. Leave Liquid Glass's own actors out (see
// isOwnActor).
function rebuildBackdropClone(box: Clutter.Actor): void {
  for (const child of [...box.get_children()] as Clutter.Actor[]) child.destroy();
  const group: any = (Main.layoutManager as any)._backgroundGroup;
  if (!group) return;
  const children = group.get_children() as Clutter.Actor[];
  if (!children.some(isOwnActor)) {
    // Nothing of ours in the group, so one clone of it keeps the shell's own
    // arrangement (monitor offsets, wallpaper switches) exactly.
    box.add_child(new UnpickableClone({ source: group }));
    return;
  }
  for (const source of children) {
    if (isOwnActor(source)) continue;
    const clone = new UnpickableClone({ source }) as Clutter.Clone;
    const [x, y] = source.get_position();
    clone.set_position(x, y);
    box.add_child(clone);
  }
}

/** A box of wallpaper clones to use as a glass backdrop; see above. */
export function createBackdropClone(): Clutter.Actor {
  const box = new UnpickableActor();
  const group: any = (Main.layoutManager as any)._backgroundGroup;
  if (group) {
    const invalidate = () => { (box as any)._liquidGlassRebuild = true; };
    const added = group.connect('child-added', invalidate);
    const removed = group.connect('child-removed', invalidate);
    box.connect('destroy', () => {
      group.disconnect(added);
      group.disconnect(removed);
    });
  }
  rebuildBackdropClone(box);
  return box;
}

/** Rebuilds the box's clones when the background group's children changed. */
export function syncBackdropClone(box: Clutter.Actor): void {
  if (!(box as any)._liquidGlassRebuild) return;
  (box as any)._liquidGlassRebuild = false;
  rebuildBackdropClone(box);
}

export interface PopupAnimationHooks {
  /** True only when the extension's custom fade will actually run this time. */
  isCustomAnimationEnabled: () => boolean;
  /** Called when GNOME's animated open is suppressed (parent snapped to neutral). */
  onSuppressOpen?: () => void;
  /** Called when GNOME's animated close is suppressed; receives the onComplete that emits 'menu-closed'. */
  onSuppressClose?: (onComplete: (() => void) | null, restoreInput?: (() => void) | null) => void;
}

export function hasStyleClass(actor: Clutter.Actor, className: string): boolean {
  const stActor = actor as any;
  return typeof stActor?.has_style_class_name === 'function' &&
    stActor.has_style_class_name(className);
}

// Converts a hexadecimal color code string to an RGB object.
export function hexToRgb(hex: string) {
  let bigint = parseInt(hex.replace('#', ''), 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255
  };
}

// Converts RGB numerical values to a hexadecimal color string.
export function rgbToHex(r: number, g: number, b: number) {
  return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
}

/**
 * Mutes or un-mutes one of BoxPointer's two input-gating flags.
 *
 * GNOME <= 50 stored them as plain booleans and did `bp._muteInput = true`,
 * a state where a truthy value means "swallow clicks/keys".
 *
 * GNOME 51 replaced them with Clutter actions added to the box pointer in
 * CAPTURE phase -- `_muteInput` is a Clutter.ClickGesture and `_muteKeys` is a
 * Clutter.KeyController -- and now toggles them with `<action>.enabled = muted`.
 *
 * Writing a boolean over those fields (what the <= 50 code did) is doubly
 * broken on 51: it never disables the real actions, so the ClickGesture keeps
 * swallowing every click aimed at the popup's buttons and the KeyController
 * keeps eating Escape; and it makes GNOME's own BoxPointer.close() throw on
 * `this._muteInput.enabled = true`, so the popup can never be dismissed by
 * click-away or Escape. Set the flag in whichever shape this shell uses.
 */
function setMuteFlag(bp: any, prop: '_muteInput' | '_muteKeys', muted: boolean): void {
  const flag = bp?.[prop];
  if (flag !== null && typeof flag === 'object' && typeof flag.enabled === 'boolean')
    flag.enabled = muted; // GNOME 51+: Clutter action controller
  else
    bp[prop] = muted;     // GNOME 49/50: plain boolean
}

/**
 * Suppresses GNOME's built-in popup open/close animation at the source by
 * overriding the per-instance open()/close() methods of a menu's _boxPointer,
 * while exactly preserving GNOME's bookkeeping (_muteKeys, _muteInput,
 * show/hide, 'menu-closed' emission, instant-close semantics).
 *
 * Returns a restore closure that puts the original methods back.
 */
export function suppressGnomePopupAnimation(menu: any, hooks: PopupAnimationHooks): () => void {
  const bp = menu?._boxPointer;
  if (!bp || bp._liquidGlassPatched) return () => {};

  const origOpen = bp.open.bind(bp);
  const origClose = bp.close.bind(bp);
  bp._liquidGlassPatched = true;

  bp.open = function (animate: number, onComplete?: () => void) {
    if (!hooks.isCustomAnimationEnabled() || !animate) {
      origOpen(animate, onComplete);
      return;
    }
    hooks.onSuppressOpen?.();
    // Mirror BoxPointer.open bookkeeping, minus the ease:
    setMuteFlag(bp, '_muteKeys', false);
    bp.remove_all_transitions();
    bp.opacity = 255;
    bp.translation_x = 0;
    bp.translation_y = 0;
    bp.set_scale(1, 1);
    bp.show();
    setMuteFlag(bp, '_muteInput', false);   // original sets this in the ease onComplete — must not skip
    if (onComplete) onComplete();
  };

  bp.close = function (animate: number, onComplete?: () => void) {
    // Defer to GNOME's own close whenever the extension's custom fade-out will
    // not run: animation/glass toggled off (keep GNOME's default animation),
    // instant close requested (animate falsy), or a stray close with no
    // open-state-changed pending (menu.isOpen already false — stashing the
    // callback here would never fire).
    if (!hooks.isCustomAnimationEnabled() || !animate || !menu.isOpen) {
      origClose(animate, onComplete);
      return;
    }

    if (!bp.visible) {
      // Nothing on screen to animate out. Still hand the close back to GNOME
      // so its own state (and _muteInput) is reset, otherwise the popup can
      // get stuck open with input muted.
      origClose(animate, onComplete);
      return;
    }
    setMuteFlag(bp, '_muteInput', true);
    setMuteFlag(bp, '_muteKeys', true);
    bp.remove_all_transitions();

    // Animated close: keep the parent visible & neutral so the extension's
    // fade-out is the only visible animation. The extension hides the actor
    // and invokes this onComplete (=> 'menu-closed') when its fade finishes.
    bp.opacity = 255;
    bp.translation_x = 0;
    bp.translation_y = 0;
    bp.set_scale(1, 1);
    // Safety net: GNOME's BoxPointer mute flags are what make a popup ignore
    // clicks (it stops dismissing itself when you click away). Our custom
    // fade-out is the only thing that clears them again, so if the fade never
    // completes the menu would stay open and undismissable.
    const restoreInput = () => {
      setMuteFlag(bp, '_muteInput', false);
      setMuteFlag(bp, '_muteKeys', false);
      // Finish the close if our fade-out never reached its end. Without this,
      // GNOME's close onComplete (which emits 'menu-closed' and makes
      // PopupMenuManager call Main.popModal) may never run, and the popup stays
      // open and undismissable -- no click-away, no Escape.
      if (menu.isOpen) {
        try {
          bp.hide();
        } catch (e) {}
        origClose(false, onComplete);
      }
    };
    hooks.onSuppressClose?.(onComplete ?? null, restoreInput);
  };

  return () => {
    if (!bp._liquidGlassPatched) return;
    bp.open = origOpen;
    bp.close = origClose;
    bp._liquidGlassPatched = false;
  };
}
