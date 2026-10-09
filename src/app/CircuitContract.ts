import { channel } from 'gesso-framework';

import type { PinRef, Rotation } from '../sim/Circuit';
import type { Arrangement, Fragment } from './DocumentEdits';
import type { FoundPart } from './Search';
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
   * level inside a chip is live, and an edit there changes the chip's
   * definition, so every instance of it.
   */
  readonly path: readonly { readonly id: string; readonly chip: string }[];
  /** True for the document a first visit opened (see `restore`), until another is opened: the page greets it. */
  readonly welcome: boolean;
  /** The chips that differ from how the document was opened, themselves or in a chip inside them: the ones Reset can put back. */
  readonly changedChips: readonly string[];
  /**
   * The document's chip definitions, by name, with the body each gives an
   * instance — for the palette — and what each pin is for, by pin, for
   * the tooltip on a pin: only the pins that say.
   */
  readonly chips: readonly { readonly name: string; readonly shape: KindLayout; readonly notes: Readonly<Record<string, string>> }[];
  /** The tests of the level on the canvas, as text; '' when it has none. See `CircuitTests.ts`. */
  readonly tests: string;
  /** How many levels — the top and chip definitions — have tests. */
  readonly testedLevels: number;
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
  /** A switch's or LED's `note`: what it is for, as a chip's pin; null for none. */
  readonly note: string | null;
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
  /** The corners it was bent to, or null for a wire that routes itself: see `route`. */
  readonly via: readonly { readonly x: number; readonly y: number }[] | null;
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
  /**
   * The cycles that can be shown again, oldest and newest, while history
   * is kept; null while it is not. `first` is -1 before a cycle has run.
   */
  readonly history: { readonly first: number; readonly last: number } | null;
  /** The cycle the canvas shows from history, while paused and looking back; null for now. */
  readonly past: number | null;
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
  /**
   * Probes and LEDs on the top level, then the pins and wires traced from
   * the canvas at any depth: those are `watched`, can be taken away, and
   * have a `title` saying where they are, `cpu › datapath › alu.Y`.
   */
  readonly traces: readonly {
    readonly id: string;
    readonly name: string;
    readonly width: number;
    readonly watched: boolean;
    readonly title: string;
    /** Where it is: the chips that open its level, from the top, and the pin there. */
    readonly path: readonly string[];
    readonly pin: PinRef;
  }[];
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

/**
 * The program editor's ROM: its source, and how the last try at loading
 * it went. Published while the editor is open, on `openProgram` and on
 * each `setProgram`. `serial` counts answers, so the same problems twice
 * are two answers, and a dialog can tell its own load's reply from the
 * view it opened on.
 */
export interface ProgramView {
  /** The ROM on the canvas's level, or '' when the editor is closed. */
  readonly id: string;
  readonly label: string;
  /** The program as the ROM keeps it; for a ROM with no source, or one that doesn't match its words, a listing of the words. */
  readonly source: string;
  /** Why `source` is a listing rather than the program, or null when it is the program. */
  readonly note: string | null;
  /** Words the ROM's program takes, of 256. */
  readonly words: number;
  /** Why the last `setProgram` didn't assemble, each with its line; empty when it did, or none was tried. */
  readonly problems: readonly { readonly line: number; readonly message: string }[];
  readonly serial: number;
  /** The line of `source` each ROM address was assembled from, 1-based, by address; 0 where none was. */
  readonly lines: readonly number[];
  /**
   * The address on the ROM's instruction port — for a CPU, its program
   * counter: the next instruction it fetches. -1 when nothing runs.
   * Kept up to date at the rate signals are, while the editor is open.
   */
  readonly pc: number;
}

