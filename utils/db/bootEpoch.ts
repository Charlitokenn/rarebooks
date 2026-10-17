/**
 * A monotonic counter bumped whenever the web client switches organization
 * (spec 0008 AC-9). fyo/demux/db.ts stamps it before each tenant fetch and
 * discards the response if it advanced meanwhile, so an in-flight request
 * from a previous organization can never land data in a newly booted one.
 *
 * Lives under utils/ (platform-agnostic) so the demux can import it without
 * crossing the client/server boundary; it has no logic, just a counter.
 */
let epoch = 0;

export function bumpBootEpoch(): number {
  return ++epoch;
}

export function getBootEpoch(): number {
  return epoch;
}
