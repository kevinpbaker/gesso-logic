import type { Circuit } from '../sim/Circuit';
import { readCircuit, writeCircuit } from '../sim/CircuitFile';
import { chipsUsedBy } from './DocumentEdits';
import type { VersionStore } from './Versions';

/**
 * A person's own chips, kept apart from any document: a chip made in one
 * circuit is there to place in the next, as the standard library's are.
 *
 * Each is a chip definition and the chips it is made of, stored as a
 * circuit file — the definition at the top, its parts' definitions under
 * `chips` — in the origin's private file system, with an index listing
 * them. Placing one brings it into the document as importing a file
 * does, so a name the document already uses for something else is
 * numbered rather than replaced. Saving a chip under a name already
 * kept replaces what was kept.
 *
 * The index is read again before each change, so two tabs saving chips
 * do not lose each other's.
 */

export interface MyChip {
  readonly name: string;
  /** When it was last saved, in milliseconds since the epoch. */
  readonly savedAt: number;
  /** The definition, with the definitions it uses as its `chips`. */
  readonly circuit: Circuit;
}

const INDEX = 'index';
/** The most chips kept: far past a person's own, short of a store that takes long to read. */
export const MAX_MY_CHIPS = 200;

/** Where a chip's file is kept: its name, made safe for a file name, and its index for uniqueness. */
const keyOf = (id: number) => `chip-${id}`;

interface Entry {
  readonly id: number;
  readonly name: string;
  readonly savedAt: number;
}

export class MyChips {
  private entries: Entry[] = [];
  private readonly loaded = new Map<string, MyChip>();
  private readonly store: VersionStore;
  private readonly now: () => number;

  constructor(store: VersionStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** The chips kept, by name, each read in full. */
  get list(): readonly MyChip[] {
    return this.entries.map(e => this.loaded.get(e.name)).filter((c): c is MyChip => c !== undefined);
  }

  get(name: string): MyChip | undefined {
    return this.loaded.get(name);
  }

  /** Reads the index and every chip in it. One that cannot be read is left out. */
  async load(): Promise<void> {
    this.entries = await this.readIndex();
    this.loaded.clear();
    for (const entry of this.entries) {
      try {
        const { value } = await this.store.read(keyOf(entry.id));
        if (value !== null) this.loaded.set(entry.name, { name: entry.name, savedAt: entry.savedAt, circuit: readCircuit(value) });
      } catch {
        // A chip that does not read is one that is not there.
      }
    }
    this.entries = this.entries.filter(e => this.loaded.has(e.name));
  }

  private async readIndex(): Promise<Entry[]> {
    try {
      const { value } = await this.store.read(INDEX);
      const parsed = value === null ? [] : (JSON.parse(value) as Entry[]);
      return Array.isArray(parsed) ? parsed.filter(e => typeof e?.id === 'number' && typeof e?.name === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Keeps a document's chip under its name, with the chips it is made
   * of; a chip already kept under that name is replaced. Resolves false
   * when there is no such chip or no room for another.
   */
  async save(document: Circuit, name: string): Promise<boolean> {
    const definition = document.chips?.[name];
    if (definition === undefined) return false;
    const { chips: _, ...body } = definition;
    const circuit: Circuit = { ...body, chips: chipsUsedBy(definition.components, document.chips) };
    const index = await this.readIndex();
    const was = index.find(e => e.name === name);
    if (was === undefined && index.length >= MAX_MY_CHIPS) return false;
    const id = was?.id ?? index.reduce((most, e) => Math.max(most, e.id), 0) + 1;
    const entry: Entry = { id, name, savedAt: this.now() };
    await this.store.write(keyOf(id), writeCircuit(circuit));
    await this.store.write(INDEX, JSON.stringify([...index.filter(e => e.name !== name), entry].sort((a, b) => a.name.localeCompare(b.name))));
    this.entries = [...this.entries.filter(e => e.name !== name), entry].sort((a, b) => a.name.localeCompare(b.name));
    this.loaded.set(name, { name, savedAt: entry.savedAt, circuit });
    return true;
  }

  async remove(name: string): Promise<void> {
    const index = await this.readIndex();
    const gone = index.find(e => e.name === name);
    await this.store.write(INDEX, JSON.stringify(index.filter(e => e.name !== name)));
    if (gone !== undefined) await this.store.remove(keyOf(gone.id));
    this.entries = this.entries.filter(e => e.name !== name);
    this.loaded.delete(name);
  }
}
