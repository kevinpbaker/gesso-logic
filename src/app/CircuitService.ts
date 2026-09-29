import { BehaviorSubject, type Observable } from 'rxjs';

import { CIRCUIT_VERSION, type Circuit, type PinRef } from '../sim/Circuit';
import { CircuitError, compile, type Netlist } from '../sim/Netlist';
import { isGate, PINS, type Kind } from '../sim/Primitives';
import { Simulator } from '../sim/Simulator';
import type { ClockRate, ComponentGeometry, DocumentSummary, Geometry, Signals, Status, WireGeometry } from './CircuitContract';
import { connect, freshId, move, place } from './DocumentEdits';
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

export class CircuitService {
  readonly document: Observable<DocumentSummary>;
  readonly geometry: Observable<Geometry>;
  readonly signals: Observable<Signals>;
  readonly status: Observable<Status>;

  private readonly documentSubject: BehaviorSubject<DocumentSummary>;
  private readonly geometrySubject: BehaviorSubject<Geometry>;
  private readonly signalsSubject: BehaviorSubject<Signals>;
  private readonly statusSubject: BehaviorSubject<Status>;

  private readonly schedule: Schedule;
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly publishIntervalMs: number;

  private circuit: Circuit = { version: CIRCUIT_VERSION, components: [], wires: [] };
  private revision = 0;
  private netlist: Netlist | null = null;
  private simulator: Simulator | null = null;
  private error: string | null = null;
  private viewport: Rect | null = null;
  private visibleChunks: number[] | null = null;

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
  }

  /** Replaces the document, as opening a file does. The simulator starts fresh. */
  load(circuit: Circuit): void {
    this.simulator = null;
    this.edit(circuit);
  }

  place(kind: Kind, x: number, y: number, id?: string): void {
    this.edit(place(this.circuit, id ?? freshId(this.circuit, kind), kind, x, y));
  }

  connect(from: PinRef, to: PinRef): void {
    this.edit(connect(this.circuit, freshId(this.circuit, 'w'), from, to));
  }

  move(id: string, x: number, y: number): void {
    this.edit(move(this.circuit, id, x, y));
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
  }

  pause(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.samples.length = 0;
    this.publish(true);
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
    this.restartPacing();
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
   * Takes a new document: compiles it and, when that works, moves the
   * running state onto the new netlist so the circuit keeps what it
   * remembered. A document that does not compile is kept — the person is
   * halfway through drawing it — and says why; nothing runs until it
   * compiles again.
   */
  private edit(next: Circuit): void {
    if (next === this.circuit && this.revision > 0) {
      return;
    }
    this.circuit = next;
    this.revision++;
    this.visibleChunks = null;
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
    this.publish(true);
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
      if (this.now() - started >= this.budgetMs) {
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
      components: this.circuit.components.length,
      gates: this.circuit.components.filter(c => isGate(c.kind)).length,
      wires: this.circuit.wires.length,
      nets: netlist?.netCount ?? 0,
      error: this.error
    };
  }

  private geometryNow(): Geometry {
    const netlist = this.netlist;
    const components: Record<string, ComponentGeometry> = {};
    for (const component of this.circuit.components) {
      const nets: Record<string, number> = {};
      if (netlist !== null) {
        const spec = PINS[component.kind];
        for (const pin of [...spec.inputs, ...spec.outputs]) {
          nets[pin] = netlist.pinNet.get(`${component.id}.${pin}`) ?? -1;
        }
      }
      components[component.id] = {
        kind: component.kind,
        x: component.x,
        y: component.y,
        label: component.label ?? null,
        nets
      };
    }
    const wires: Record<string, WireGeometry> = {};
    for (const wire of this.circuit.wires) {
      wires[wire.id] = {
        from: wire.from,
        to: wire.to,
        net: netlist?.pinNet.get(`${wire.from.component}.${wire.from.pin}`) ?? -1
      };
    }
    return { components, wires };
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
   * The chunks holding a net on a component in the viewport, or every
   * chunk before the render worker has said what it can see. A wire is
   * on the net of the pin it leaves, and that pin's component is where
   * it starts, so the components are enough.
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
    const viewport = this.viewport;
    if (viewport === null) {
      for (let chunk = 0; chunk * CHUNK < netlist.netCount; chunk++) {
        chunks.add(chunk);
      }
    } else {
      for (const component of this.circuit.components) {
        if (
          component.x < viewport.left ||
          component.x > viewport.right ||
          component.y < viewport.top ||
          component.y > viewport.bottom
        ) {
          continue;
        }
        const spec = PINS[component.kind];
        for (const pin of [...spec.inputs, ...spec.outputs]) {
          const net = netlist.pinNet.get(`${component.id}.${pin}`);
          if (net !== undefined) {
            chunks.add(Math.floor(net / CHUNK));
          }
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