export interface CircuitCommands {
  /**
   * Adds a component. With no id, one is made from the kind. A chip names
   * the document's definition, a standard library part, or `mine:` and
   * one of the person's own chips, which comes into the document with it.
   */
  place(kind: Kind, x: number, y: number, id?: string, rotation?: Rotation, chip?: string, width?: number): void;
  /** Joins two pins with a wire. With no id, one is made. */
  connect(from: PinRef, to: PinRef, id?: string): void;
  /**
   * Moves a component so its top-left corner is at (x, y), in grid units.
   * @idempotent
   */
  move(id: string, x: number, y: number): void;
  /** Moves components by an offset: a selection dragged. */
  moveBy(ids: readonly string[], dx: number, dy: number, gesture?: string): void;
  /**
   * Bends a wire through these corners, or with null lets it route itself again. Moves of one drag share `gesture`.
   * @idempotent
   */
  setVia(id: string, via: readonly { readonly x: number; readonly y: number }[] | null, gesture?: string): void;
  /**
   * Lets wires route themselves again: these wires and every wire to or from these parts, or every wire on the level for none.
   * @idempotent
   */
  straighten(ids: readonly string[]): void;
  /**
   * Lines components up: an edge or a middle in common, or for three or
   * more the same space between them, across or down. One edit.
   * @idempotent
   */
  arrange(ids: readonly string[], how: Arrangement): void;
  /** Turns components a quarter turn clockwise. */
  rotate(ids: readonly string[]): void;
  /** Removes components and wires; wires left with an end on nothing go too. */
  remove(ids: readonly string[]): void;
  /** Adds components and wires whose ids are already fresh: paste, duplicate. */
  insert(fragment: Fragment): void;
  /** Takes back the last edit; a drag is one edit. */
  undo(): void;
  /** Puts back the last edit undone. */
  redo(): void;
  /**
   * Replaces the document with a named one, and forgets its history.
   * @destructive
   * @confirm
   */
  loadScene(name: SceneName): void;
  /**
   * Replaces the document with the computer, running this program's
   * assembly source from its ROM, clocked at `rate` (60 Hz unless it
   * says); `name` is what to call it when it does not assemble.
   * @destructive
   * @confirm
   */
  loadProgram(name: string, source: string, rate?: number): void;
  /**
   * Sets a switch or holds a button, as a person does: a bit, or for a wide switch a number.
   * @idempotent
   */
  setInput(id: string, value: number): void;
  /**
   * Makes these components `width` bits wide; see `setWidth` in `DocumentEdits`.
   * @idempotent
   */
  setWidth(ids: readonly string[], width: number): void;
  /**
   * Names a part on the level shown; blank text takes the name away. See `setLabel` in `DocumentEdits`.
   * @idempotent
   */
  setLabel(id: string, label: string): void;
  /**
   * Says what a switch or LED is for, as a chip's pin; see `setNote` in `DocumentEdits`.
   * @idempotent
   */
  setNote(id: string, note: string): void;
  /** Opens the program editor on a ROM of the level on the canvas, published as `program`; '' closes it. */
  openProgram(id: string): void;
  /**
   * Assembles `source` into a ROM: when it assembles, its words and
   * source replace the ROM's as one edit and the circuit restarts from
   * power-on; when it doesn't, nothing changes and `program` says why.
   */
  setProgram(id: string, source: string): void;
  /**
   * Runs the circuit at its clock rate, until paused.
   * @idempotent
   */
  run(): void;
  /**
   * Stops the circuit where it is.
   * @idempotent
   */
  pause(): void;
  /** One clock cycle, while paused. */
  step(): void;
  /**
   * Sets every clock to `rate` cycles a second, or `max` for as fast as it goes.
   * @idempotent
   */
  setClockHz(rate: ClockRate): void;
  /**
   * The world rectangle on screen. Until the first one, every net is published.
   * @hidden
   */
  setViewport(left: number, top: number, right: number, bottom: number): void;
  /**
   * Opens the truth table of these components; an empty list closes it.
   * @idempotent
   */
  tabulate(ids: readonly string[]): void;
  /**
   * Opens a circuit file's text, read from `name`; `handle` is the shell's, when it gave one.
   * @destructive
   * @confirm
   */
  open(text: string, name: string, handle: number | null): void;
  /**
   * Asks for the document as file text, published as `saving`. `asNew` is Save As.
   * @hidden
   */
  requestSave(asNew: boolean): void;
  /**
   * Says how a save went: where it was written, or null when it was cancelled or failed, with why.
   * @hidden
   */
  finishSave(saved: { readonly name: string; readonly handle: number | null } | null, message: string | null): void;
  /**
   * Where the view is, for the autosave to bring back.
   * @hidden
   */
  rememberCamera(x: number, y: number, scale: number): void;
  /**
   * Brings back what was open when the tab closed, and starts
   * autosaving; with nothing saved, opens `first` — a program for the
   * computer — running. Sent once, at start, by an application that
   * wants it — not by the bench, which loads its own scene and must not
   * overwrite a person's work.
   * @hidden
   */
  restore(first?: { readonly name: string; readonly source: string; readonly rate: number }): void;
  /** Makes the selected components into a chip, named `name` or the next free `chip N`. */
  makeChip(ids: readonly string[], name?: string): void;
  /** Opens a chip on the current level, to show its insides live. */
  openChip(id: string): void;
  /**
   * Steps back out to `depth` levels from the top: 0 is the top.
   * @idempotent
   */
  closeChip(depth: number): void;
  /**
   * Goes to the level these chips open, from the top, in one step: as
   * far as the path still leads. Nothing happens when that level is
   * the one on the canvas.
   * @idempotent
   */
  openPath(ids: readonly string[]): void;
  /** Renames a chip definition, and every instance of it. */
  renameChip(from: string, to: string): void;
  /** Puts a chip back as the document was opened, with the chips inside it; one edit, so undo takes it back. */
  resetChip(name: string): void;
  /** Adds a circuit file's text to the document as a chip, named after the file, ready to place from the palette. */
  importChip(text: string, fileName: string): void;
  /**
   * Opens the analyser on a window of `span` cycles from `start`, drawn
   * in `columns` pixels; a null start follows the newest cycle. Zero
   * columns closes it.
   * @hidden
   */
  setAnalyserView(start: number | null, span: number, columns: number): void;
  /**
   * Pauses the circuit on the cycle `trace` becomes `value`; a null trace disarms it.
   * @idempotent
   */
  setTrigger(trace: string | null, value: number): void;
  /**
   * Traces these pins of the level on the canvas in the analyser, at
   * whatever depth it is, without changing the circuit. A pin already
   * traced this way, or on the same nets as one, is left as it is.
   */
  watch(pins: readonly PinRef[]): void;
  /** Stops tracing a pin traced with `watch`, by its trace's id. */
  unwatch(id: string): void;
  /**
   * Shows the circuit as it was at the end of a cycle, from history:
   * signals are that cycle's until `null`, running, stepping or an input
   * brings back now. Only while paused, and only a cycle history holds.
   * @idempotent
   */
  showCycle(cycle: number | null): void;
  /**
   * Makes the cycle shown from history now: the circuit goes back to it,
   * and the cycles after it, in history and the analyser, are gone. It
   * stays paused, for an input to be given or a step taken from there.
   */
  resumeFromHere(): void;
  /**
   * Keeps history, or stops and lets it go. On unless turned off.
   * @idempotent
   */
  setKeepHistory(keep: boolean): void;
  /** Makes a link that opens the document, traced pins and all: published as `share`. */
  share(): void;
  /**
   * Replaces the tests of the level on the canvas; blank text takes them away. One edit while typing, for undo.
   * @idempotent
   */
  setTests(text: string): void;
  /** Writes tests for the level on the canvas from what it does now, replacing any it had. */
  fillTests(): void;
  /**
   * Runs the tests of the level on the canvas, or of every level, and
   * publishes how they went as `tested`. With `follow`, the level's are
   * run again after every edit until `stopTests`.
   */
  runTests(all: boolean, follow: boolean): void;
  /**
   * Stops running the level's tests after every edit.
   * @hidden
   */
  stopTests(): void;
  /**
   * Brings back an earlier version, by its id in `versions`, keeping a copy of the document as it is first.
   * @destructive
   * @confirm
   */
  restoreVersion(id: number): void;
  /**
   * Keeps one of the document's chips in the person's own chips, with the
   * chips it is made of, to place in any document; one kept under that
   * name is replaced.
   */
  saveMyChip(name: string): void;
  /**
   * Stops keeping one of the person's own chips. Documents that use it
   * keep their copy.
   * @destructive
   * @confirm
   */
  removeMyChip(name: string): void;
  /**
   * Writes what the analyser holds as a VCD file, published as `exported`.
   * @hidden
   */
  exportWaveforms(): void;
  /**
   * Opens a link's circuit, the text after its `#`, as a new document that is not saved anywhere yet.
   * @destructive
   * @confirm
   */
  openShared(fragment: string): void;
  /**
   * Finds parts by name at every depth: published as `found`. Blank text finds nothing.
   * @idempotent
   */
  find(query: string): void;
  /**
   * Puts these parts, and the chips they use, on the clipboard as text: published as `clipboard`.
   * @hidden
   */
  copy(ids: readonly string[]): void;
  /** Copies these parts in place, moved by (dx, dy), under the new ids `rename` gives, by old id, for parts and the wires between them. */
  duplicate(ids: readonly string[], rename: Readonly<Record<string, string>>, dx: number, dy: number): void;
}

