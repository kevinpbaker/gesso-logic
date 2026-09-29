import type { Circuit, Component, PinRef } from '../sim/Circuit';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { library } from '../sim/Library';
import { dFlipFlop } from '../sim/Parts';
import { chipInterface, pinsOf } from '../sim/Chips';
import { PINS, type GateKind } from '../sim/Primitives';
import { shapeOf, sizeOf } from './Layout';
import { assemble } from '../cpu/Assembler';
import { cpu, datapath, ram } from './Generators';

/**
 * Circuits the application starts with, until Phase 6 opens files.
 *
 * `benchScene` is Phase 0's 10,000-gate scene made real: the same 100-row
 * grid of gates, each reading two gates a little to its left — mostly one
 * to three columns back, one in twenty much further, so long wires cross
 * tiles as a real layout's would. What Phase 0 faked with a timer
 * flipping random nets is here a 10-bit ripple counter driving the first
 * column, so running the clock sends real activity rippling rightwards
 * through real gates. It is the scene Phase 3's exit is measured on.
 */

export const BENCH = {
  rows: 100,
  columns: 99,
  counterBits: 10,
  /** Grid units between neighbouring gates; a gate is 4 × 4. */
  pitch: 6
};

const KINDS: readonly GateKind[] = ['and', 'or', 'nand', 'nor', 'xor', 'xnor'];

export function benchScene(seed = 7): Circuit {
  const random = mulberry32(seed);
  const b = new CircuitBuilder();
  const { rows, columns, counterBits, pitch } = BENCH;

  // The counter, stacked in a column to the left of the grid.
  let clock = b.clock('clk');
  b.position('clk', -pitch * 4, 0);
  const bits: PinRef[] = [];
  for (let bit = 0; bit < counterBits; bit++) {
    const loop = b.gate('not', `count${bit}.loop`);
    const ff = dFlipFlop(b, loop.out, clock, `count${bit}`);
    b.connect(ff.q, loop.a);
    bits.push(ff.q);
    clock = ff.qBar;
    const names = ['loop', 'clockBar', 'master.sBar', 'master.rBar', 'master.q', 'master.qBar', 'slave.sBar', 'slave.rBar', 'slave.q', 'slave.qBar'];
    names.forEach((name, n) => b.position(`count${bit}.${name}`, -pitch * 3 + Math.round((n % 5) * pitch * 0.75), bit * pitch * 1.5 + Math.floor(n / 5) * 5));
  }

  // The grid. A gate's id is its row and column, so a spec or a person
  // can find one.
  const out: PinRef[][] = [];
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const id = `g${row}.${column}`;
      const gate = b.gate(KINDS[Math.floor(random() * KINDS.length)]!, id);
      b.position(id, column * pitch, row * pitch);
      (out[row] ??= [])[column] = gate.out;
      for (const pin of [gate.a, gate.b]) {
        if (column === 0) {
          b.connect(bits[Math.floor(random() * counterBits)]!, pin);
          continue;
        }
        const far = random() < 0.05;
        const back = 1 + Math.floor(random() * Math.min(column, far ? 20 : 3));
        const reach = far ? 20 : 2;
        const sourceRow = Math.min(rows - 1, Math.max(0, row + Math.floor(random() * (2 * reach + 1)) - reach));
        b.connect(out[sourceRow]![column - back]!, pin);
      }
    }
  }
  return b.build();
}

/**
 * Phase 5's exit: a 4-bit counter driving a seven-segment display,
 * clocked at 2 Hz.
 *
 * Four positive-edge D flip-flops count through XORs, each bit toggling
 * when every bit below it is high; `count` gates the lowest carry, so
 * flipping it off holds the count, and holding `reset` clears it on the
 * next edge. The decoder is a 4-to-16 line decoder whose lines each
 * segment ORs together — or, where a segment is off for fewer digits
 * than it is on, NORs the lines it is off for. A hex display and four
 * LEDs show the same count, so the decoder can be checked by eye.
 */
export const COUNTER_HZ = 2;

/** The segments lit for each hex digit, 0 to F. */
export const SEGMENTS_LIT: readonly string[] = [
  'abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc',
  'abcdefg', 'abcdfg', 'abcefg', 'cdefg', 'adef', 'bcdeg', 'adefg', 'aefg'
];

