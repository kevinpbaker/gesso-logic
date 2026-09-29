import type { Circuit, Component, PinRef } from '../sim/Circuit';
import { pinsOf } from '../sim/Chips';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { library, libraryWithDependencies } from '../sim/Library';
import { shapeOf, sizeOf } from './Layout';
import { layOut } from './Scenes';

/**
 * The generators: structures too regular to draw by hand, written as
 * ordinary circuit documents by code (see "One file format, no HDL" in
 * the roadmap). `scripts/generate.ts` writes them to `circuits/`, where
 * the editor opens them like anything else and the specs check they are
 * what this code makes.
 *
 * Each generator returns a document whose top level is the part itself —
 * its switches and LEDs are the pins it has as a chip — with every chip
 * it is made of in `chips`, laid out. So the file opens as the part's
 * insides, and imports as a chip.
 */

/** A part and the chips it is made of: a document. */
export type Generated = Circuit & { readonly chips: Readonly<Record<string, Circuit>> };

/**
 * Lays out each definition with every chip to hand, so a chip made of
 * chips knows their sizes: the library's parts as the library lays them
 * out, and the generated ones by `layered`.
 */
function laidOut(top: Circuit, chips: Record<string, Circuit>, generated: ReadonlySet<string>): Generated {
  const all = { ...chips };
  const out: Record<string, Circuit> = {};
  for (const [name, definition] of Object.entries(chips)) {
    const { chips: _, ...placed } = (generated.has(name) ? layered : layOut)({ ...definition, chips: all });
    out[name] = placed as Circuit;
  }
  const { chips: _, ...placedTop } = layered({ ...top, chips: all });
  return { ...(placedTop as Circuit), chips: out };
}

/**
 * A layout for circuits with no loops, which every generated level is:
 * each part a column past the furthest of its drivers, so signals only
 * ever run left to right — the decoders before the rows they select, the
 * rows before the tree that reads them — and each column stacked in the
 * order its drivers sit, with switches first and LEDs last. `layOut`
 * places by nearest source instead, which puts a row beside the switches
 * that also feed it, ahead of its decoder.
 */
function layered(circuit: Circuit): Circuit {
  const byId = new Map(circuit.components.map(c => [c.id, c]));
  const pins = (c: Component) => pinsOf(c, circuit.chips);
  const drivers = new Map<string, string[]>();
  for (const w of circuit.wires) {
    const from = byId.get(w.from.component)!;
    const [driver, reader] = pins(from).outputs.includes(w.from.pin) ? [w.from.component, w.to.component] : [w.to.component, w.from.component];
    drivers.set(reader, [...(drivers.get(reader) ?? []), driver]);
  }
  const level = new Map<string, number>();
  const levelOf = (id: string, seen: Set<string>): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const l = Math.max(-1, ...(drivers.get(id) ?? []).map(d => levelOf(d, seen))) + 1;
    level.set(id, l);
    return l;
  };
  circuit.components.forEach(c => levelOf(c.id, new Set()));
  const isSink = (c: Component) => c.kind === 'output';
  const deepest = Math.max(0, ...circuit.components.filter(c => !isSink(c)).map(c => level.get(c.id)!));
  const columns: Component[][] = Array.from({ length: deepest + 2 }, () => []);
  for (const c of circuit.components) columns[isSink(c) ? deepest + 1 : level.get(c.id)!]!.push(c);

  const size = (c: Component) => sizeOf(shapeOf(c, circuit.chips), c.rotation ?? 0);
  const GAP_X = 6;
  const GAP_Y = 2;
  const heightOf = (column: Component[]) => column.reduce((h, c) => h + size(c).height + GAP_Y, -GAP_Y);
  const tallest = Math.max(...columns.map(heightOf));
  const rowOf = new Map<string, number>();
  const placed = new Map<string, Component>();
  let x = 0;
  columns.forEach((column, index) => {
    const weight = (c: Component) => {
      const rows = (drivers.get(c.id) ?? []).map(d => rowOf.get(d)).filter((r): r is number => r !== undefined);
      return rows.length === 0 ? 0 : rows.reduce((a, r) => a + r, 0) / rows.length;
    };
    const ordered = index === 0 ? column : [...column].sort((a, b) => weight(a) - weight(b));
    let y = Math.round((tallest - heightOf(column)) / 2);
    for (const c of ordered) {
      const { height } = size(c);
      rowOf.set(c.id, y + height / 2);
      placed.set(c.id, { ...c, x, y });
      y += height + GAP_Y;
    }
    x += Math.max(0, ...column.map(c => size(c).width)) + GAP_X;
  });
  return { ...circuit, components: circuit.components.map(c => placed.get(c.id)!) };
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/** A decoder's name: `decoder 4→16`. */
export const decoderName = (bits: number) => `decoder ${bits}→${1 << bits}`;

