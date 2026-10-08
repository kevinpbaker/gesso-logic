import type { Circuit, Component, PinRef } from '../sim/Circuit';
import { pinsOf } from '../sim/Chips';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { ALU_OP, EXECUTE, RIGHT, type Lines } from '../cpu/Control';
import { INSTRUCTIONS } from '../cpu/Isa';
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
    // Switches and LEDs stay in the order they were made: it is the
    // order of the pins down the sides of the chip they make.
    const ordered = index === 0 || index === columns.length - 1 ? column : [...column].sort((a, b) => weight(a) - weight(b));
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
  b.describe({
    A: 'Which output bit to raise',
    Y: 'Only bit A is 1'
  });
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
  b.describe({
    ...Object.fromEntries(Array.from({ length: inputs }, (_, i) => [`I${i}`, 'A word to OR in: most often 0, or the one value let through'])),
    Y: 'Every input ORed together, bit by bit'
  });
  chips[name] = b.build();
  return name;
}

// ---------------------------------------------------------------------------
// RAM
// ---------------------------------------------------------------------------

/** Bytes a RAM row holds: the low four address bits pick one. */
export const ROW_BYTES = 16;

export const ramName = (bytes: number) => `RAM ${bytes}`;

/** The framebuffer's size: 32 × 16 pixels, a bit each. */
export const SCREEN_BYTES = 64;

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
export function ram(bytes = 128, screenFrom?: number): Generated {
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
    const p = b.join('P bits', 8);
    for (let bit = 0; bit < 8; bit++) {
      const latch = b.chip(`bit ${bit}`, 'D latch');
      b.connect({ component: d, pin: `b${bit}` }, { component: latch, pin: 'd' });
      b.connect(enable, { component: latch, pin: 'en' });
      b.connect(b.and({ component: latch, pin: 'q' }, sel, `read ${bit}`), { component: q, pin: `b${bit}` });
      b.connect({ component: latch, pin: 'q' }, { component: p, pin: `b${bit}` });
    }
    b.output('Q', { component: q, pin: 'out' }, 8);
    // The latches themselves, always: what a framebuffer's pixels are.
    b.output('P', { component: p, pin: 'out' }, 8);
    b.describe({
      D: 'The byte to write',
      sel: '1 when the address picks this byte',
      we: 'Write enable: while 1 (and sel is 1) the byte follows D',
      rst: 'Reset: while 1 the byte takes D whatever sel is; the RAM holds D at 0 then, so this clears it',
      Q: 'The byte, while sel is 1; 0 otherwise',
      P: 'The byte, always: what the screen shows'
    });
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
    const bytesOfRow: string[] = [];
    for (let n = 0; n < ROW_BYTES; n++) {
      const byte = b.chip(`byte ${n}`, 'RAM byte');
      b.connect(d, { component: byte, pin: 'D' });
      b.connect(b.and({ component: columnLines, pin: `b${n}` }, row, `sel ${n}`), { component: byte, pin: 'sel' });
      b.connect(we, { component: byte, pin: 'we' });
      b.connect(rst, { component: byte, pin: 'rst' });
      b.connect({ component: byte, pin: 'Q' }, { component: tree, pin: `I${n}` });
      bytesOfRow.push(byte);
    }
    b.output('Q', { component: tree, pin: 'Y' }, 8);
    // Four bytes at a time, as 32-bit buses: a framebuffer's rows.
    for (let group = 0; group < ROW_BYTES / 4; group++) {
      const pixels = b.join(`P${group} bits`, 32);
      for (let k = 0; k < 4; k++) {
        const split = b.split(`byte ${group * 4 + k} bits`, 8);
        b.connect({ component: bytesOfRow[group * 4 + k]!, pin: 'P' }, { component: split, pin: 'in' });
        for (let bit = 0; bit < 8; bit++) b.connect({ component: split, pin: `b${bit}` }, { component: pixels, pin: `b${k * 8 + bit}` });
      }
      b.output(`P${group}`, { component: pixels, pin: 'out' }, 32);
    }
    b.describe({
      C: 'Column lines: one bit high, picking a byte in the row',
      row: '1 when the address is in this row',
      D: 'The byte to write',
      we: 'Write enable',
      rst: 'Reset: clears every byte',
      Q: 'The byte the address picks, when it is in this row; 0 otherwise',
      ...Object.fromEntries(Array.from({ length: ROW_BYTES / 4 }, (_, g) => [`P${g}`, `Bytes ${4 * g}–${4 * g + 3} of the row, always: 32 pixels`]))
    });
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
  const rowChips: string[] = [];
  for (let r = 0; r < rows; r++) {
    const row = b.chip(`row ${r}`, 'RAM row');
    rowChips.push(row);
    b.connect({ component: columnDecoder, pin: 'Y' }, { component: row, pin: 'C' });
    b.connect(rowLine(r), { component: row, pin: 'row' });
    b.connect({ component: d, pin: 'out' }, { component: row, pin: 'D' });
    b.connect(we, { component: row, pin: 'we' });
    b.connect(rst, { component: row, pin: 'rst' });
    if (tree !== null) b.connect({ component: row, pin: 'Q' }, { component: tree, pin: `I${r}` });
    else only = { component: row, pin: 'Q' };
  }
  b.output('Q', tree !== null ? { component: tree, pin: 'Y' } : only!, 8);
  if (screenFrom !== undefined) {
    // The framebuffer: from `screenFrom`, four bytes a row of pixels,
    // sixteen rows, straight off the latches.
    if (screenFrom % 4 !== 0 || screenFrom + SCREEN_BYTES > bytes) {
      throw new Error(`A screen of ${SCREEN_BYTES} bytes can't start at 0x${screenFrom.toString(16)} in ${bytes} bytes.`);
    }
    for (let y = 0; y < SCREEN_BYTES / 4; y++) {
      const first = screenFrom + 4 * y;
      b.output(`F${y}`, { component: rowChips[Math.floor(first / ROW_BYTES)]!, pin: `P${(first % ROW_BYTES) / 4}` }, 32);
    }
  }
  b.describe({
    A: `The address: which of the ${bytes} bytes Q reads and a write writes`,
    D: 'The byte to write',
    we: 'Write enable: while 1 the byte at A follows D, and keeps it when this falls',
    rst: 'Reset: while 1 every byte is cleared to 0',
    Q: 'The byte at address A',
    ...(screenFrom === undefined
      ? {}
      : Object.fromEntries(Array.from({ length: SCREEN_BYTES / 4 }, (_, y) => [`F${y}`, `Row ${y} of the screen: the four bytes from 0x${(screenFrom + 4 * y).toString(16).toUpperCase()}`])))
  });
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
  b.describe({
    D: 'The byte a register takes when its load line is 1',
    ...Object.fromEntries(names.map(name => [`load ${name}`, `1 to store D in ${name} on the next rising clock edge`])),
    clk: 'Clock: registers change only as this rises',
    ...Object.fromEntries(names.map(name => [name, `What register ${name} holds`]))
  });
  return laidOut(b.build(), chips, new Set());
}

