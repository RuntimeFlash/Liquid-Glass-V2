// utils.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

/**
 * A Clutter.Clone the Looking Glass picker passes through.
 */
export const UnpickableClone = GObject.registerClass({
    GTypeName: 'LiquidGlassQsUnpickableClone',
}, class UnpickableClone extends Clutter.Clone {
    vfunc_pick(_pickContext) {
        // Picks fall through to the actors behind.
    }
});

/**
 * A container the picker passes through, along with all of its children.
 */
export const UnpickableActor = GObject.registerClass({
    GTypeName: 'LiquidGlassQsUnpickableActor',
}, class UnpickableActor extends Clutter.Actor {
    vfunc_pick(_pickContext) {
        // Picks fall through to the actors behind.
    }
});

export function hasStyleClass(actor, className) {
    const stActor = actor;
    return typeof stActor?.has_style_class_name === 'function' &&
        stActor.has_style_class_name(className);
}

// Converts a hexadecimal color code string to an RGB object.
export function hexToRgb(hex) {
    let bigint = parseInt(hex.replace('#', ''), 16);
    return {
        r: (bigint >> 16) & 255,
        g: (bigint >> 8) & 255,
        b: bigint & 255
    };
}

// Converts RGB numerical values to a hexadecimal color string.
export function rgbToHex(r, g, b) {
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
function setMuteFlag(bp, prop, muted) {
    const flag = bp?.[prop];
    if (flag !== null && typeof flag === 'object' && typeof flag.enabled === 'boolean')
        flag.enabled = muted; // GNOME 51+: Clutter action controller
    else
        bp[prop] = muted; // GNOME 49/50: plain boolean
}

/**
 * Suppresses GNOME's built-in popup open/close animation at the source by
 * overriding the per-instance open()/close() methods of a menu's _boxPointer,
 * while exactly preserving GNOME's bookkeeping (_muteKeys, _muteInput,
 * show/hide, 'menu-closed' emission, instant-close semantics).
 *
 * Returns a restore closure that puts the original methods back.
 */
export function suppressGnomePopupAnimation(menu, hooks) {
    const bp = menu?._boxPointer;
    if (!bp || bp._liquidGlassPatched)
        return () => { };
    const origOpen = bp.open.bind(bp);
    const origClose = bp.close.bind(bp);
    bp._liquidGlassPatched = true;
    bp.open = function (animate, onComplete) {
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
        setMuteFlag(bp, '_muteInput', false); // original sets this in the ease onComplete — must not skip
        if (onComplete)
            onComplete();
    };
    bp.close = function (animate, onComplete) {
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
                }
                catch (e) { }
                origClose(false, onComplete);
            }
        };
        hooks.onSuppressClose?.(onComplete ?? null, restoreInput);
    };
    return () => {
        if (!bp._liquidGlassPatched)
            return;
        bp.open = origOpen;
        bp.close = origClose;
        bp._liquidGlassPatched = false;
    };
}
