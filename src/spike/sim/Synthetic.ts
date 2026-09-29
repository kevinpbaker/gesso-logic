import { NAND, NetlistBuilder, type GateType, type Netlist, AND, OR, NOR, XOR } from './Netlist.ts';

/**
 * A 10,000-gate circuit with the CPU's rough shape and none of its
 * meaning.
 *
 * The roadmap's gate budget says most of the CPU is memory — a wide
 * latch array with a decoder in front and an AND-OR read tree behind —
 * and the rest is a narrow datapath and a control unit. This builds
 * exactly that proportion out of real parts that really clock, so the
 * activity per cycle is the activity of a circuit rather than of noise:
 *
 *   - a 7-bit program counter and incrementer, addressing
 *   - 128 bytes of RAM as gated D latches (4 NANDs a bit), with an
 *     unshared 7 → 128 decoder and a 128 → 1 read tree per bit,
 *   - A, B, X and IR registers of master–slave flip-flops, an ALU
 *     (add, and, or, xor) whose result is written back to A and to RAM,
 *   - and a combinational "control" block that fills the budget to
 *     the gate, feeding a register so none of it is dead logic (see
 *     `ControlStyle` below for its two shapes).
 *
 * RAM starts with seeded random contents, so the accumulator has
 * something to add and the read tree something to carry; with an
 * all-zero memory the whole datapath would sit still and the benchmark
 * would measure a counter.
 */
export interface SyntheticCpu {
  readonly netlist: Netlist;
  readonly clock: number;
  /** The program counter's bits, low first, for the sanity check that the thing actually clocks. */
  readonly pc: readonly number[];
  readonly accumulator: readonly number[];
  /** Gates per block, so the benchmark can print where the budget went. */
  readonly budget: Readonly<Record<string, number>>;
  /** Each block's gates as index ranges, for attributing evaluations to blocks. */
  readonly ranges: readonly { readonly name: string; readonly start: number; readonly end: number }[];
}

export type ControlStyle = 'pla' | 'random';