/**
 * An n → 2ⁿ decoder with no enable: `Y` has bit `A` high and only that
 * one. Up to two bits, from the address bits and their complements
 * directly; above that, two smaller decoders for the low and high halves
 * of the address and an AND for every pair — shared partial decoding,
 * which is what keeps a 7 → 128 decode near 150 gates rather than 900.
 * Adds the definition and those it uses to `chips`.
 */
function decoder(bits: number, chips: Record<string, Circuit>): string {
  const name = decoderName(bits);
  if (chips[name] !== undefined) return name;
  const b = new CircuitBuilder();
  // A bus is two bits or more; a one-bit address is a plain pin.
  const input = b.input('A', 0, bits);
  const address = bits > 1 ? b.split('A bits', bits) : null;
  if (address !== null) b.connect(input, { component: address, pin: 'in' });
  const outputs = 1 << bits;
  const y = b.join('Y bits', outputs);
  const bit = (i: number): PinRef => (address === null ? input : { component: address, pin: `b${i}` });
  if (bits <= 2) {
    const low = Array.from({ length: bits }, (_, i) => b.not(bit(i), `not a${i}`));
    for (let n = 0; n < outputs; n++) {
      const literal = (i: number) => ((n >> i) & 1 ? bit(i) : low[i]!);
      const line = bits === 1 ? literal(0) : b.and(literal(0), literal(1), `y${n}`);
      b.connect(line, { component: y, pin: `b${n}` });
    }
  } else {
    const lowBits = Math.floor(bits / 2);
    const highBits = bits - lowBits;
    const lowName = decoder(lowBits, chips);
    const highName = decoder(highBits, chips);
    const low = b.chip('low', lowName);
    const high = b.chip('high', highName);
    // Each half of the address to its decoder: through a join, or
    // straight there when it is one bit.
    const feed = (from: number, count: number, chip: string, label: string) => {
      if (count === 1) {
        b.connect(bit(from), { component: chip, pin: 'A' });
        return;
      }
      const join = b.join(label, count);
      for (let i = 0; i < count; i++) b.connect(bit(from + i), { component: join, pin: `b${i}` });
      b.connect({ component: join, pin: 'out' }, { component: chip, pin: 'A' });
    };
    feed(0, lowBits, low, 'low address');
    feed(lowBits, highBits, high, 'high address');
    const lowLines = b.split('low lines', 1 << lowBits);
    const highLines = b.split('high lines', 1 << highBits);
    b.connect({ component: low, pin: 'Y' }, { component: lowLines, pin: 'in' });
    b.connect({ component: high, pin: 'Y' }, { component: highLines, pin: 'in' });
    for (let n = 0; n < outputs; n++) {
      const line = b.and(
        { component: lowLines, pin: `b${n & ((1 << lowBits) - 1)}` },
        { component: highLines, pin: `b${n >> lowBits}` },
        `y${n}`
      );
      b.connect(line, { component: y, pin: `b${n}` });
    }
  }
  b.output('Y', { component: y, pin: 'out' }, outputs);
  chips[name] = b.build();
  return name;
}

// ---------------------------------------------------------------------------
// OR trees
// ---------------------------------------------------------------------------

export const orTreeName = (inputs: number, width: number) => `or ${inputs} ×${width}`;

/**
 * `inputs` buses of `width` bits ORed bit by bit into `Y`: a balanced
 * tree of two-input ORs a bit, `(inputs − 1) × width` gates. The read
 * path of a RAM is this and an AND a byte.
 */
function orTree(inputs: number, width: number, chips: Record<string, Circuit>): string {
  const name = orTreeName(inputs, width);
  if (chips[name] !== undefined) return name;
  const b = new CircuitBuilder();
  const buses = Array.from({ length: inputs }, (_, i) => {
    const bits = b.split(`I${i} bits`, width);
    b.connect(b.input(`I${i}`, 0, width), { component: bits, pin: 'in' });
    return bits;
  });
  const y = b.join('Y bits', width);
  for (let bit = 0; bit < width; bit++) {
    let level: PinRef[] = buses.map(bus => ({ component: bus, pin: `b${bit}` }));
    while (level.length > 1) {
      const next: PinRef[] = [];
      for (let i = 0; i + 1 < level.length; i += 2) next.push(b.or(level[i]!, level[i + 1]!));
      if (level.length % 2 === 1) next.push(level[level.length - 1]!);
      level = next;
    }
    b.connect(level[0]!, { component: y, pin: `b${bit}` });
  }
  b.output('Y', { component: y, pin: 'out' }, width);
  chips[name] = b.build();
  return name;
}

