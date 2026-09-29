import { BehaviorSubject, type Observable } from 'rxjs';

import { CIRCUIT_VERSION, type Circuit, type PinRef, type Rotation } from '../sim/Circuit';
import { CircuitError, compile, type Netlist } from '../sim/Netlist';
import { isGate, PINS, type Kind } from '../sim/Primitives';
import { Simulator } from '../sim/Simulator';
import type {
  ClockRate,
  ComponentGeometry,
  DocumentSummary,
  Geometry,
  SceneName,
  Signals,
  Camera,
  ClipRequest,
  SaveRequest,
  Status,
  TableView,
  WireGeometry
} from './CircuitContract';
import { NO_CLIP, NO_SAVE, NO_TABLE } from './CircuitContract';
import { CircuitFileError, DEFAULT_FILE_NAME, readCircuit, writeCircuit } from '../sim/CircuitFile';
import {
  connect,
  extract,
  freshChipName,
  freshId,
  importChip,
  insert,
  makeChip,
  move,
  moveBy,
  place,
  relabel,
  remove,
  renameChip,
  rotate,
  sameConnectivity,
  type Fragment
} from './DocumentEdits';
import { adderScene, benchScene, counterScene } from './Scenes';
import { truthTable } from './TruthTable';
import { boundsOf, boxOf, intersects, pinAt, route, shapeOf, slotOf, type KindLayout } from './Layout';
import { pinsOf } from '../sim/Chips';
import { CHUNK, packChunk } from './SignalPacking';

/**
 * The circuit, on its own thread: the document, the simulator running
 * it, and the four views the render worker reads.
 *
 * RxJS and `src/sim`, nothing else — no framework — so it runs under
 * bare vitest, and `circuitChannels` in `channels.ts` is the only place
 * it meets the barrier. The contract's types are imported as types.
 *
 * **Running in slices.** While running, the simulator works in slices of
 * at most `budgetMs`, each handed back to the event loop, so a command —
 * an edit, a switch — is handled between two slices, never after a long
 * run. At a set clock rate a slice runs the cycles that are due since
 * the run started; at `max` it runs until its budget is spent.
 *
 * **Publishing at a frame rate, not a cycle rate.** A slice at `max` can
 * run hundreds of cycles, and nobody sees more than one frame's worth.
 * So signals and status are published at most once per
 * `publishIntervalMs`, and always after a command, so a switch flipped
 * while paused lights its LED at once. gessosheet's Phase 0 is the
 * warning here: an application thread busy past a frame left its view
 * empty while the frame rate stayed perfect, and publishing is what
 * keeps the view filled.
 */
export type Schedule = (run: () => void) => void;

export interface ServiceOptions {
  /** How the next slice is queued. A spec passes one it advances by hand. */
  readonly schedule?: Schedule;
  /** The clock slices are measured against, in milliseconds. */
  readonly now?: () => number;
  /** The longest a slice may run. */
  readonly budgetMs?: number;
  /** The least time between two publishes while running. */
  readonly publishIntervalMs?: number;
  /** Where the autosave is kept. Without one, nothing is remembered. */
  readonly store?: AutosaveStore;
  /** How an autosave is put off until edits stop; returns a cancel. A spec passes one it fires by hand. */
  readonly delay?: (run: () => void, ms: number) => () => void;
}

/**
 * The two methods of Gesso's `StorageAdapter` the autosave uses, so
 * this file needs no framework: `OpfsStorage` in the worker, a map in
 * a spec.
 */
export interface AutosaveStore {
  read(key: string): Promise<{ readonly value: string | null }>;
  write(key: string, value: string): Promise<unknown>;
}

/** The autosave's key in the store, and how long after the last change it is written. */
export const AUTOSAVE_KEY = 'autosave';
const AUTOSAVE_MS = 1000;

/**
 * What the autosave holds: the circuit as file text, and what else was
 * on screen — which file it was, whether it had changed since, whether
 * it was running, and where the view was. Not the simulator's state: a
 * reload brings the circuit back running from reset, as a real circuit
 * comes back from a power cut.
 */