export function syntheticCpu(targetGates = 10_000, control: ControlStyle = 'pla', seed = 1): SyntheticCpu {
  const b = new NetlistBuilder();
  const random = mulberry32(seed);
  const budget: Record<string, number> = {};
  const ranges: { name: string; start: number; end: number }[] = [];
  let mark = 0;
  const block = (name: string) => {
    budget[name] = (budget[name] ?? 0) + b.gateCount - mark;
    ranges.push({ name, start: mark, end: b.gateCount });
    mark = b.gateCount;
  };

  const one = b.net(1);
  const clock = b.net(0);
  const clockLow = b.not(clock);

  const latch = (d: number, enable: number, q = b.net(0), hint = 0): number => {
    const s = b.nand(d, enable);
    const r = b.nand(s, enable);
    const qn = b.net(1 - hint);
    b.drive(q, NAND, s, qn);
    b.drive(qn, NAND, r, q);
    return q;
  };
  // Master open while the clock is low, slave while it is high: the
  // output changes on the rising edge. Eight gates, where the roadmap's
  // six-NAND edge-triggered flip-flop would be six; close enough to size
  // a benchmark, and far easier to be sure of under unit delay.
  const flipFlop = (d: number, q?: number): number => latch(latch(d, clockLow), clock, q);
  const register = (inputs: readonly number[]): number[] => inputs.map(d => flipFlop(d));
  const mux = (select: number, whenHigh: number, whenLow: number, selectLow: number): number =>
    b.or(b.and(select, whenHigh), b.and(selectLow, whenLow));
  const orTree = (nets: readonly number[]): number => reduce(nets, (x, y) => b.or(x, y));
  block('clock');

  // --- Program counter -------------------------------------------------
  const pc = Array.from({ length: 7 }, () => b.net(0));
  let carry = one;
  const next: number[] = [];
  for (const bit of pc) {
    next.push(b.xor(bit, carry));
    carry = b.and(bit, carry);
  }
  next.forEach((d, i) => flipFlop(d, pc[i]));
  block('pc + incrementer');

  // --- Registers that exist before the ALU is built ---------------------
  const accumulator = Array.from({ length: 8 }, () => b.net(0));
  const ir = Array.from({ length: 16 }, () => b.net(0));

  // --- RAM: decoder ----------------------------------------------------
  const pcLow = pc.map(bit => b.not(bit));
  const select: number[] = [];
  for (let address = 0; address < 128; address++) {
    const literals = pc.map((bit, i) => ((address >> i) & 1 ? bit : pcLow[i]));
    select.push(reduce(literals, (x, y) => b.and(x, y)));
  }
  block('ram decode');

  // --- RAM: storage, written while the clock is low ---------------------
  //
  // Hold time, found by the first run oscillating. With the strobe as
  // `ir0 AND clockLow`, a rising edge closed the latches' enable three
  // ticks after the clock but changed the accumulator — their data — in
  // two, so a latch saw its data move while still open, both halves of
  // its SR pair went low for a tick, and it rang forever. Real latches
  // fail the same way. The strobe is now one gate from the clock rather
  // than two, and the data goes through a buffer, which gives the write
  // a tick of hold margin.
  const irLow = b.not(ir[0]);
  const writeStrobe = b.nor(clock, irLow);
  const writeData = accumulator.map(bit => b.and(bit, one));
  const cells: number[][] = [];
  for (let address = 0; address < 128; address++) {
    const enable = b.and(select[address], writeStrobe);
    const row: number[] = [];
    for (let bit = 0; bit < 8; bit++) {
      row.push(latch(writeData[bit], enable, b.net(0), random() < 0.5 ? 1 : 0));
    }
    cells.push(row);
  }
  block('ram storage');

  // --- RAM: read tree --------------------------------------------------
  const read: number[] = [];
  for (let bit = 0; bit < 8; bit++) {
    read.push(orTree(select.map((sel, address) => b.and(sel, cells[address][bit]))));
  }
  block('ram read');

  // --- Datapath --------------------------------------------------------
  const operand = register(read);
  block('registers');

  const opLow = b.not(pc[1]);
  const opHigh = b.not(pc[2]);
  const opcode = [b.and(opLow, opHigh), b.and(pc[1], opHigh), b.and(opLow, pc[2]), b.and(pc[1], pc[2])];
  let carryIn = b.net(0);
  const result: number[] = [];
  for (let bit = 0; bit < 8; bit++) {
    const a = accumulator[bit];
    const x = operand[bit];
    const half = b.xor(a, x);
    const sum = b.xor(half, carryIn);
    carryIn = b.or(b.and(a, x), b.and(half, carryIn));
    const lanes = [sum, b.and(a, x), b.or(a, x), half];
    result.push(orTree(lanes.map((lane, i) => b.and(opcode[i], lane))));
  }
  const carryOut = carryIn;
  block('alu');

  // A takes the ALU result or, on alternate instructions, the RAM read.
  const loadSelect = pc[3];
  const loadSelectLow = b.not(loadSelect);
  const toAccumulator = result.map((r, bit) => mux(loadSelect, read[bit], r, loadSelectLow));
  block('operand muxes');

  toAccumulator.forEach((d, bit) => flipFlop(d, accumulator[bit]));
  [...read, ...result].forEach((d, bit) => flipFlop(b.xor(d, pc[bit % 7]), ir[bit]));
  const index = register(accumulator.map((a, bit) => b.xor(a, operand[bit])));
  const zero = b.not(orTree(result));
  const flags = register([zero, carryOut, result[7]]);
  block('registers');

  // --- Control: whatever is left of the budget ------------------------
  //
  // Two styles, because the first run said the style decides the
  // answer. `pla` is what a hardwired control unit is: product terms
  // (ANDs of a few instruction-register and step literals) ORed into
  // control lines. `random` is a cloud of mixed gates, XOR included,
  // each reading recent ones — a glitch amplifier, kept as the worst
  // case rather than as a model of anything.
  const lines = 16;
  const remaining = targetGates - b.gateCount - lines * 8;
  let outputs: number[];
  if (control === 'pla') {
    const variables = [...ir.slice(0, 8), pc[4], pc[5], ...flags];
    const complements = variables.map(v => b.not(v));
    const terms: number[] = [];
    // Each term is an AND chain of five literals on distinct variables
    // (four gates) and feeds one line's OR tree (one gate, less one per
    // line for the tree's root): five gates a term.
    const termCount = Math.max(lines, Math.floor((remaining - complements.length + lines) / 5));
    for (let t = 0; t < termCount; t++) {
      const chosen = new Set<number>();
      while (chosen.size < 5) {
        chosen.add(Math.floor(random() * variables.length));
      }
      const literals = [...chosen].map(v => (random() < 0.5 ? variables[v] : complements[v]));
      terms.push(reduce(literals, (x, y) => b.and(x, y)));
    }
    outputs = Array.from({ length: lines }, (_, line) => orTree(terms.filter((_, t) => t % lines === line)));
  } else {
    const pool = [...pc, ...ir, ...flags, ...index.slice(0, 4)];
    const types: GateType[] = [AND, OR, NAND, NOR, AND, OR, XOR];
    for (let i = 0; i < remaining; i++) {
      // Inputs drawn mostly from recent gates, so the cloud has depth
      // rather than being one wide layer over the pool.
      const pick = () => pool[pool.length - 1 - Math.floor(random() ** 2 * Math.min(pool.length, 200))];
      pool.push(b.gate(types[Math.floor(random() * types.length)], pick(), pick()));
    }
    outputs = pool.slice(-lines);
  }
  register(outputs);
  block('control');

  return { netlist: b.compile(), clock, pc, accumulator, budget, ranges };
}

function reduce(nets: readonly number[], combine: (a: number, b: number) => number): number {
  let level = [...nets];
  while (level.length > 1) {
    const up: number[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      up.push(combine(level[i], level[i + 1]));
    }
    if (level.length % 2 === 1) {
      up.push(level[level.length - 1]);
    }
    level = up;
  }
  return level[0];
}

/** A small seeded PRNG, so every run builds the same circuit. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
