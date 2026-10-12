import GObject from 'gi://GObject';
// gjs answers GObject.Object.prototype.toString from the JS wrapper, so it can
// report "(DISPOSED)" without touching the C object. String(actor) is not an
// option: the shell overrides Clutter.Actor.prototype.toString with
// St.describe_actor(), a C call that logs a critical on a disposed actor.
const _gobjectToString = GObject.Object.prototype.toString;

/**
 * Whether an actor is still alive. A disposed wrapper neither throws nor
 * returns undefined in gjs (it logs a critical and returns the property's
 * default), so this is the only reliable test.
 */
export function isActorValid(actor) {
    if (!actor)
        return false;
    // Menu items, settings rows and similar plain JS objects reach this through
    // the Quick Settings submenu scrapers; the GObject toString below throws on
    // them, which must read as "not an actor" rather than abort the caller.
    let desc;
    try {
        desc = _gobjectToString.call(actor);
    }
    catch (e) {
        return false;
    }
    if (desc.includes('(DISPOSED)') || desc.includes('(FINALIZED)'))
        return false;
    // Rejects values that are not actors at all.
    return typeof actor.visible === 'boolean';
}
