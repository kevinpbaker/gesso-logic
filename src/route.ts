/**
 * Which page is being asked for, answered from `location` on the main
 * thread and handed to the render worker as its name.
 *
 * `/` is the simulator. `/proof` is the same simulator with Phase 7's
 * instruments: the strip along the top, on the main thread, and in the
 * render worker the 10,000-gate scene with a full-speed switch. The
 * strip has to be decided here, because it is the one part of the page
 * that is not in a worker — which is the whole reason to believe it.
 */
export const PROOF_PATH = '/proof';

export function isProofPath(path: string): boolean {
  return path === PROOF_PATH || path === `${PROOF_PATH}/`;
}