interface Autosave {
  readonly format: 'gessologic-autosave';
  readonly file: string;
  readonly name: string | null;
  readonly handle: number | null;
  readonly dirty: boolean;
  readonly running: boolean;
  readonly camera: Camera | null;
}

/** A viewport, widened by a quarter on each side: the band Phase 0 put on the publishing side. */
interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The most cycles one slice runs at a set rate, however far behind it
 * is. A run that fell behind — the tab was hidden, a breakpoint was
 * hit — catches up to now over several slices instead of spending one
 * enormous one doing it.
 */
const CATCH_UP_CYCLES = 10_000;

/** Edits kept for undo. Documents share structure, so each is the size of what changed. */
const HISTORY = 500;

export class CircuitService {
  readonly document: Observable<DocumentSummary>;
  readonly geometry: Observable<Geometry>;
  readonly signals: Observable<Signals>;
  readonly status: Observable<Status>;
  readonly table: Observable<TableView>;
  readonly saving: Observable<SaveRequest>;
  readonly clipboard: Observable<ClipRequest>;

  private readonly documentSubject: BehaviorSubject<DocumentSummary>;
  private readonly geometrySubject: BehaviorSubject<Geometry>;
  private readonly signalsSubject: BehaviorSubject<Signals>;
  private readonly statusSubject: BehaviorSubject<Status>;
  private readonly tableSubject = new BehaviorSubject<TableView>(NO_TABLE);
  private readonly savingSubject = new BehaviorSubject<SaveRequest>(NO_SAVE);
  private readonly clipboardSubject = new BehaviorSubject<ClipRequest>(NO_CLIP);

  private readonly schedule: Schedule;
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly publishIntervalMs: number;

  private circuit: Circuit = { version: CIRCUIT_VERSION, components: [], wires: [] };
  private readonly undoStack: { circuit: Circuit; gesture: string | null }[] = [];
  private readonly redoStack: Circuit[] = [];
  /** The gesture of the last edit, which the next one folds into if it carries the same. */
  private lastGesture: string | null = null;
  private revision = 0;
  private opened = 0;
  private netlist: Netlist | null = null;
  private simulator: Simulator | null = null;
  private error: string | null = null;
  private viewport: Rect | null = null;
  private visibleChunks: number[] | null = null;

  private name: string | null = null;
  private handle: number | null = null;
  /** The chip instances opened from the top, each on the level before; empty at the top. */
  private readonly path: string[] = [];
  /** The revision last opened or saved; the document is dirty when it has moved on. -1 is never. */
  private savedRevision = 0;
  private openCamera: Camera | null = null;
  private camera: Camera | null = null;
  private message: string | null = null;
  private saveSerial = 0;
  private readonly store: AutosaveStore | null;
  private readonly delay: (run: () => void, ms: number) => () => void;
  /** Whether autosaving has begun: only once `restore` has read what was there, or it would be overwritten. */
  private autosaving = false;
  private cancelAutosave: (() => void) | null = null;

  private running = false;
  private clockHz: ClockRate = 'max';
  private ringing: readonly string[] = [];
  /** When the current run started, and the cycle count then, for pacing a set rate. */
  private runStartedAt = 0;
  private runStartCycles = 0;
  private sliceQueued = false;
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  /** Cycle counts over the last second of running, for the achieved rate. */
  private readonly samples: { at: number; cycles: number }[] = [];

  constructor(options: ServiceOptions = {}) {
    this.schedule = options.schedule ?? (run => setTimeout(run, 0));
    this.now = options.now ?? (() => performance.now());
    this.budgetMs = options.budgetMs ?? 8;
    this.publishIntervalMs = options.publishIntervalMs ?? 1000 / 60;
    this.documentSubject = new BehaviorSubject(this.summary());
    this.geometrySubject = new BehaviorSubject(this.geometryNow());
    this.signalsSubject = new BehaviorSubject(this.signalsNow());
    this.statusSubject = new BehaviorSubject(this.statusNow());
    this.document = this.documentSubject;
    this.geometry = this.geometrySubject;
    this.signals = this.signalsSubject;
    this.status = this.statusSubject;
    this.table = this.tableSubject;
    this.saving = this.savingSubject;
    this.clipboard = this.clipboardSubject;
    this.store = options.store ?? null;
    this.delay =
      options.delay ??
      ((run, ms) => {
        const id = setTimeout(run, ms);
        return () => clearTimeout(id);
      });
  }

