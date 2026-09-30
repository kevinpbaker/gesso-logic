import { channel } from 'gesso-framework';

import type { PinRef, Rotation } from '../sim/Circuit';
import type { Fragment } from './DocumentEdits';
import type { KindLayout } from './Layout';
import type { Kind } from '../sim/Primitives';

/**
 * The barrier between the application worker, which owns the circuit
 * and runs it, and the render worker, which draws it.
 *
 * Four view keys, split by how often they change, because the differ
 * walks a key every time it is published and a key that changes every
 * frame must not drag one that changes on an edit along with it:
 *
 *   - `document` — a summary: revision, counts, the compile error if
 *     there is one. Changes on an edit.
 *   - `geometry` — where everything is, keyed by id: components, and
 *     wires with the net each is on. Changes on an edit. The render
 *     worker never sees the netlist; it sees this.
 *   - `signals` — which nets are high, packed 256 to a hex string, only
 *     for nets in the viewport. Changes every frame the circuit runs.
 *   - `status` — running or not, the clock rate asked for and achieved,
 *     and any oscillation. Changes a few times a second while running.
 *
 * Keyed maps rather than arrays, because Phase 0 measured an array-shaped
 * view at 80× the bytes of a keyed one: a change near the front shifts
 * every element, and the differ re-sends them all.
 */

export interface DocumentSummary {
  /** Bumped on every edit that changed the document. */
  readonly revision: number;
  /**
   * Bumped when a document is opened — a scene loaded, and from Phase 6 a
   * file — and not by edits. The canvas frames the view on this, and
   * only this: framing on the first component placed fitted one switch
   * to the window.
   */
  readonly opened: number;
  readonly components: number;
  readonly gates: number;
  readonly wires: number;
  readonly nets: number;
  /** Why the document does not compile, or null when it does. While it does not, nothing runs. */
  readonly error: string | null;
  /** Whether there is an edit to undo, or an undone one to redo. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The file the document was opened from or last saved to; null for one never saved. */
  readonly name: string | null;
  /** The shell's handle to that file, for Save to write back to; null when there is none. */
  readonly handle: number | null;
  /** Changed since it was opened or saved. */
  readonly dirty: boolean;
  /**
   * Where the view was when the document was last seen, for the canvas
   * to open at instead of fitting the circuit; null to fit. Set when a
   * reload restores the autosave, and on nothing else.
   */
  readonly camera: Camera | null;
  /** The last thing a file operation had to say — saved, or why an open failed — or null. */
  readonly message: string | null;
  /**
   * Which level is on the canvas: the chips opened from the top, each
   * by its instance id and its definition's name. Empty at the top. A
   * level inside a chip is shown live and read-only.
   */
  readonly path: readonly { readonly id: string; readonly chip: string }[];
  /** True for the document a first visit opened (see `restore`), until another is opened: the page greets it. */
  readonly welcome: boolean;
  /** The document's chip definitions, by name, with the body each gives an instance: for the palette. */
  readonly chips: readonly { readonly name: string; readonly shape: KindLayout }[];
  /** The standard library, for the palette: each part's name, body and a line on what it does. Placing one brings it in. */
  readonly library: readonly { readonly name: string; readonly shape: KindLayout; readonly note: string }[];
}

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/**
 * A save the application worker has made ready: the document as file
 * text, for the render worker to hand to the shell's picker. A command
 * cannot return a value, so the text comes back as a view key. `serial`
 * counts requests, so the same text asked for twice is two saves; 0 is
 * none. Cleared by `finishSave`, so a megabyte of circuit does not sit
 * in the replica.
 */
export interface SaveRequest {
  readonly serial: number;
  readonly name: string;
  readonly text: string;
  /** Where to write: the open file's handle, or null for a picker (Save As). */
  readonly handle: number | null;
}

export interface ComponentGeometry {
  readonly kind: Kind;
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  readonly label: string | null;
  /** The net each pin is on, by pin name. Empty while the document does not compile. */
  readonly nets: Readonly<Record<string, number>>;
  /** A chip's definition name and the body it gives it; null for every other kind. */
  readonly chip: string | null;
  /** How many bits wide it is: its `width`, or 1. */
  readonly width: number;
  readonly shape: KindLayout | null;
}

export interface WireGeometry {
  readonly from: PinRef;
  readonly to: PinRef;
  /** The net the wire is on, or -1 while the document does not compile; for a bus, its first bit's. */
  readonly net: number;
  /** How many bits wide it is. */
  readonly width: number;
  /** A bus's nets, least significant bit first; empty for a one-bit wire. */
  readonly bits: readonly number[];
}

/**
 * Entries by id, in buckets by a hash of the id: see `bucketOf`. Read
 * them with `entryOf` and `entriesOf`.
 */
export type Buckets<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

export interface Geometry {
  readonly components: Buckets<ComponentGeometry>;
  readonly wires: Buckets<WireGeometry>;
  /**
   * Which level this is, as the path's instance ids joined with `/`: ''
   * at the top. The summary and the geometry are separate keys, and one
   * can arrive before the other; a canvas framing a newly opened chip
   * waits for geometry of that level.
   */
  readonly level: string;
  /** The document's `opened` count when this was published: a canvas framing a document just opened waits for its geometry. */
  readonly opened: number;
}

