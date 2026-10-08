import { describe, expect, it } from 'vitest';

import { CircuitBuilder } from '../sim/CircuitBuilder';
import { dFlipFlop } from '../sim/Parts';
import type { Signals, Status } from './CircuitContract';
import { CircuitService, type Schedule } from './CircuitService';
import { signalOf } from './SignalPacking';
import { entryOf } from './CircuitContract';
import { libraryPart } from './LibraryParts';

/**
 * The service on its own, with time in the spec's hands.
 *
 * A slice is queued on a schedule the spec runs by hand, and measured
 * against a clock the spec moves, so how many cycles a slice runs and
 * when a publish happens are exact, not a race with the machine.
 */
class Harness {
  time = 0;
  /** How far the clock moves each time it is read, so `max` slices end. */
  readStep = 0;
  private readonly queue: (() => void)[] = [];
  readonly signals: Signals[] = [];
  readonly statuses: Status[] = [];
  readonly service: CircuitService;

  constructor(options: { budgetMs?: number; publishIntervalMs?: number } = {}) {
    const schedule: Schedule = run => this.queue.push(run);
    this.service = new CircuitService({
      schedule,
      now: () => (this.time += this.readStep),
      budgetMs: options.budgetMs ?? 8,
      publishIntervalMs: options.publishIntervalMs ?? 16
    });
    this.service.signals.subscribe(s => this.signals.push(s));
    this.service.status.subscribe(s => this.statuses.push(s));
  }

  get status(): Status {
    return this.statuses[this.statuses.length - 1]!;
  }

  /** Runs one queued slice, `gapMs` after the last. Returns whether there was one. */
  slice(gapMs = 16): boolean {
    this.time += gapMs;
    const next = this.queue.shift();
    next?.();
    return next !== undefined;
  }
}

/** A 3-bit ripple counter on a clock, its bits readable as `bitN.slave.q`. */
function counter() {
  const b = new CircuitBuilder();
  let clock = b.clock();
  for (let bit = 0; bit < 3; bit++) {
    const loop = b.gate('not', `bit${bit}.loop`);
    const ff = dFlipFlop(b, loop.out, clock, `bit${bit}`);
    b.connect(ff.q, loop.a);
    b.output(`q${bit}`, ff.q);
    clock = ff.qBar;
  }
  return b.build();
}

