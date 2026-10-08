import { describe, expect, it } from 'vitest';

import { CircuitBuilder } from '../sim/CircuitBuilder';
import { dFlipFlop } from '../sim/Parts';
import type { AnalyserView, Signals, Status } from './CircuitContract';
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

describe('pins traced from the canvas', () => {
  /** A switch into an inverter chip into an LED: the inverter's gate is `n`, inside instance `c`. */
  function inverter() {
    const inside = new CircuitBuilder();
    inside.output('y', inside.not(inside.input('a'), 'n'));
    const b = new CircuitBuilder();
    const c = b.chip('inv', 'inverter');
    b.connect(b.input('x'), { component: c, pin: 'a' });
    b.output('led', { component: c, pin: 'y' });
    return { ...b.build(), chips: { inverter: inside.build() } };
  }

  it('traces a pin at any depth, live, once, through a change of level, until it is taken away', () => {
    const service = new Harness().service;
    let view!: AnalyserView;
    service.analyserView.subscribe(v => (view = v));
    service.load(inverter());
    service.setAnalyserView(null, 4, 100);
    service.openChip('inv');
    service.watch([{ component: 'n', pin: 'out' }]);
    const traced = view.traces.find(t => t.watched)!;
    expect(traced).toMatchObject({ name: 'n.out', title: 'inv › n.out', width: 1 });

    // The inverter's output: the opposite of the switch, a cycle a column.
    service.setInput('x', 0);
    service.step();
    service.setInput('x', 1);
    service.step();
    expect(view.data[traced.id]!.slice(-2)).toBe('10');

    // Again, or the LED inside on the same net: still one trace.
    service.watch([{ component: 'n', pin: 'out' }, { component: 'y', pin: 'in' }]);
    expect(view.traces.filter(t => t.watched)).toHaveLength(1);

    // Back at the top, it is traced still; taken away, it is gone.
    service.closeChip(0);
    service.step();
    expect(view.traces.map(t => t.id)).toContain(traced.id);
    service.unwatch(traced.id);
    expect(view.traces.some(t => t.watched)).toBe(false);
  });

  it('says where each trace is, and goes to a level in one step', () => {
    const service = new Harness().service;
    let view!: AnalyserView;
    let path: readonly string[] = [];
    let opened = 0;
    service.analyserView.subscribe(v => (view = v));
    service.document.subscribe(d => ((path = d.path.map(l => l.id)), (opened = d.opened)));
    service.load(inverter());
    service.setAnalyserView(null, 4, 100);
    service.openChip('inv');
    service.watch([{ component: 'n', pin: 'out' }]);
    service.closeChip(0);
    expect(view.traces.map(t => [t.name, t.path, t.pin])).toEqual([
      ['led', [], { component: 'led', pin: 'in' }],
      ['n.out', ['inv'], { component: 'n', pin: 'out' }]
    ]);

    const before = opened;
    service.openPath(['inv']);
    expect(path).toEqual(['inv']);
    expect(opened).toBe(before + 1);
    // Already there: nothing happens. A path that stops leading goes as far as it does.
    service.openPath(['inv']);
    expect(opened).toBe(before + 1);
    service.openPath(['nothing', 'inv']);
    expect(path).toEqual([]);
  });

  it('renames a chip’s pin from inside it, and what is traced on the pin follows', () => {
    const service = new Harness().service;
    let view!: AnalyserView;
    service.analyserView.subscribe(v => (view = v));
    service.load(inverter());
    service.setAnalyserView(null, 4, 100);
    service.watch([{ component: 'inv', pin: 'y' }]);
    service.openChip('inv');
    service.setLabel('y', 'out');
    service.closeChip(0);
    expect(service['circuit'].wires.map(w => w.from.pin)).toContain('out');
    expect(view.traces.filter(t => t.watched).map(t => t.name)).toEqual(['inv.out']);
  });

  it('saves what is traced with the file, as a change to save, and traces it again on opening', () => {
    const service = new Harness().service;
    let view!: AnalyserView;
    let dirty = false;
    let text = '';
    service.analyserView.subscribe(v => (view = v));
    service.document.subscribe(d => (dirty = d.dirty));
    service.saving.subscribe(s => (text = s.text));
    service.load(inverter());
    service.setAnalyserView(null, 4, 100);
    expect(dirty).toBe(false);
    service.openChip('inv');
    service.watch([{ component: 'n', pin: 'out' }]);
    expect(dirty).toBe(true);
    service.requestSave(false);
    expect(text).toContain('"traces"');

    service.load(inverter());
    expect(view.traces.some(t => t.watched)).toBe(false);
    service.open(text, 'inverter.gessologic.json', null);
    expect(view.traces.filter(t => t.watched).map(t => t.title)).toEqual(['inv › n.out']);
    expect(dirty).toBe(false);
  });

  it('forgets what was traced when another document is opened', () => {
    const service = new Harness().service;
    let view!: AnalyserView;
    service.analyserView.subscribe(v => (view = v));
    service.load(inverter());
    service.setAnalyserView(null, 4, 100);
    service.watch([{ component: 'x', pin: 'out' }]);
    expect(view.traces.filter(t => t.watched).map(t => t.name)).toEqual(['x.out']);
    service.load(inverter());
    expect(view.traces.some(t => t.watched)).toBe(false);
  });
});

