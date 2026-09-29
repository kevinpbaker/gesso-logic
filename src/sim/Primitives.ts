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
export type DisplayKind = 'output' | 'probe' | 'hex' | 'seg7';
export type Kind = GateKind | SourceKind | DisplayKind;

export const GATE_KINDS: readonly GateKind[] = ['not', 'and', 'or', 'nand', 'nor', 'xor', 'xnor'];

export interface PinSpec {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
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
  seg7: { inputs: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], outputs: [] }
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