describe('CircuitService', () => {
  it('runs the cycles a set clock rate has due, and no more', () => {
    const h = new Harness();
    h.service.load(counter());
    h.service.setClockHz(100);

    h.service.run();
    for (let n = 0; n < 62; n++) {
      h.slice(16);
    }

    // Status while running is at most one publish interval old; the
    // rate it reports is over the last second.
    expect(h.status.running).toBe(true);
    expect(h.status.achievedHz).toBeGreaterThanOrEqual(98);
    expect(h.status.achievedHz).toBeLessThanOrEqual(101);
    // 62 slices 16 ms apart is 992 ms after the run started: 99 cycles
    // due at 100 Hz. A pause publishes at once, so it reads exactly.
    h.service.pause();
    expect(h.status.cycles).toBe(99);
  });

  it('bounds a slice at max by its budget, and handles a command between slices', () => {
    const h = new Harness({ budgetMs: 8 });
    h.readStep = 0.5;
    h.service.load(counter());

    h.service.run();
    h.slice();
    const afterOne = h.status.cycles;

    // The clock moves half a millisecond a read and each cycle reads it
    // once; the slice reads it once more to start and once to sample.
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThanOrEqual(16);

    // A command between two slices is handled at once, not after a run.
    h.service.place('input', 40, 0, 'late');
    expect(h.service['circuit'].components.some(c => c.id === 'late')).toBe(true);
    h.slice();
    expect(h.status.cycles).toBeGreaterThan(afterOne);
  });

  it('publishes signals at most once per interval while running, and at once for a command', () => {
    const h = new Harness({ publishIntervalMs: 16 });
    h.readStep = 0.01;
    h.service.load(counter());
    h.service.setClockHz('max');
    h.service.run();
    const before = h.signals.length;
    const times: number[] = [];
    const watching = h.service.signals.subscribe(() => times.push(h.time));
    times.length = 0;

    // Slices four milliseconds apart, each spending its 8 ms budget:
    // twelve milliseconds a slice on this clock. A publish can only
    // happen at the end of a slice, so the gaps between publishes are
    // at least the interval and less than an interval plus a slice.
    for (let n = 0; n < 40; n++) {
      h.slice(4);
    }
    watching.unsubscribe();
    const gaps = times.slice(1).map((at, i) => at - times[i]!);
    expect(gaps.length).toBeGreaterThan(10);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(16);
    expect(Math.max(...gaps)).toBeLessThan(16 + 12 + 1);
    const running = h.signals.length - before;
    // Far fewer publishes than slices, which is the point.
    expect(running).toBeLessThan(40);

    // A command publishes on the spot, interval or not.
    h.service.pause();
    expect(h.signals.length).toBe(before + running + 1);
    expect(h.status.running).toBe(false);
  });

  it('keeps what the counter holds when the document is edited while it runs', () => {
    const h = new Harness();
    h.service.load(counter());
    h.service.setClockHz(100);
    h.service.run();
    for (let n = 0; n < 20; n++) {
      h.slice(16);
    }
    const count = () => {
      const signals = h.signals[h.signals.length - 1]!;
      const geometry = h.service['geometryNow']();
      return [0, 1, 2].reduce((sum, bit) => {
        const net = entryOf(geometry.components, `bit${bit}.slave.q`)!.nets.out!;
        return sum | (signalOf(signals.chunks, net) << bit);
      }, 0);
    };
    h.service.pause();
    const held = count();
    const cycles = h.status.cycles;

    h.service.place('and', 40, 40, 'unrelated');

    expect(count()).toBe(held);
    expect(h.status.cycles).toBe(cycles);
    h.service.step();
    expect(count()).toBe((held + 1) % 8);
  });

  it('pauses a run that oscillates, and names the ringing nets', () => {
    const b = new CircuitBuilder();
    const g = b.gate('nand', 'ring');
    b.connect(b.clock(), g.a);
    b.connect(g.out, g.b);
    const h = new Harness();
    h.service.load(b.build());

    h.service.run();
    h.slice();

    expect(h.status.running).toBe(false);
    expect(h.status.ringing).toEqual(['ring.out']);
  });

  it('publishes only the chunks of nets in the viewport once it has one', () => {
    // 600 switches in a row, 10 units apart: 600 nets, three chunks.
    const b = new CircuitBuilder();
    for (let n = 0; n < 600; n++) {
      b.input(`s${n}`);
    }
    const circuit = b.build();
    const spread = { ...circuit, components: circuit.components.map((c, n) => ({ ...c, x: n * 10, y: 0 })) };
    const h = new Harness();
    h.service.load(spread);

    expect(Object.keys(h.signals[h.signals.length - 1]!.chunks)).toEqual(['0', '1', '2']);

    // Switches 300 to 309 are nets 300 to 309, in chunk 1. The band
    // widens the view by a quarter a side, which stays inside it.
    h.service.setViewport(3000, -10, 3090, 10);

    expect(Object.keys(h.signals[h.signals.length - 1]!.chunks)).toEqual(['1']);
  });

  it('counts an edit that changes nothing as no edit', () => {
    const h = new Harness();
    h.service.place('input', 0, 0, 'x');
    let revision = 0;
    h.service.document.subscribe(d => (revision = d.revision));

    h.service.move('x', 0, 0);
    h.service.place('input', 4, 4, 'x');

    expect(revision).toBe(1);
    h.service.move('x', 4, 0);
    expect(revision).toBe(2);
  });
});

