import type { Circuit } from '../sim/Circuit';
import type { Kind } from '../sim/Primitives';

/**
 * Finding parts by name at any depth: what Find (Ctrl+F) asks the
 * application worker for, since only it has every level.
 *
 * A part matches on its label, or its id where it has none, or — for a
 * chip — the name of the chip it is an instance of. The levels are
 * walked a level at a time from the top, so the shallow parts come
 * first: the CPU before the 128 bytes of RAM inside it, each of which
 * has a `Q`. The walk stops after `VISIT_LIMIT` parts, which the
 * showpiece's 8,559 gates and their wiring fit inside.
 */

export interface FoundPart {
  /** The chips that open its level, from the top. */
  readonly path: readonly string[];
  readonly id: string;
  /** What it is called: its label, or its id. */
  readonly name: string;
  readonly kind: Kind;
  /** For a chip, the chip it is an instance of; null for any other part. */
  readonly chip: string | null;
  /** Where it is, as a person reads it: `cpu › datapath`, or `top`. */
  readonly where: string;
}

/** The most results a search gives. */
export const FIND_LIMIT = 50;
/** The most parts a search looks at before it gives what it has. */
export const VISIT_LIMIT = 40_000;

/**
 * How well `text` matches `query`, both already lower case: 0 exactly,
 * 1 at its start, 2 at a word's start, 3 anywhere; null not at all.
 */
function rank(text: string, query: string): number | null {
  if (text === query) return 0;
  if (text.startsWith(query)) return 1;
  const at = text.indexOf(query);
  if (at < 0) return null;
  return /[\s./_×→-]/.test(text[at - 1]!) ? 2 : 3;
}

export function findParts(document: Circuit, query: string, limit = FIND_LIMIT): FoundPart[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') return [];
  const found: { part: FoundPart; rank: number; depth: number; order: number }[] = [];
  let level: { circuit: Circuit; path: readonly string[]; titles: readonly string[] }[] = [{ circuit: document, path: [], titles: [] }];
  let visited = 0;
  // Enough, a level at a time, to rank: the best of the shallowest.
  while (level.length > 0 && visited < VISIT_LIMIT && found.length < limit * 4) {
    const next: typeof level = [];
    for (const { circuit, path, titles } of level) {
      for (const c of circuit.components) {
        if (++visited > VISIT_LIMIT) break;
        const name = c.label ?? c.id;
        const chip = c.kind === 'chip' ? (c.chip ?? null) : null;
        const best = Math.min(rank(name.toLowerCase(), wanted) ?? 9, chip === null ? 9 : (rank(chip.toLowerCase(), wanted) ?? 9));
        if (best < 9) {
          found.push({
            part: { path, id: c.id, name, kind: c.kind, chip, where: titles.length === 0 ? 'top' : titles.join(' › ') },
            rank: best,
            depth: path.length,
            order: found.length
          });
        }
        const definition = chip === null ? undefined : document.chips?.[chip];
        if (definition !== undefined) next.push({ circuit: definition, path: [...path, c.id], titles: [...titles, name] });
      }
    }
    level = next;
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.order - b.order)
    .slice(0, limit)
    .map(f => f.part);
}
