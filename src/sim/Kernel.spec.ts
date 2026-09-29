import { describe, expect, it } from 'vitest';

import { benchmarkCpu, seedRam } from './Benchmark';
import { CircuitBuilder } from './CircuitBuilder';
import { compile, type Netlist } from './Netlist';
import { GATE_KINDS, TRUTH, type GateKind } from './Primitives';
import { Simulator } from './Simulator';

/**
 * Unit delay by its definition, with nothing clever: every tick, every
 * gate's output becomes what its inputs were when the tick began. The
 * kernel evaluates only what a change reaches, in WebAssembly, from
 * edges rather than gates; whatever it does, it must agree with this on
 * every net, every tick.
 */
function referenceTick(netlist: Netlist, value: Uint8Array): void {
  const next = netlist.out.map((_, g) => TRUTH[(netlist.type[g]! << 2) | (value[netlist.in0[g]!]! << 1) | value[netlist.in1[g]!]!]!);
  next.forEach((v, g) => (value[netlist.out[g]!] = v));
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return (below: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * below);
  };
}

/** Gates of every kind wired at random, feedback and all: latches, rings and races included. */
function randomCircuit(seed: number, gates: number, inputs: number) {
  const random = seeded(seed);
  const b = new CircuitBuilder();
  const sources = Array.from({ length: inputs }, (_, i) => b.input(`in${i}`));
  const kinds = Array.from({ length: gates }, () => GATE_KINDS[random(GATE_KINDS.length)] as GateKind);
  const handles = kinds.map((kind, i) => b.gate(kind, `g${i}`));
  const outs = [...sources, ...handles.map(h => h.out)];
  handles.forEach((handle, i) => {
    b.connect(outs[random(outs.length)]!, handle.a);
    if (kinds[i] !== 'not') b.connect(outs[random(outs.length)]!, handle.b);
  });
  return b.build();
}

describe('the kernel', () => {
  it('agrees with unit delay by definition, tick by tick, on random circuits', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const inputs = 4;
      const netlist = compile(randomCircuit(seed, 60, inputs));
      const sim = new Simulator(netlist);
      const reference = Uint8Array.from(sim.value);
      const random = seeded(seed * 31);
      for (let step = 0; step < 300; step++) {
        if (random(4) === 0) {
          const input = `in${random(inputs)}`;
          const level = random(2);
          sim.set(input, level);
          reference[netlist.inputs.get(input)!.net] = level;
        }
        sim.tick();
        referenceTick(netlist, reference);
        expect([...sim.value], `seed ${seed}, tick ${step}`).toEqual([...reference]);
      }
    }
  });

  it('agrees with it on the ten-thousand-gate benchmark, through a thousand clock edges', () => {
    const netlist = compile(benchmarkCpu());
    const sim = new Simulator(netlist);
    seedRam(sim);
    sim.settle();
    const reference = Uint8Array.from(sim.value);
    for (let edge = 0; edge < 1000; edge++) {
      const level = ((edge + 1) % 2) as 0 | 1;
      sim.setClock(level);
      for (const net of netlist.clocks) reference[net] = level;
      // Bounded: a kernel that gets it wrong may never settle.
      for (let ticks = 0; sim.pending && ticks < 200; ticks++) {
        sim.tick();
        referenceTick(netlist, reference);
      }
      expect(sim.pending, `edge ${edge} settles`).toBe(false);
      // One more reference tick: settled means nothing moves.
      referenceTick(netlist, reference);
      if (edge % 50 === 0) expect(sim.value.every((v, n) => v === reference[n]), `edge ${edge}`).toBe(true);
    }
    expect(sim.value.every((v, n) => v === reference[n])).toBe(true);
  }, 60_000);
});