  /** Replaces the document, as opening a file does. The simulator starts fresh and the history is forgotten. */
  load(
    circuit: Circuit,
    file: { name: string | null; handle: number | null; dirty?: boolean; camera?: Camera | null } = { name: null, handle: null }
  ): void {
    this.opened++;
    this.path.length = 0;
    this.name = file.name;
    this.handle = file.handle;
    this.openCamera = file.camera ?? null;
    this.message = null;
    this.simulator = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastGesture = null;
    // The document's clocks carry its rate.
    this.clockHz = circuit.components.find(c => c.kind === 'clock')?.rate ?? 'max';
    this.running = false;
    this.samples.length = 0;
    this.tableSubject.next(NO_TABLE);
    // Clean from the revision `apply` is about to make, unless it was
    // dirty when it was put away.
    this.savedRevision = file.dirty === true ? -1 : this.revision + 1;
    this.apply(circuit);
  }

  open(text: string, name: string, handle: number | null): void {
    let circuit: Circuit;
    try {
      circuit = readCircuit(text);
    } catch (error) {
      if (!(error instanceof CircuitFileError)) throw error;
      this.message = `Couldn't open ${name}: ${error.message}`;
      this.documentSubject.next(this.summary());
      return;
    }
    this.load(circuit, { name, handle });
    this.message = `Opened ${name}`;
    this.documentSubject.next(this.summary());
  }

  requestSave(asNew: boolean): void {
    this.savingSubject.next({
      serial: ++this.saveSerial,
      name: this.name ?? DEFAULT_FILE_NAME,
      text: writeCircuit(this.circuit),
      handle: asNew ? null : this.handle
    });
  }

  finishSave(saved: { readonly name: string; readonly handle: number | null } | null, message: string | null): void {
    this.savingSubject.next(NO_SAVE);
    if (saved !== null) {
      this.name = saved.name;
      this.handle = saved.handle;
      this.savedRevision = this.revision;
      this.autosave();
    }
    this.message = message;
    this.documentSubject.next(this.summary());
  }

  rememberCamera(x: number, y: number, scale: number): void {
    this.camera = { x, y, scale };
    this.autosave();
  }

  /** Reads the autosave back and loads it, running if it was; then autosaves from here on. */
  async restore(): Promise<void> {
    if (this.autosaving || this.store === null) {
      return;
    }
    // The read is asynchronous, and a person does not wait for it: a
    // scene loaded, a file opened or an edit made before it answers is
    // the document now, and the autosave must not replace it.
    const openedAtAsk = this.opened;
    const revisionAtAsk = this.revision;
    try {
      const { value } = await this.store.read(AUTOSAVE_KEY);
      const saved = value === null ? null : (JSON.parse(value) as Autosave);
      const untouched = this.opened === openedAtAsk && this.revision === revisionAtAsk;
      if (untouched && saved !== null && saved.format === 'gessologic-autosave') {
        this.load(readCircuit(saved.file), {
          name: saved.name,
          handle: saved.handle,
          dirty: saved.dirty,
          camera: saved.camera
        });
        this.camera = saved.camera;
        if (saved.running) this.run();
      }
    } catch {
      // An autosave that cannot be read is one that is not there: the
      // person starts with an empty canvas, which is what they would
      // have had without it, and the next change overwrites it.
    }
    this.autosaving = true;
  }

  loadScene(name: SceneName): void {
    this.load(
      name === 'bench'
        ? benchScene()
        : name === 'counter'
          ? counterScene()
          : name === 'adder'
            ? adderScene()
            : { version: CIRCUIT_VERSION, components: [], wires: [] }
    );
  }

  place(kind: Kind, x: number, y: number, id?: string, rotation?: Rotation, chip?: string): void {
    this.editLevel(level => {
      const placed = place(level, id ?? freshId(level, kind), kind, x, y, rotation, chip);
      return kind === 'clock' ? withRate(placed, this.clockHz) : placed;
    });
  }

