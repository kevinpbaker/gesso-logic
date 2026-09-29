import type { Circuit } from '../sim/Circuit';
import { library, LIBRARY_NOTES, LIBRARY_ORDER, libraryWithDependencies, type LibraryName } from '../sim/Library';
import { shapeOf, type KindLayout } from './Layout';
import { layOut } from './Scenes';

/**
 * The standard library as a document sees it: each definition laid out,
 * ready to open, and the body an instance of each takes, for the palette.
 * `src/sim/Library.ts` builds the gates; this is only where they go.
 */

let laidOut: Record<string, Circuit> | null = null;

/** Every library definition, laid out; made once. */
export function libraryChips(): Readonly<Record<string, Circuit>> {
  if (laidOut === null) {
    const raw = library();
    const out: Record<string, Circuit> = {};
    for (const name of LIBRARY_ORDER) {
      // Laid out with the whole library to hand, so a part made of parts
      // knows how big they are.
      const { chips: _, ...definition } = layOut({ ...raw[name], chips: raw });
      out[name] = definition as Circuit;
    }
    laidOut = out;
  }
  return laidOut;
}

/** A library part and the parts it is made of, laid out, by name. */
export function libraryPart(name: LibraryName): Record<string, Circuit> {
  const chips = libraryChips();
  return Object.fromEntries(Object.keys(libraryWithDependencies(name)).map(part => [part, chips[part]!]));
}

export function isLibraryName(name: string): name is LibraryName {
  return (LIBRARY_ORDER as readonly string[]).includes(name);
}

/** The palette's view of the library: each part's name, body and note, in order. */
export const LIBRARY_PALETTE: readonly { readonly name: LibraryName; readonly shape: KindLayout; readonly note: string }[] =
  LIBRARY_ORDER.map(name => ({
    name,
    shape: shapeOf({ id: '', kind: 'chip', chip: name, x: 0, y: 0 }, library()) as KindLayout,
    note: LIBRARY_NOTES[name]
  }));
