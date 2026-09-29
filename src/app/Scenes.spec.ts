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