  makeChip(ids: readonly string[], name?: string): void {
    this.editLevel(level => makeChip(level, ids, name ?? freshChipName(this.circuit), freshId(level, 'chip')));
  }

  importChip(text: string, fileName: string): void {
    let file: Circuit;
    try {
      file = readCircuit(text);
    } catch (error) {
      if (!(error instanceof CircuitFileError)) throw error;
      this.message = `Couldn't insert ${fileName}: ${error.message}`;
      this.documentSubject.next(this.summary());
      return;
    }
    const name = fileName.replace(/\.gessologic\.json$|\.json$/i, '');
    const result = importChip(this.circuit, file, name);
    if (result.name === null) {
      this.message = `${fileName} has no parts to make a chip of`;
      this.documentSubject.next(this.summary());
      return;
    }
    this.edit(result.circuit);
    this.message = `Added chip "${result.name}": place it from the palette`;
    this.documentSubject.next(this.summary());
  }

  copy(ids: readonly string[]): void {
    const fragment = extract(this.levelWithChips(), ids);
    if (fragment.components.length === 0) return;
    this.clipboardSubject.next({
      serial: this.clipboardSubject.value.serial + 1,
      text: JSON.stringify({ gessologic: 1, ...fragment })
    });
  }

  duplicate(ids: readonly string[], rename: Readonly<Record<string, string>>, dx: number, dy: number): void {
    this.editLevel(level => {
      const fragment = extract(level, ids);
      const taken = new Set([...level.components.map(c => c.id), ...level.wires.map(w => w.id), ...Object.values(rename)]);
      const fresh = (prefix: string, old: string) => {
        const wanted = rename[old];
        if (wanted !== undefined) return wanted;
        for (let n = 1; ; n++) {
          if (!taken.has(`${prefix}${n}`)) {
            taken.add(`${prefix}${n}`);
            return `${prefix}${n}`;
          }
        }
      };
      return insert(level, relabel(fragment, dx, dy, fresh));
    });
  }

  /** The level on the canvas, with the document's chips attached, as edits and copies see it. */
  private levelWithChips(): Circuit {
    const { circuit } = this.level();
    return this.path.length === 0 ? this.circuit : { ...circuit, chips: this.circuit.chips };
  }

  renameChip(from: string, to: string): void {
    // A document-wide edit wherever it is asked from: the name is the
    // definition's, and the breadcrumb follows it.
    this.edit(renameChip(this.circuit, from, to));
  }

  openChip(id: string): void {
    const { circuit } = this.level();
    if (!circuit.components.some(c => c.id === id && c.kind === 'chip')) {
      return;
    }
    this.path.push(id);
    this.changedLevel();
  }

  closeChip(depth: number): void {
    if (depth < 0 || depth >= this.path.length) {
      return;
    }
    this.path.length = depth;
    this.changedLevel();
  }

  /** A new level on the canvas: framed afresh, like a document opened, but the document is the same one. */
  private changedLevel(): void {
    this.opened++;
    this.openCamera = null;
    this.visibleChunks = null;
    this.tableSubject.next(NO_TABLE);
    this.documentSubject.next(this.summary());
    this.geometrySubject.next(this.geometryNow());
    this.publish(true);
  }

  tabulate(ids: readonly string[]): void {
    this.tableSubject.next(ids.length === 0 ? NO_TABLE : this.tableOf(ids));
  }

  connect(from: PinRef, to: PinRef, id?: string): void {
    this.editLevel(level => connect(level, id ?? freshId(level, 'w'), from, to));
  }

  move(id: string, x: number, y: number): void {
    this.editLevel(level => move(level, id, x, y));
  }

  moveBy(ids: readonly string[], dx: number, dy: number, gesture?: string): void {
    this.editLevel(level => moveBy(level, ids, dx, dy), gesture);
  }

  rotate(ids: readonly string[]): void {
    this.editLevel(level => rotate(level, ids));
  }

  remove(ids: readonly string[]): void {
    this.editLevel(level => remove(level, ids));
  }

