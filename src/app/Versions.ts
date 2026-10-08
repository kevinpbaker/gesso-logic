/**
 * Earlier versions of the document, kept so that no change is past
 * taking back: not undo, which forgets on reload and on opening another
 * file, but copies of the whole circuit, in the origin's private file
 * system, listed by when they were made.
 *
 * A copy is kept
 *
 *   - **before the first change** to a document opened or brought back,
 *     so what it was is always one step away;
 *   - **every few minutes while it changes**, at the autosave;
 *   - **before it is replaced** — another file opened, an example, a
 *     link — whether or not it was saved;
 *   - **before an earlier version is restored**, so restoring is itself
 *     undone by restoring.
 *
 * A copy the same as the newest is not kept again. Past `MAX_VERSIONS`,
 * or `MAX_VERSION_BYTES` in all, the oldest go.
 *
 * Each copy is a file of its own, and an index lists them, so the list
 * opens without reading a megabyte of circuits. Writes go one at a
 * time, in order, so the index never names a copy not yet written.
 */

/** The three methods of Gesso's `StorageAdapter` this uses: `OpfsStorage` in the worker, a map in a spec. */
export interface VersionStore {
  read(key: string): Promise<{ readonly value: string | null }>;
  write(key: string, value: string): Promise<unknown>;
  remove(key: string): Promise<unknown>;
}

export type VersionReason = 'opened' | 'editing' | 'replaced' | 'restored';

export interface VersionEntry {
  readonly id: number;
  /** When it was kept, in milliseconds since the epoch. */
  readonly at: number;
  readonly reason: VersionReason;
  /** The file it was, or null for a circuit never saved. */
  readonly name: string | null;
  readonly parts: number;
  readonly bytes: number;
  /** A fingerprint of its text, for not keeping the same circuit twice running. */
  readonly hash: string;
}

/** What a copy holds: the document as file text, and which file it was. */
export interface VersionRecord {
  readonly file: string;
  readonly name: string | null;
  readonly handle: number | null;
  /** The chips as the document was opened, where they differ, for Reset: see the autosave. */
  readonly originals?: string;
}

export const MAX_VERSIONS = 50;
export const MAX_VERSION_BYTES = 32 * 1024 * 1024;
/** The least time between two copies kept while editing. */
export const VERSION_EVERY_MS = 5 * 60_000;

const INDEX = 'index';
const keyOf = (id: number) => `version-${id}`;

/** FNV-1a, 32 bits: enough to tell one circuit's text from the next. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class Versions {
  private index: VersionEntry[] = [];
  private nextId = 1;
  /** The writes in flight, one after another. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly store: VersionStore;
  private readonly now: () => number;

  constructor(store: VersionStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** Newest first. */
  get list(): readonly VersionEntry[] {
    return this.index;
  }

  /** When the newest copy was kept; -Infinity before any. */
  get newestAt(): number {
    return this.index[0]?.at ?? Number.NEGATIVE_INFINITY;
  }

  /** Reads the index. An index that cannot be read is an empty one: the next copy starts it again. */
  async load(): Promise<void> {
    try {
      const { value } = await this.store.read(INDEX);
      const parsed = value === null ? [] : (JSON.parse(value) as VersionEntry[]);
      this.index = Array.isArray(parsed) ? parsed.filter(e => typeof e?.id === 'number').sort((a, b) => b.at - a.at || b.id - a.id) : [];
    } catch {
      this.index = [];
    }
    this.nextId = this.index.reduce((most, e) => Math.max(most, e.id), 0) + 1;
  }

  /**
   * Keeps a copy, unless it is the newest one again. Resolves with its
   * entry once it and the index are written, or null when it was not
   * kept. The list changes at once.
   */
  keep(record: VersionRecord, reason: VersionReason, parts: number): Promise<VersionEntry | null> {
    const text = JSON.stringify(record);
    const hash = fingerprint(record.file);
    if (this.index[0]?.hash === hash) return Promise.resolve(null);
    const entry: VersionEntry = { id: this.nextId++, at: this.now(), reason, name: record.name, parts, bytes: text.length, hash };
    this.index = [entry, ...this.index];
    // The oldest go past the limits, but never the one just kept.
    const dropped: VersionEntry[] = [];
    let bytes = this.index.reduce((sum, e) => sum + e.bytes, 0);
    while (this.index.length > 1 && (this.index.length > MAX_VERSIONS || bytes > MAX_VERSION_BYTES)) {
      const oldest = this.index.pop()!;
      bytes -= oldest.bytes;
      dropped.push(oldest);
    }
    const index = JSON.stringify(this.index);
    const written = this.queue.then(async () => {
      await this.store.write(keyOf(entry.id), text);
      await this.store.write(INDEX, index);
      for (const old of dropped) await this.store.remove(keyOf(old.id));
      return entry;
    });
    // A failed write leaves the queue usable for the next.
    this.queue = written.catch(() => null);
    return written.catch(() => null);
  }

  /** A copy's contents, or null when it is gone or cannot be read. */
  async read(id: number): Promise<VersionRecord | null> {
    await this.queue;
    try {
      const { value } = await this.store.read(keyOf(id));
      if (value === null) return null;
      const record = JSON.parse(value) as VersionRecord;
      return typeof record?.file === 'string' ? record : null;
    } catch {
      return null;
    }
  }
}
