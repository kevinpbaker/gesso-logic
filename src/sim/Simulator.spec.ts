import { describe, expect, it } from 'vitest';

import { CircuitBuilder } from './CircuitBuilder';
import { compile } from './Netlist';
import { dFlipFlop, dLatch } from './Parts';
import { GATE_KINDS } from './Primitives';
import { Simulator } from './Simulator';

describe('the kernel', () => {
  it('delays every gate by one tick', () => {
    // Three inverters in a row: the output follows the input on the
    // third tick, not before.
    const b = new CircuitBuilder();
    b.output('out', b.not(b.not(b.not(b.input('in'), 'n1'), 'n2'), 'n3'));
    const sim = new Simulator(compile(b.build()));
    expect(sim.read('n3')).toBe(1);

    sim.set('in', 1);

    const seen: number[] = [];
    for (let t = 0; t < 4; t++) {
      sim.tick();
      seen.push(sim.read('n3'));
    }
    expect(seen).toEqual([1, 1, 0, 0]);
  });

  it('evaluates every gate kind by its truth table', () => {
    const expected: Record<string, number[]> = {
      not: [1, 1, 0, 0],
      and: [0, 0, 0, 1],
      or: [0, 1, 1, 1],
      nand: [1, 1, 1, 0],
      nor: [1, 0, 0, 0],
      xor: [0, 1, 1, 0],
      xnor: [1, 0, 0, 1]
    };
    for (const kind of GATE_KINDS) {
      const b = new CircuitBuilder();
      const gate = b.gate(kind, 'g');
      b.connect(b.input('x'), gate.a);
      if (kind !== 'not') {
        b.connect(b.input('y'), gate.b);
      }
      const sim = new Simulator(compile(b.build()));
      const rows: number[] = [];
      for (const [x, y] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1]
      ] as const) {
        sim.set('x', x);
        if (kind !== 'not') {
          sim.set('y', y);
        }
        sim.settle();
        rows.push(sim.read('g'));
      }
      expect(rows, kind).toEqual(expected[kind]);
    }
  });

  it('evaluates only the gates a change reaches', () => {
    // Two independent chains of ten inverters. Changing one input must
    // not evaluate a single gate of the other chain.
    const b = new CircuitBuilder();
    for (const chain of ['left', 'right']) {
      let at = b.input(chain);
      for (let n = 0; n < 10; n++) {
        at = b.not(at);
      }
    }
    const sim = new Simulator(compile(b.build()));
    const before = sim.evaluations;

    sim.set('left', 1);
    expect(sim.settle()).toEqual({ settled: true, ticks: 10 });

    expect(sim.evaluations - before).toBe(10);
  });

  it('is quiet after power-on when the circuit has a settled state', () => {
    const b = new CircuitBuilder();
    const latch = dLatch(b, b.input('d'), b.input('e'), 'latch');
    b.output('q', latch.q);
    const sim = new Simulator(compile(b.build()));

    expect(sim.pending).toBe(false);
    expect(sim.settle()).toEqual({ settled: true, ticks: 0 });
  });

  it('reads 0 on an input nothing drives', () => {
    const b = new CircuitBuilder();
    const gate = b.gate('nand', 'g');
    b.connect(b.input('x', 1), gate.a);
    const netlist = compile(b.build());
    const sim = new Simulator(netlist);

    expect(sim.read('g')).toBe(1);
    expect(netlist.floating.map(net => netlist.netNames[net])).toEqual(['g.b']);
  });
});