  insert(fragment: Fragment): void {
    this.editLevel(level => insert(level, fragment));
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (previous === undefined) {
      return;
    }
    this.redoStack.push(this.circuit);
    this.lastGesture = null;
    this.apply(previous.circuit);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) {
      return;
    }
    this.undoStack.push({ circuit: this.circuit, gesture: null });
    this.lastGesture = null;
    this.apply(next);
  }

  setInput(id: string, value: 0 | 1): void {
    const simulator = this.simulator;
    if (simulator === null || !this.netlist?.inputs.has(id)) {
      return;
    }
    simulator.set(id, value);
    if (!this.running) {
      this.settle(simulator);
    }
    this.publish(true);
  }

  run(): void {
    if (this.running || this.simulator === null) {
      return;
    }
    this.running = true;
    this.ringing = [];
    this.restartPacing();
    this.queueSlice();
    this.publish(true);
    this.autosave();
  }

  pause(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.samples.length = 0;
    this.publish(true);
    this.autosave();
  }

  step(): void {
    const simulator = this.simulator;
    if (this.running || simulator === null) {
      return;
    }
    this.cycle(simulator);
    this.publish(true);
  }

  setClockHz(rate: ClockRate): void {
    if (rate !== 'max' && !(rate > 0)) {
      return;
    }
    this.clockHz = rate;
    // Kept on the document's clocks, outside the history: a rate is a
    // setting, not an edit, and undoing a wire should not change it.
    this.circuit = withRate(this.circuit, rate);
    this.restartPacing();
    this.autosave();
    this.publish(true);
  }

  setViewport(left: number, top: number, right: number, bottom: number): void {
    const bandX = (right - left) / 4;
    const bandY = (bottom - top) / 4;
    this.viewport = { left: left - bandX, top: top - bandY, right: right + bandX, bottom: bottom + bandY };
    this.visibleChunks = null;
    this.publish(true);
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  /**
   * An edit: the new document, recorded for undo.
   *
   * An edit that changed nothing is not recorded. Edits carrying the
   * gesture of the edit before them are folded into it, so a drag of
   * fifty pointer moves is one step back, not fifty. Any edit clears
   * what could be redone, as it does everywhere.
   */
  /**
   * An edit to the level on the canvas. At the top that is the document;
   * inside a chip it is the chip's definition, which every instance of it
   * shares — so an AND added inside one full adder is in all eight, as
   * it would be in hardware made from one design. The edit is given the
   * level with the document's chips attached, so a part it places or a
   * chip it makes can name any definition, and what comes back is folded
   * into the document as that definition.
   */
  private editLevel(change: (level: Circuit) => Circuit, gesture?: string): void {
    const before = this.levelWithChips();
    const after = change(before);
    if (after === before) {
      return;
    }
    if (this.path.length === 0) {
      this.edit(after, gesture);
      return;
    }
    const name = this.pathNow().at(-1)!.chip;
    const { chips, ...definition } = after;
    this.edit({ ...this.circuit, chips: { ...(chips ?? this.circuit.chips), [name]: definition } }, gesture);
  }

  private edit(next: Circuit, gesture?: string): void {
    if (next === this.circuit) {
      return;
    }
    const folds = gesture !== undefined && gesture === this.lastGesture && this.undoStack.length > 0;
    if (!folds) {
      this.undoStack.push({ circuit: this.circuit, gesture: gesture ?? null });
      if (this.undoStack.length > HISTORY) {
        this.undoStack.shift();
      }
    }
    this.lastGesture = gesture ?? null;
    this.redoStack.length = 0;
    this.message = null;
    this.apply(next);
  }

  /**
   * Takes a new document. When it joins the same pins as the last one —
   * a move, a rotation — the netlist and the running simulator are kept
   * exactly as they are, and only geometry is published: a drag through
   * a running CPU does not recompile it fifty times. Otherwise it is
   * compiled and, when that works, the running state moves onto the new
   * netlist so the circuit keeps what it remembered. A document that
   * does not compile is kept — the person is halfway through drawing it
   * — and says why; nothing runs until it compiles again.
   */
  private apply(next: Circuit): void {
    const previous = this.circuit;
    this.circuit = next;
    this.revision++;
    this.autosave();
    this.visibleChunks = null;
    if (this.netlist !== null && this.simulator !== null && sameConnectivity(previous, next)) {
      this.documentSubject.next(this.summary());
      this.geometrySubject.next(this.geometryNow());
      this.publish(true);
      return;
    }
    try {
      const netlist = compile(next);
      const simulator = new Simulator(netlist);
      if (this.simulator !== null) {
        simulator.adopt(this.simulator);
      }
      this.netlist = netlist;
      this.simulator = simulator;
      this.error = null;
      if (!this.running) {
        this.settle(simulator);
      }
    } catch (error) {
      if (!(error instanceof CircuitError)) {
        throw error;
      }
      this.error = error.message;
      this.netlist = null;
      this.simulator = null;
      this.running = false;
    }
    this.documentSubject.next(this.summary());
    this.geometrySubject.next(this.geometryNow());
    const table = this.tableSubject.value;
    if (table.ids.length > 0) {
      const level = this.level().circuit;
      const ids = table.ids.filter(id => level.components.some(c => c.id === id));
      this.tableSubject.next(ids.length === 0 ? NO_TABLE : this.tableOf(ids));
    }
    this.publish(true);
  }

  private tableOf(ids: readonly string[]): TableView {
    const result = truthTable(this.levelWithChips(), ids);
    return 'table' in result
      ? { ids, ...result.table, error: null }
      : { ids, inputs: [], outputs: [], rows: [], error: result.error };
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  private queueSlice(): void {
    if (this.sliceQueued) {
      return;
    }
    this.sliceQueued = true;
    this.schedule(() => {
      this.sliceQueued = false;
      this.slice();
    });
  }

  private slice(): void {
    const simulator = this.simulator;
    if (!this.running || simulator === null) {
      return;
    }
    const started = this.now();
    const due =
      this.clockHz === 'max'
        ? Number.POSITIVE_INFINITY
        : Math.min(
            CATCH_UP_CYCLES,
            Math.floor(((started - this.runStartedAt) * this.clockHz) / 1000) - (simulator.cycles - this.runStartCycles)
          );
    let ran = 0;
    while (ran < due && this.running) {
      if (!this.cycle(simulator)) {
        break;
      }
      ran++;
      // The clock is read every cycle. A cycle of a 10,000-gate circuit
      // is tens of microseconds, so the read is a small share of it,
      // and a slice that overran its budget is the failure this avoids.
      const at = this.now();
      // Publishing is checked here, inside the slice, rather than only at
      // its end. Phase 3's bench found why: nested `setTimeout(0)` is
      // clamped to 4 ms, so 8 ms slices ran 12 ms apart, a publish could
      // only land on every other one, and the render worker got 38
      // snapshots a second. Checked per cycle, the interval is kept
      // whatever the slices' spacing. (A `MessageChannel` avoids the
      // clamp, and was tried: its next slice queued ahead of every
      // command, and a `pause` never got in.)
      if (at - this.lastPublishAt >= this.publishIntervalMs) {
        this.sample(simulator);
        this.publish(false);
      }
      if (at - started >= this.budgetMs) {
        break;
      }
    }
    this.sample(simulator);
    this.publish(false);
    if (this.running) {
      this.queueSlice();
    }
  }

  /** One clock cycle. An oscillation pauses the run and is reported; returns whether it settled. */
  private cycle(simulator: Simulator): boolean {
    const result = simulator.cycle();
    if (result.settled) {
      return true;
    }
    const failed = result.rise.settled ? result.fall : result.rise;
    this.ringing = failed.settled ? [] : failed.ringing.map(net => net.name);
    this.running = false;
    this.samples.length = 0;
    return false;
  }

  /** Settles after a change while paused, reporting an oscillation the same way a run does. */
  private settle(simulator: Simulator): void {
    const result = simulator.settle();
    this.ringing = result.settled ? [] : result.ringing.map(net => net.name);
  }

  private restartPacing(): void {
    this.runStartedAt = this.now();
    this.runStartCycles = this.simulator?.cycles ?? 0;
    this.samples.length = 0;
  }

  private sample(simulator: Simulator): void {
    const at = this.now();
    this.samples.push({ at, cycles: simulator.cycles });
    while (this.samples.length > 2 && at - this.samples[0].at > 1000) {
      this.samples.shift();
    }
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * Publishes signals and status. `force` for a command, whose effect
   * should show on the next frame; otherwise at most once per interval.
   */
  private publish(force: boolean): void {
    const at = this.now();
    if (!force && at - this.lastPublishAt < this.publishIntervalMs) {
      return;
    }
    this.lastPublishAt = at;
    this.signalsSubject.next(this.signalsNow());
    this.statusSubject.next(this.statusNow());
  }

  private summary(): DocumentSummary {
    const netlist = this.netlist;
    return {
      revision: this.revision,
      opened: this.opened,
      components: this.circuit.components.length,
      // Every gate at every depth, as the simulator counts them.
      gates: netlist?.gateCount ?? this.circuit.components.filter(c => isGate(c.kind)).length,
      wires: this.circuit.wires.length,
      nets: netlist?.netCount ?? 0,
      error: this.error,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      name: this.name,
      handle: this.handle,
      dirty: this.revision !== this.savedRevision,
      camera: this.openCamera,
      message: this.message,
      path: this.pathNow(),
      chips: Object.keys(this.circuit.chips ?? {})
        .sort()
        .map(name => ({ name, shape: shapeOf({ id: '', kind: 'chip', chip: name, x: 0, y: 0 }, this.circuit.chips) as KindLayout }))
    };
  }

  /** The opened chips, each with its definition's name, for the breadcrumb. */
  private pathNow(): { id: string; chip: string }[] {
    this.level();
    const out: { id: string; chip: string }[] = [];
    let circuit = this.circuit;
    for (const id of this.path) {
      const chip = circuit.components.find(c => c.id === id)!;
      out.push({ id, chip: chip.chip! });
      circuit = this.circuit.chips![chip.chip!]!;
    }
    return out;
  }

  /**
   * Writes the autosave once changes stop for a second. Each change
   * puts it off again, so a drag writes once, when it ends, and a
   * running circuit, whose changes are not the document's, never does.
   */
  private autosave(): void {
    if (!this.autosaving || this.store === null) {
      return;
    }
    this.cancelAutosave?.();
    this.cancelAutosave = this.delay(() => {
      this.cancelAutosave = null;
      const record: Autosave = {
        format: 'gessologic-autosave',
        file: writeCircuit(this.circuit),
        name: this.name,
        handle: this.handle,
        dirty: this.revision !== this.savedRevision,
        running: this.running,
        camera: this.camera
      };
      void this.store?.write(AUTOSAVE_KEY, JSON.stringify(record));
    }, AUTOSAVE_MS);
  }

  /**
   * The level on the canvas: the top, or the definition of the chip the
   * path has opened, with the prefix its parts' nets are found under.
   * A path an edit or an undo has made stale is cut back to where it
   * still leads.
   */
  private level(): { circuit: Circuit; prefix: string } {
    let circuit = this.circuit;
    let prefix = '';
    for (let depth = 0; depth < this.path.length; depth++) {
      const id = this.path[depth]!;
      const chip = circuit.components.find(c => c.id === id && c.kind === 'chip');
      const definition = chip?.chip === undefined ? undefined : this.circuit.chips?.[chip.chip];
      if (definition === undefined) {
        this.path.length = depth;
        break;
      }
      circuit = definition;
      prefix += `${id}/`;
    }
    return { circuit, prefix };
  }

  private geometryNow(): Geometry {
    const netlist = this.netlist;
    const { circuit, prefix } = this.level();
    const chips = this.circuit.chips;
    const components: Record<string, ComponentGeometry> = {};
    for (const component of circuit.components) {
      const nets: Record<string, number> = {};
      const spec = pinsOf(component, chips);
      if (netlist !== null) {
        for (const pin of [...spec.inputs, ...spec.outputs]) {
          nets[pin] = netlist.pinNet.get(`${prefix}${component.id}.${pin}`) ?? -1;
        }
      }
      const shape = shapeOf(component, chips);
      components[component.id] = {
        kind: component.kind,
        x: component.x,
        y: component.y,
        rotation: component.rotation ?? 0,
        label: component.label ?? null,
        nets,
        chip: component.kind === 'chip' ? (component.chip ?? null) : null,
        shape: typeof shape === 'string' ? null : shape
      };
    }
    const wires: Record<string, WireGeometry> = {};
    for (const wire of circuit.wires) {
      wires[wire.id] = {
        from: wire.from,
        to: wire.to,
        net: netlist?.pinNet.get(`${prefix}${wire.from.component}.${wire.from.pin}`) ?? -1
      };
    }
    return { components, wires, level: this.path.join('/') };
  }

  private signalsNow(): Signals {
    const simulator = this.simulator;
    if (simulator === null) {
      return { cycle: 0, chunks: {} };
    }
    const chunks: Record<string, string> = {};
    for (const chunk of this.chunksToPublish()) {
      chunks[chunk] = packChunk(simulator.value, chunk);
    }
    return { cycle: simulator.cycles, chunks };
  }

  /**
   * The chunks holding a net drawn in the viewport, or every chunk before
   * the render worker has said what it can see.
   *
   * "Drawn in" by the same geometry the canvas draws with (`Layout.ts`):
   * a component whose box meets the viewport, or a wire whose route does.
   * A wire routed through the view from two components outside it is
   * still lit.
   */
  private chunksToPublish(): readonly number[] {
    const netlist = this.netlist;
    if (netlist === null) {
      return [];
    }
    if (this.visibleChunks !== null) {
      return this.visibleChunks;
    }
    const chunks = new Set<number>();
    const { circuit, prefix } = this.level();
    const chips = this.circuit.chips;
    const add = (component: string, pin: string) => {
      const net = netlist.pinNet.get(`${prefix}${component}.${pin}`);
      if (net !== undefined) {
        chunks.add(Math.floor(net / CHUNK));
      }
    };
    const viewport = this.viewport;
    if (viewport === null) {
      for (let chunk = 0; chunk * CHUNK < netlist.netCount; chunk++) {
        chunks.add(chunk);
      }
    } else {
      const byId = new Map(circuit.components.map(c => [c.id, c]));
      for (const component of circuit.components) {
        if (intersects(boxOf(shapeOf(component, chips), component.x, component.y, component.rotation), viewport)) {
          const spec = pinsOf(component, chips);
          for (const pin of [...spec.inputs, ...spec.outputs]) {
            add(component.id, pin);
          }
        }
      }
      for (const wire of circuit.wires) {
        const from = byId.get(wire.from.component);
        const to = byId.get(wire.to.component);
        if (from === undefined || to === undefined) {
          continue;
        }
        const path = route(
          pinAt(shapeOf(from, chips), from.x, from.y, wire.from.pin, from.rotation),
          pinAt(shapeOf(to, chips), to.x, to.y, wire.to.pin, to.rotation),
          slotOf(wire.to.pin)
        );
        if (intersects(boundsOf(path), viewport)) {
          add(wire.from.component, wire.from.pin);
        }
      }
    }
    this.visibleChunks = [...chunks].sort((a, b) => a - b);
    return this.visibleChunks;
  }

  private statusNow(): Status {
    let achievedHz = 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (this.running && first !== undefined && last !== undefined && last.at > first.at) {
      achievedHz = Math.round(((last.cycles - first.cycles) * 1000) / (last.at - first.at));
    }
    return {
      running: this.running,
      clockHz: this.clockHz,
      achievedHz,
      cycles: this.simulator?.cycles ?? 0,
      ringing: this.ringing
    };
  }
}

/** A document whose clocks all run at a rate; the same document when they already do. */
function withRate(circuit: Circuit, rate: ClockRate): Circuit {
  const wanted = rate === 'max' ? undefined : rate;
  if (!circuit.components.some(c => c.kind === 'clock' && c.rate !== wanted)) {
    return circuit;
  }
  return {
    ...circuit,
    components: circuit.components.map(c => {
      if (c.kind !== 'clock' || c.rate === wanted) return c;
      const { rate: _, ...rest } = c;
      return wanted === undefined ? rest : { ...rest, rate: wanted };
    })
  };
}
