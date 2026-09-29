import type { Circuit, PinRef } from './Circuit';
import { CircuitBuilder } from './CircuitBuilder';
import { dFlipFlop } from './Parts';
import type { Simulator } from './Simulator';

/**
 * Phase 12's benchmark: a 10,000-gate circuit with the CPU's rough shape
 * and none of its meaning — Phase 0's synthetic CPU, built as a real
 * document so it runs on the real compiler and simulator, and loads as a
 * scene.
 *
 *   - a 7-bit program counter and incrementer, addressing
 *   - 128 bytes of RAM as gated D latches (4 NANDs a bit), with an
 *     unshared 7 → 128 decoder and a 128 → 1 AND-OR read tree per bit,
 *   - A, B, X and IR registers of master–slave flip-flops, an ALU (add,
 *     and, or, xor) whose result goes back to A and to RAM,
 *   - and a control block shaped like a PLA — product terms of a few
 *     instruction-register and step literals, ORed into control lines —
 *     filling the budget to the gate, feeding a register so none of it is
 *     dead logic.
 *
 * The RAM's write strobe is one gate from the clock and its data goes
 * through a buffer: a tick of hold margin, which Phase 0 found the first
 * version of this circuit oscillating without.
 *
 * A document cannot say what a latch holds at power-on, and an all-zero
 * memory leaves the datapath still — the benchmark would measure a
 * counter. `seedRam` gives the cells seeded random contents directly on
 * a simulator, as Phase 0's spike did; the circuit itself is ordinary.
 */
export const BENCHMARK_GATES = 10_000;

