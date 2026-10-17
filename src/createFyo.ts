import { Fyo } from 'fyo';

/**
 * Shared fyo construction for the two platform singletons.
 * src/initFyo.ts wraps this with isElectron: true (Desktop), and
 * src/initFyoWeb.ts (the Web alias target for src/initFyo) wraps it
 * with isElectron: false plus the Web store defaults.
 *
 * Spec: docs/specs/0008-web-app-shell/index.md (task 1)
 */
export function createFyo(isElectron: boolean): Fyo {
  const fyo = new Fyo({ isTest: false, isElectron });
  if (!isElectron) {
    fyo.store.language = 'English';
    fyo.store.platform = 'Web';
  }
  return fyo;
}
