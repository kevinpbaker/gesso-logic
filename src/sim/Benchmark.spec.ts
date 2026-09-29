import { describe, expect, it } from 'vitest';

import { BENCHMARK_GATES, benchmarkCpu, seedRam } from './Benchmark';
import { compile } from './Netlist';
import { Simulator } from './Simulator';

describe("Phase 12's benchmark", () => {
  it('is ten thousand gates, a clocked circuit whose program counter counts', () => {
    const netlist = compile(benchmarkCpu());
    expect(netlist.gateCount).toBe(BENCHMARK_GATES);
    const sim = new Simulator(netlist);
    seedRam(sim);
    expect(sim.settle().settled).toBe(true);
    const pc = () => [0, 1, 2, 3, 4, 5, 6].reduce((n, i) => n | (sim.read(`pc${i}.slave.q`) << i), 0);
    const before = pc();
    for (let i = 0; i < 200; i++) expect(sim.cycle().settled).toBe(true);
    expect(pc()).toBe((before + 200) % 128);
  });
});
