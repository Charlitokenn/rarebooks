import { createFyo } from './createFyo';

/**
 * Global fyo: this is meant to be used only by the app. For
 * testing purposes a separate instance of fyo should be initialized.
 *
 * On the Web build this specifier resolves to src/initFyoWeb.ts via the
 * alias in vite.config.web.ts, so the 49+ desktop importers are untouched
 * (spec 0008 AC-7).
 */

export const fyo = createFyo(true);