export function counterScene(): Circuit {
  const b = new CircuitBuilder();
  const clock = b.clock('clk');
  const count = b.input('count', 1);
  const reset = b.button('reset');
  const clear = b.not(reset, 'clear');

  const q: PinRef[] = [];
  const flops: { d: PinRef; q: PinRef }[] = [];
  let carry = count;
  for (let bit = 0; bit < 4; bit++) {
    // The flip-flop's D is wired once Q exists: next = (q xor carry) and not reset.
    const toggle = b.gate('xor', `t${bit}`);
    const d = b.and(toggle.out, clear, `d${bit}`);
    const ff = dFlipFlop(b, d, clock, `q${bit}`);
    b.connect(ff.q, toggle.a);
    b.connect(carry, toggle.b);
    q.push(ff.q);
    flops.push({ d, q: ff.q });
    if (bit < 3) carry = b.and(ff.q, carry, `c${bit + 1}`);
  }

  // The decoder: line n is high when the count is n.
  const qBar = q.map((pin, bit) => b.not(pin, `q${bit}Bar`));
  const lit = (bit: number, n: number) => ((n >> bit) & 1 ? q[bit]! : qBar[bit]!);
  const low = [0, 1, 2, 3].map(n => b.and(lit(0, n), lit(1, n), `lo${n}`));
  const high = [0, 1, 2, 3].map(n => b.and(lit(2, n << 2), lit(3, n << 2), `hi${n}`));
  const line = Array.from({ length: 16 }, (_, n) => b.and(low[n & 3]!, high[n >> 2]!, `n${n}`));

  const orTree = (pins: PinRef[], name: string): PinRef => {
    let layer = pins;
    let depth = 0;
    while (layer.length > 1) {
      const next: PinRef[] = [];
      for (let i = 0; i + 1 < layer.length; i += 2) next.push(b.or(layer[i]!, layer[i + 1]!, `${name}.${depth}.${i / 2}`));
      if (layer.length % 2 === 1) next.push(layer[layer.length - 1]!);
      layer = next;
      depth++;
    }
    return layer[0]!;
  };
  const segments: Record<string, PinRef> = {};
  for (const segment of PINS.seg7.inputs) {
    const on = SEGMENTS_LIT.flatMap((s, n) => (s.includes(segment) ? [n] : []));
    const off = SEGMENTS_LIT.flatMap((s, n) => (s.includes(segment) ? [] : [n]));
    segments[segment] =
      off.length < on.length
        ? b.not(orTree(off.map(n => line[n]!), `${segment}Off`), `seg.${segment}`)
        : orTree(on.map(n => line[n]!), `seg.${segment}`);
  }

  b.display('seg7', 'digit', segments);
  b.display('hex', 'hex', { b0: q[0]!, b1: q[1]!, b2: q[2]!, b3: q[3]! });
  q.forEach((pin, bit) => b.output(`bit${bit}`, pin));
  // The count as one 4-bit bus, for the logic analyser to draw as a staircase.
  const countBits = b.join('count bits', 4);
  q.forEach((pin, bit) => b.connect(pin, { component: countBits, pin: `b${bit}` }));
  b.display('probe', 'count value', { in: { component: countBits, pin: 'out' } }, 4);

  const circuit = b.build();
  return layOut({
    ...circuit,
    components: circuit.components.map(c => (c.kind === 'clock' ? { ...c, rate: COUNTER_HZ } : c))
  });
}

/**
 * Places a circuit in columns by how far each part is from a source:
 * sources on the left, displays on the right, each column ordered by
 * where its parts' drivers sit so wires mostly run level. Feedback wires
 * run back to the left, which the router draws around. Not a schematic
 * a person would draw, but a legible one, which is what a scene built in
 * code needs until Phase 6 can open one drawn by hand.
 */
