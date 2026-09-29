import type { DocumentSummary, Status } from '../app/CircuitContract';

/**
 * The parts on the level shown that drive a net that will not settle.
 *
 * A net is named for the pin that drives it, through the chips it is
 * inside — `fa3/g1.out` — so the part on this level is the first step
 * of the name once the path to this level is taken off. A ringing net
 * that is not under this level has no part here to point at.
 */
export function ringingParts(d: Pick<DocumentSummary, 'path'>, s: Pick<Status, 'ringing'>): string[] {
  const prefix = d.path.length === 0 ? '' : `${d.path.map(level => level.id).join('/')}/`;
  const ids = new Set<string>();
  for (const name of s.ringing) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const id = rest.split(/[/.]/)[0];
    if (id !== undefined && id !== '') ids.add(id);
  }
  return [...ids].sort();
}
