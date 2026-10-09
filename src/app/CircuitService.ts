import { BehaviorSubject, type Observable } from 'rxjs';

import { CIRCUIT_VERSION, type Circuit, type Component, type PinRef, type Rotation } from '../sim/Circuit';
import { CircuitError, compile, type Netlist } from '../sim/Netlist';
import { bitPins, isGate, widthOf, type Kind, type PinSpec } from '../sim/Primitives';
import { Simulator } from '../sim/Simulator';
import type {
  ClockRate,
  ComponentGeometry,
  DocumentSummary,
  Geometry,
  SceneName,
  Signals,
  AnalyserView,
  Camera,
  ClipRequest,
  FoundView,
  ShareView,
  ExportView,
  TestsView,
  VersionsView,
  LevelView,
  MyChipsView,
  CourseView,
  Readings,
  ProgramView,
  SaveRequest,
  Status,
  TableView,
  WireGeometry
} from './CircuitContract';
import { bucketOf, CLOSED_ANALYSER, NO_CLIP, NO_PROGRAM, NO_EXPORT, NO_SAVE, NO_TESTS, NO_VERSIONS, EMPTY_LEVEL, NO_MY_CHIPS, NO_COURSE, NO_SHARE, NO_TABLE, NOTHING_FOUND, type Buckets as GeometryBuckets } from './CircuitContract';
import { findParts } from './Search';
import { History } from './History';
import { circuitOfLink, linkOf } from './ShareLink';
import { Analyser } from './Analyser';
import { writeVcd } from './Vcd';
import { runTests, testsFromNow } from './CircuitTests';
import { MyChips } from './MyChips';
import { answer, lessonCircuit, mark } from './Course';
import { lessonById } from './CourseLessons';
import { VERSION_EVERY_MS, Versions, type VersionReason, type VersionStore } from './Versions';
import { CircuitFileError, DEFAULT_FILE_NAME, readCircuit, writeCircuit } from '../sim/CircuitFile';
import { assemble, AssemblyError, listing } from '../cpu/Assembler';
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
  programChanged,
  relabel,
  remove,
  renameChip,
  rotate,
  setProgram,
  setLabel,
  setNote,
  setVia,
  straighten,
  arrange,
  type Arrangement,
  setWidth,
  sameConnectivity,
  type Fragment
} from './DocumentEdits';
import { adderScene, benchScene, busAdderScene, computerScene, counterScene, datapathScene, DIAGONAL, ramScene } from './Scenes';
import { isLibraryName, LIBRARY_PALETTE, libraryPart } from './LibraryParts';
import { truthTable } from './TruthTable';
import { boundsOf, boxOf, intersects, pinAt, route, shapeOf, slotOf, type KindLayout } from './Layout';
import { chipInterface, pinsOf } from '../sim/Chips';
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
  /** Where earlier versions are kept. Without one, none are. */
  readonly versions?: VersionStore;
  /** Where the person's own chips are kept. Without one, there are none. */
  readonly myChips?: VersionStore;
  /** Where progress through the course is kept. Without one, it lasts as long as the page. */
  readonly course?: VersionStore;
  /** The time of day, for dating versions: `Date.now` unless a spec moves it by hand. */
  readonly wallClock?: () => number;
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

/** Progress through the course, as it is kept. */
interface CourseProgress {
  /** The chips the person built, as circuit file text, by chip name. */
  readonly built: Readonly<Record<string, string>>;
  readonly done: readonly string[];
  /** The lesson the document is, or null. */
  readonly current: string | null;
  /** Each lesson's circuit as the person left it, as file text, by lesson id. */
  readonly work: Readonly<Record<string, string>>;
}

const PROGRESS_KEY = 'progress';

/** What a chip placed from the person's own chips is named with, before its name. */
export const MINE = 'mine:';

/** How long after the last edit a followed level's tests run again. */
const TEST_RUN_MS = 300;