describe('CircuitService history', () => {
  const pin = (component: string, name: string) => ({ component, pin: name });

  it('undoes to empty and redoes back, edit by edit', () => {
    const h = new Harness();
    const service = h.service;
    service.place('input', 0, 0, 'a');
    service.place('not', 4, 0, 'n');
    service.connect(pin('a', 'out'), pin('n', 'a'), 'w1');
    const count = () => service['circuit'].components.length + service['circuit'].wires.length;
    expect(count()).toBe(3);

    service.undo();
    service.undo();
    service.undo();
    expect(count()).toBe(0);
    service.undo();
    expect(count()).toBe(0);

    service.redo();
    service.redo();
    service.redo();
    expect(count()).toBe(3);
    expect(service['circuit'].wires[0]!.id).toBe('w1');
  });

  it('folds a drag into one undo step by its gesture', () => {
    const h = new Harness();
    const service = h.service;
    service.place('and', 0, 0, 'g');
    for (let i = 0; i < 20; i++) {
      service.moveBy(['g'], 1, 0, 'drag-1');
    }
    expect(service['circuit'].components[0]).toMatchObject({ x: 20 });

    service.undo();
    expect(service['circuit'].components[0]).toMatchObject({ x: 0 });
    // A second drag is its own step.
    service.redo();
    service.moveBy(['g'], 0, 5, 'drag-2');
    service.undo();
    expect(service['circuit'].components[0]).toMatchObject({ x: 20, y: 0 });
  });

  it('records nothing for an edit that changes nothing, and a new edit clears redo', () => {
    const h = new Harness();
    const service = h.service;
    let summary = { canUndo: false, canRedo: false };
    service.document.subscribe(d => (summary = d));
    service.place('and', 0, 0, 'g');
    service.place('and', 4, 4, 'g');
    service.moveBy(['g'], 0, 0);
    service.undo();
    expect(summary).toMatchObject({ canUndo: false, canRedo: true });

    service.place('or', 0, 0, 'o');
    expect(summary).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('keeps the running simulator through a move, and recompiles for a change of wiring', () => {
    const h = new Harness();
    const service = h.service;
    service.load(counter());
    service.step();
    service.step();
    const simulator = service['simulator'];

    service.moveBy(['bit0.loop'], 3, 3);
    service.rotate(['bit1.loop']);
    expect(service['simulator']).toBe(simulator);

    service.remove(['q2']);
    expect(service['simulator']).not.toBe(simulator);
    expect(h.status.cycles).toBe(2);
  });
});

describe('loadProgram', () => {
  it('opens the computer running the program, and says so', () => {
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: import('./CircuitContract').DocumentSummary;
    service.document.subscribe(d => (summary = d));
    service.loadProgram('tiny.asm', 'LDA #1\nHLT\n');
    expect(summary.gates).toBeGreaterThan(1000);
    expect(summary.message).toBe('Loaded the computer, running tiny.asm');
    expect(summary.dirty).toBe(false);
  });

  it('keeps the document and says why when the program does not assemble', () => {
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: import('./CircuitContract').DocumentSummary;
    service.document.subscribe(d => (summary = d));
    service.loadScene('counter');
    const gates = summary.gates;
    service.loadProgram('broken.asm', 'NOPE 1\n');
    expect(summary.gates).toBe(gates);
    expect(summary.message).toMatch(/^Couldn't assemble broken\.asm/);
  });
});

describe('pin notes', () => {
  it('publishes what each chip’s pins are for, and a switch’s or LED’s own note, which an edit can change', () => {
    const h = new Harness();
    const service = h.service;
    const b = new CircuitBuilder();
    b.chip('ff', 'D flip-flop');
    b.input('d');
    service.load({ ...b.build(), chips: libraryPart('D flip-flop') });
    let notes: Readonly<Record<string, string>> = {};
    service.document.subscribe(d => (notes = d.chips.find(c => c.name === 'D flip-flop')?.notes ?? {}));
    expect(notes).toMatchObject({ clk: 'Clock: q takes d as this goes from 0 to 1', qn: 'The opposite of q' });

    let note: string | null = 'unset';
    service.geometry.subscribe(g => (note = entryOf(g.components, 'd')?.note ?? null));
    expect(note).toBeNull();
    service.setNote('d', '  The bit to keep  ');
    expect(note).toBe('The bit to keep');
    service.setNote('d', '');
    expect(note).toBeNull();
  });
});
