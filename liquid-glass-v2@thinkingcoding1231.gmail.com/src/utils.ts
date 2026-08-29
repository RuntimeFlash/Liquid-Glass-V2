// utils.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

/**
 * Looking Glassのピッカー（ヒットテスト）を透過するClutter.Clone
 */
export const UnpickableClone = GObject.registerClass(
  {
    GTypeName: 'LiquidGlassUnpickableClone',
  },
  class UnpickableClone extends Clutter.Clone {
    vfunc_pick(_pickContext: any): void {
      // No-op: このアクターへのヒットテストを完全にスルーする
    }
  }
);
/**
 * 自分自身と子要素すべてをLooking Glassのピッカーから透過するコンテナアクター
 */
export const UnpickableActor = GObject.registerClass(
  {
    GTypeName: 'LiquidGlassUnpickableActor',
  },
  class UnpickableActor extends Clutter.Actor {
    vfunc_pick(_pickContext: any): void {
      // No-op: 子要素も含めてヒットテストをスルーする
    }
  }
);

export interface PopupAnimationHooks {
  /** True only when the extension's custom fade will actually run this time. */
  isCustomAnimationEnabled: () => boolean;
  /** Called when GNOME's animated open is suppressed (parent snapped to neutral). */
  onSuppressOpen?: () => void;
  /** Called when GNOME's animated close is suppressed; receives the onComplete that emits 'menu-closed'. */
  onSuppressClose?: (onComplete: (() => void) | null) => void;
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
    bp._muteKeys = false;
    bp.remove_all_transitions();
    bp.opacity = 255;
    bp.translation_x = 0;
    bp.translation_y = 0;
    bp.set_scale(1, 1);
    bp.show();
    bp._muteInput = false;   // original sets this in the ease onComplete — must not skip
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

    if (!bp.visible) return;
    bp._muteInput = true;
    bp._muteKeys = true;
    bp.remove_all_transitions();

    // Animated close: keep the parent visible & neutral so the extension's
    // fade-out is the only visible animation. The extension hides the actor
    // and invokes this onComplete (=> 'menu-closed') when its fade finishes.
    bp.opacity = 255;
    bp.translation_x = 0;
    bp.translation_y = 0;
    bp.set_scale(1, 1);
    hooks.onSuppressClose?.(onComplete ?? null);
  };

  return () => {
    if (!bp._liquidGlassPatched) return;
    bp.open = origOpen;
    bp.close = origClose;
    bp._liquidGlassPatched = false;
  };
}
