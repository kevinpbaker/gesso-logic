/**
 * The parts a circuit is made of, and the pins each one has.
 *
 * Seven gates and four things that are not gates: a clock, a constant,
 * an input a person drives, and an output that only reads. Every gate
 * has two inputs, `a` and `b`, except NOT, which has `a`. That keeps the
 * gate count honest by construction — a wider gate is a tree of these,
 * which is what the roadmap counts it as anyway.
 */

export type GateKind = 'not' | 'and' | 'or' | 'nand' | 'nor' | 'xor' | 'xnor';
export type SourceKind = 'clock' | 'constant' | 'input' | 'button';
/** Parts that only read: they show a value and drive nothing. */
export type DisplayKind = 'output' | 'probe' | 'hex' | 'seg7' | 'matrix';
/** A chip: a circuit used as a part. Its pins are its definition's switches and LEDs; see `Chips.ts`. */
export type ChipKind = 'chip';
/**
 * A bus's ends: `split` takes a bus and gives its bits, `join` takes bits
 * and gives a bus. Wiring, not logic — the compiler joins their pins, and
 * they cost no gate and no tick.
 */
export type BusKind = 'split' | 'join';
/**
 * The program ROM: 256 words of 16 bits, looked up, not built of gates —
 * the one part the showpiece's gate count leaves out, as Logisim's ROM
 * is. Two read ports: `A` → `D` for instructions, `T` → `Q` for a word's
 * low byte, which `LDT` reads tables through. Each takes a tick, as a
 * gate does. Its words are the component's `rom`.
 */
export type MemoryKind = 'rom';
export type Kind = GateKind | SourceKind | DisplayKind | ChipKind | BusKind | MemoryKind;

/** A ROM's size in words, and its ports' widths. */
export const ROM_WORDS = 256;

/** The LED matrix: 32 × 16 pixels, fed a row a pin, pixel x of row y on `r{y}[x]`. */
export const MATRIX_WIDTH = 32;
export const MATRIX_HEIGHT = 16;
const MATRIX_ROWS = Array.from({ length: MATRIX_HEIGHT }, (_, y) => `r${y}`);

export const GATE_KINDS: readonly GateKind[] = ['not', 'and', 'or', 'nand', 'nor', 'xor', 'xnor'];

export interface PinSpec {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** Pins wider than one bit, by name; a pin not listed is one bit. */
  readonly widths?: Readonly<Record<string, number>>;
}

/** The widest a bus may be. */
export const MAX_WIDTH = 32;

/** A pin's width in bits: 1 unless its spec says otherwise. */
export function widthOf(spec: PinSpec, pin: string): number {
  return spec.widths?.[pin] ?? 1;
}

/**
 * A pin's bits, as the compiler names them: the pin itself when it is one
 * bit wide, and `pin[0]`, `pin[1]`, … when it is a bus, least significant
 * first.
 */
export function bitPins(pin: string, width: number): string[] {
  return width === 1 ? [pin] : Array.from({ length: width }, (_, i) => `${pin}[${i}]`);
}

const TWO_INPUT: PinSpec = { inputs: ['a', 'b'], outputs: ['out'] };
const SOURCE: PinSpec = { inputs: [], outputs: ['out'] };

export const PINS: Readonly<Record<Kind, PinSpec>> = {
  not: { inputs: ['a'], outputs: ['out'] },
  and: TWO_INPUT,
  or: TWO_INPUT,
  nand: TWO_INPUT,
  nor: TWO_INPUT,
  xor: TWO_INPUT,
  xnor: TWO_INPUT,
  clock: SOURCE,
  constant: SOURCE,
  input: SOURCE,
  // A push button drives its net like a switch; it differs only in how a
  // person works it — held, not flipped — which is the editor's business.
  button: SOURCE,
  output: { inputs: ['in'], outputs: [] },
  probe: { inputs: ['in'], outputs: [] },
  // Four bits, least significant first, shown as one hex digit.
  hex: { inputs: ['b0', 'b1', 'b2', 'b3'], outputs: [] },
  // One input per segment, lettered as the standard does: a across the
  // top, then clockwise, g across the middle.
  seg7: { inputs: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], outputs: [] },
  // The LED matrix: a row of pixels a pin, top row first, the leftmost
  // pixel the least significant bit.
  matrix: { inputs: MATRIX_ROWS, outputs: [], widths: Object.fromEntries(MATRIX_ROWS.map(row => [row, MATRIX_WIDTH])) },
  // A chip's pins depend on its definition, so none are listed here:
  // ask `pinsOf` in `Chips.ts`, which knows the definitions.
  chip: { inputs: [], outputs: [] },
  // Their pins depend on their width; ask `pinsOf`. These are an 8-bit one's shape without the bits.
  split: { inputs: ['in'], outputs: [] },
  join: { inputs: [], outputs: ['out'] },
  rom: { inputs: ['A', 'T'], outputs: ['D', 'Q'], widths: { A: 8, T: 8, D: 16, Q: 8 } }
};

/** Parts a person drives: switches and push buttons. */
export function isSettable(kind: Kind): boolean {
  return kind === 'input' || kind === 'button';
}

export function isGate(kind: Kind): kind is GateKind {
  return (GATE_KINDS as readonly string[]).includes(kind);
}

/**
 * Every gate's truth table, four entries per gate kind in `GATE_KINDS`
 * order, indexed by `kind * 4 + a * 2 + b`.
 *
 * A table rather than a switch because the kernel's inner loop is
 * nothing but this lookup, and Phase 0 measured the event-driven kernel
 * built on it at 59–68 M evaluations a second. NOT ignores `b`; the
 * compiler wires `b` to the same net as `a` so the index is still valid.
 */
export const TRUTH = new Uint8Array([
  /* not  */ 1, 1, 0, 0,
  /* and  */ 0, 0, 0, 1,
  /* or   */ 0, 1, 1, 1,
  /* nand */ 1, 1, 1, 0,
  /* nor  */ 1, 0, 0, 0,
  /* xor  */ 0, 1, 1, 0,
  /* xnor */ 1, 0, 0, 1
]);