// ---------------------------------------------------------------------------
// The ALU
// ---------------------------------------------------------------------------

/** Joins eight single-bit pins into a bus. */
function bus(b: CircuitBuilder, label: string, bits: readonly PinRef[]): PinRef {
  const join = b.join(label, bits.length);
  bits.forEach((bit, i) => b.connect(bit, { component: join, pin: `b${i}` }));
  return { component: join, pin: 'out' };
}

/** A bus's bits, through a split. */
function bitsOf(b: CircuitBuilder, label: string, source: PinRef, width = 8): PinRef[] {
  const split = b.split(label, width);
  b.connect(source, { component: split, pin: 'in' });
  return Array.from({ length: width }, (_, i) => ({ component: split, pin: `b${i}` }));
}

/**
 * The ALU: `L` and `R` in, `op` choosing what to do with them (the codes
 * are `ALU_OP` in `src/cpu/Control.ts`), `Y` out with the flags it would
 * set — `C`, `Z`, `N`. Whether they are kept is the flags register's
 * business, not the ALU's.
 *
 *   - `op` is decoded to one line an operation.
 *   - One library adder/subtractor does ADD, SUB (and CMP), INC and DEC:
 *     for the last two its right side is forced to 1, which costs nine
 *     gates where a mux would cost 32.
 *   - AND, OR and XOR are a gate a bit; the shifts are wiring.
 *   - `Y` is each result gated by its operation's line, and ORed.
 *   - `C` is the adder's carry for ADD and SUB, the bit shifted out for
 *     SHL and SHR; `Z` is a NOR of `Y`, `N` its top bit.
 */
function alu(chips: Record<string, Circuit>): string {
  const name = 'ALU';
  if (chips[name] !== undefined) return name;
  Object.assign(chips, libraryWithDependencies('add/sub 8'));
  const lines = decoder(4, chips);
  const gather = orTree(8, 8, chips);
  const b = new CircuitBuilder();
  const l = bitsOf(b, 'L bits', b.input('L', 0, 8));
  const r = bitsOf(b, 'R bits', b.input('R', 0, 8));
  const decode = b.chip('decode', lines);
  b.connect(b.input('op', 0, 4), { component: decode, pin: 'A' });
  const line = bitsOf(b, 'op lines', { component: decode, pin: 'Y' }, 16);
  const [add, sub, and, or, xor, passR, passL, inc, dec, shl, shr] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => line[i]!);

  // The adder: right side R, or 1 for INC and DEC.
  const one = b.or(inc!, dec!, 'inc or dec');
  const notOne = b.not(one, 'not inc/dec');
  const adderRight = bus(b, 'adder right', r.map((bit, i) => (i === 0 ? b.or(bit, one, 'one') : b.and(bit, notOne, `r${i} or 0`))));
  const adder = b.chip('adder', 'add/sub 8');
  b.connect(bus(b, 'adder left', l), { component: adder, pin: 'A' });
  b.connect(adderRight, { component: adder, pin: 'B' });
  b.connect(b.or(sub!, dec!, 'subtract'), { component: adder, pin: 'sub' });
  const sum = bitsOf(b, 'sum bits', { component: adder, pin: 'S' });
  const arithmetic = b.or(b.or(add!, sub!, 'add or sub'), one, 'arithmetic');

  // Each operation's result, gated by its line.
  const gated = (label: string, select: PinRef, bit: (i: number) => PinRef | null) =>
    bus(
      b,
      label,
      Array.from({ length: 8 }, (_, i) => {
        const value = bit(i);
        return value === null ? b.constant(0, `${label} ${i}`) : b.and(value, select, `${label} ${i}`);
      })
    );
  const results = [
    gated('sum', arithmetic, i => sum[i]!),
    gated('and', and!, i => b.and(l[i]!, r[i]!, `l and r ${i}`)),
    gated('or', or!, i => b.or(l[i]!, r[i]!, `l or r ${i}`)),
    gated('xor', xor!, i => b.xor(l[i]!, r[i]!, `l xor r ${i}`)),
    gated('R', passR!, i => r[i]!),
    gated('L', passL!, i => l[i]!),
    gated('shl', shl!, i => (i === 0 ? null : l[i - 1]!)),
    gated('shr', shr!, i => (i === 7 ? null : l[i + 1]!))
  ];
  const tree = b.chip('result', gather);
  results.forEach((result, i) => b.connect(result, { component: tree, pin: `I${i}` }));
  const y = bitsOf(b, 'Y bits', { component: tree, pin: 'Y' });
  b.output('Y', { component: tree, pin: 'Y' }, 8);

  const carry = b.or(
    b.or(b.and({ component: adder, pin: 'cout' }, b.or(add!, sub!, 'add or sub?'), 'adder carry'), b.and(l[7]!, shl!, 'shl carry'), 'carries'),
    b.and(l[0]!, shr!, 'shr carry'),
    'carry'
  );
  b.output('C', carry);
  let any = y[0]!;
  for (let i = 1; i < 8; i++) any = b.or(any, y[i]!, `any ${i}`);
  b.output('Z', b.not(any, 'zero'));
  b.output('N', y[7]!);
  b.describe({
    L: 'Left operand: A or X, as the datapath’s left line picks',
    R: 'Right operand: K, B, M or 0, as the datapath’s right lines pick',
    op: 'Operation: 0 ADD, 1 SUB, 2 AND, 3 OR, 4 XOR, 5 pass R, 6 pass L, 7 INC, 8 DEC, 9 SHL, 10 SHR',
    Y: 'The result',
    C: 'Carry: out of ADD, not-borrow from SUB, or the bit a shift pushed out',
    Z: 'Zero: 1 when Y is 0',
    N: 'Negative: the top bit of Y'
  });
  chips[name] = b.build();
  return name;
}

