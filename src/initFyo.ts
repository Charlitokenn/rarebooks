import { Fyo } from 'fyo';
import { DatabaseDemuxWeb } from 'fyo/demux/dbWeb';

/**
 * Global fyo: this is meant to be used only by the app. For
 * testing purposes a separate instance of fyo should be initialized.
 *
 * Auto-detects Electron vs web at runtime (same check Fyo.setIsElectron() already used
 * elsewhere: window.ipc's presence) rather than needing two separate singleton files that
 * every shared file (router.ts, etc.) would have to know to pick between correctly. When
 * window.ipc exists (Electron), DatabaseDemux is left undefined so DatabaseHandler falls
 * back to its own default electron DatabaseDemux import - behavior is unchanged from
 * before for the Electron build. When it doesn't (web), DatabaseDemuxWeb is used instead.
 */
const isElectron = typeof window !== 'undefined' && !!(window as unknown as { ipc?: unknown }).ipc;

export const fyo = new Fyo({
  isTest: false,
  isElectron,
  DatabaseDemux: isElectron ? undefined : DatabaseDemuxWeb,
});