export interface Signals {
  /** Clock cycles run, for telling one snapshot from the next. */
  readonly cycle: number;
  /** Chunk id → 64 hex digits; see `SignalPacking.ts`. Only chunks with a visible net are present. */
  readonly chunks: Readonly<Record<string, string>>;
}

export type ClockRate = number | 'max';

/** The documents the application can open by name, until Phase 6 opens files. */
export type SceneName = 'empty' | 'bench' | 'counter' | 'adder' | 'bus adder' | 'ram' | 'datapath' | 'computer' | 'diagonal';

export interface Status {
  readonly running: boolean;
  /** Clock cycles a second asked for, or `max` for as fast as the machine allows. */
  readonly clockHz: ClockRate;
  /** Clock cycles a second achieved over the last second of running; 0 while paused. */
  readonly achievedHz: number;
  readonly cycles: number;
  /** The nets that were ringing when the circuit last failed to settle, by name; empty when it settles. */
  readonly ringing: readonly string[];
}

/**
 * Every command that creates something takes the id to give it, so the
 * render worker can select what it just made without waiting to be told
 * its name. A command whose id is already taken does nothing.
 *
 * Edits that belong to one gesture — the moves of a single drag — carry
 * the same `gesture` string, and undo takes the whole gesture back at
 * once rather than one pointer event at a time.
 */
/**
 * The truth table of the selection the person asked about, kept up to
 * date as they edit. Small by construction — at most 256 rows — so
 * arrays rather than keyed records.
 */
