import { describe, expect, it } from 'vitest';

import { CircuitBuilder } from './CircuitBuilder';
import { compile } from './Netlist';
import { dFlipFlop, fullAdder, srLatch } from './Parts';
import { Simulator } from './Simulator';

/**
 * Phase 1's exit: circuits built from gates, clocked, with every output
 * asserted on every tick.
 *
 * "Tick" means two things here, and each spec says which. For the SR
 * latch it is the unit-delay tick, and the spec asserts the waveform —
 * which output moves on which tick after an input does. For the
 * clocked circuits it is the clock tick, and every output is asserted
 * after every one.
 */

function waveform(sim: Simulator, pins: readonly string[], ticks: number): string[] {
  const rows: string[] = [];
  for (let t = 0; t <= ticks; t++) {
    rows.push(pins.map(pin => sim.read(pin)).join(''));
    if (t < ticks) {
      sim.tick();
    }
  }
  return rows;
}

describe('an SR latch from two NANDs', () => {
  function build() {
    const b = new CircuitBuilder();
    const latch = srLatch(b, b.input('sBar', 1), b.input('rBar', 1), 'sr');
    b.output('q', latch.q);
    b.output('qBar', latch.qBar);
    const sim = new Simulator(compile(b.build()));
    // Power-on puts it in a state; reset it to a known one.
    sim.set('rBar', 0);
    expect(sim.settle().settled).toBe(true);
    sim.set('rBar', 1);
    expect(sim.settle().settled).toBe(true);
    return sim;
  }

  it('sets: Q rises on the first tick, Q̅ falls on the second, and then it is quiet', () => {
    const sim = build();
    expect([sim.read('sr.q'), sim.read('sr.qBar')]).toEqual([0, 1]);

    sim.set('sBar', 0);

    // Each row is Q Q̅ at the start of a tick.
    expect(waveform(sim, ['sr.q', 'sr.qBar'], 3)).toEqual(['01', '11', '10', '10']);
    expect(sim.pending).toBe(false);
  });

  it('holds what it was set to when S̄ is released', () => {
    const sim = build();
    sim.set('sBar', 0);
    sim.settle();

    sim.set('sBar', 1);

    // S̄ rising wakes Q's NAND, which already reads Q̅ low: nothing moves.
    expect(waveform(sim, ['sr.q', 'sr.qBar'], 2)).toEqual(['10', '10', '10']);
    expect(sim.pending).toBe(false);
  });

  it('resets: Q̅ rises on the first tick, Q falls on the second', () => {
    const sim = build();
    sim.set('sBar', 0);
    sim.settle();
    sim.set('sBar', 1);
    sim.settle();

    sim.set('rBar', 0);

    expect(waveform(sim, ['sr.q', 'sr.qBar'], 3)).toEqual(['10', '11', '01', '01']);
  });

  it('drives both outputs high in the forbidden state, and settles when it is left', () => {
    const sim = build();
    sim.set('sBar', 0);
    sim.set('rBar', 0);
    expect(sim.settle().settled).toBe(true);
    expect([sim.read('sr.q'), sim.read('sr.qBar')]).toEqual([1, 1]);

    // Releasing one at a time is well defined; releasing both on the
    // same tick is the race hardware has too, and is covered by the
    // oscillation specs rather than here.
    sim.set('rBar', 1);
    expect(sim.settle().settled).toBe(true);
    expect([sim.read('sr.q'), sim.read('sr.qBar')]).toEqual([1, 0]);
  });
});

