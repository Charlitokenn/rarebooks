import { Fyo } from 'fyo';
import { AuthDemux } from 'fyo/demux/auth';
import { DatabaseDemuxWeb } from 'fyo/demux/dbWeb';

/**
 * Web counterpart to src/initFyo.ts. Same Fyo singleton pattern, but isElectron: false and
 * DatabaseDemuxWeb in place of the default Electron-only DatabaseDemux.
 *
 * DatabaseDemuxWeb's Clerk token getter is wired separately via setClerkTokenGetter (see
 * fyo/demux/dbWeb.ts) from rendererWeb.ts, once Clerk has loaded - not here, since this
 * module (and the Fyo instance below) loads before the Clerk plugin does.
 */
export const fyo = new Fyo({
  isTest: false,
  isElectron: false,
  AuthDemux, // unchanged - getCreds() already returns empty strings when !isElectron
  DatabaseDemux: DatabaseDemuxWeb,
});
