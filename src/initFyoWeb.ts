import type { Fyo } from 'fyo';
import { createFyo } from './createFyo';

/**
 * Global fyo for the Web target. This module is what the `src/initFyo`
 * specifier resolves to in the web bundle (alias in vite.config.web.ts),
 * so the desktop chrome's importers all share one instance here
 * (spec 0008 AC-7). isElectron: false routes fyo/demux/*.ts to their
 * fetch()-based web branch instead of ipc calls — see fyo/demux/db.ts.
 *
 * resetWebFyo() swaps the singleton on organization switch; ESM live
 * bindings mean every `import { fyo } from 'src/initFyo'` consumer sees
 * the new instance without touching the importers.
 *
 * Specs: docs/specs/0001-web-platform-foundation-control-plane.md (AC-6),
 * docs/specs/0008-web-app-shell/index.md (task 1)
 */
function createWebFyo(): Fyo {
  return createFyo(false);
}

export let fyo = createWebFyo();

export function resetWebFyo(): Fyo {
  fyo = createWebFyo();
  return fyo;
}