describe('a positive-edge D flip-flop', () => {
  function build() {
    const b = new CircuitBuilder();
    const ff = dFlipFlop(b, b.input('d'), b.clock(), 'ff');
    b.output('q', ff.q);
    b.output('qBar', ff.qBar);
    const sim = new Simulator(compile(b.build()));
    return sim;
  }

  it('takes D on the rising edge and only then, on every clock tick', () => {
    const sim = build();
    // A known start: clock a 0 in.
    sim.set('d', 0);
    expect(sim.cycle().settled).toBe(true);

    // D per cycle, set while the clock is low. After each full cycle Q
    // holds what D was at that cycle's rising edge.
    const inputs = [1, 1, 0, 1, 0, 0, 1, 0] as const;
    let previous: 0 | 1 = 0;
    for (const [n, d] of inputs.entries()) {
      sim.set('d', d);
      expect(sim.settle().settled).toBe(true);
      // Not before the edge: D moved while the clock was low, and Q
      // still shows the value clocked in on the cycle before.
      expect(sim.read('ff.slave.q'), `Q before rising edge ${n}`).toBe(previous);

      sim.setClock(1);
      expect(sim.settle().settled).toBe(true);
      expect(sim.read('ff.slave.q'), `Q after rising edge ${n}`).toBe(d);
      expect(sim.read('ff.slave.qBar'), `Q̅ after rising edge ${n}`).toBe(1 - d);

      sim.setClock(0);
      expect(sim.settle().settled).toBe(true);
      expect(sim.read('ff.slave.q'), `Q after falling edge ${n}`).toBe(d);
      expect(sim.read('ff.slave.qBar'), `Q̅ after falling edge ${n}`).toBe(1 - d);
      previous = d;
    }
  });

  it('ignores D changing while the clock is high', () => {
    const sim = build();
    sim.set('d', 1);
    sim.cycle();
    sim.setClock(1);
    sim.settle();
    expect(sim.read('ff.slave.q')).toBe(1);

    sim.set('d', 0);
    expect(sim.settle().settled).toBe(true);

    expect(sim.read('ff.slave.q')).toBe(1);
    sim.setClock(0);
    sim.settle();
    expect(sim.read('ff.slave.q')).toBe(1);
  });
});

describe('a full adder', () => {
  it('adds every combination of its three inputs, settling within three ticks', () => {
    const b = new CircuitBuilder();
    const adder = fullAdder(b, b.input('x'), b.input('y'), b.input('carryIn'), 'fa');
    b.output('sum', adder.sum);
    b.output('carry', adder.carry);
    const sim = new Simulator(compile(b.build()));

    for (let n = 0; n < 8; n++) {
      const [x, y, c] = [n & 1, (n >> 1) & 1, (n >> 2) & 1] as (0 | 1)[];
      sim.set('x', x);
      sim.set('y', y);
      sim.set('carryIn', c);
      const settled = sim.settle();

      expect(settled.settled).toBe(true);
      // The longest path is XOR → AND → OR: three gates, three ticks.
      expect(settled.ticks).toBeLessThanOrEqual(3);
      expect(sim.read('fa.sum'), `sum of ${x}+${y}+${c}`).toBe((x + y + c) & 1);
      expect(sim.read('fa.carry'), `carry of ${x}+${y}+${c}`).toBe((x + y + c) >> 1);
    }
  });
});

describe('a 4-bit ripple counter', () => {
  it('counts on every rising edge, with every bit asserted on every clock tick', () => {
    // Four flip-flops, each toggling (D = Q̅), each clocked by the Q̅ of
    // the one before: a stage's Q̅ rises exactly when its Q falls, which
    // is when the next bit up should flip.
    const b = new CircuitBuilder();
    let clock = b.clock();
    for (let bit = 0; bit < 4; bit++) {
      const qBar = b.gate('not', `bit${bit}.loop`);
      const ff = dFlipFlop(b, qBar.out, clock, `bit${bit}`);
      b.connect(ff.q, qBar.a);
      b.output(`q${bit}`, ff.q);
      clock = ff.qBar;
    }
    const sim = new Simulator(compile(b.build()));
    const count = () => [0, 1, 2, 3].reduce((sum, bit) => sum | (sim.read(`bit${bit}.slave.q`) << bit), 0);
    const start = count();

    for (let tick = 1; tick <= 40; tick++) {
      const cycle = sim.cycle();
      expect(cycle.settled, `clock tick ${tick} settled`).toBe(true);
      const expected = (start + tick) % 16;
      for (let bit = 0; bit < 4; bit++) {
        expect(sim.read(`bit${bit}.slave.q`), `bit ${bit} after clock tick ${tick}`).toBe((expected >> bit) & 1);
      }
    }
  });
});