// ---------------------------------------------------------------------------
// The datapath
// ---------------------------------------------------------------------------

/**
 * The CPU's datapath: every register and everything between them, with
 * a pin for each control line (`Lines` in `src/cpu/Control.ts`), so a
 * person can drive it from switches — Phase 15 — and the control unit
 * can drive it from gates — Phase 16.
 *
 * In: `I` the ROM word at `PC`; `M` the data byte the memory system puts
 * up (RAM, a ROM table byte or a port, as the control unit says); the
 * control lines; `rst`; `clk`. Out: `PC` for the ROM; `OP` and `K`, the
 * instruction register's two bytes, for the control unit; `ADDR` the data
 * address; `A` (also the data written to RAM and ports), `B`, `X`, `L`;
 * the flags.
 *
 *   - **IR** is two library registers, loaded from `I` on `ir`.
 *   - **A, B, X** are the generated register file, all loaded from the
 *     ALU's `Y`.
 *   - **The ALU** takes A or X on the left (`left`), and on the right K,
 *     B, M or 0 (`right`).
 *   - **The flags** are three flip-flops: Z and N load on `lzn`, C on
 *     `lc`.
 *   - **PC** is a library counter: `inc` counts, `jump` loads K — or L,
 *     with `ret`. **L** loads PC on `link`.
 *   - **ADDR** is K, or K + X from an adder of its own on `index`.
 *   - **Reset is synchronous:** while `rst` is high, a clock edge loads 0
 *     into every register and flag.
 */