export interface CircuitView {
  /** The document: its name, whether it compiles, the level shown, its chips and the library's parts. */
  readonly document: DocumentSummary;
  /**
   * Where everything on the level is, for the canvas; an agent reads
   * `level` instead.
   * @hidden
   */
  readonly geometry: Geometry;
  /**
   * Net values packed for the canvas; an agent reads `readings` instead.
   * @hidden
   */
  readonly signals: Signals;
  /** Running or paused, the clock rate, the cycle, and what will not settle. */
  readonly status: Status;
  /** The truth table `tabulate` asked for. */
  readonly table: TableView;
  /**
   * A file on its way to the save picker.
   * @hidden
   */
  readonly saving: SaveRequest;
  /**
   * Text on its way to the clipboard.
   * @hidden
   */
  readonly clipboard: ClipRequest;
  /** The logic analyser, while its panel is open. */
  readonly analyser: AnalyserView;
  /** The program editor's ROM, while it is open. */
  readonly program: ProgramView;
  /** The parts `find` found. */
  readonly found: FoundView;
  /** The link `share` made. */
  readonly share: ShareView;
  /**
   * A waveform file on its way to the save picker.
   * @hidden
   */
  readonly exported: ExportView;
  /** How the tests `runTests` ran went. */
  readonly tested: TestsView;
  /** The earlier versions `restoreVersion` can bring back. */
  readonly versions: VersionsView;
  /** The level on the canvas: its parts, their pins, and the wires between them. */
  readonly level: LevelView;
  /** What the level's switches, LEDs, probes and displays show now. */
  readonly readings: Readings;
  /** The person's own chips, kept across documents. */
  readonly myChips: MyChipsView;
}

