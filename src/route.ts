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

/**
 * Where `main.ts` leaves a shared link's circuit for the render worker:
 * a folder of the origin's private storage, and the record in it. The
 * worker's name is `link`, or `link+main`, while one is waiting.
 */
export const LINK_STORE = 'gessologic-link';
export const INCOMING_LINK = 'incoming';

/** Whether the render worker was started to open a shared link, from its name. */
export function openingLink(workerName: string): boolean {
  return workerName === 'link' || workerName.startsWith('link+');
}