export function layOut(circuit: Circuit): Circuit {
  const byId = new Map(circuit.components.map(c => [c.id, c]));
  const readers = new Map<string, string[]>();
  const drivers = new Map<string, string[]>();
  for (const w of circuit.wires) {
    const from = byId.get(w.from.component);
    const [driver, reader] = from !== undefined && pinsOf(from, circuit.chips).outputs.includes(w.from.pin) ? [w.from, w.to] : [w.to, w.from];
    readers.set(driver.component, [...(readers.get(driver.component) ?? []), reader.component]);
    drivers.set(reader.component, [...(drivers.get(reader.component) ?? []), driver.component]);
  }
  const isSink = (c: Component) => pinsOf(c, circuit.chips).outputs.length === 0;
  const level = new Map<string, number>();
  const queue = circuit.components.filter(c => pinsOf(c, circuit.chips).inputs.length === 0).map(c => c.id);
  queue.forEach(id => level.set(id, 0));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const next of readers.get(id) ?? []) {
      if (!level.has(next)) {
        level.set(next, level.get(id)! + 1);
        queue.push(next);
      }
    }
  }
  let deepest = 0;
  for (const c of circuit.components) {
    if (!isSink(c)) deepest = Math.max(deepest, level.get(c.id) ?? 0);
  }
  const columns: Component[][] = Array.from({ length: deepest + 2 }, () => []);
  for (const c of circuit.components) {
    columns[isSink(c) ? deepest + 1 : (level.get(c.id) ?? 0)]!.push(c);
  }

  const COLUMN = Math.max(10, ...circuit.components.map(c => sizeOf(shapeOf(c, circuit.chips)).width + 6));
  const GAP = 2;
  const rowOf = new Map<string, number>();
  const placed = new Map<string, Component>();
  // Columns are centred on the tallest, so the displays at the end sit
  // halfway down rather than tucked into a corner.
  const heightOf = (column: Component[]) =>
    column.reduce((h, c) => h + sizeOf(shapeOf(c, circuit.chips), c.rotation ?? 0).height + GAP, -GAP);
  const tallest = Math.max(...columns.map(heightOf));
  columns.forEach((column, x) => {
    const weight = (c: Component) => {
      const rows = (drivers.get(c.id) ?? []).map(d => rowOf.get(d)).filter((r): r is number => r !== undefined);
      return rows.length === 0 ? 0 : rows.reduce((a, r) => a + r, 0) / rows.length;
    };
    const ordered = x === 0 ? column : [...column].sort((a, b) => weight(a) - weight(b));
    let y = Math.round((tallest - heightOf(column)) / 2);
    for (const c of ordered) {
      const height = sizeOf(shapeOf(c, circuit.chips), c.rotation ?? 0).height;
      rowOf.set(c.id, y + height / 2);
      placed.set(c.id, { ...c, x: x * COLUMN, y });
      y += height + GAP;
    }
  });
  return { ...circuit, components: circuit.components.map(c => placed.get(c.id)!) };
}

/**
 * Phase 8's exit: a full adder made into a chip, eight of them chained
 * into an 8-bit adder, and that made into a chip too. The top level is
 * the adder chip between two bytes of switches and a byte of LEDs, with
 * hex displays reading each byte, set to add 0x2B and 0x3C, and carry
 * in toggling once a second.
 *
 * Built in code, each level laid out by `layOut`; `makeChip` makes the
 * same thing from a selection, which the specs check agrees.
 */
export const ADDER = { a: 0x2b, b: 0x3c };

/** The library's full adder, laid out. */
export function fullAdderChip(): Circuit {
  return layOut(library()['full adder']);
}

export function adder8Chip(chips: Record<string, Circuit>): Circuit {
  const b = new CircuitBuilder();
  const a = Array.from({ length: 8 }, (_, i) => b.input(`a${i}`));
  const x = Array.from({ length: 8 }, (_, i) => b.input(`b${i}`));
  let carry = b.input('cin');
  for (let i = 0; i < 8; i++) {
    const fa = b.chip(`fa${i}`, 'full adder');
    b.connect(a[i]!, { component: fa, pin: 'a' });
    b.connect(x[i]!, { component: fa, pin: 'b' });
    b.connect(carry, { component: fa, pin: 'cin' });
    b.output(`s${i}`, { component: fa, pin: 's' });
    carry = { component: fa, pin: 'cout' };
  }
  b.output('cout', carry);
  return layOut({ ...b.build(), chips });
}