export function benchmarkCpu(targetGates = BENCHMARK_GATES, seed = 1): Circuit {
  const b = new CircuitBuilder();
  const random = mulberry32(seed);
  const clock = b.clock('clk');
  const one = b.constant(1, 'one');
  const zero = b.constant(0, 'zero');

  const reduce = (pins: readonly PinRef[], combine: (x: PinRef, y: PinRef) => PinRef): PinRef => {
    let level = [...pins];
    while (level.length > 1) {
      const up: PinRef[] = [];
      for (let i = 0; i + 1 < level.length; i += 2) up.push(combine(level[i]!, level[i + 1]!));
      if (level.length % 2 === 1) up.push(level[level.length - 1]!);
      level = up;
    }
    return level[0]!;
  };
  const orTree = (pins: readonly PinRef[]) => reduce(pins, (x, y) => b.or(x, y));
  let flops = 0;
  /** A flip-flop whose Q feeds back before its D exists: returns Q, and a function wiring D. */
  const pending = (name: string): { q: PinRef; connect: (d: PinRef) => void } => {
    const d = b.gate('and', `${name}.d`);
    b.connect(one, d.b);
    const ff = dFlipFlop(b, d.out, clock, name);
    return { q: ff.q, connect: pin => b.connect(pin, d.a) };
  };
  const register = (inputs: readonly PinRef[], name: string) => inputs.map((d, i) => dFlipFlop(b, d, clock, `${name}${i}.${flops++}`).q);

  // --- Program counter -------------------------------------------------
  const pc = Array.from({ length: 7 }, (_, i) => pending(`pc${i}`));
  let carry = one;
  pc.forEach((bit, i) => {
    bit.connect(b.xor(bit.q, carry, `pc${i}.next`));
    carry = b.and(bit.q, carry, `pc${i}.carry`);
  });
  const pcQ = pc.map(bit => bit.q);

  // --- Registers that feed back ----------------------------------------
  const accumulator = Array.from({ length: 8 }, (_, i) => pending(`a${i}`));
  const ir = Array.from({ length: 16 }, (_, i) => pending(`ir${i}`));

  // --- RAM: decoder ----------------------------------------------------
  const pcLow = pcQ.map((bit, i) => b.not(bit, `pc${i}.low`));
  const select = Array.from({ length: 128 }, (_, address) =>
    reduce(
      pcQ.map((bit, i) => ((address >> i) & 1 ? bit : pcLow[i]!)),
      (x, y) => b.and(x, y)
    )
  );

  // --- RAM: storage, written while the clock is low ---------------------
  const irLow = b.not(ir[0]!.q, 'ir0.low');
  const writeStrobe = b.nor(clock, irLow, 'strobe');
  const writeData = accumulator.map((bit, i) => b.and(bit.q, one, `wd${i}`));
  const cells = Array.from({ length: 128 }, (_, address) => {
    const enable = b.and(select[address]!, writeStrobe, `ram${address}.en`);
    return Array.from({ length: 8 }, (_, bit) => {
      const name = `ram${address}.${bit}`;
      const sBar = b.nand(writeData[bit]!, enable, `${name}.sBar`);
      const rBar = b.nand(sBar, enable, `${name}.rBar`);
      const q = b.gate('nand', `${name}.q`);
      const qBar = b.gate('nand', `${name}.qBar`);
      b.connect(sBar, q.a);
      b.connect(qBar.out, q.b);
      b.connect(rBar, qBar.a);
      b.connect(q.out, qBar.b);
      return q.out;
    });
  });

  // --- RAM: read tree --------------------------------------------------
  const read = Array.from({ length: 8 }, (_, bit) => orTree(select.map((sel, address) => b.and(sel, cells[address]![bit]!))));

  // --- Datapath --------------------------------------------------------
  const operand = register(read, 'operand');
  const opLow = b.not(pcQ[1]!);
  const opHigh = b.not(pcQ[2]!);
  const opcode = [b.and(opLow, opHigh), b.and(pcQ[1]!, opHigh), b.and(opLow, pcQ[2]!), b.and(pcQ[1]!, pcQ[2]!)];
  let carryIn: PinRef = zero;
  const result: PinRef[] = [];
  for (let bit = 0; bit < 8; bit++) {
    const a = accumulator[bit]!.q;
    const x = operand[bit]!;
    const half = b.xor(a, x);
    const sum = b.xor(half, carryIn);
    carryIn = b.or(b.and(a, x), b.and(half, carryIn));
    const lanes = [sum, b.and(a, x), b.or(a, x), half];
    result.push(orTree(lanes.map((lane, i) => b.and(opcode[i]!, lane))));
  }
  const carryOut = carryIn;
  // A takes the ALU result or, on alternate instructions, the RAM read.
  const loadSelect = pcQ[3]!;
  const loadSelectLow = b.not(loadSelect);
  result.forEach((r, bit) => accumulator[bit]!.connect(b.or(b.and(loadSelect, read[bit]!), b.and(loadSelectLow, r))));
  [...read, ...result].forEach((d, bit) => ir[bit]!.connect(b.xor(d, pcQ[bit % 7]!)));
  const index = register(
    accumulator.map((a, bit) => b.xor(a.q, operand[bit]!)),
    'x'
  );
  const flags = register([b.not(orTree(result)), carryOut, result[7]!], 'flag');
  void index;

  // --- Control: a PLA filling what is left -----------------------------
  const lines = 16;
  const built = () => b.build().components.filter(c => c.kind !== 'clock' && c.kind !== 'constant').length;
  const remaining = targetGates - built() - lines * 9;
  const variables = [...ir.slice(0, 8).map(r => r.q), pcQ[4]!, pcQ[5]!, ...flags];
  const complements = variables.map(v => b.not(v));
  // Each term is an AND chain of five literals (four gates) and feeds one
  // line's OR tree (about one gate): five a term.
  const termCount = Math.max(lines, Math.floor((remaining - complements.length + lines) / 5));
  const terms: PinRef[] = [];
  for (let t = 0; t < termCount; t++) {
    const chosen = new Set<number>();
    while (chosen.size < 5) chosen.add(Math.floor(random() * variables.length));
    terms.push(
      reduce(
        [...chosen].map(v => (random() < 0.5 ? variables[v]! : complements[v]!)),
        (x, y) => b.and(x, y)
      )
    );
  }
  register(
    Array.from({ length: lines }, (_, line) => orTree(terms.filter((_, t) => t % lines === line))),
    'control'
  );
  return b.build();
}

/** Gives the RAM seeded random contents on a simulator, to settle on its next tick: see the file comment. */
export function seedRam(sim: Simulator, seed = 1): void {
  const random = mulberry32(seed * 7919);
  for (let address = 0; address < 128; address++) {
    for (let bit = 0; bit < 8; bit++) {
      const v = random() < 0.5 ? 1 : 0;
      sim.force(sim.net(`ram${address}.${bit}.q`), v);
      sim.force(sim.net(`ram${address}.${bit}.qBar`), (1 - v) as 0 | 1);
    }
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
