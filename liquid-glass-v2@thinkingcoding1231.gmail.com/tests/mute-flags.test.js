// Verifies suppressGnomePopupAnimation() input-gating against both the
// GNOME 51 BoxPointer API (Clutter action controllers) and the GNOME 49/50
// API (plain booleans).
//
// Run: gjs -m .verify/mute-test.js
import { suppressGnomePopupAnimation } from '../dist/utils.js';

let failures = 0;
function check(name, cond) {
    if (cond)
        print(`ok   - ${name}`);
    else {
        failures++;
        print(`FAIL - ${name}`);
    }
}

function makeBp(modern) {
    const bp = {
        visible: true,
        opacity: 255,
        translation_x: 0,
        translation_y: 0,
        calls: [],
        remove_all_transitions() {},
        set_scale() {},
        show() { this.visible = true; },
        hide() { this.visible = false; },
    };
    if (modern) {
        bp._muteInput = { enabled: true };
        bp._muteKeys = { enabled: true };
    } else {
        bp._muteInput = true;
        bp._muteKeys = true;
    }
    bp.open = function (animate, onComplete) {
        this.calls.push('origOpen');
        if (onComplete) onComplete();
    };
    // Mirrors GNOME 51 BoxPointer.close()'s first statements: this is exactly
    // where a clobbered boolean field makes the shell throw.
    bp.close = function (animate, onComplete) {
        this.calls.push('origClose');
        this._muteInput.enabled = true;
        this._muteKeys.enabled = true;
        this.hide();
        if (onComplete) onComplete();
    };
    return bp;
}

print('--- GNOME 51 (Clutter action controllers) ---');
const bp = makeBp(true);
const menu = {_boxPointer: bp, isOpen: true};
let restoreInput = null;
let openHooks = 0;
let closeHooks = 0;
suppressGnomePopupAnimation(menu, {
    isCustomAnimationEnabled: () => true,
    onSuppressOpen: () => openHooks++,
    onSuppressClose: (cb, restore) => {
        closeHooks++;
        restoreInput = restore;
    },
});

bp.open(1);
check('open hook ran', openHooks === 1);
check('_muteInput is still the action object', typeof bp._muteInput === 'object' && bp._muteInput !== null);
check('_muteKeys is still the action object', typeof bp._muteKeys === 'object' && bp._muteKeys !== null);
check('open disables the click-muting gesture', bp._muteInput.enabled === false);
check('open disables the key-muting controller', bp._muteKeys.enabled === false);

bp.close(1);
// PopupMenu.close() runs super.close() AFTER calling _boxPointer.close(), and
// that flips isOpen to false before our fade-out finishes. Emulate it so the
// restoreInput backstop is exercised the way it really runs.
menu.isOpen = false;
check('close enables the click-muting gesture', bp._muteInput.enabled === true);
check('close enables the key-muting controller', bp._muteKeys.enabled === true);
check('close handed a restoreInput backstop to the hook', typeof restoreInput === 'function');

restoreInput?.();
check('backstop unmutes the click-muting gesture', bp._muteInput.enabled === false);
check('backstop unmutes the key-muting controller', bp._muteKeys.enabled === false);

// The delegated (non-animated) close must not throw: before the fix, the
// suppressed open() had replaced _muteInput with `false` and GNOME's own
// close() then threw on `false.enabled = true`, leaving the menu stuck open.
print('--- delegated close after a suppressed open ---');
const bp2 = makeBp(true);
const menu2 = {_boxPointer: bp2, isOpen: true};
suppressGnomePopupAnimation(menu2, {isCustomAnimationEnabled: () => true});
bp2.open(1);
let threw = false;
try {
    bp2.close(0); // animate falsy => delegates to GNOME's close
} catch (e) {
    threw = true;
    print(`  (threw: ${e})`);
}
check('GNOME close runs without throwing', !threw);
check('GNOME close was delegated to', bp2.calls.includes('origClose'));

print('--- GNOME 49/50 (plain booleans) ---');
const bp3 = makeBp(false);
const menu3 = {_boxPointer: bp3, isOpen: true};
suppressGnomePopupAnimation(menu3, {isCustomAnimationEnabled: () => true});
bp3.open(1);
check('open un-mutes _muteInput', bp3._muteInput === false);
check('open un-mutes _muteKeys', bp3._muteKeys === false);
bp3.close(1);
check('close mutes _muteInput', bp3._muteInput === true);
check('close mutes _muteKeys', bp3._muteKeys === true);

print('--- custom animation disabled delegates everything ---');
const bp4 = makeBp(true);
const menu4 = {_boxPointer: bp4, isOpen: true};
suppressGnomePopupAnimation(menu4, {isCustomAnimationEnabled: () => false});
bp4.open(1);
check('open delegated to GNOME', bp4.calls.includes('origOpen'));
bp4.close(1);
check('close delegated to GNOME', bp4.calls.includes('origClose'));

print('--- negative control: the pre-fix boolean clobber ---');
const ctl = {_muteInput: {enabled: true}};
ctl._muteInput = false; // what the old code did on GNOME 51
let ctlThrew = false;
try {
    ctl._muteInput.enabled = true;
} catch (e) {
    ctlThrew = true;
}
check('boolean clobber breaks GNOME close (so the test detects the old bug)', ctlThrew);

print(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
imports.system.exit(failures === 0 ? 0 : 1);
