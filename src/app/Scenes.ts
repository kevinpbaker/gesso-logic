import type { Circuit, Component, PinRef } from '../sim/Circuit';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { dFlipFlop } from '../sim/Parts';
import { PINS, type GateKind } from '../sim/Primitives';
import { sizeOf } from './Layout';

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
    names.forEach((name, n) => b.position(`count${bit}.${name}`, -pitch * 3 + (n % 5) * pitch * 0.75, bit * pitch * 1.5 + Math.floor(n / 5) * 5));
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
    const [driver, reader] = from !== undefined && PINS[from.kind].outputs.includes(w.from.pin) ? [w.from, w.to] : [w.to, w.from];
    readers.set(driver.component, [...(readers.get(driver.component) ?? []), reader.component]);
    drivers.set(reader.component, [...(drivers.get(reader.component) ?? []), driver.component]);
  }
  const isSink = (c: Component) => PINS[c.kind].outputs.length === 0;
  const level = new Map<string, number>();
  const queue = circuit.components.filter(c => PINS[c.kind].inputs.length === 0).map(c => c.id);
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

  const COLUMN = 10;
  const GAP = 2;
  const rowOf = new Map<string, number>();
  const placed = new Map<string, Component>();
  // Columns are centred on the tallest, so the displays at the end sit
  // halfway down rather than tucked into a corner.
  const heightOf = (column: Component[]) =>
    column.reduce((h, c) => h + sizeOf(c.kind, c.rotation ?? 0).height + GAP, -GAP);
  const tallest = Math.max(...columns.map(heightOf));
  columns.forEach((column, x) => {
    const weight = (c: Component) => {
      const rows = (drivers.get(c.id) ?? []).map(d => rowOf.get(d)).filter((r): r is number => r !== undefined);
      return rows.length === 0 ? 0 : rows.reduce((a, r) => a + r, 0) / rows.length;
    };
    const ordered = x === 0 ? column : [...column].sort((a, b) => weight(a) - weight(b));
    let y = Math.round((tallest - heightOf(column)) / 2);
    for (const c of ordered) {
      const height = sizeOf(c.kind, c.rotation ?? 0).height;
      rowOf.set(c.id, y + height / 2);
      placed.set(c.id, { ...c, x: x * COLUMN, y });
      y += height + GAP;
    }
  });
  return { ...circuit, components: circuit.components.map(c => placed.get(c.id)!) };
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