/**
 * A link `share` made: the text after `#` that opens the document, or
 * why there is none. `serial` counts requests, so the same link asked
 * for twice is two answers; 0 is none.
 */
export interface ShareView {
  readonly serial: number;
  readonly fragment: string;
  readonly error: string | null;
}

/**
 * A file made for the person to keep rather than to open again — the
 * analyser's waveforms as VCD — for the render worker to hand to the
 * shell's save picker, as a save is. `serial` counts requests; 0 is none.
 */
export interface ExportView {
  readonly serial: number;
  readonly name: string;
  readonly text: string;
  readonly mediaType: string;
  /** Why there is no file, or null when there is one. */
  readonly error: string | null;
}

/**
 * How tests went: the level on the canvas's, while its tests are open,
 * run again after every edit; or every level's, when all were asked
 * for. `serial` counts runs; 0 is none.
 */
export interface TestsView {
  readonly serial: number;
  /** Every level's, rather than the one on the canvas. */
  readonly all: boolean;
  readonly results: readonly {
    /** Where: “the top level”, or the chip's name. */
    readonly level: string;
    readonly rows: number;
    readonly failed: number;
    readonly failures: readonly { readonly line: number; readonly message: string }[];
    readonly error: string | null;
  }[];
}

/**
 * The earlier versions kept of the document, newest first: see
 * `Versions.ts`. Small — fifty at most — and changed only when a copy
 * is kept, so published whole.
 */