export function adderScene(): Circuit {
  const full = fullAdderChip();
  const chips: Record<string, Circuit> = { 'full adder': full };
  const adder8 = adder8Chip(chips);
  chips['adder 8'] = { ...adder8, chips: undefined };
  const b = new CircuitBuilder();
  const add = b.chip('add', 'adder 8');
  const bits = (name: string, value: number) =>
    Array.from({ length: 8 }, (_, i) => {
      const pin = b.input(`${name}${i}`, ((value >> i) & 1) as 0 | 1);
      b.connect(pin, { component: add, pin: `${name.toLowerCase()}${i}` });
      return pin;
    });
  const a = bits('A', ADDER.a);
  const x = bits('B', ADDER.b);
  // Carry in from a flip-flop that toggles on every tick of a 1 Hz
  // clock — a clock itself reads low between cycles, so it would never
  // be seen high. With these two bytes the carry into bit 2 is the carry
  // in, so running the circuit makes the inside of the third full adder
  // change once a second while the sum flips between 0x67 and 0x68.
  const toggle = b.gate('not', 'CIN.next');
  const cin = dFlipFlop(b, toggle.out, b.clock('CLK'), 'CIN');
  b.connect(cin.q, toggle.a);
  b.connect(cin.q, { component: add, pin: 'cin' });
  const s = Array.from({ length: 8 }, (_, i) => {
    const out = { component: add, pin: `s${i}` };
    b.output(`S${i}`, out);
    return out;
  });
  b.output('COUT', { component: add, pin: 'cout' });
  const hex = (label: string, from: PinRef[]) =>
    b.display('hex', label, { b0: from[0]!, b1: from[1]!, b2: from[2]!, b3: from[3]! });
  hex('A lo', a.slice(0, 4));
  hex('A hi', a.slice(4));
  hex('B lo', x.slice(0, 4));
  hex('B hi', x.slice(4));
  hex('S lo', s.slice(0, 4));
  hex('S hi', s.slice(4));
  const { chips: _, ...adderDefinition } = adder8;
  const built = b.build();
  return layOut({
    ...built,
    components: built.components.map(c => (c.kind === 'clock' ? { ...c, rate: 1 } : c)),
    chips: { 'full adder': full, 'adder 8': adderDefinition as Circuit }
  });
}

/**
 * Phase 9's exit: the 8-bit adder rebuilt with bus pins. The `bus adder`
 * chip takes two 8-bit buses, A and B, and a carry in, and gives an
 * 8-bit S and a carry out. Inside, splits take A and B apart into the
 * eight full adders and a join puts their sums together into S. At the
 * top, 8-bit switches feed it and S feeds a two-digit hex display, with
 * carry in toggling once a second as in the adder scene.
 */
export function busAdderChip(): Circuit {
  const b = new CircuitBuilder();
  const a = b.input('A', 0, 8);
  const x = b.input('B', 0, 8);
  let carry = b.input('cin');
  const splitA = b.split('A bits', 8);
  const splitB = b.split('B bits', 8);
  const joinS = b.join('S bits', 8);
  b.connect(a, { component: splitA, pin: 'in' });
  b.connect(x, { component: splitB, pin: 'in' });
  for (let i = 0; i < 8; i++) {
    const fa = b.chip(`fa${i}`, 'full adder');
    b.connect({ component: splitA, pin: `b${i}` }, { component: fa, pin: 'a' });
    b.connect({ component: splitB, pin: `b${i}` }, { component: fa, pin: 'b' });
    b.connect(carry, { component: fa, pin: 'cin' });
    b.connect({ component: fa, pin: 's' }, { component: joinS, pin: `b${i}` });
    carry = { component: fa, pin: 'cout' };
  }
  b.output('S', { component: joinS, pin: 'out' }, 8);
  b.output('cout', carry);
  return layOut({ ...b.build(), chips: { 'full adder': fullAdderChip() } });
}

export function busAdderScene(): Circuit {
  const full = fullAdderChip();
  const { chips: _, ...busAdder } = busAdderChip();
  const chips = { 'full adder': full, 'bus adder': busAdder as Circuit };
  const b = new CircuitBuilder();
  const add = b.chip('add', 'bus adder');
  const a = b.input('A', ADDER.a, 8);
  const x = b.input('B', ADDER.b, 8);
  b.connect(a, { component: add, pin: 'A' });
  b.connect(x, { component: add, pin: 'B' });
  const toggle = b.gate('not', 'CIN.next');
  const cin = dFlipFlop(b, toggle.out, b.clock('CLK'), 'CIN');
  b.connect(cin.q, toggle.a);
  b.connect(cin.q, { component: add, pin: 'cin' });
  const s = { component: add, pin: 'S' };
  b.display('hex', 'A', { in: a }, 8);
  b.display('hex', 'B', { in: x }, 8);
  b.display('hex', 'sum', { in: s }, 8);
  b.output('S', s, 8);
  b.output('COUT', { component: add, pin: 'cout' });
  const built = b.build();
  return layOut({
    ...built,
    components: built.components.map(c => (c.kind === 'clock' ? { ...c, rate: 1 } : c)),
    chips
  });
}

/** A small seeded PRNG, so the scene is the same every time. */
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

