import { BackdropGlass } from '../rendering/backdropGlass.js';
import { hexToColorArray } from '../animation.js';
/** Transparent padding outside the glass body, so refraction is never clipped. */
export const QS_GLASS_PADDING = 20;
/** Fallback when quick-settings-corner-radius is unset. */
export const QS_DEFAULT_CORNER_RADIUS = 18;
/** Slack added to the shadow's reach so the fade never lands on the actor edge. */
const SHADOW_MARGIN_HEADROOM = 20;

/** Room the glass body needs around it for the global drop shadow, or 0 when off. */
export function quickSettingsShadowRoom(settings) {
    const radius = settings.get_double('shadow-radius');
    const intensity = settings.get_double('shadow-intensity');
    if (!(radius > 0) || !(intensity > 0))
        return 0;
    return Math.ceil(radius) + SHADOW_MARGIN_HEADROOM;
}

export function quickSettingsCornerRadius(settings) {
    return settings.get_double('quick-settings-corner-radius') || QS_DEFAULT_CORNER_RADIUS;
}

/** Applies the Quick Settings surface settings and returns the shadow room used. */
export function applyQuickSettingsGlassAppearance(glass, settings, cornerRadius = quickSettingsCornerRadius(settings)) {
    const room = quickSettingsShadowRoom(settings);
    glass.setPadding(QS_GLASS_PADDING);
    glass.setIsDock(false);
    glass.setTintColor(...hexToColorArray(settings.get_string('quick-settings-tint-color')));
    glass.setTintStrength(settings.get_double('quick-settings-tint-strength'));
    glass.setBlurRadius(settings.get_int('quick-settings-blur-radius'));
    glass.setCornerRadius(cornerRadius);
    glass.setShadowMaxRadius(room);
    return room;
}

/** A BackdropGlass configured like the Quick Settings grid's glass. */
export function createQuickSettingsGlass(manager, options) {
    const glass = new BackdropGlass({
        extensionPath: manager.extensionPath,
        settings: manager._settings,
        logger: manager._logger,
        owner: options.owner,
        outline: options.outline,
    });
    if (options.multiRegion)
        glass.setMultiRegionMode(true);
    applyQuickSettingsGlassAppearance(glass, manager._settings, options.cornerRadius);
    return glass;
}