export function datapath(): Generated {
  const chips: Record<string, Circuit> = {
    ...libraryWithDependencies('register 8'),
    ...libraryWithDependencies('counter 8'),
    ...libraryWithDependencies('mux 2 ×8'),
    ...libraryWithDependencies('mux 4 ×8'),
    ...libraryWithDependencies('add/sub 8')
  };
  const generated = new Set<string>();
  const before = new Set(Object.keys(chips));
  alu(chips);
  const { chips: fileChips, ...file } = registerFile();
  Object.assign(chips, fileChips);
  chips['register file'] = file as Circuit;

  // Clear ×8: a byte, or 0 while rst is high — what a register loads on reset.
  {
    const b = new CircuitBuilder();
    const d = bitsOf(b, 'D bits', b.input('D', 0, 8));
    const keep = b.not(b.input('rst'), 'not rst');
    b.output('Y', bus(b, 'Y bits', d.map((bit, i) => b.and(bit, keep, `bit ${i}`))), 8);
    b.describe({ D: 'The byte to pass on', rst: 'Reset: while 1, Y is 0', Y: 'D, or 0 while rst is 1' });
    chips['clear ×8'] = b.build();
  }
  // Flags: Z, C and N, each held, loaded, or cleared on reset.
  {
    const b = new CircuitBuilder();
    const inputs = { Z: b.input('Z in'), C: b.input('C in'), N: b.input('N in') };
    const lzn = b.input('lzn');
    const lc = b.input('lc');
    const rst = b.input('rst');
    const clk = b.input('clk');
    const keep = b.not(rst, 'not rst');
    for (const flag of ['Z', 'C', 'N'] as const) {
      const ff = b.chip(`${flag} flag`, 'D flip-flop');
      const choose = b.chip(`${flag} next`, 'mux 2');
      b.connect({ component: ff, pin: 'q' }, { component: choose, pin: 'a' });
      b.connect(inputs[flag], { component: choose, pin: 'b' });
      b.connect(flag === 'C' ? lc : lzn, { component: choose, pin: 's' });
      b.connect(b.and({ component: choose, pin: 'y' }, keep, `${flag} or reset`), { component: ff, pin: 'd' });
      b.connect(clk, { component: ff, pin: 'clk' });
      b.output(flag, { component: ff, pin: 'q' });
    }
    b.describe({
      'Z in': 'The ALU’s Z, kept on the clock edge while lzn is 1',
      'C in': 'The ALU’s C, kept on the clock edge while lc is 1',
      'N in': 'The ALU’s N, kept on the clock edge while lzn is 1',
      lzn: 'Load Z and N from the ALU on the next rising clock edge',
      lc: 'Load C from the ALU on the next rising clock edge',
      rst: 'Reset: clears every flag on the next rising clock edge',
      clk: 'Clock: flags change only as this rises',
      Z: 'Zero flag: the last result kept was 0',
      C: 'Carry flag',
      N: 'Negative flag: the last result kept had its top bit set'
    });
    chips.flags = b.build();
  }
  for (const name of Object.keys(chips)) if (!before.has(name)) generated.add(name);
  generated.delete('register file');

  const b = new CircuitBuilder();
  const word = bitsOf(b, 'I bits', b.input('I', 0, 16), 16);
  const m = b.input('M', 0, 8);
  const line = (name: string, width = 1) => b.input(name, 0, width);
  const ir = line('ir');
  const inc = line('inc');
  const jump = line('jump');
  const ret = line('ret');
  const link = line('link');
  const la = line('la');
  const lb = line('lb');
  const lx = line('lx');
  const lzn = line('lzn');
  const lc = line('lc');
  const op = line('op', 4);
  const left = line('left');
  const right = line('right', 2);
  const index = line('index');
  const rst = line('rst');
  const clk = line('clk');
  const withReset = (load: PinRef, label: string) => b.or(load, rst, label);
  const cleared = (d: PinRef, label: string) => {
    const clear = b.chip(label, 'clear ×8');
    b.connect(d, { component: clear, pin: 'D' });
    b.connect(rst, { component: clear, pin: 'rst' });
    return { component: clear, pin: 'Y' };
  };
  const register = (label: string, d: PinRef, load: PinRef) => {
    const reg = b.chip(label, 'register 8');
    b.connect(cleared(d, `${label} in`), { component: reg, pin: 'D' });
    b.connect(withReset(load, `${label} load`), { component: reg, pin: 'load' });
    b.connect(clk, { component: reg, pin: 'clk' });
    return { component: reg, pin: 'Q' };
  };

  // IR
  const opcode = register('IR op', bus(b, 'op byte', word.slice(8)), ir);
  const k = register('IR k', bus(b, 'k byte', word.slice(0, 8)), ir);

  // A, B, X, from the ALU.
  const regs = b.chip('registers', 'register file');
  const theAlu = b.chip('alu', 'ALU');
  const y = { component: theAlu, pin: 'Y' };
  b.connect(cleared(y, 'Y in'), { component: regs, pin: 'D' });
  b.connect(withReset(la, 'A load'), { component: regs, pin: 'load A' });
  b.connect(withReset(lb, 'B load'), { component: regs, pin: 'load B' });
  b.connect(withReset(lx, 'X load'), { component: regs, pin: 'load X' });
  b.connect(clk, { component: regs, pin: 'clk' });
  const a = { component: regs, pin: 'A' };
  const x = { component: regs, pin: 'X' };
  const regB = { component: regs, pin: 'B' };

  const leftMux = b.chip('left', 'mux 2 ×8');
  b.connect(a, { component: leftMux, pin: 'A' });
  b.connect(x, { component: leftMux, pin: 'B' });
  b.connect(left, { component: leftMux, pin: 's' });
  const rightMux = b.chip('right', 'mux 4 ×8');
  b.connect(k, { component: rightMux, pin: 'A' });
  b.connect(regB, { component: rightMux, pin: 'B' });
  b.connect(m, { component: rightMux, pin: 'C' });
  b.connect(b.constant(0, 'zero', 8), { component: rightMux, pin: 'D' });
  b.connect(right, { component: rightMux, pin: 'S' });
  b.connect({ component: leftMux, pin: 'Y' }, { component: theAlu, pin: 'L' });
  b.connect({ component: rightMux, pin: 'Y' }, { component: theAlu, pin: 'R' });
  b.connect(op, { component: theAlu, pin: 'op' });

  // Flags
  const flags = b.chip('flags', 'flags');
  for (const flag of ['Z', 'C', 'N']) b.connect({ component: theAlu, pin: flag }, { component: flags, pin: `${flag} in` });
  b.connect(lzn, { component: flags, pin: 'lzn' });
  b.connect(lc, { component: flags, pin: 'lc' });
  b.connect(rst, { component: flags, pin: 'rst' });
  b.connect(clk, { component: flags, pin: 'clk' });

  // PC and L
  const pc = b.chip('PC', 'counter 8');
  const pcSource = b.chip('PC source', 'mux 2 ×8');
  b.connect(k, { component: pcSource, pin: 'A' });
  b.connect(ret, { component: pcSource, pin: 's' });
  b.connect({ component: pcSource, pin: 'Y' }, { component: pc, pin: 'D' });
  b.connect(rst, { component: pc, pin: 'clr' });
  b.connect(jump, { component: pc, pin: 'load' });
  b.connect(inc, { component: pc, pin: 'inc' });
  b.connect(clk, { component: pc, pin: 'clk' });
  const pcOut = { component: pc, pin: 'Q' };
  const l = register('L', pcOut, link);
  b.connect(l, { component: pcSource, pin: 'B' });

  // The data address
  const indexAdder = b.chip('K + X', 'add/sub 8');
  b.connect(k, { component: indexAdder, pin: 'A' });
  b.connect(x, { component: indexAdder, pin: 'B' });
  b.connect(b.constant(0, 'add'), { component: indexAdder, pin: 'sub' });
  const address = b.chip('address', 'mux 2 ×8');
  b.connect(k, { component: address, pin: 'A' });
  b.connect({ component: indexAdder, pin: 'S' }, { component: address, pin: 'B' });
  b.connect(index, { component: address, pin: 's' });

  b.output('PC', pcOut, 8);
  b.output('OP', opcode, 8);
  b.output('K', k, 8);
  b.output('ADDR', { component: address, pin: 'Y' }, 8);
  b.output('A', a, 8);
  b.output('B', regB, 8);
  b.output('X', x, 8);
  b.output('L', l, 8);
  for (const flag of ['Z', 'C', 'N']) b.output(flag, { component: flags, pin: flag });
  b.describe({
    I: 'The 16-bit instruction word the ROM has at PC',
    M: 'The data byte read: from RAM, a ROM table or a port',
    ir: 'Fetch: load the instruction register from I',
    inc: 'Count PC up by one',
    jump: 'Load PC from K, or from L when ret is 1',
    ret: 'Return: a jump takes PC from L, not K',
    link: 'Save PC in L, for a call to return to',
    la: 'Load A with the ALU’s result',
    lb: 'Load B with the ALU’s result',
    lx: 'Load X with the ALU’s result',
    lzn: 'Keep the ALU’s Z and N flags',
    lc: 'Keep the ALU’s C flag',
    op: 'ALU operation: 0 ADD, 1 SUB, 2 AND, 3 OR, 4 XOR, 5 pass R, 6 pass L, 7 INC, 8 DEC, 9 SHL, 10 SHR',
    left: 'ALU left operand: 0 A, 1 X',
    right: 'ALU right operand: 0 K, 1 B, 2 M, 3 zero',
    index: 'Data address is K + X, not K',
    rst: 'Reset: zeroes every register and flag on the next clock edge',
    clk: 'Clock: registers change only as this rises',
    PC: 'Program counter: the address of the next instruction',
    OP: 'Opcode: the instruction’s high byte',
    K: 'Operand: the instruction’s low byte',
    ADDR: 'The data address: K, or K + X',
    A: 'Register A, the accumulator: also the byte stores and OUT write',
    B: 'Register B',
    X: 'Register X, the index register',
    L: 'Link register: where RET returns to',
    Z: 'Zero flag',
    C: 'Carry flag',
    N: 'Negative flag'
  });
  // The register file is generated too; it lays out as the generator
  // left it, like a library part.
  const done = laidOut(b.build(), chips, generated);
  return { ...done, chips: { ...done.chips, 'register file': file as Circuit } };
}