export interface TableView {
  /** The components tabulated, or none when no table is open. */
  readonly ids: readonly string[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly rows: readonly string[];
  readonly error: string | null;
}

/**
 * Text for the clipboard, made by the application worker, which alone
 * has whole parts — labels, values, rates, which chip a chip is, and the
 * definitions it needs. As with `SaveRequest`, `serial` counts copies
 * so the same text copied twice is two copies; 0 is none.
 */
export interface ClipRequest {
  readonly serial: number;
  readonly text: string;
}

/**
 * The logic analyser's panel: what is traced, what is held, and the
 * window the panel asked for — a column an entry (see `AnalyserWindow`
 * in `Analyser.ts`). Published only while the panel is open, at the rate
 * signals are.
 */
export interface AnalyserView {
  readonly open: boolean;
  readonly traces: readonly { readonly id: string; readonly name: string; readonly width: number }[];
  /** The oldest cycle held and the newest; `last` is `first - 1` when none is. */
  readonly first: number;
  readonly last: number;
  /** Whether the window follows the newest cycle, as it does until someone scrubs. */
  readonly following: boolean;
  readonly start: number;
  readonly step: number;
  readonly count: number;
  readonly data: Readonly<Record<string, string>>;
  readonly trigger: { readonly trace: string; readonly value: number } | null;
}

export interface CircuitCommands {
  /** Adds a component. With no id, one is made from the kind. */
  place(kind: Kind, x: number, y: number, id?: string, rotation?: Rotation, chip?: string, width?: number): void;
  /** Joins two pins with a wire. With no id, one is made. */
  connect(from: PinRef, to: PinRef, id?: string): void;
  move(id: string, x: number, y: number): void;
  /** Moves components by an offset: a selection dragged. */
  moveBy(ids: readonly string[], dx: number, dy: number, gesture?: string): void;
  /** Turns components a quarter turn clockwise. */
  rotate(ids: readonly string[]): void;
  /** Removes components and wires; wires left with an end on nothing go too. */
  remove(ids: readonly string[]): void;
  /** Adds components and wires whose ids are already fresh: paste, duplicate. */
  insert(fragment: Fragment): void;
  undo(): void;
  redo(): void;
  /** Replaces the document with a named one, and forgets its history. */
  loadScene(name: SceneName): void;
  /**
   * Replaces the document with the computer, running this program's
   * assembly source from its ROM; `name` is what to call it when it
   * does not assemble.
   */
  /** The computer running `source`, clocked at `rate` (60 Hz unless it says). */
  loadProgram(name: string, source: string, rate?: number): void;
  /** Drives an input component, as a person flipping a switch does. */
  /** Sets a switch: a bit, or for a wide one a number. */
  setInput(id: string, value: number): void;
  /** Makes these components `width` bits wide; see `setWidth` in `DocumentEdits`. */
  setWidth(ids: readonly string[], width: number): void;
  run(): void;
  pause(): void;
  /** One clock cycle, while paused. */
  step(): void;
  setClockHz(rate: ClockRate): void;
  /** The world rectangle on screen. Until the first one, every net is published. */
  setViewport(left: number, top: number, right: number, bottom: number): void;
  /** Opens the truth table of these components; an empty list closes it. */
  tabulate(ids: readonly string[]): void;
  /** Opens a circuit file's text, read from `name`; `handle` is the shell's, when it gave one. */
  open(text: string, name: string, handle: number | null): void;
  /** Asks for the document as file text, published as `saving`. `asNew` is Save As. */
  requestSave(asNew: boolean): void;
  /** Says how a save went: where it was written, or null when it was cancelled or failed, with why. */
  finishSave(saved: { readonly name: string; readonly handle: number | null } | null, message: string | null): void;
  /** Where the view is, for the autosave to bring back. */
  rememberCamera(x: number, y: number, scale: number): void;
  /**
   * Brings back the autosave, and starts autosaving. Sent once, at
   * start, by an application that wants it — not by the bench, which
   * loads its own scene and must not overwrite a person's work.
   */
  /** Brings back what was open when the tab closed; with nothing saved, opens `first` — a program for the computer — running. */
  restore(first?: { readonly name: string; readonly source: string; readonly rate: number }): void;
  /** Makes the selected components into a chip, named `name` or the next free `chip N`. */
  makeChip(ids: readonly string[], name?: string): void;
  /** Opens a chip on the current level, to show its insides live. */
  openChip(id: string): void;
  /** Steps back out to `depth` levels from the top: 0 is the top. */
  closeChip(depth: number): void;
  /** Renames a chip definition, and every instance of it. */
  renameChip(from: string, to: string): void;
  /** Adds a circuit file's text to the document as a chip, named after the file, ready to place from the palette. */
  importChip(text: string, fileName: string): void;
  /**
   * Opens the analyser on a window of `span` cycles from `start`, drawn
   * in `columns` pixels; a null start follows the newest cycle. Zero
   * columns closes it.
   */
  setAnalyserView(start: number | null, span: number, columns: number): void;
  /** Pauses the circuit on the cycle `trace` becomes `value`; a null trace disarms it. */
  setTrigger(trace: string | null, value: number): void;
  /** Puts these parts, and the chips they use, on the clipboard as text: published as `clipboard`. */
  copy(ids: readonly string[]): void;
  /** Copies these parts in place, moved by (dx, dy), under the new ids `rename` gives, by old id, for parts and the wires between them. */
  duplicate(ids: readonly string[], rename: Readonly<Record<string, string>>, dx: number, dy: number): void;
}

export interface CircuitView {
  readonly document: DocumentSummary;
  readonly geometry: Geometry;
  readonly signals: Signals;
  readonly status: Status;
  readonly table: TableView;
  readonly saving: SaveRequest;
  readonly clipboard: ClipRequest;
  readonly analyser: AnalyserView;
}

export const EMPTY_SUMMARY: DocumentSummary = {
  revision: 0,
  opened: 0,
  components: 0,
  gates: 0,
  wires: 0,
  nets: 0,
  error: null,
  canUndo: false,
  canRedo: false,
  name: null,
  handle: null,
  dirty: false,
  camera: null,
  message: null,
  path: [],
  welcome: false,
  chips: [],
  library: []
};
export const NO_SAVE: SaveRequest = { serial: 0, name: '', text: '', handle: null };
export const NO_CLIP: ClipRequest = { serial: 0, text: '' };
export const CLOSED_ANALYSER: AnalyserView = {
  open: false,
  traces: [],
  first: 0,
  last: -1,
  following: true,
  start: 0,
  step: 1,
  count: 0,
  data: {},
  trigger: null
};
export const EMPTY_GEOMETRY: Geometry = { components: {}, wires: {}, level: '', opened: 0 };
export const EMPTY_SIGNALS: Signals = { cycle: 0, chunks: {} };
export const NO_TABLE: TableView = { ids: [], inputs: [], outputs: [], rows: [], error: null };
export const INITIAL_STATUS: Status = { running: false, clockHz: 'max', achievedHz: 0, cycles: 0, ringing: [] };

export const Circuit = channel<CircuitView, CircuitCommands>('circuit', {
  document: EMPTY_SUMMARY,
  geometry: EMPTY_GEOMETRY,
  signals: EMPTY_SIGNALS,
  status: INITIAL_STATUS,
  table: NO_TABLE,
  saving: NO_SAVE,
  clipboard: NO_CLIP,
  analyser: CLOSED_ANALYSER
});

/**
 * How many buckets geometry is kept in. An edit publishes the buckets it
 * touched — a new object each, with the rest shared — so the differ
 * walks a few hundred entries rather than thirty thousand, and the render
 * worker copies as few when it applies the patch. A flat record of ten
 * thousand parts was both, on every edit, for one changed part.
 */
export const GEOMETRY_BUCKETS = 64;

/** The bucket an id's entry is in: a hash of the id, the same wherever it is asked. */
export function bucketOf(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return String((hash >>> 0) % GEOMETRY_BUCKETS);
}

/** An entry by id, or undefined. */
export function entryOf<T>(buckets: Buckets<T>, id: string): T | undefined {
  return buckets[bucketOf(id)]?.[id];
}

/** Every entry, as `[id, entry]`, in no particular order. */
export function entriesOf<T>(buckets: Buckets<T>): [string, T][] {
  const entries: [string, T][] = [];
  for (const bucket of Object.values(buckets)) {
    for (const id in bucket) entries.push([id, bucket[id]!]);
  }
  return entries;
}
