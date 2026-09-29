import { describe, expect, it } from 'vitest';

import { compile } from '../sim/Netlist';
import { isGate } from '../sim/Primitives';
import { Simulator } from '../sim/Simulator';
import { BENCH, benchScene } from './Scenes';

describe('the bench scene', () => {
  const circuit = benchScene();
  const netlist = compile(circuit);

  it('is 10,000 gates, and compiles', () => {
    expect(circuit.components.filter(c => isGate(c.kind))).toHaveLength(10_000);
    expect(netlist.gateCount).toBe(10_000);
    expect(netlist.floating).toEqual([]);
  });

  it('runs: every cycle settles, and activity reaches the far column', () => {
    const sim = new Simulator(netlist);
    const last = Array.from({ length: BENCH.rows }, (_, row) => sim.net(`g${row}.${BENCH.columns - 1}`));
    const moved = new Set<number>();
    let previous = last.map(net => sim.value[net]);
    for (let cycle = 0; cycle < 256; cycle++) {
      expect(sim.cycle().settled).toBe(true);
      last.forEach((net, row) => {
        if (sim.value[net] !== previous[row]) {
          moved.add(row);
        }
      });
      previous = last.map(net => sim.value[net]);
    }
    // Most of the rightmost column changes: the counter's activity
    // ripples through 99 columns of gates rather than dying out.
    expect(moved.size).toBeGreaterThan(BENCH.rows / 2);
  });

  it('is the same scene every time', () => {
    expect(benchScene()).toEqual(circuit);
  });
});

describe('the counter scene', () => {
  it('counts through sixteen digits at 2 Hz, lighting the right segments', async () => {
    const { counterScene, SEGMENTS_LIT } = await import('./Scenes');
    const circuit = counterScene();
    expect(circuit.components.find(c => c.kind === 'clock')?.rate).toBe(2);
    const sim = new Simulator(compile(circuit));
    expect(sim.settle().settled).toBe(true);
    const shown = () => {
      const segments = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter(s => sim.value[sim.net('digit', s)] === 1).join('');
      const hex = [0, 1, 2, 3].reduce((n, bit) => n | (sim.value[sim.net('hex', `b${bit}`)]! << bit), 0);
      return { segments, hex };
    };
    // Power-on leaves the flip-flops wherever the latches fell; reset first.
    sim.set('reset', 1);
    sim.cycle();
    sim.set('reset', 0);
    for (let n = 0; n < 20; n++) {
      expect(shown()).toEqual({ segments: SEGMENTS_LIT[n % 16], hex: n % 16 });
      expect(sim.cycle().settled).toBe(true);
    }
    // Holding reset clears the count on the next edge.
    sim.set('reset', 1);
    sim.cycle();
    expect(shown().hex).toBe(0);
  });
});