describe('looking back', () => {
  function counting() {
    const h = new Harness();
    h.service.load(counter());
    const count = () => {
      const signals = h.signals[h.signals.length - 1]!;
      const geometry = h.service['geometryNow']();
      return [0, 1, 2].reduce((sum, bit) => {
        const net = entryOf(geometry.components, `bit${bit}.slave.q`)!.nets.out!;
        return sum | (signalOf(signals.chunks, net) << bit);
      }, 0);
    };
    // Each step a cycle: what the counter held after each, and when.
    const held = new Map<number, number>();
    for (let n = 0; n < 40; n++) {
      h.service.step();
      held.set(h.status.cycles, count());
    }
    return { h, count, held };
  }

  it('shows any cycle history holds as it was, and comes back to now on a step', () => {
    const { h, count, held } = counting();
    const now = h.status.cycles;
    expect(h.status.history).toEqual({ first: 1, last: now });
    for (const cycle of [now - 1, 5, 23, 24, 6]) {
      h.service.showCycle(cycle);
      expect(h.status.past).toBe(cycle);
      expect(h.signals.at(-1)!.cycle).toBe(cycle);
      expect(count()).toBe(held.get(cycle));
    }
    h.service.step();
    expect(h.status.past).toBeNull();
    expect(h.signals.at(-1)!.cycle).toBe(now + 1);
  });

  it('resumes from a cycle shown: it is now, and what came after is gone and comes again', () => {
    const { h, count, held } = counting();
    let view!: AnalyserView;
    h.service.analyserView.subscribe(v => (view = v));
    h.service.setAnalyserView(null, 64, 100);
    const first = view.first;
    h.service.showCycle(10);
    h.service.resumeFromHere();
    expect(h.status).toMatchObject({ cycles: 10, past: null, history: { first: 1, last: 10 } });
    expect(count()).toBe(held.get(10));
    expect([view.first, view.last]).toEqual([first, 10]);
    // Nothing given differently, so the same future comes again.
    h.service.step();
    expect(count()).toBe(held.get(11));
    expect([view.first, view.last]).toEqual([first, 11]);
    expect(h.status.history?.last).toBe(11);
  });

  it('shows nothing it does not hold, nothing while running, and nothing once history is off', () => {
    const { h } = counting();
    h.service.showCycle(1_000);
    expect(h.status.past).toBeNull();
    h.service.run();
    h.service.showCycle(3);
    expect(h.status.past).toBeNull();
    h.service.pause();
    h.service.setKeepHistory(false);
    expect(h.status.history).toBeNull();
    h.service.showCycle(3);
    expect(h.status.past).toBeNull();
  });

  it('forgets history when an edit makes another simulator, and keeps it through a move', () => {
    const { h } = counting();
    h.service.moveBy(['bit0.loop'], 1, 0);
    expect(h.status.history?.first).toBe(1);
    h.service.place('and', 40, 40, 'unrelated');
    h.service.showCycle(3);
    expect(h.status.past).toBeNull();
    expect(h.status.history?.first).toBe(-1);
  });
});