// ---------------------------------------------------------------------------
// RAM
// ---------------------------------------------------------------------------

/** Bytes a RAM row holds: the low four address bits pick one. */
export const ROW_BYTES = 16;

export const ramName = (bytes: number) => `RAM ${bytes}`;

/**
 * An N-byte RAM, N a power of two from 16 to 256.
 *
 * Pins: `A` the address, `D` the byte to write, `we` write enable, `rst`
 * reset in; `Q` the addressed byte out.
 *
 *   - **Reading** is combinational: `Q` is the byte at `A`, always.
 *   - **Writing**: while `we` is high the byte at `A` follows `D`, and it
 *     holds what `D` was when `we` falls. `we` must rise only after `A`
 *     and `D` are steady, and fall before they change — a decoder
 *     glitching while `we` is high writes the wrong byte.
 *   - **Reset**: while `rst` is high every byte is opened and written 0,
 *     which is how the CPU's reset clears RAM, as `ISA.md` says it does.
 *
 * Built as a person would draw it, so each level opens onto the next:
 *
 *   - `RAM byte` — eight library D latches, their enable
 *     `(sel · we) + rst`, and eight ANDs putting the byte on `Q` only
 *     while `sel` is high. 42 gates.
 *   - `RAM row` — sixteen bytes, each selected by its column line and
 *     the row's line, and an OR tree gathering their `Q`s.
 *   - `RAM N` — the address split into row and column bits, a decoder
 *     for each, the rows, and an OR tree across the rows. `D` is ANDed
 *     with `¬rst`, so a reset writes zeros.
 */