export interface VersionsView {
  readonly entries: readonly {
    readonly id: number;
    /** When it was kept, in milliseconds since the epoch. */
    readonly at: number;
    /** Why: before the first change, while editing, before it was replaced, before a restore. */
    readonly reason: 'opened' | 'editing' | 'replaced' | 'restored';
    readonly name: string | null;
    readonly parts: number;
  }[];
}

/**
 * The level on the canvas, as an agent reads it: each part with its
 * pins, and each wire as the two pins it joins, `part.pin`. A pin of a
 * bus is one name for all its bits. Grid units: a gate is 4 × 4, and
 * pins sit on its left and right edges.
 */
export interface LevelView {
  /** Which level: “the top level”, or the chips opened to reach it, `cpu › ALU`. */
  readonly path: string;
  readonly parts: readonly {
    readonly id: string;
    readonly kind: Kind;
    readonly x: number;
    readonly y: number;
    readonly label?: string;
    /** A chip's definition name. */
    readonly chip?: string;
    /** Bits wide, when more than one. */
    readonly width?: number;
    readonly rotation?: Rotation;
    /** The pins a wire may end on, and the ones that drive one. */
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
  }[];
  readonly wires: readonly { readonly id: string; readonly from: string; readonly to: string; readonly bent?: true }[];
}

/**
 * What the level's switches, buttons, clocks, constants, LEDs, probes
 * and hex displays show now, by id: a number, a bus's least significant
 * bit first, or null while it does not compile.
 */
export type Readings = Readonly<Record<string, number | null>>;

/**
 * The person's own chips, kept across documents (see `MyChips.ts`), for
 * the palette: each by name, with the body an instance gets and what its
 * pins are for. Placing one is `place('chip', …, 'mine:' + name)`.
 */
export interface MyChipsView {
  readonly chips: readonly {
    readonly name: string;
    readonly shape: KindLayout;
    readonly notes: Readonly<Record<string, string>>;
    /** When it was last saved, in milliseconds since the epoch. */
    readonly savedAt: number;
  }[];
}

/** What `find` found: the query it answers, so a stale answer can be told from the latest, and the parts. */
export interface FoundView {
  readonly query: string;
  readonly parts: readonly FoundPart[];
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
  changedChips: [],
  tests: '',
  testedLevels: 0,
  chips: [],
  library: []
};
export const NO_SAVE: SaveRequest = { serial: 0, name: '', text: '', handle: null };
export const NO_CLIP: ClipRequest = { serial: 0, text: '' };
export const NO_PROGRAM: ProgramView = { id: '', label: '', source: '', note: null, words: 0, problems: [], serial: 0, lines: [], pc: -1 };
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
export const NOTHING_FOUND: FoundView = { query: '', parts: [] };
export const NO_SHARE: ShareView = { serial: 0, fragment: '', error: null };
export const NO_VERSIONS: VersionsView = { entries: [] };
export const EMPTY_LEVEL: LevelView = { path: 'the top level', parts: [], wires: [] };
export const NO_MY_CHIPS: MyChipsView = { chips: [] };
export const NO_TESTS: TestsView = { serial: 0, all: false, results: [] };
export const NO_EXPORT: ExportView = { serial: 0, name: '', text: '', mediaType: '', error: null };
export const INITIAL_STATUS: Status = { running: false, clockHz: 'max', achievedHz: 0, cycles: 0, ringing: [], history: null, past: null };

export const Circuit = channel<CircuitView, CircuitCommands>('circuit', {
  document: EMPTY_SUMMARY,
  geometry: EMPTY_GEOMETRY,
  signals: EMPTY_SIGNALS,
  status: INITIAL_STATUS,
  table: NO_TABLE,
  saving: NO_SAVE,
  clipboard: NO_CLIP,
  analyser: CLOSED_ANALYSER,
  program: NO_PROGRAM,
  found: NOTHING_FOUND,
  share: NO_SHARE,
  exported: NO_EXPORT,
  tested: NO_TESTS,
  versions: NO_VERSIONS,
  level: EMPTY_LEVEL,
  readings: {},
  myChips: NO_MY_CHIPS
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