/** The widest window the analyser shows: each column of it is folded from the ring on every publish. */
const MAX_ANALYSER_SPAN = 8192;

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
  /**
   * The chips as the document was opened, where they differ from the
   * document's now, as a circuit file of chips alone: what Reset puts
   * back. Absent from autosaves written before there was a Reset.
   */
  readonly originals?: string;
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
  readonly found: Observable<FoundView>;
  readonly shared: Observable<ShareView>;
  readonly exported: Observable<ExportView>;
  readonly tested: Observable<TestsView>;
  readonly versionsView: Observable<VersionsView>;
  readonly levelView: Observable<LevelView>;
  readonly myChipsView: Observable<MyChipsView>;
  readonly courseView: Observable<CourseView>;
  readonly readings: Observable<Readings>;
  readonly saving: Observable<SaveRequest>;
  readonly clipboard: Observable<ClipRequest>;
  readonly analyserView: Observable<AnalyserView>;
  readonly program: Observable<ProgramView>;

  private readonly documentSubject: BehaviorSubject<DocumentSummary>;
  private readonly geometrySubject: BehaviorSubject<Geometry>;
  private readonly signalsSubject: BehaviorSubject<Signals>;
  private readonly statusSubject: BehaviorSubject<Status>;
  private readonly tableSubject = new BehaviorSubject<TableView>(NO_TABLE);
  private readonly foundSubject = new BehaviorSubject<FoundView>(NOTHING_FOUND);
  private readonly shareSubject = new BehaviorSubject<ShareView>(NO_SHARE);
  private shareSerial = 0;
  private readonly exportSubject = new BehaviorSubject<ExportView>(NO_EXPORT);
  private exportSerial = 0;
  private readonly testsSubject = new BehaviorSubject<TestsView>(NO_TESTS);
  private readonly versionsSubject = new BehaviorSubject<VersionsView>(NO_VERSIONS);
  private readonly levelSubject = new BehaviorSubject<LevelView>(EMPTY_LEVEL);
  private readonly myChipsSubject = new BehaviorSubject<MyChipsView>(NO_MY_CHIPS);
  private readonly mine: MyChips | null;
  private readonly courseSubject = new BehaviorSubject<CourseView>(NO_COURSE);
  private readonly courseStore: VersionStore | null;
  /** Progress through the course: the chips built, as file text by name, the lessons passed, the lesson open, and work left in each. */
  private progress: CourseProgress = { built: {}, done: [], current: null, work: {} };
  private readonly readingsSubject = new BehaviorSubject<Readings>({});
  /** The readings last published, as text, so an unchanged set is not published again. */
  private readingsText = '{}';
  private readonly versions: Versions | null;
  private readonly wallClock: () => number;
  /** The document — by its `opened` count — whose state before its first change has been kept. */
  private versionedOpen = -1;
  /** Whether the level's tests run again after each edit, and the run waiting for edits to stop. */
  private followingTests = false;
  private cancelTestRun: (() => void) | null = null;
  private readonly savingSubject = new BehaviorSubject<SaveRequest>(NO_SAVE);
  private readonly clipboardSubject = new BehaviorSubject<ClipRequest>(NO_CLIP);
  private readonly analyserSubject = new BehaviorSubject<AnalyserView>(CLOSED_ANALYSER);
  private readonly programSubject = new BehaviorSubject<ProgramView>(NO_PROGRAM);
  private programSerial = 0;
  private readonly analyser = new Analyser();
  /** What the panel asked to see: a null start follows the newest cycle; no columns is closed. */
  private analyserAsk: { start: number | null; span: number; columns: number } = { start: null, span: 256, columns: 0 };

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
  /**
   * What the circuit was, for looking back (`History`): kept unless
   * turned off, and forgotten whenever the simulator is another one —
   * an edit renumbers the nets a keyframe's bytes are, a document is
   * another circuit.
   */
  private history: History | null = new History();
  /** The cycle shown from history, and its values: the replaying simulator's; null for now. */
  private past: { readonly cycle: number; readonly values: Uint8Array } | null = null;
  /** The simulator history is replayed in, on the live one's netlist. */
  private replayer: Simulator | null = null;
  private error: string | null = null;
  private viewport: Rect | null = null;
  private visibleChunks: number[] | null = null;

  private name: string | null = null;
  private handle: number | null = null;
  /** The chip instances opened from the top, each on the level before; empty at the top. */
  private readonly path: string[] = [];
  /**
   * Pins traced from the canvas: the level each is on, as the path that
   * opens it, and the pin there. Found again after every compile, so a
   * trace follows its pin through edits, and lapses while an edit or an
   * undo has taken it away.
   */
  private watches: { readonly id: string; readonly path: readonly string[]; readonly pin: PinRef }[] = [];
  private watchCount = 0;
  /** Last published geometry, for `geometryNow` to patch: what it was built from, and indexes into that. */
  private geometryCache: {
    level: string;
    chips: Circuit['chips'];
    netlist: Netlist | null;
    /** The level's document it was built from. */
    circuit: Circuit;
    byId: Map<string, Component>;
    /** The level's wires by the component driving them. */
    wiresFrom: Map<string, Set<Wire>>;
    components: GeometryBuckets<ComponentGeometry>;
    wires: GeometryBuckets<WireGeometry>;
  } | null = null;
  /** The revision last opened or saved; the document is dirty when it has moved on. -1 is never. */
  private savedRevision = 0;
  private openCamera: Camera | null = null;
  private camera: Camera | null = null;
  private message: string | null = null;
  private saveSerial = 0;
  private readonly store: AutosaveStore | null;
  private readonly delay: (run: () => void, ms: number) => () => void;
  /** The `opened` count of the document a first visit opened, or -1: see `DocumentSummary.welcome`. */
  private welcomeOpened = -1;
  /** The chips as the document was opened, by name: what Reset puts back. */
  private originals: Readonly<Record<string, Circuit>> = {};
  /** Whether a chip definition differs from its original, by the definition. */
  private changedCache = new WeakMap<Circuit, boolean>();
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
    this.found = this.foundSubject;
    this.shared = this.shareSubject;
    this.exported = this.exportSubject;
    this.tested = this.testsSubject;
    this.versionsView = this.versionsSubject;
    this.levelView = this.levelSubject;
    this.myChipsView = this.myChipsSubject;
    this.courseView = this.courseSubject;
    this.courseStore = options.course ?? null;
    this.readings = this.readingsSubject;
    this.wallClock = options.wallClock ?? Date.now;
    this.versions = options.versions === undefined ? null : new Versions(options.versions, this.wallClock);
    this.mine = options.myChips === undefined ? null : new MyChips(options.myChips, this.wallClock);
    this.saving = this.savingSubject;
    this.clipboard = this.clipboardSubject;
    this.analyserView = this.analyserSubject;
    this.program = this.programSubject;
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
    file: {
      name: string | null;
      handle: number | null;
      dirty?: boolean;
      camera?: Camera | null;
      originals?: Readonly<Record<string, Circuit>>;
      /** The course's lesson this document is; absent for any other. */
      lesson?: string;
    } = { name: null, handle: null }
  ): void {
    // What was open, kept before it goes, saved or not; a lesson's work
    // is kept with the course too.
    this.keepVersion('replaced');
    this.keepLessonWork();
    this.setLesson(file.lesson ?? null);
    this.opened++;
    // What the file traced, traced again; the document itself does not
    // carry them, so an edit's undo does not take a trace away.
    const { traces: _, ...document } = circuit;
    this.watches = (circuit.traces ?? []).map(t => ({ id: `watch:${++this.watchCount}`, path: [...t.path], pin: { ...t.pin } }));
    circuit = document;
    this.originals = { ...circuit.chips, ...file.originals };
    this.changedCache = new WeakMap();
    this.path.length = 0;
    this.name = file.name;
    this.handle = file.handle;
    this.openCamera = file.camera ?? null;
    this.message = null;
    this.simulator = null;
    this.forgetHistory();
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

  async share(): Promise<void> {
    const serial = ++this.shareSerial;
    try {
      this.shareSubject.next({ serial, fragment: await linkOf(this.withTraces()), error: null });
    } catch (error) {
      this.shareSubject.next({ serial, fragment: '', error: error instanceof Error ? error.message : String(error) });
    }
  }

  setTests(text: string): void {
    this.editLevel(level => {
      if ((level.tests ?? '') === text) return level;
      if (text.trim() === '') {
        const { tests: _, ...rest } = level;
        return rest;
      }
      return { ...level, tests: text };
    }, `tests:${this.opened}:${this.path.join('/')}`);
  }

  fillTests(): void {
    const level = this.levelWithChips();
    this.lastGesture = null;
    this.setTests(testsFromNow(level, this.circuit.chips));
    this.lastGesture = null;
  }

  runTests(all: boolean, follow: boolean): void {
    this.followingTests = follow && !all;
    this.cancelTestRun?.();
    this.cancelTestRun = null;
    this.testsSubject.next(this.testsNow(all));
  }

  stopTests(): void {
    this.followingTests = false;
    this.cancelTestRun?.();
    this.cancelTestRun = null;
  }

  /** The level's tests run again once edits stop for a moment, while they are followed. */
  private testsChanged(): void {
    if (!this.followingTests) return;
    this.cancelTestRun?.();
    this.cancelTestRun = this.delay(() => {
      this.cancelTestRun = null;
      if (this.followingTests) this.testsSubject.next(this.testsNow(false));
    }, TEST_RUN_MS);
  }

  private testsNow(all: boolean): TestsView {
    const chips = this.circuit.chips;
    const levels: { level: string; circuit: Circuit }[] = all
      ? [
          ...(this.circuit.tests === undefined ? [] : [{ level: 'the top level', circuit: this.circuit }]),
          ...Object.keys(chips ?? {})
            .sort()
            .filter(name => chips![name]!.tests !== undefined)
            .map(name => ({ level: name, circuit: chips![name]! }))
        ]
      : [{ level: this.pathNow().at(-1)?.chip ?? 'the top level', circuit: this.level().circuit }];
    return {
      serial: this.testsSubject.value.serial + 1,
      all,
      results: levels.map(({ level, circuit }) => ({ level, ...runTests(circuit, chips, circuit.tests ?? '') }))
    };
  }

  // -------------------------------------------------------------------------
  // The course
  // -------------------------------------------------------------------------

  private async readProgress(): Promise<CourseProgress> {
    if (this.courseStore !== null) {
      try {
        const { value } = await this.courseStore.read(PROGRESS_KEY);
        const read = value === null ? null : (JSON.parse(value) as Partial<CourseProgress>);
        if (read !== null) {
          this.progress = { built: read.built ?? {}, done: read.done ?? [], current: read.current ?? null, work: read.work ?? {} };
        }
      } catch {
        // Progress that cannot be read is a course not started.
      }
    }
    this.publishCourse(this.courseSubject.value.marking);
    return this.progress;
  }

  private writeProgress(): void {
    void this.courseStore?.write(PROGRESS_KEY, JSON.stringify(this.progress));
  }

  private setLesson(id: string | null): void {
    if (this.progress.current === id) return;
    this.progress = { ...this.progress, current: id };
    this.writeProgress();
    this.publishCourse({ serial: this.courseSubject.value.marking.serial, passed: false, lines: [] });
  }

  private publishCourse(marking: CourseView['marking']): void {
    this.courseSubject.next({ lesson: this.progress.current, done: this.progress.done, marking });
  }

  /** The chips built in the course, read from their file text. */
  private builtChips(): Record<string, Circuit> {
    const out: Record<string, Circuit> = {};
    for (const [name, text] of Object.entries(this.progress.built)) {
      try {
        out[name] = readCircuit(text);
      } catch {
        // A chip that does not read is one built again.
      }
    }
    return out;
  }

  /** The lesson open's top level as it is, kept so going back to it finds it so. */
  private keepLessonWork(): void {
    const id = this.progress.current;
    if (id === null || this.circuit.components.length === 0) return;
    const { chips: _, ...level } = this.circuit;
    this.progress = { ...this.progress, work: { ...this.progress.work, [id]: writeCircuit(level) } };
    this.writeProgress();
  }

  openLesson(id: string, fresh = false): void {
    const lesson = lessonById(id);
    if (lesson === undefined) return;
    this.keepLessonWork();
    let start: Circuit | null = null;
    const work = fresh ? undefined : this.progress.work[id];
    if (work !== undefined) {
      try {
        start = readCircuit(work);
      } catch {
        start = null;
      }
    }
    // Not the work just kept: this lesson's, opened now.
    this.progress = { ...this.progress, current: null };
    this.load(lessonCircuit(lesson, this.builtChips(), start), { name: null, handle: null, lesson: id });
    this.message = null;
    this.documentSubject.next(this.summary());
  }

  checkLesson(): void {
    const lesson = this.progress.current === null ? undefined : lessonById(this.progress.current);
    const serial = this.courseSubject.value.marking.serial + 1;
    if (lesson === undefined) return;
    const { chips, ...level } = this.circuit;
    const marking = mark(lesson, level, chips);
    if (marking.passed) {
      const { tests: _, traces: __, ...definition } = level;
      this.progress = {
        ...this.progress,
        done: this.progress.done.includes(lesson.id) ? this.progress.done : [...this.progress.done, lesson.id],
        built: { ...this.progress.built, [lesson.chip]: writeCircuit(definition) }
      };
      this.keepLessonWork();
    }
    this.writeProgress();
    this.publishCourse({ serial, passed: marking.passed, lines: marking.lines });
  }

  showAnswer(): void {
    const lesson = this.progress.current === null ? undefined : lessonById(this.progress.current);
    if (lesson === undefined) return;
    this.lastGesture = null;
    // The answer, in place of the level, as one edit: undo brings back what was there.
    this.edit({ ...answer(lesson), ...(this.circuit.tests === undefined ? {} : { tests: this.circuit.tests }), ...(this.circuit.chips === undefined ? {} : { chips: this.circuit.chips }) });
    this.publishCourse({ serial: this.courseSubject.value.marking.serial + 1, passed: false, lines: ['That is one answer. Read it, run it, and check it to move on.'] });
  }

  leaveCourse(): void {
    this.keepLessonWork();
    this.setLesson(null);
  }

  async saveMyChip(name: string): Promise<void> {
    if (this.mine === null) return;
    const kept = await this.mine.save(this.circuit, name);
    this.message = kept ? `“${name}” is in My chips: place it in any circuit from the palette.` : `Couldn't keep “${name}” in My chips.`;
    this.publishMyChips();
    this.documentSubject.next(this.summary());
  }

  async removeMyChip(name: string): Promise<void> {
    if (this.mine === null) return;
    await this.mine.remove(name);
    this.publishMyChips();
  }

  private publishMyChips(): void {
    this.myChipsSubject.next({
      chips: (this.mine?.list ?? []).map(({ name, savedAt, circuit }) => {
        const { chips, ...definition } = circuit;
        const all = { ...chips, [name]: definition };
        return {
          name,
          savedAt,
          shape: shapeOf({ id: '', kind: 'chip', chip: name, x: 0, y: 0 }, all) as KindLayout,
          notes: pinNotes(definition)
        };
      })
    });
  }

  exportWaveforms(): void {
    const dump = this.analyser.dump();
    const serial = ++this.exportSerial;
    if (dump.traces.length === 0 || dump.last < dump.first) {
      this.exportSubject.next({
        ...NO_EXPORT,
        serial,
        error: dump.traces.length === 0 ? 'nothing is traced in the analyser' : 'the analyser has not recorded a cycle yet: run or step the circuit first'
      });
      return;
    }
    const base = this.baseName();
    this.exportSubject.next({
      serial,
      name: `${base}.vcd`,
      text: writeVcd(dump, { date: new Date().toUTCString(), scope: base }),
      mediaType: 'text/plain',
      error: null
    });
  }

  /** The document's name without its extensions, for naming what is made from it. */
  private baseName(): string {
    return (this.name ?? 'circuit').replace(/(\.gessologic)?\.json$/i, '') || 'circuit';
  }

  async openShared(fragment: string): Promise<void> {
    let circuit: Circuit;
    try {
      circuit = await circuitOfLink(fragment);
    } catch (error) {
      if (!(error instanceof CircuitFileError)) throw error;
      this.message = `Couldn't open the shared link: ${error.message}`;
      this.documentSubject.next(this.summary());
      return;
    }
    // Not saved anywhere yet: the person who opened it decides whether to keep it.
    this.load(circuit, { name: null, handle: null, dirty: true });
    this.message = 'Opened a shared circuit. It is not saved anywhere yet: Save keeps a copy.';
    this.documentSubject.next(this.summary());
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
      text: writeCircuit(this.withTraces()),
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
  async restore(first?: { readonly name: string; readonly source: string; readonly rate: number }): Promise<void> {
    if (this.autosaving || this.store === null) {
      return;
    }
    // The read is asynchronous, and a person does not wait for it: a
    // scene loaded, a file opened or an edit made before it answers is
    // the document now, and the autosave must not replace it.
    const openedAtAsk = this.opened;
    const revisionAtAsk = this.revision;
    const versionsRead = this.versions?.load();
    const mineRead = this.mine?.load().then(() => this.publishMyChips());
    const courseRead = this.readProgress();
    try {
      const { value } = await this.store.read(AUTOSAVE_KEY);
      const saved = value === null ? null : (JSON.parse(value) as Autosave);
      const untouched = this.opened === openedAtAsk && this.revision === revisionAtAsk;
      if (untouched && saved !== null && saved.format === 'gessologic-autosave') {
        this.load(readCircuit(saved.file), {
          name: saved.name,
          handle: saved.handle,
          dirty: saved.dirty,
          camera: saved.camera,
          originals: saved.originals === undefined ? undefined : readCircuit(saved.originals).chips
        });
        this.camera = saved.camera;
        if (saved.running) this.run();
        // A lesson open when the page closed is the document it brought back.
        const progress = await courseRead;
        if (progress.current !== null && lessonById(progress.current) !== undefined) this.setLesson(progress.current);
      } else if (untouched && value === null && first !== undefined) {
        // A first visit: the showpiece, already playing.
        this.loadProgram(first.name, first.source, first.rate);
        this.message = null;
        this.welcomeOpened = this.opened;
        this.documentSubject.next(this.summary());
        this.run();
      }
    } catch {
      // An autosave that cannot be read is one that is not there: the
      // person starts with an empty canvas, which is what they would
      // have had without it, and the next change overwrites it.
    }
    await versionsRead;
    await mineRead;
    await courseRead;
    this.autosaving = true;
    this.publishVersions();
  }

  /**
   * Keeps a copy of the document as it is now, in the version history:
   * once the autosave is running, and when there is anything to keep.
   */
  private keepVersion(reason: VersionReason): void {
    const versions = this.versions;
    if (versions === null || !this.autosaving) return;
    if (this.circuit.components.length === 0 && Object.keys(this.circuit.chips ?? {}).length === 0) return;
    const record = { file: writeCircuit(this.withTraces()), name: this.name, handle: this.handle, ...(this.changedOriginals() === undefined ? {} : { originals: this.changedOriginals()! }) };
    void versions.keep(record, reason, this.circuit.components.length).then(() => this.publishVersions());
    this.publishVersions();
  }

  private publishVersions(): void {
    const entries = this.versions?.list ?? [];
    if (entries.length === this.versionsSubject.value.entries.length && entries.every((e, i) => e.id === this.versionsSubject.value.entries[i]!.id)) return;
    this.versionsSubject.next({ entries: entries.map(({ id, at, reason, name, parts }) => ({ id, at, reason, name, parts })) });
  }

  async restoreVersion(id: number): Promise<void> {
    const entry = this.versions?.list.find(e => e.id === id);
    const record = entry === undefined ? null : await this.versions!.read(id);
    let circuit: Circuit;
    try {
      if (record === null) throw new CircuitFileError('it is no longer kept');
      circuit = readCircuit(record.file);
    } catch (error) {
      if (!(error instanceof CircuitFileError) && !(error instanceof SyntaxError)) throw error;
      this.message = `Couldn't restore that version: ${error.message}`;
      this.documentSubject.next(this.summary());
      return;
    }
    this.keepVersion('restored');
    this.load(circuit, {
      name: record!.name,
      handle: record!.handle,
      dirty: true,
      originals: record!.originals === undefined ? undefined : readCircuit(record!.originals).chips
    });
    this.message = 'Restored an earlier version. What was open before is kept in the list too.';
    this.documentSubject.next(this.summary());
  }

  loadScene(name: SceneName): void {
    this.load(
      name === 'bench'
        ? benchScene()
        : name === 'counter'
          ? counterScene()
          : name === 'adder'
            ? adderScene()
            : name === 'bus adder'
              ? busAdderScene()
              : name === 'ram'
                ? ramScene()
                : name === 'datapath'
                  ? datapathScene()
                  : name === 'computer'
                    ? computerScene()
                    : name === 'diagonal'
                      ? computerScene(DIAGONAL, 60)
                      : { version: CIRCUIT_VERSION, components: [], wires: [] }
    );
  }

  loadProgram(name: string, source: string, rate = 60): void {
    let circuit: Circuit;
    try {
      circuit = computerScene(source, rate);
    } catch (error) {
      if (!(error instanceof AssemblyError)) throw error;
      this.message = `Couldn't assemble ${name}: ${error.message}`;
      this.documentSubject.next(this.summary());
      return;
    }
    this.load(circuit);
    this.message = `Loaded the computer, running ${name}`;
    this.documentSubject.next(this.summary());
  }

  place(kind: Kind, x: number, y: number, id?: string, rotation?: Rotation, chip?: string, width?: number): void {
    this.editLevel(level => {
      // A library part the document does not have yet comes in first,
      // with the parts it is made of; placing and bringing it are one edit.
      let target = level;
      let name = chip;
      if (kind === 'chip' && chip !== undefined && level.chips?.[chip] === undefined && isLibraryName(chip)) {
        const parts = libraryPart(chip);
        const { [chip]: definition, ...dependencies } = parts;
        const brought = importChip(level, { ...definition!, chips: dependencies }, chip);
        target = brought.circuit;
        name = brought.name ?? chip;
      }
      // One of the person's own chips: brought in the same way, numbered
      // if the document has another of its name.
      if (kind === 'chip' && chip !== undefined && chip.startsWith(MINE)) {
        const kept = this.mine?.get(chip.slice(MINE.length));
        if (kept === undefined) return level;
        const brought = importChip(level, kept.circuit, kept.name);
        if (brought.name === null) return level;
        target = brought.circuit;
        name = brought.name;
      }
      const placed = place(target, id ?? freshId(target, kind), kind, x, y, rotation, name, width);
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
    const next = renameChip(this.circuit, from, to);
    const original = this.originalOf(from);
    if (next !== this.circuit && original !== undefined) {
      // The original goes by the new name too, and keeps the old one
      // for an undo of the rename.
      const chips = { ...this.originals, [from]: original };
      const renamed = renameChip({ version: CIRCUIT_VERSION, components: [], wires: [], chips }, from, to).chips;
      this.originals = { ...this.originals, ...renamed };
    }
    this.edit(next);
  }

  /**
   * Puts a chip back as the document was opened — or, for a library
   * part brought in since, as the library has it — with every chip it
   * is made of. One edit, so undo takes it back.
   */
  resetChip(name: string): void {
    if (!this.changedChips().includes(name)) return;
    const chips = { ...this.circuit.chips };
    const todo = [name];
    const seen = new Set<string>();
    while (todo.length > 0) {
      const next = todo.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const original = this.originalOf(next);
      if (original === undefined) continue;
      chips[next] = original;
      for (const c of original.components) if (c.kind === 'chip' && c.chip !== undefined) todo.push(c.chip);
    }
    this.edit({ ...this.circuit, chips });
    this.message = `Reset ${name} to how it was opened`;
    this.documentSubject.next(this.summary());
  }

  /** A chip as the document was opened, or as the library has it. */
  private originalOf(name: string): Circuit | undefined {
    const opened = this.originals[name];
    if (opened !== undefined) return opened;
    return isLibraryName(name) ? libraryPart(name)[name] : undefined;
  }

  /** Whether a chip's own definition differs from its original. Cached on the definition, which an edit replaces. */
  private differs(name: string, definition: Circuit): boolean {
    const known = this.changedCache.get(definition);
    if (known !== undefined) return known;
    const original = this.originalOf(name);
    const differs = original !== definition && (original === undefined || JSON.stringify(original) !== JSON.stringify(definition));
    this.changedCache.set(definition, differs);
    return differs;
  }

  /**
   * The chips that differ from their originals, themselves or in a chip
   * they are made of: the ones Reset has something to put back. A chip
   * with no original — one made here — has nothing to go back to.
   */
  private changedChips(): string[] {
    const chips = this.circuit.chips ?? {};
    const memo = new Map<string, boolean>();
    const changed = (name: string, trail: Set<string>): boolean => {
      const known = memo.get(name);
      if (known !== undefined) return known;
      const definition = chips[name];
      if (this.originalOf(name) === undefined) return false;
      if (definition === undefined || trail.has(name)) return definition === undefined;
      trail.add(name);
      const result =
        this.differs(name, definition) ||
        definition.components.some(c => c.kind === 'chip' && c.chip !== undefined && changed(c.chip, trail));
      trail.delete(name);
      memo.set(name, result);
      return result;
    };
    return Object.keys(chips).filter(name => changed(name, new Set()));
  }

  /** The originals that differ from the chips now, as a file for the autosave; undefined when none do. */
  private changedOriginals(): string | undefined {
    const chips = this.circuit.chips ?? {};
    const differing = Object.fromEntries(Object.entries(this.originals).filter(([name, original]) => chips[name] !== original));
    if (Object.keys(differing).length === 0) return undefined;
    return writeCircuit({ version: CIRCUIT_VERSION, components: [], wires: [], chips: differing });
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

  openPath(ids: readonly string[]): void {
    let circuit = this.circuit;
    const path: string[] = [];
    for (const id of ids) {
      const chip = circuit.components.find(c => c.id === id && c.kind === 'chip');
      const definition = chip?.chip === undefined ? undefined : this.circuit.chips?.[chip.chip];
      if (definition === undefined) break;
      path.push(id);
      circuit = definition;
    }
    if (path.length === this.path.length && path.every((id, i) => id === this.path[i])) return;
    this.path.length = 0;
    this.path.push(...path);
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
    this.levelSubject.next(this.levelNow());
    this.testsChanged();
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

  setVia(id: string, via: readonly { readonly x: number; readonly y: number }[] | null, gesture?: string): void {
    this.editLevel(level => setVia(level, id, via), gesture);
  }

  straighten(ids: readonly string[]): void {
    this.editLevel(level => straighten(level, ids));
  }

  arrange(ids: readonly string[], how: Arrangement): void {
    this.editLevel(level => arrange(level, ids, how));
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

  setWidth(ids: readonly string[], width: number): void {
    this.editLevel(level => setWidth(level, ids, width));
  }

  setLabel(id: string, label: string): void {
    const chip = this.path.length === 0 ? null : this.pathNow().at(-1)!.chip;
    const part = this.level().circuit.components.find(c => c.id === id);
    if (part === undefined) return;
    const next = setLabel(this.circuit, chip, id, label);
    if (next === this.circuit) {
      if ((part.label ?? '') !== label.trim()) {
        this.message = `Another pin of ${chip} is already called ${label.trim() || id}.`;
        this.documentSubject.next(this.summary());
      }
      return;
    }
    // A pin renamed: what was traced on it, on any instance, follows it.
    if (chip !== null && (part.kind === 'input' || part.kind === 'output')) {
      const from = part.label ?? part.id;
      const to = label.trim() === '' ? part.id : label.trim();
      this.watches = this.watches.map(w => {
        if (w.pin.pin !== from) return w;
        let level: Circuit | undefined = this.circuit;
        for (const step of w.path) {
          const instance: Component | undefined = level?.components.find(c => c.id === step && c.kind === 'chip');
          level = instance?.chip === undefined ? undefined : this.circuit.chips?.[instance.chip];
        }
        const instance = level?.components.find(c => c.id === w.pin.component);
        return instance?.kind === 'chip' && instance.chip === chip ? { ...w, pin: { component: w.pin.component, pin: to } } : w;
      });
    }
    this.edit(next);
  }

  setNote(id: string, note: string): void {
    this.editLevel(level => setNote(level, id, note));
  }

  openProgram(id: string): void {
    const rom = id === '' ? undefined : this.romOnLevel(id);
    if (rom === undefined) {
      if (this.programSubject.value.id !== '') this.programSubject.next(NO_PROGRAM);
      return;
    }
    const words = rom.rom ?? [];
    let source = listing(words);
    let note: string | null = 'This ROM kept no program, only its words, so this is a listing of them.';
    if (rom.source !== undefined) {
      if (assemblesTo(rom.source, words)) {
        source = rom.source;
        note = null;
      } else {
        note = "This ROM's program doesn't assemble to its words, so this is a listing of the words.";
      }
    }
    this.programSubject.next({
      id,
      label: rom.label ?? id,
      source,
      note,
      words: sizeOf(words),
      problems: [],
      serial: ++this.programSerial,
      lines: linesOf(source),
      pc: this.programCounter(id)
    });
  }

  setProgram(id: string, source: string): void {
    const rom = this.romOnLevel(id);
    if (rom === undefined) return;
    let words: number[];
    try {
      const { rom: image, size } = assemble(source);
      words = [...image.slice(0, size)];
    } catch (error) {
      if (!(error instanceof AssemblyError)) throw error;
      this.programSubject.next({ ...this.programView(id, rom), source, problems: error.problems, serial: ++this.programSerial });
      return;
    }
    const revision = this.revision;
    this.editLevel(level => setProgram(level, id, words, source));
    const label = rom.label ?? id;
    this.message =
      this.revision === revision ? `${label} already holds that program` : `Loaded ${words.length} word${words.length === 1 ? '' : 's'} into ${label}, and restarted`;
    this.programSubject.next({
      id,
      label,
      source,
      note: null,
      words: words.length,
      problems: [],
      serial: ++this.programSerial,
      lines: linesOf(source),
      pc: this.programCounter(id)
    });
    this.documentSubject.next(this.summary());
  }

  /** The address on a ROM's `A` pins, or -1 while nothing runs. */
  private programCounter(id: string): number {
    const simulator = this.simulator;
    const netlist = this.netlist;
    if (simulator === null || netlist === null) return -1;
    const full = this.level().prefix + id;
    let address = 0;
    for (let bit = 0; bit < 8; bit++) {
      const net = netlist.netOfPin(full, `A[${bit}]`);
      if (net === undefined) return -1;
      address |= simulator.value[net]! << bit;
    }
    return address;
  }

  /** Moves the open editor's program counter on, when it has moved. */
  private followProgram(): void {
    const view = this.programSubject.value;
    if (view.id === '') return;
    const pc = this.programCounter(view.id);
    if (pc !== view.pc) this.programSubject.next({ ...view, pc });
  }

  /** A ROM on the level on the canvas, by id. */
  private romOnLevel(id: string): Component | undefined {
    return this.level().circuit.components.find(c => c.id === id && c.kind === 'rom');
  }

  /** What the open editor shows of a ROM, keeping its source and note. */
  private programView(id: string, rom: Component): ProgramView {
    const open = this.programSubject.value;
    return open.id === id ? open : { ...NO_PROGRAM, id, label: rom.label ?? id, words: sizeOf(rom.rom ?? []) };
  }

  setInput(id: string, value: number): void {
    const simulator = this.simulator;
    if (simulator === null || !this.netlist?.inputs.has(id)) {
      return;
    }
    this.history?.input(simulator.cycles, id, value);
    this.past = null;
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
    this.past = null;
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
    this.past = null;
    this.cycle(simulator);
    this.publish(true);
  }

  showCycle(cycle: number | null): void {
    const simulator = this.simulator;
    const netlist = this.netlist;
    if (cycle === null || simulator === null || netlist === null || this.running || this.history === null) {
      if (this.past === null) return;
      this.past = null;
      this.publish(true);
      return;
    }
    const plan = this.history.plan(cycle);
    if (plan === null) return;
    let replayer = this.replayer;
    if (replayer === null || replayer.netlist !== netlist) replayer = this.replayer = new Simulator(netlist);
    // On from where the last look stopped, when that is on the way: a
    // scrub forward is a cycle or two a move, not a run from a keyframe.
    if (this.past === null || replayer.cycles > cycle || replayer.cycles < plan.from.cycle) {
      replayer.restore(plan.from.values, plan.from.cycle);
    }
    let next = plan.inputs.findIndex(i => i.cycle >= replayer.cycles);
    if (next < 0) next = plan.inputs.length;
    while (replayer.cycles < cycle) {
      while (next < plan.inputs.length && plan.inputs[next]!.cycle === replayer.cycles) {
        replayer.set(plan.inputs[next]!.id, plan.inputs[next]!.value);
        next++;
      }
      replayer.cycle();
    }
    this.past = { cycle, values: replayer.value };
    this.publish(true);
  }

  resumeFromHere(): void {
    const simulator = this.simulator;
    const past = this.past;
    if (simulator === null || past === null || this.running) return;
    const dropped = simulator.cycles - past.cycle;
    simulator.restore(past.values, past.cycle);
    this.history?.truncate(past.cycle);
    this.analyser.truncate(past.cycle);
    this.past = null;
    this.restartPacing();
    this.message = `Resumed from cycle ${past.cycle.toLocaleString('en')}: the ${dropped.toLocaleString('en')} ${dropped === 1 ? 'cycle' : 'cycles'} after it are gone.`;
    this.documentSubject.next(this.summary());
    this.publish(true);
    this.autosave();
  }

  setKeepHistory(keep: boolean): void {
    if (keep === (this.history !== null)) return;
    this.history = keep ? new History() : null;
    this.past = null;
    this.replayer = null;
    this.publish(true);
  }

  /** Another simulator: history is the last one's, in its nets' numbering. */
  private forgetHistory(): void {
    this.history?.clear();
    this.past = null;
    this.replayer = null;
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
    // The document as it was opened, kept before its first change.
    if (this.versionedOpen !== this.opened) {
      this.versionedOpen = this.opened;
      this.keepVersion('opened');
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
    const visible = this.visibleChunks;
    this.visibleChunks = null;
    if (this.netlist !== null && this.simulator !== null && sameConnectivity(previous, next)) {
      this.documentSubject.next(this.summary());
      this.geometrySubject.next(this.geometryNow());
    this.levelSubject.next(this.levelNow());
      this.traceNow();
      this.testsChanged();
      this.publish(true);
      return;
    }
    try {
      // Against the netlist before, so nets keep their numbers.
      const netlist = compile(next, this.netlist ?? undefined);
      const simulator = new Simulator(netlist);
      // A new program starts from power-on: see `programChanged`.
      const restarted = this.simulator !== null && programChanged(previous, next);
      if (this.simulator !== null && !restarted) {
        simulator.adopt(this.simulator);
      }
      // Nets keep their numbers, so what was in view still is, give or
      // take the nets the edit touched: those are added rather than the
      // viewport searched again. One that left the view is published
      // until the view next moves, which costs a little and shows
      // nothing wrong.
      if (visible !== null && netlist.numberedAgainst === this.netlist && netlist.changedNets !== null) {
        const chunks = new Set(visible);
        for (const net of netlist.changedNets) chunks.add(Math.floor(net / CHUNK));
        this.visibleChunks = [...chunks].sort((a, b) => a - b);
      }
      this.netlist = netlist;
      this.simulator = simulator;
      this.forgetHistory();
      this.error = null;
      // Paced from cycle 0 again, or a run at a set rate would race to
      // catch up with the cycles the old program had run.
      if (restarted) this.restartPacing();
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
    this.levelSubject.next(this.levelNow());
    this.traceNow();
    // The editor closes on a ROM that has gone: deleted, or undone away.
    const program = this.programSubject.value;
    if (program.id !== '' && this.romOnLevel(program.id) === undefined) {
      this.programSubject.next(NO_PROGRAM);
    }
    this.testsChanged();
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
    // A slice that stopped the run — an oscillation, or the analyser's
    // trigger — publishes whatever the interval says: left to the
    // interval, the last status said "running" for good and the problem
    // that stopped it was never shown.
    this.publish(!this.running);
    if (this.running) {
      this.queueSlice();
    }
  }

  /** One clock cycle. An oscillation pauses the run and is reported; returns whether it settled. */
  private cycle(simulator: Simulator): boolean {
    const result = simulator.cycle();
    this.history?.record(simulator.cycles, simulator.value);
    if (this.analyser.record(simulator.cycles, simulator.value)) {
      // The trigger: pause on the cycle the condition became true, and say so.
      const trigger = this.analyser.armed!;
      const name = this.analyser.traced.find(t => t.id === trigger.trace)?.name ?? trigger.trace;
      this.running = false;
      this.samples.length = 0;
      this.message = `Triggered at cycle ${simulator.cycles.toLocaleString('en')}: ${name} = ${trigger.value}`;
      this.documentSubject.next(this.summary());
    }
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
    this.publishReadings();
    this.followProgram();
    if (this.analyserAsk.columns > 0) {
      this.analyserSubject.next(this.analyserNow());
    }
  }

  /**
   * The level on the canvas for an agent: every part with its pins, every
   * wire by the pins it joins. What the geometry says, without what only
   * a screen needs — buckets, nets, shapes.
   */
  private levelNow(): LevelView {
    const { circuit } = this.level();
    const chips = this.circuit.chips;
    const shapes = shapeCache(chips);
    const chain = this.pathNow();
    return {
      path: chain.length === 0 ? 'the top level' : chain.map(step => step.chip).join(' › '),
      parts: circuit.components.map(c => {
        const pins = shapes.pins(c);
        return {
          id: c.id,
          kind: c.kind,
          x: c.x,
          y: c.y,
          ...(c.label === undefined ? {} : { label: c.label }),
          ...(c.chip === undefined ? {} : { chip: c.chip }),
          ...(c.width === undefined ? {} : { width: c.width }),
          ...(c.rotation === undefined || c.rotation === 0 ? {} : { rotation: c.rotation }),
          inputs: pins.inputs,
          outputs: pins.outputs
        };
      }),
      wires: circuit.wires.map(w => ({
        id: w.id,
        from: `${w.from.component}.${w.from.pin}`,
        to: `${w.to.component}.${w.to.pin}`,
        ...(w.via === undefined ? {} : { bent: true as const })
      }))
    };
  }

  /**
   * What the level's switches, buttons, LEDs, probes and displays show,
   * by id: what an agent reads to see whether a circuit works. Published
   * with the signals, and only when something in it changed.
   */
  private publishReadings(): void {
    const simulator = this.simulator;
    const netlist = this.netlist;
    const readings: Record<string, number | null> = {};
    if (simulator !== null && netlist !== null) {
      const values = this.past?.values ?? simulator.value;
      const { circuit, prefix } = this.level();
      for (const c of circuit.components) {
        const pins =
          c.kind === 'input' || c.kind === 'button' || c.kind === 'constant' || c.kind === 'clock'
            ? bitPins('out', c.width ?? 1)
            : c.kind === 'output' || c.kind === 'probe'
              ? bitPins('in', c.width ?? 1)
              : c.kind === 'hex'
                ? c.width === undefined
                  ? ['b0', 'b1', 'b2', 'b3']
                  : bitPins('in', c.width)
                : null;
        if (pins === null) continue;
        let value: number | null = 0;
        pins.forEach((pin, bit) => {
          const net = netlist.netOfPin(prefix + c.id, pin);
          if (net === undefined || value === null) value = null;
          else value |= (values[net] ?? 0) << bit;
        });
        readings[c.id] = value === null ? null : value >>> 0;
      }
    }
    const text = JSON.stringify(readings);
    if (text === this.readingsText) return;
    this.readingsText = text;
    this.readingsSubject.next(readings);
  }

  setAnalyserView(start: number | null, span: number, columns: number): void {
    this.analyserAsk = { start, span: Math.max(1, Math.min(MAX_ANALYSER_SPAN, Math.round(span))), columns: Math.max(0, Math.round(columns)) };
    this.analyserSubject.next(this.analyserAsk.columns > 0 ? this.analyserNow() : CLOSED_ANALYSER);
  }

  setTrigger(trace: string | null, value: number): void {
    this.analyser.setTrigger(trace === null ? null : { trace, value });
    if (this.analyserAsk.columns > 0) this.analyserSubject.next(this.analyserNow());
  }

  watch(pins: readonly PinRef[]): void {
    // Against the other pins traced, not the probes and LEDs: a pin asked
    // for is shown, under its own name, though an LED is on its net.
    const traced = new Set(this.analyser.traced.filter(t => t.watched === true).map(t => t.nets.join(',')));
    let added = false;
    for (const pin of pins) {
      const watch = { id: `watch:${++this.watchCount}`, path: [...this.path], pin: { component: pin.component, pin: pin.pin } };
      const found = this.resolveWatch(watch);
      if (found === null || traced.has(found.nets.join(','))) continue;
      traced.add(found.nets.join(','));
      this.watches.push(watch);
      added = true;
    }
    if (!added) return;
    this.tracesChanged();
  }

  /** The document as a file has it: with what is traced. */
  private withTraces(): Circuit {
    return this.watches.length === 0 ? this.circuit : { ...this.circuit, traces: this.watches.map(({ path, pin }) => ({ path, pin })) };
  }

  /** What is traced is saved with the file, so changing it is a change to save. */
  private tracesChanged(): void {
    this.traceNow();
    if (this.analyserAsk.columns > 0) this.analyserSubject.next(this.analyserNow());
    if (this.savedRevision === this.revision) this.savedRevision = -1;
    this.autosave();
    this.documentSubject.next(this.summary());
  }

  find(query: string): void {
    this.foundSubject.next({ query, parts: findParts(this.circuit, query) });
  }

  unwatch(id: string): void {
    const before = this.watches.length;
    this.watches = this.watches.filter(w => w.id !== id);
    if (this.watches.length === before) return;
    this.tracesChanged();
  }

  /**
   * A watched pin's nets, width and names, or null while the path to it
   * or the pin itself is not in the document, or nothing compiles.
   */
  private resolveWatch(watch: { readonly path: readonly string[]; readonly pin: PinRef }): {
    nets: number[];
    width: number;
    name: string;
    parent: string;
    title: string;
  } | null {
    const netlist = this.netlist;
    if (netlist === null) return null;
    let circuit = this.circuit;
    let prefix = '';
    const chips: string[] = [];
    for (const id of watch.path) {
      const chip = circuit.components.find(c => c.id === id && c.kind === 'chip');
      const definition = chip?.chip === undefined ? undefined : this.circuit.chips?.[chip.chip];
      if (definition === undefined) return null;
      chips.push(chip!.label ?? id);
      circuit = definition;
      prefix += `${id}/`;
    }
    const part = circuit.components.find(c => c.id === watch.pin.component);
    if (part === undefined) return null;
    const spec = pinsOf(part, this.circuit.chips);
    if (!spec.inputs.includes(watch.pin.pin) && !spec.outputs.includes(watch.pin.pin)) return null;
    const width = widthOf(spec, watch.pin.pin);
    const nets = bitPins(watch.pin.pin, width).map(bit => netlist.netOfPin(prefix + part.id, bit) ?? -1);
    const name = `${part.label ?? part.id}.${watch.pin.pin}`;
    return { nets, width, name, parent: chips.at(-1) ?? 'top', title: [...chips, name].join(' › ') };
  }

  private analyserNow(): AnalyserView {
    const { start, span, columns } = this.analyserAsk;
    // A window scrubbed back past the oldest cycle held slides forward
    // with it, rather than showing cycles long since overwritten.
    const from = start === null ? this.analyser.last - span + 1 : Math.max(start, Math.min(this.analyser.first, this.analyser.last - span + 1));
    const window = this.analyser.window(from, span, columns);
    return {
      open: true,
      traces: this.analyser.traced.map(({ id, name, width, watched, title, path, pin }) => ({
        id,
        name,
        width,
        watched: watched === true,
        title: title ?? name,
        path: path ?? [],
        pin: pin ?? { component: id, pin: 'in' }
      })),
      first: this.analyser.first,
      last: this.analyser.last,
      following: start === null,
      ...window,
      trigger: this.analyser.armed
    };
  }

  /**
   * What the analyser traces: every probe and LED on the top level, by
   * label, top to bottom as drawn, a wide one a bus; then every pin
   * watched from the canvas that is still there, in the order watched,
   * named `part.pin` — or `chip/part.pin` where two would share a name.
   */
  private traceNow(): void {
    const netlist = this.netlist;
    if (netlist === null) {
      this.analyser.configure([]);
      return;
    }
    const traces = this.circuit.components
      .filter(c => c.kind === 'output' || c.kind === 'probe')
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map(c => {
        const width = c.width ?? 1;
        return {
          id: c.id,
          name: c.label ?? c.id,
          width,
          nets: bitPins('in', width).map(bit => netlist.netOfPin(c.id, bit) ?? -1)
        };
      });
    const watched = this.watches.flatMap(w => {
      const found = this.resolveWatch(w);
      return found === null ? [] : [{ id: w.id, path: w.path, pin: w.pin, ...found }];
    });
    const names = new Map<string, number>();
    for (const n of [...traces.map(t => t.name), ...watched.map(w => w.name)]) names.set(n, (names.get(n) ?? 0) + 1);
    this.analyser.configure([
      ...traces,
      ...watched.map(w => ({
        id: w.id,
        name: names.get(w.name)! > 1 ? `${w.parent}/${w.name}` : w.name,
        width: w.width,
        nets: w.nets,
        watched: true,
        title: w.title,
        path: w.path,
        pin: w.pin
      }))
    ]);
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
      nets: netlist?.liveNetCount ?? 0,
      error: this.error,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      name: this.name,
      handle: this.handle,
      dirty: this.revision !== this.savedRevision,
      camera: this.openCamera,
      message: this.message,
      path: this.pathNow(),
      welcome: this.welcomeOpened === this.opened,
      changedChips: this.changedChips(),
      tests: this.level().circuit.tests ?? '',
      testedLevels: (this.circuit.tests === undefined ? 0 : 1) + Object.values(this.circuit.chips ?? {}).filter(c => c.tests !== undefined).length,
      library: LIBRARY_PALETTE,
      chips: Object.keys(this.circuit.chips ?? {})
        .sort()
        .map(name => ({
          name,
          shape: shapeOf({ id: '', kind: 'chip', chip: name, x: 0, y: 0 }, this.circuit.chips) as KindLayout,
          notes: pinNotes(this.circuit.chips![name]!)
        }))
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
        file: writeCircuit(this.withTraces()),
        name: this.name,
        handle: this.handle,
        dirty: this.revision !== this.savedRevision,
        running: this.running,
        camera: this.camera,
        originals: this.changedOriginals()
      };
      void this.store?.write(AUTOSAVE_KEY, JSON.stringify(record));
      // Every few minutes, while it is being changed: the autosave also
      // follows the view, and a document only looked at is kept as it was
      // when it is replaced.
      const edited = this.versionedOpen === this.opened;
      if (this.versions !== null && edited && this.wallClock() - this.versions.newestAt >= VERSION_EVERY_MS) this.keepVersion('editing');
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

  /**
   * The level's geometry, patched rather than rebuilt. Nets are numbered
   * stably across recompiles (`compile`'s `previous`), and the compile
   * says which components' pins moved; the document says, by object
   * identity, which parts and wires are new or gone. So an edit builds
   * the entries it touched — a gate dragged is one, a wire removed the
   * few on the net it split — and publishes only the buckets they are in
   * (see `GEOMETRY_BUCKETS`). Anything the edit cannot be read from —
   * another level, a chip redefined, a compile renumbered from zero, one
   * that failed — is built afresh.
   */
  private geometryNow(): Geometry {
    const netlist = this.netlist;
    const { circuit, prefix } = this.level();
    const chips = this.circuit.chips;
    const levelKey = `${this.opened}|${this.path.join('/')}`;
    const netOf = (component: string, pin: string) => netlist?.netOfPin(prefix + component, pin) ?? -1;
    const shapes = shapeCache(chips);
    const buildComponent = (component: Component): ComponentGeometry => {
      const spec = shapes.pins(component);
      const nets: Record<string, number> = {};
      if (netlist !== null) {
        // A bus pin under its own name has its first bit's net, and each
        // bit under `pin[i]`.
        for (const pin of [...spec.inputs, ...spec.outputs]) {
          const width = widthOf(spec, pin);
          nets[pin] = netOf(component.id, width === 1 ? pin : `${pin}[0]`);
          for (let i = 0; i < width && width > 1; i++) nets[`${pin}[${i}]`] = netOf(component.id, `${pin}[${i}]`);
        }
      }
      const shape = shapes.shape(component);
      return {
        kind: component.kind,
        x: component.x,
        y: component.y,
        rotation: component.rotation ?? 0,
        label: component.label ?? null,
        nets,
        chip: component.kind === 'chip' ? (component.chip ?? null) : null,
        width: component.width ?? 1,
        shape: typeof shape === 'string' ? null : shape,
        note: component.note ?? null
      };
    };
    const buildWire = (wire: Wire, byId: ReadonlyMap<string, Component>): WireGeometry => {
      const from = byId.get(wire.from.component);
      const width = from === undefined ? 1 : widthOf(shapes.pins(from), wire.from.pin);
      const first = netOf(wire.from.component, width === 1 ? wire.from.pin : `${wire.from.pin}[0]`);
      const bits = width === 1 ? [] : Array.from({ length: width }, (_, i) => netOf(wire.from.component, `${wire.from.pin}[${i}]`));
      return { from: wire.from, to: wire.to, net: first, width, bits, via: wire.via ?? null };
    };

    const cache = this.geometryCache;
    // Which components' pins moved since the cache was built: none, when
    // the netlist is the same one; the compile's word, when it was
    // numbered against that one; otherwise unknown.
    const changed =
      cache === null || cache.level !== levelKey || cache.chips !== chips
        ? null
        : netlist === cache.netlist
          ? new Set<string>()
          : netlist !== null && netlist.numberedAgainst === cache.netlist
            ? netlist.changedComponents
            : null;
    if (cache === null || changed === null) {
      const byId = new Map<string, Component>();
      const wiresFrom = new Map<string, Set<Wire>>();
      const components = new Buckets<ComponentGeometry>();
      const wires = new Buckets<WireGeometry>();
      for (const component of circuit.components) {
        byId.set(component.id, component);
        components.set(component.id, buildComponent(component));
      }
      for (const wire of circuit.wires) {
        addTo(wiresFrom, wire.from.component, wire);
        wires.set(wire.id, buildWire(wire, byId));
      }
      this.geometryCache = { level: levelKey, chips, netlist, circuit, byId, wiresFrom, components: components.publish(), wires: wires.publish() };
    } else {
      const { byId, wiresFrom } = cache;
      const components = new Buckets(cache.components);
      const wires = new Buckets(cache.wires);
      const parts = changesBetween(cache.circuit.components, circuit.components);
      const links = changesBetween(cache.circuit.wires, circuit.wires);
      for (const component of parts.removed) {
        if (byId.get(component.id) === component) {
          byId.delete(component.id);
          components.delete(component.id);
        }
      }
      for (const wire of links.removed) {
        wiresFrom.get(wire.from.component)?.delete(wire);
        wires.delete(wire.id);
      }
      for (const component of parts.added) {
        byId.set(component.id, component);
        components.set(component.id, buildComponent(component));
      }
      for (const wire of links.added) {
        addTo(wiresFrom, wire.from.component, wire);
        wires.set(wire.id, buildWire(wire, byId));
      }
      // Components whose pins moved, and every chip — its pins are its
      // insides', which any edit inside it may renumber: their entries
      // again if their nets differ, and the wires they drive, whose nets
      // are theirs.
      const added = new Set<object>([...parts.added, ...links.added]);
      const recheck = new Set<string>();
      for (const id of changed) {
        const local = prefix === '' ? id : id.startsWith(prefix) ? id.slice(prefix.length) : null;
        if (local !== null && byId.has(local)) recheck.add(local);
      }
      for (const component of circuit.components) if (component.kind === 'chip') recheck.add(component.id);
      for (const id of recheck) {
        const component = byId.get(id)!;
        if (!added.has(component)) {
          const old = components.get(id);
          if (old === undefined || !sameNets(old.nets, shapes.pins(component), id, netOf)) components.set(id, buildComponent(component));
        }
        for (const wire of wiresFrom.get(id) ?? []) {
          if (added.has(wire)) continue;
          const old = wires.get(wire.id);
          const next = buildWire(wire, byId);
          if (old === undefined || old.net !== next.net || old.width !== next.width || old.bits.some((net, i) => net !== next.bits[i])) wires.set(wire.id, next);
        }
      }
      this.geometryCache = { ...cache, netlist, circuit, components: components.publish(), wires: wires.publish() };
    }
    const published = this.geometryCache!;
    return { components: published.components, wires: published.wires, level: this.path.join('/'), opened: this.opened };
  }

  private signalsNow(): Signals {
    const simulator = this.simulator;
    if (simulator === null) {
      return { cycle: 0, chunks: {} };
    }
    // Looking back, the cycle shown's values; otherwise now's.
    const values = this.past?.values ?? simulator.value;
    const chunks: Record<string, string> = {};
    for (const chunk of this.chunksToPublish()) {
      chunks[chunk] = packChunk(values, chunk);
    }
    return { cycle: this.past?.cycle ?? simulator.cycles, chunks };
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
      const net = netlist.netOfPin(prefix + component, pin);
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
      const shapes = shapeCache(chips);
      for (const component of circuit.components) {
        if (intersects(boxOf(shapes.shape(component), component.x, component.y, component.rotation), viewport)) {
          const spec = shapes.pins(component);
          for (const pin of [...spec.inputs, ...spec.outputs]) {
            for (const bit of bitPins(pin, widthOf(spec, pin))) add(component.id, bit);
          }
        }
      }
      for (const wire of circuit.wires) {
        const from = byId.get(wire.from.component);
        const to = byId.get(wire.to.component);
        if (from === undefined || to === undefined) {
          continue;
        }
        // Not routed: a route keeps within its ends' box, a unit and a
        // half either side and three and a half below (see `route`), so
        // that box is enough to say whether it can meet the viewport, and
        // ten thousand wires cost ten thousand box tests.
        const a = pinAt(shapes.shape(from), from.x, from.y, wire.from.pin, from.rotation);
        const b = pinAt(shapes.shape(to), to.x, to.y, wire.to.pin, to.rotation);
        let reach = { left: Math.min(a.x, b.x) - 1.5, top: Math.min(a.y, b.y), right: Math.max(a.x, b.x) + 1.5, bottom: Math.max(a.y, b.y) + 3.5 };
        // A bent wire goes where its corners are, which may be anywhere.
        if (wire.via !== undefined) {
          const corners = boundsOf(wire.via);
          reach = { left: Math.min(reach.left, corners.left), top: Math.min(reach.top, corners.top), right: Math.max(reach.right, corners.right), bottom: Math.max(reach.bottom, corners.bottom) };
        }
        if (intersects(reach, viewport)) {
          for (const bit of bitPins(wire.from.pin, widthOf(shapes.pins(from), wire.from.pin))) add(wire.from.component, bit);
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
      ringing: this.ringing,
      history: this.history === null ? null : { first: this.history.first, last: this.history.last },
      past: this.past?.cycle ?? null
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

/**
 * Shapes and pins for one pass over a level. A chip's are worked out from
 * its definition — its switches and LEDs, sorted — which is worth doing
 * once a definition rather than once an instance; every other kind's are
 * a table lookup and are not cached.
 */
/** What a chip definition's pins are for, by pin: the notes its switches and LEDs carry. */
function pinNotes(definition: Circuit): Record<string, string> {
  const notes: Record<string, string> = {};
  const face = chipInterface(definition);
  for (const pin of [...face.inputs, ...face.outputs]) if (pin.note !== null) notes[pin.name] = pin.note;
  return notes;
}

function shapeCache(chips: Circuit['chips']) {
  const chipShapes = new Map<string, ReturnType<typeof shapeOf>>();
  const chipPins = new Map<string, ReturnType<typeof pinsOf>>();
  return {
    shape(component: Component) {
      if (component.kind !== 'chip') return shapeOf(component, chips);
      const name = component.chip ?? '';
      let shape = chipShapes.get(name);
      if (shape === undefined) chipShapes.set(name, (shape = shapeOf(component, chips)));
      return shape;
    },
    pins(component: Component) {
      if (component.kind !== 'chip') return pinsOf(component, chips);
      const name = component.chip ?? '';
      let pins = chipPins.get(name);
      if (pins === undefined) chipPins.set(name, (pins = pinsOf(component, chips)));
      return pins;
    }
  };
}

/** Whether a component's recorded nets are still the nets its pins are on. */
function sameNets(
  nets: Readonly<Record<string, number>>,
  spec: PinSpec,
  id: string,
  netOf: (component: string, pin: string) => number
): boolean {
  for (const pin of spec.inputs.length === 0 ? spec.outputs : spec.outputs.length === 0 ? spec.inputs : [...spec.inputs, ...spec.outputs]) {
    const width = widthOf(spec, pin);
    if (width === 1) {
      if (nets[pin] !== netOf(id, pin)) return false;
    } else {
      for (let i = 0; i < width; i++) if (nets[`${pin}[${i}]`] !== netOf(id, `${pin}[${i}]`)) return false;
    }
  }
  return true;
}

type Wire = Circuit['wires'][number];

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (set === undefined) map.set(key, (set = new Set()));
  set.add(value);
}

/**
 * What an edit did to a list of document objects, by identity: the
 * objects gone and the objects new. The lists an edit makes — one
 * filtered, one appended to, one mapped with an object replaced — share
 * a prefix and a suffix with the list before, trimmed first, so the
 * sets are built over only what differs.
 */
function changesBetween<T>(before: readonly T[], after: readonly T[]): { removed: T[]; added: T[] } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const gone = before.slice(start, endBefore);
  const come = after.slice(start, endAfter);
  if (gone.length === 0 || come.length === 0) return { removed: gone, added: come };
  const was = new Set(gone);
  const is = new Set(come);
  return { removed: gone.filter(x => !is.has(x)), added: come.filter(x => !was.has(x)) };
}

/**
 * Geometry's buckets, written copy-on-write: a bucket is copied the
 * first time an entry in it changes, and `publish` gives the buckets
 * with the untouched ones shared — the same objects as before, which the
 * differ passes over by identity.
 */
class Buckets<T> {
  private readonly base: GeometryBuckets<T>;
  private readonly copies = new Map<string, Record<string, T>>();

  constructor(base: GeometryBuckets<T> = {}) {
    this.base = base;
  }

  get(id: string): T | undefined {
    const bucket = bucketOf(id);
    return (this.copies.get(bucket) ?? this.base[bucket])?.[id];
  }

  set(id: string, value: T): void {
    this.own(bucketOf(id))[id] = value;
  }

  delete(id: string): void {
    const bucket = bucketOf(id);
    if ((this.copies.get(bucket) ?? this.base[bucket])?.[id] !== undefined) delete this.own(bucket)[id];
  }

  publish(): GeometryBuckets<T> {
    if (this.copies.size === 0) return this.base;
    return { ...this.base, ...Object.fromEntries(this.copies) };
  }

  private own(bucket: string): Record<string, T> {
    let copy = this.copies.get(bucket);
    if (copy === undefined) this.copies.set(bucket, (copy = { ...this.base[bucket] }));
    return copy;
  }
}

/** Words a ROM's program takes: up to its last word that isn't 0. */
function sizeOf(words: readonly number[]): number {
  let end = words.length;
  while (end > 0 && words[end - 1] === 0) end--;
  return end;
}

/** Whether a program assembles to exactly these words, give or take the 0s after them. */
function assemblesTo(source: string, words: readonly number[]): boolean {
  try {
    const { rom } = assemble(source);
    return rom.every((w, i) => w === (words[i] ?? 0));
  } catch (error) {
    if (error instanceof AssemblyError) return false;
    throw error;
  }
}

/** The line each ROM address came from, 1-based, 0 for none; empty for a program that doesn't assemble. */
function linesOf(source: string): number[] {
  try {
    const { lineOf } = assemble(source);
    return Array.from({ length: 256 }, (_, address) => lineOf.get(address) ?? 0);
  } catch (error) {
    if (error instanceof AssemblyError) return [];
    throw error;
  }
}