/**
 * Phase 14's exit, as a scene: the generated 128-byte RAM as a chip,
 * between switches for the address and the data, buttons for write
 * enable and reset, and hex displays of all three. Double-click it to
 * open it: rows, then bytes, then the latches.
 */
export function ramScene(): Circuit {
  const { chips, ...definition } = ram(128);
  const b = new CircuitBuilder();
  const memory = b.chip('ram', 'RAM 128');
  const address = b.input('A', 0x05, 7);
  const data = b.input('D', 0x5a, 8);
  b.connect(address, { component: memory, pin: 'A' });
  b.connect(data, { component: memory, pin: 'D' });
  b.connect(b.button('we'), { component: memory, pin: 'we' });
  b.connect(b.button('rst'), { component: memory, pin: 'rst' });
  const q = { component: memory, pin: 'Q' };
  b.display('hex', 'address', { in: address }, 7);
  b.display('hex', 'data', { in: data }, 8);
  b.display('hex', 'read', { in: q }, 8);
  b.output('Q', q, 8);
  return layOut({ ...b.build(), chips: { ...chips, 'RAM 128': definition as Circuit } });
}

/**
 * Phase 15's exit, as a scene: the datapath as a chip, a switch for each
 * control line and for the instruction word `I` and data byte `M`, a
 * button on `clk`, and a display on everything it puts out. Set the
 * lines, press `clk`, and watch the registers take what the lines said.
 * `op` codes and `right`'s are in `src/cpu/Control.ts`.
 */
export function datapathScene(): Circuit {
  const { chips, ...definition } = datapath();
  const face = chipInterface(definition as Circuit);
  const b = new CircuitBuilder();
  const dp = b.chip('datapath', 'datapath');
  for (const pin of face.inputs) {
    const source = pin.name === 'clk' ? b.button('clk') : b.input(pin.name, 0, pin.width);
    b.connect(source, { component: dp, pin: pin.name });
  }
  for (const pin of face.outputs) {
    const out = { component: dp, pin: pin.name };
    if (pin.width > 1) b.display('hex', pin.name, { in: out }, pin.width);
    else b.output(pin.name, out);
  }
  return layOut({ ...b.build(), chips: { ...chips, datapath: definition as Circuit } });
}

/** The program Phase 16's exit runs: three instructions, and a halt. */
export const THREE_INSTRUCTIONS = `
        LDA #5
        ADD #3          ; A = 8
        HLT
`;

/**
 * Phase 16's exit, as a scene: the CPU chip, a ROM holding a program,
 * and the clock. `M` carries the ROM's table port when the CPU asks for
 * a table byte, and 0 otherwise — RAM and devices come with Phase 17.
 * `rst` starts on: flip it off and the program runs, then halts.
 */
export function computerScene(program = THREE_INSTRUCTIONS): Circuit {
  const { chips, ...definition } = cpu();
  const b = new CircuitBuilder();
  const processor = b.chip('cpu', 'CPU');
  const rom = b.rom('rom', [...assemble(program).rom.slice(0, assemble(program).size)]);
  const clock = b.clock('clk');
  const rst = b.input('rst', 1);
  b.connect(clock, { component: processor, pin: 'clk' });
  b.connect(rst, { component: processor, pin: 'rst' });
  b.connect({ component: processor, pin: 'PC' }, { component: rom, pin: 'A' });
  b.connect({ component: rom, pin: 'D' }, { component: processor, pin: 'I' });
  b.connect({ component: processor, pin: 'ADDR' }, { component: rom, pin: 'T' });
  const m = b.chip('M', 'mux 2 ×8');
  b.connect(b.constant(0, 'no memory', 8), { component: m, pin: 'A' });
  b.connect({ component: rom, pin: 'Q' }, { component: m, pin: 'B' });
  b.connect({ component: processor, pin: 'table' }, { component: m, pin: 's' });
  b.connect({ component: m, pin: 'Y' }, { component: processor, pin: 'M' });
  b.display('hex', 'PC', { in: { component: processor, pin: 'PC' } }, 8);
  b.display('hex', 'A', { in: { component: processor, pin: 'A' } }, 8);
  b.display('hex', 'B', { in: { component: processor, pin: 'B' } }, 8);
  b.display('hex', 'X', { in: { component: processor, pin: 'X' } }, 8);
  b.output('halted', { component: processor, pin: 'halted' });
  const built = b.build();
  return layOut({
    ...built,
    components: built.components.map(c => (c.kind === 'clock' ? { ...c, rate: 4 } : c)),
    chips: { ...chips, CPU: definition as Circuit }
  });
}