export function ram(bytes = 128): Generated {
  const rows = bytes / ROW_BYTES;
  const rowBits = Math.log2(rows);
  if (!Number.isInteger(rowBits) || rowBits < 0 || rowBits > 4) {
    throw new Error(`A RAM is 16, 32, 64, 128 or 256 bytes, not ${bytes}.`);
  }
  const addressBits = 4 + rowBits;
  const lib = library();
  const chips: Record<string, Circuit> = { 'D latch': lib['D latch'] };

  // RAM byte
  {
    const b = new CircuitBuilder();
    const d = b.split('D bits', 8);
    b.connect(b.input('D', 0, 8), { component: d, pin: 'in' });
    const sel = b.input('sel');
    const enable = b.or(b.and(sel, b.input('we'), 'write'), b.input('rst'), 'enable');
    const q = b.join('Q bits', 8);
    for (let bit = 0; bit < 8; bit++) {
      const latch = b.chip(`bit ${bit}`, 'D latch');
      b.connect({ component: d, pin: `b${bit}` }, { component: latch, pin: 'd' });
      b.connect(enable, { component: latch, pin: 'en' });
      b.connect(b.and({ component: latch, pin: 'q' }, sel, `read ${bit}`), { component: q, pin: `b${bit}` });
    }
    b.output('Q', { component: q, pin: 'out' }, 8);
    chips['RAM byte'] = b.build();
  }

  const columns = decoder(4, chips);
  const rowTree = orTree(ROW_BYTES, 8, chips);

  // RAM row
  {
    const b = new CircuitBuilder();
    const columnLines = b.split('column lines', ROW_BYTES);
    b.connect(b.input('C', 0, ROW_BYTES), { component: columnLines, pin: 'in' });
    const row = b.input('row');
    const d = b.input('D', 0, 8);
    const we = b.input('we');
    const rst = b.input('rst');
    const tree = b.chip('read', rowTree);
    for (let n = 0; n < ROW_BYTES; n++) {
      const byte = b.chip(`byte ${n}`, 'RAM byte');
      b.connect(d, { component: byte, pin: 'D' });
      b.connect(b.and({ component: columnLines, pin: `b${n}` }, row, `sel ${n}`), { component: byte, pin: 'sel' });
      b.connect(we, { component: byte, pin: 'we' });
      b.connect(rst, { component: byte, pin: 'rst' });
      b.connect({ component: byte, pin: 'Q' }, { component: tree, pin: `I${n}` });
    }
    b.output('Q', { component: tree, pin: 'Y' }, 8);
    chips['RAM row'] = b.build();
  }

  // RAM N
  const b = new CircuitBuilder();
  const address = b.split('A bits', addressBits);
  b.connect(b.input('A', 0, addressBits), { component: address, pin: 'in' });
  const dIn = b.split('D bits', 8);
  b.connect(b.input('D', 0, 8), { component: dIn, pin: 'in' });
  const we = b.input('we');
  const rst = b.input('rst');
  const keep = b.not(rst, 'not rst');
  const d = b.join('written', 8);
  for (let bit = 0; bit < 8; bit++) {
    b.connect(b.and({ component: dIn, pin: `b${bit}` }, keep, `clear ${bit}`), { component: d, pin: `b${bit}` });
  }
  const columnAddress = b.join('column address', 4);
  for (let i = 0; i < 4; i++) b.connect({ component: address, pin: `b${i}` }, { component: columnAddress, pin: `b${i}` });
  const columnDecoder = b.chip('columns', columns);
  b.connect({ component: columnAddress, pin: 'out' }, { component: columnDecoder, pin: 'A' });
  let rowLine: (n: number) => PinRef;
  if (rowBits === 0) {
    const one = b.constant(1, 'one');
    rowLine = () => one;
  } else {
    const rowDecoder = b.chip('rows', decoder(rowBits, chips));
    if (rowBits === 1) {
      b.connect({ component: address, pin: 'b4' }, { component: rowDecoder, pin: 'A' });
    } else {
      const rowAddress = b.join('row address', rowBits);
      for (let i = 0; i < rowBits; i++) b.connect({ component: address, pin: `b${4 + i}` }, { component: rowAddress, pin: `b${i}` });
      b.connect({ component: rowAddress, pin: 'out' }, { component: rowDecoder, pin: 'A' });
    }
    const rowLines = b.split('row lines', rows);
    b.connect({ component: rowDecoder, pin: 'Y' }, { component: rowLines, pin: 'in' });
    rowLine = n => ({ component: rowLines, pin: `b${n}` });
  }
  const tree = rows > 1 ? b.chip('read', orTree(rows, 8, chips)) : null;
  let only: PinRef | null = null;
  for (let r = 0; r < rows; r++) {
    const row = b.chip(`row ${r}`, 'RAM row');
    b.connect({ component: columnDecoder, pin: 'Y' }, { component: row, pin: 'C' });
    b.connect(rowLine(r), { component: row, pin: 'row' });
    b.connect({ component: d, pin: 'out' }, { component: row, pin: 'D' });
    b.connect(we, { component: row, pin: 'we' });
    b.connect(rst, { component: row, pin: 'rst' });
    if (tree !== null) b.connect({ component: row, pin: 'Q' }, { component: tree, pin: `I${r}` });
    else only = { component: row, pin: 'Q' };
  }
  b.output('Q', tree !== null ? { component: tree, pin: 'Y' } : only!, 8);
  return laidOut(b.build(), chips, new Set(Object.keys(chips).filter(name => name !== 'D latch')));
}

// ---------------------------------------------------------------------------
// The register file
// ---------------------------------------------------------------------------

/**
 * The CPU's data registers: one library `register 8` each, sharing `D`
 * and `clk`, each with its own load line, and each with its own output —
 * the datapath reads A, B and X at once (the ALU's two sides and the
 * address adder), so there are no read ports to select between.
 *
 * Pins: `D`, `load A`, `load B`, `load X`… and `clk` in; `A`, `B`, `X`…
 * out. A register takes `D` on the rising edge of `clk` while its load
 * line is high.
 */
export function registerFile(names: readonly string[] = ['A', 'B', 'X']): Generated {
  const chips: Record<string, Circuit> = libraryWithDependencies('register 8');
  const b = new CircuitBuilder();
  const d = b.input('D', 0, 8);
  const loads = names.map(name => b.input(`load ${name}`));
  const clk = b.input('clk');
  names.forEach((name, i) => {
    const register = b.chip(name, 'register 8');
    b.connect(d, { component: register, pin: 'D' });
    b.connect(loads[i]!, { component: register, pin: 'load' });
    b.connect(clk, { component: register, pin: 'clk' });
    b.output(name, { component: register, pin: 'Q' }, 8);
  });
  return laidOut(b.build(), chips, new Set());
}

/** What `scripts/generate.ts` writes, file name by file name, under `circuits/`. */
export function generatedFiles(): Record<string, Generated> {
  return {
    'ram-128.gessologic.json': ram(128),
    'register-file.gessologic.json': registerFile()
  };
}