// ---------------------------------------------------------------------------
// The control unit
// ---------------------------------------------------------------------------

/** ORs a list of pins as a balanced tree; none is a constant 0. */
function any(b: CircuitBuilder, pins: readonly PinRef[], label: string): PinRef {
  if (pins.length === 0) return b.constant(0, `${label} (none)`);
  let level = [...pins];
  let n = 0;
  while (level.length > 1) {
    const next: PinRef[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(b.or(level[i]!, level[i + 1]!, `${label} ${n++}`));
    if (level.length % 2 === 1) next.push(level[level.length - 1]!);
    level = next;
  }
  return level[0]!;
}

/**
 * The control unit, hardwired from the control table (`src/cpu/Control.ts`):
 * opcode decode crossed with a cycle counter, one row an opcode.
 *
 *   - **step** is a flip-flop: fetch, then execute, then fetch. `rst`
 *     puts it at fetch.
 *   - **halted** is a flip-flop set by executing `HLT` and cleared by
 *     `rst`; while it is set every line is low and step stands still.
 *   - **Decode:** two 4 → 16 decoders on the opcode's nibbles, and an AND
 *     for each opcode the ISA defines. A reserved opcode raises nothing.
 *   - **Each line** is the OR of the opcodes whose row raises it, ANDed
 *     with execute; `ir` and `inc` are fetch itself. `op` and `right` are
 *     each bit's OR. `jump` is each jump's opcode ANDed with its flag.
 *   - **`we` and `out`** are the store and port-write lines ANDed with
 *     the clock being low: a strobe in the second half of the execute
 *     cycle, after the address and data have settled and before the
 *     clock edge that moves them.
 */
export function controlUnit(chips: Record<string, Circuit> = {}): string {
  const name = 'control unit';
  if (chips[name] !== undefined) return name;
  Object.assign(chips, libraryWithDependencies('D flip-flop'));
  const nibbles = decoder(4, chips);
  const b = new CircuitBuilder();
  const opcode = bitsOf(b, 'OP bits', b.input('OP', 0, 8));
  const z = b.input('Z');
  const c = b.input('C');
  const n = b.input('N');
  const rst = b.input('rst');
  const clk = b.input('clk');
  const keep = b.not(rst, 'not rst');

  // step and halted
  const stepFf = b.chip('step', 'D flip-flop');
  const haltedFf = b.chip('halted', 'D flip-flop');
  const step = { component: stepFf, pin: 'q' };
  const halted = { component: haltedFf, pin: 'q' };
  const running = { component: haltedFf, pin: 'qn' };
  const fetch = b.and({ component: stepFf, pin: 'qn' }, running, 'fetch');
  const execute = b.and(step, running, 'execute');

  // Decode
  const decodeNibble = (from: number, label: string) => {
    const d = b.chip(label, nibbles);
    b.connect(bus(b, `${label} nibble`, opcode.slice(from, from + 4)), { component: d, pin: 'A' });
    return bitsOf(b, `${label} lines`, { component: d, pin: 'Y' }, 16);
  };
  const low = decodeNibble(0, 'low');
  const high = decodeNibble(4, 'high');
  const lineOf = new Map<number, PinRef>();
  for (const instruction of INSTRUCTIONS) {
    const code = instruction.opcode;
    lineOf.set(code, b.and(high[code >> 4]!, low[code & 15]!, `${instruction.mnemonic} ${instruction.mode}`));
  }
  const opcodesWhere = (test: (lines: Lines) => boolean) => INSTRUCTIONS.filter(i => test(EXECUTE.get(i.opcode)!)).map(i => lineOf.get(i.opcode)!);
  const executed = (test: (lines: Lines) => boolean, label: string) => b.and(any(b, opcodesWhere(test), label), execute, label);

  // halted's next state: set by HLT, held once set, cleared by reset.
  const halting = b.or(halted, b.and(execute, lineOf.get(0x00)!, 'HLT now'), 'halt');
  b.connect(b.and(halting, keep, 'halt or reset'), { component: haltedFf, pin: 'd' });

  const outputs: [string, PinRef, number?][] = [];
  outputs.push(['ir', fetch], ['inc', fetch]);
  const flag = { Z: z, C: c, N: n } as const;
  const notFlag = { Z: b.not(z, 'not Z'), C: b.not(c, 'not C'), N: b.not(n, 'not N') } as const;
  const jumps = INSTRUCTIONS.flatMap(i => {
    const condition = EXECUTE.get(i.opcode)!.jump;
    if (condition === undefined) return [];
    const line = lineOf.get(i.opcode)!;
    if (condition === 'always') return [line];
    const holds = condition.startsWith('N') && condition.length === 2 ? notFlag[condition[1] as 'Z' | 'C' | 'N'] : flag[condition as 'Z' | 'C' | 'N'];
    return [b.and(line, holds, `${i.mnemonic} taken`)];
  });
  outputs.push(['jump', b.and(any(b, jumps, 'jump'), execute, 'jump')]);
  for (const line of ['ret', 'link', 'la', 'lb', 'lx', 'lzn', 'lc'] as const) outputs.push([line, executed(l => l[line] === true, line)]);
  const opBits = [0, 1, 2, 3].map(bit => executed(l => l.op !== undefined && ((ALU_OP[l.op] >> bit) & 1) === 1, `op${bit}`));
  outputs.push(['op', bus(b, 'op bus', opBits), 4]);
  outputs.push(['left', executed(l => l.left === 'X', 'left')]);
  const rightBits = [0, 1].map(bit => executed(l => ((RIGHT[l.right ?? 'ZERO'] >> bit) & 1) === 1, `right${bit}`));
  outputs.push(['right', bus(b, 'right bus', rightBits), 2]);
  outputs.push(['index', executed(l => l.index === true, 'index')]);
  const clockLow = b.not(clk, 'clock low');
  outputs.push(['we', b.and(executed(l => l.store === true, 'store'), clockLow, 'we')]);
  outputs.push(['out', b.and(executed(l => l.out === true, 'port write'), clockLow, 'out')]);
  outputs.push(['table', executed(l => l.source === 'table', 'table')]);
  outputs.push(['port', executed(l => l.source === 'port', 'port')]);
  outputs.push(['halted', halted]);

  // step's next state: toggles while running, holds while halted, 0 on reset.
  b.connect(b.and(b.xor(step, running, 'step next'), keep, 'step or reset'), { component: stepFf, pin: 'd' });
  b.connect(clk, { component: stepFf, pin: 'clk' });
  b.connect(clk, { component: haltedFf, pin: 'clk' });
  for (const [label, pin, width] of outputs) b.output(label, pin, width ?? 1);
  b.describe({
    OP: 'The opcode to decode',
    Z: 'Zero flag, for conditional jumps',
    C: 'Carry flag, for conditional jumps',
    N: 'Negative flag, for conditional jumps',
    rst: 'Reset: back to fetch, and not halted',
    clk: 'Clock: each instruction takes two cycles, fetch then execute',
    ir: 'Fetch: load the instruction register',
    inc: 'Count PC up by one',
    jump: 'Load PC: a jump, call or return that is taken',
    ret: 'Return: PC from L, not K',
    link: 'Save PC in L, for a call',
    la: 'Load A with the ALU’s result',
    lb: 'Load B with the ALU’s result',
    lx: 'Load X with the ALU’s result',
    lzn: 'Keep the ALU’s Z and N flags',
    lc: 'Keep the ALU’s C flag',
    op: 'ALU operation: 0 ADD, 1 SUB, 2 AND, 3 OR, 4 XOR, 5 pass R, 6 pass L, 7 INC, 8 DEC, 9 SHL, 10 SHR',
    left: 'ALU left operand: 0 A, 1 X',
    right: 'ALU right operand: 0 K, 1 B, 2 M, 3 zero',
    index: 'Data address is K + X, not K',
    we: 'RAM write strobe: high in the second half of a store',
    out: 'Port write strobe: high in the second half of OUT',
    table: 'M should carry the ROM table byte (LDT)',
    port: 'M should carry the input port (IN)',
    halted: 'The CPU has run HLT and stopped; reset starts it again'
  });
  chips[name] = b.build();
  return name;
}

// ---------------------------------------------------------------------------
// The CPU
// ---------------------------------------------------------------------------

/**
 * The CPU: the control unit driving the datapath. What it needs from
 * outside is a ROM and, from Phase 17, memory and devices.
 *
 * In: `I` the ROM word at `PC`; `M` the data byte (a RAM byte, a ROM
 * table byte or a port, as `table` and `port` ask); `rst`; `clk`. Out:
 * `PC` for the ROM; `ADDR` the data address, for RAM and the ROM's table
 * port; `D` the data to write, which is A; `K`, whose low bits name the
 * port; `we` and `out`, the RAM and port write strobes; `table` and
 * `port`, which say what `M` should carry; `halted`; and A, B, X for
 * displays.
 */
export function cpu(): Generated {
  const { chips: dataChips, ...dp } = datapath();
  const chips: Record<string, Circuit> = { ...dataChips, datapath: dp as Circuit };
  const before = new Set(Object.keys(chips));
  controlUnit(chips);
  const generated = new Set(Object.keys(chips).filter(name => !before.has(name) && name !== 'D flip-flop' && name !== 'mux 2'));
  const b = new CircuitBuilder();
  const i = b.input('I', 0, 16);
  const m = b.input('M', 0, 8);
  const rst = b.input('rst');
  const clk = b.input('clk');
  const control = b.chip('control', 'control unit');
  const path = b.chip('datapath', 'datapath');
  b.connect(i, { component: path, pin: 'I' });
  b.connect(m, { component: path, pin: 'M' });
  for (const target of [control, path]) {
    b.connect(rst, { component: target, pin: 'rst' });
    b.connect(clk, { component: target, pin: 'clk' });
  }
  b.connect({ component: path, pin: 'OP' }, { component: control, pin: 'OP' });
  for (const flag of ['Z', 'C', 'N']) b.connect({ component: path, pin: flag }, { component: control, pin: flag });
  for (const line of ['ir', 'inc', 'jump', 'ret', 'link', 'la', 'lb', 'lx', 'lzn', 'lc', 'op', 'left', 'right', 'index']) {
    b.connect({ component: control, pin: line }, { component: path, pin: line });
  }
  b.output('PC', { component: path, pin: 'PC' }, 8);
  b.output('ADDR', { component: path, pin: 'ADDR' }, 8);
  b.output('D', { component: path, pin: 'A' }, 8);
  b.output('K', { component: path, pin: 'K' }, 8);
  for (const line of ['we', 'out', 'table', 'port', 'halted']) b.output(line, { component: control, pin: line });
  b.output('A', { component: path, pin: 'A' }, 8);
  b.output('B', { component: path, pin: 'B' }, 8);
  b.output('X', { component: path, pin: 'X' }, 8);
  b.describe({
    I: 'The 16-bit instruction word the ROM has at PC',
    M: 'The data byte read: from RAM, a ROM table or a port',
    rst: 'Reset: zeroes the registers and starts again from address 0',
    clk: 'Clock: each instruction takes two cycles',
    PC: 'Program counter: the ROM address to fetch from',
    ADDR: 'The data address, for RAM and the ROM’s table port',
    D: 'The byte to write to RAM or a port: register A',
    K: 'The instruction’s operand byte: its low bits name the port',
    we: 'RAM write strobe',
    out: 'Port write strobe',
    table: 'M should carry the ROM table byte (LDT)',
    port: 'M should carry the input port (IN)',
    halted: 'The CPU has run HLT and stopped',
    A: 'Register A, the accumulator',
    B: 'Register B',
    X: 'Register X, the index register'
  });
  const done = laidOut(b.build(), chips, generated);
  // The datapath's own chips are laid out as `datapath` left them.
  return { ...done, chips: { ...done.chips, ...Object.fromEntries(Object.entries(dataChips)), datapath: dp as Circuit } };
}

// ---------------------------------------------------------------------------
// Memory and devices
// ---------------------------------------------------------------------------

/** The frame timer's width: its top bit, the frame tick, toggles every 2⁹ = 512 cycles. */
export const TIMER_BITS = 10;

/**
 * A binary counter of clock cycles: bit i toggles when every bit below
 * it is 1. A flip-flop, an XOR and two ANDs a bit — the library's
 * `counter 8` would do, with a load and a clear it doesn't need. Reset
 * clears it.
 */
function timer(bits: number, chips: Record<string, Circuit>): string {
  const name = `timer ${bits}`;
  if (chips[name] !== undefined) return name;
  Object.assign(chips, libraryWithDependencies('D flip-flop'));
  const b = new CircuitBuilder();
  const rst = b.input('rst');
  const clk = b.input('clk');
  const keep = b.not(rst, 'not rst');
  let carry: PinRef = b.constant(1, 'count');
  const q: PinRef[] = [];
  for (let i = 0; i < bits; i++) {
    const ff = b.chip(`bit ${i}`, 'D flip-flop');
    const bit = { component: ff, pin: 'q' };
    b.connect(b.and(b.xor(bit, carry, `toggle ${i}`), keep, `next ${i}`), { component: ff, pin: 'd' });
    b.connect(clk, { component: ff, pin: 'clk' });
    q.push(bit);
    if (i < bits - 1) carry = b.and(carry, bit, `carry ${i}`);
  }
  b.output('Q', bus(b, 'Q bits', q), bits);
  b.describe({ rst: 'Reset: back to 0', clk: 'Clock: counts each rising edge', Q: 'Clock cycles since reset; the top bit is the frame tick' });
  chips[name] = b.build();
  return name;
}

/**
 * Everything on the CPU's buses but the ROM: what `ISA.md`'s memory map
 * and ports say is there.
 *
 *   - **RAM** — `RAM 128 + screen`: 0x00–0x7F, its top 64 bytes also the
 *     screen's pixels, out on `F0`…`F15` a row each. An address from 0x80
 *     up reads 0 and doesn't write.
 *   - **`M`** — what the CPU reads: a RAM byte, the ROM's table byte on
 *     `table`, or the input port on `port`.
 *   - **The input port** — `IN 0` the buttons, `up` in bit 0 and `down`
 *     in bit 1; `IN 1` the frame tick in bit 0; ports 2 and 3 read 0.
 *   - **The output ports** — `OUT 0` and `OUT 1` into a latch each, open
 *     while the `out` strobe is high for that port; `S0` and `S1`.
 *   - **The frame timer** — a counter of cycles since reset, whose top
 *     bit is the frame tick.
 *
 * Reset clears the RAM, the port latches and the timer.
 */
export function memoryAndPorts(): Generated {
  const { chips: ramChips, ...memory } = ram(128, 0x40);
  const chips: Record<string, Circuit> = {
    ...ramChips,
    'RAM 128 + screen': memory as Circuit,
    ...libraryWithDependencies('mux 4 ×8'),
    ...libraryWithDependencies('D latch')
  };
  const before = new Set(Object.keys(chips));
  const ticker = timer(TIMER_BITS, chips);
  // latch 8: a byte of D latches, for a port's output.
  {
    const b = new CircuitBuilder();
    const d = bitsOf(b, 'D bits', b.input('D', 0, 8));
    const en = b.input('en');
    b.output('Q', bus(b, 'Q bits', d.map((bit, i) => {
      const latch = b.chip(`bit ${i}`, 'D latch');
      b.connect(bit, { component: latch, pin: 'd' });
      b.connect(en, { component: latch, pin: 'en' });
      return { component: latch, pin: 'q' };
    })), 8);
    b.describe({ D: 'The byte to hold', en: 'Enable: Q follows D while 1, and holds when it falls', Q: 'The byte held' });
    chips['latch 8'] = b.build();
  }
  const generated = new Set(Object.keys(chips).filter(name => !before.has(name)));

  const b = new CircuitBuilder();
  const address = bitsOf(b, 'ADDR bits', b.input('ADDR', 0, 8));
  const d = b.input('D', 0, 8);
  const k = bitsOf(b, 'K bits', b.input('K', 0, 8));
  const we = b.input('we');
  const out = b.input('out');
  const table = b.input('table');
  const port = b.input('port');
  const romByte = b.input('T', 0, 8);
  const up = b.input('up');
  const down = b.input('down');
  const rst = b.input('rst');
  const clk = b.input('clk');

  // RAM, below 0x80.
  const inRam = b.not(address[7]!, 'below 0x80');
  const store = b.and(we, inRam, 'store');
  const theRam = b.chip('RAM', 'RAM 128 + screen');
  b.connect(bus(b, 'RAM address', address.slice(0, 7)), { component: theRam, pin: 'A' });
  b.connect(d, { component: theRam, pin: 'D' });
  b.connect(store, { component: theRam, pin: 'we' });
  b.connect(rst, { component: theRam, pin: 'rst' });
  const ramBits = bitsOf(b, 'RAM Q bits', { component: theRam, pin: 'Q' });
  const ramByte = bus(b, 'RAM byte', ramBits.map((bit, i) => b.and(bit, inRam, `RAM ${i}`)));

  // The timer and the input port.
  const theTimer = b.chip('frame timer', ticker);
  b.connect(rst, { component: theTimer, pin: 'rst' });
  b.connect(clk, { component: theTimer, pin: 'clk' });
  const tick = bitsOf(b, 'timer bits', { component: theTimer, pin: 'Q' }, TIMER_BITS)[TIMER_BITS - 1]!;
  const low = b.not(k[1]!, 'port 0 or 1');
  const port0 = b.and(low, b.not(k[0]!, 'even port'), 'port 0');
  const port1 = b.and(low, k[0]!, 'port 1');
  const zero = b.constant(0, 'nothing');
  const portByte = bus(b, 'port byte', [
    b.or(b.and(port0, up, 'up read'), b.and(port1, tick, 'tick read'), 'bit 0'),
    b.and(port0, down, 'down read'),
    ...Array.from({ length: 6 }, () => zero)
  ]);

  // M
  const source = b.chip('M source', 'mux 4 ×8');
  b.connect(ramByte, { component: source, pin: 'A' });
  b.connect(romByte, { component: source, pin: 'B' });
  b.connect(portByte, { component: source, pin: 'C' });
  b.connect(b.constant(0, 'unused', 8), { component: source, pin: 'D' });
  b.connect(bus(b, 'M select', [table, port]), { component: source, pin: 'S' });
  b.output('M', { component: source, pin: 'Y' }, 8);

  // The output ports: open while `out` is high for the port, and on reset.
  const keep = b.not(rst, 'not rst');
  const written = bus(b, 'port data', bitsOf(b, 'D bits', d).map((bit, i) => b.and(bit, keep, `port data ${i}`)));
  const scores = [port0, port1].map((selected, n) => {
    const latch = b.chip(`port ${n}`, 'latch 8');
    b.connect(written, { component: latch, pin: 'D' });
    b.connect(b.or(b.and(out, selected, `OUT ${n}`), rst, `port ${n} open`), { component: latch, pin: 'en' });
    return { component: latch, pin: 'Q' };
  });
  for (let y = 0; y < 16; y++) b.output(`F${y}`, { component: theRam, pin: `F${y}` }, 32);
  b.output('S0', scores[0]!, 8);
  b.output('S1', scores[1]!, 8);
  b.describe({
    ADDR: 'The data address: RAM below 0x80',
    D: 'The byte to write to RAM or a port',
    K: 'The instruction’s operand: its low bits pick the port',
    we: 'RAM write strobe',
    out: 'Port write strobe: OUT stores D in port K',
    table: 'Put the ROM table byte T on M',
    port: 'Put input port K on M',
    T: 'The ROM’s table byte, at ADDR',
    up: 'The up button: bit 0 of input port 0',
    down: 'The down button: bit 1 of input port 0',
    rst: 'Reset: clears RAM, the output ports and the timer',
    clk: 'Clock: drives the frame timer',
    M: 'The byte the CPU reads: RAM, a table byte or a port',
    ...Object.fromEntries(Array.from({ length: 16 }, (_, y) => [`F${y}`, `Row ${y} of the screen, straight from RAM`])),
    S0: 'Output port 0: the left score display',
    S1: 'Output port 1: the right score display'
  });
  const done = laidOut(b.build(), chips, generated);
  return { ...done, chips: { ...done.chips, ...ramChips, 'RAM 128 + screen': memory as Circuit } };
}

/** What `scripts/generate.ts` writes, file name by file name, under `circuits/`. */
export function generatedFiles(): Record<string, Generated> {
  return {
    'ram-128.gessologic.json': ram(128),
    'register-file.gessologic.json': registerFile(),
    'datapath.gessologic.json': datapath(),
    'cpu.gessologic.json': cpu(),
    'memory-and-ports.gessologic.json': memoryAndPorts()
  };
}