describe('oscillation', () => {
  it('reports a ring oscillator rather than hanging, naming every net in the ring', () => {
    const b = new CircuitBuilder();
    const r1 = b.gate('not', 'r1');
    const r2 = b.gate('not', 'r2');
    const r3 = b.gate('not', 'r3');
    b.connect(r1.out, r2.a);
    b.connect(r2.out, r3.a);
    b.connect(r3.out, r1.a);
    const sim = new Simulator(compile(b.build()));

    const result = sim.settle(1_000);

    expect(result.settled).toBe(false);
    expect(result.ticks).toBe(1_000);
    expect(result.settled === false && result.ringing.map(net => net.name)).toEqual(['r1.out', 'r2.out', 'r3.out']);
    // Asking again is just as bounded: the ring is still ringing.
    expect(sim.settle(100).settled).toBe(false);
  });

  it('lets an even loop settle: two inverters are a latch, not an oscillator', () => {
    const b = new CircuitBuilder();
    const i1 = b.gate('not', 'i1');
    const i2 = b.gate('not', 'i2');
    b.connect(i1.out, i2.a);
    b.connect(i2.out, i1.a);
    const sim = new Simulator(compile(b.build()));

    expect(sim.settle().settled).toBe(true);
    expect(sim.read('i1')).not.toBe(sim.read('i2'));
  });

  it('names the latch that rings when its data moves on the tick before its enable falls', () => {
    // Phase 0's first circuit, reduced: a gated D latch, open, whose D
    // rises one tick before its enable falls. S̄ and R̄ both go low for
    // a tick, Q and Q̅ both go high, and then they flip together forever.
    // The report has to point at the latch, not just say "oscillates".
    const b = new CircuitBuilder();
    const latch = dLatch(b, b.input('d', 0), b.input('enable', 1), 'ram7');
    b.output('q', latch.q);
    const sim = new Simulator(compile(b.build()));
    expect(sim.settle().settled).toBe(true);

    sim.set('d', 1);
    sim.tick();
    sim.set('enable', 0);
    const result = sim.settle(500);

    expect(result.settled).toBe(false);
    expect(result.settled === false && result.ringing.map(net => net.name)).toEqual(['ram7.q.out', 'ram7.qBar.out']);
  });

  it('holds when the same latch gets a tick of margin', () => {
    // The fix Phase 0 used: enable falls first, then D moves.
    const b = new CircuitBuilder();
    const latch = dLatch(b, b.input('d', 0), b.input('enable', 1), 'ram7');
    b.output('q', latch.q);
    const sim = new Simulator(compile(b.build()));
    sim.settle();

    sim.set('enable', 0);
    sim.tick();
    sim.set('d', 1);

    expect(sim.settle().settled).toBe(true);
    expect(sim.read('ram7.q')).toBe(0);
  });
});

describe('adopting an earlier simulator', () => {
  it('keeps what a counter holds across an edit that adds a gate', () => {
    const build = (extra: boolean) => {
      const b = new CircuitBuilder();
      let clock = b.clock();
      for (let bit = 0; bit < 3; bit++) {
        const loop = b.gate('not', `bit${bit}.loop`);
        const ff = dFlipFlop(b, loop.out, clock, `bit${bit}`);
        b.connect(ff.q, loop.a);
        clock = ff.qBar;
      }
      if (extra) {
        b.output('spare', b.and(b.input('x'), b.input('y'), 'spare'));
      }
      return compile(b.build());
    };
    const count = (sim: Simulator) => [0, 1, 2].reduce((n, bit) => n | (sim.read(`bit${bit}.slave.q`) << bit), 0);
    const before = new Simulator(build(false));
    for (let n = 0; n < 5; n++) {
      before.cycle();
    }
    const held = count(before);

    const after = new Simulator(build(true));
    after.adopt(before);

    expect(after.settle().settled).toBe(true);
    expect(count(after)).toBe(held);
    expect(after.cycles).toBe(5);
    after.cycle();
    expect(count(after)).toBe((held + 1) % 8);
  });

  it('keeps an input where a person left it', () => {
    const b = new CircuitBuilder();
    b.output('q', b.not(b.input('x'), 'n'));
    const netlist = compile(b.build());
    const before = new Simulator(netlist);
    before.set('x', 1);
    before.settle();

    const after = new Simulator(netlist);
    after.adopt(before);
    after.settle();

    expect(after.read('x')).toBe(1);
    expect(after.read('n')).toBe(0);
  });
});
