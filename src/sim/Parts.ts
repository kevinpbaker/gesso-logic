import type { PinRef } from './Circuit';
import type { CircuitBuilder } from './CircuitBuilder';

/**
 * Gate-level building blocks, as functions over a builder.
 *
 * The parts Phase 1's specs are made of. Phase 10 turns parts like
 * these into library chips, each a circuit file; until then they are
 * code, and each takes a `name` so its gates have labels a spec can read
 * and a report can name.
 */

export interface LatchPins {
  readonly q: PinRef;
  readonly qBar: PinRef;
}

/**
 * An SR latch from two cross-coupled NANDs, with active-low inputs:
 * pulling `sBar` low sets Q, pulling `rBar` low resets it, both high
 * holds. Both low at once is the forbidden state, as in hardware.
 */
export function srLatch(b: CircuitBuilder, sBar: PinRef, rBar: PinRef, name: string): LatchPins {
  const q = b.gate('nand', `${name}.q`);
  const qBar = b.gate('nand', `${name}.qBar`);
  b.connect(sBar, q.a);
  b.connect(qBar.out, q.b);
  b.connect(rBar, qBar.a);
  b.connect(q.out, qBar.b);
  return { q: q.out, qBar: qBar.out };
}

/**
 * A gated D latch in four NANDs: Q follows D while `enable` is high and
 * holds while it is low.
 *
 * The reset side reads the set side's NAND instead of an inverted D,
 * which saves the inverter and has a property the specs rely on: S̄ and
 * R̄ cannot both be low while D is steady. They can when D moves on the
 * tick before `enable` falls — a hold-time violation — and then the
 * latch rings, which is how Phase 0 first met this.
 */
export function dLatch(b: CircuitBuilder, d: PinRef, enable: PinRef, name: string): LatchPins {
  const sBar = b.nand(d, enable, `${name}.sBar`);
  const rBar = b.nand(sBar, enable, `${name}.rBar`);
  return srLatch(b, sBar, rBar, name);
}

/**
 * A positive-edge D flip-flop: a master latch open while the clock is
 * low, a slave open while it is high, so Q takes D on the rising edge.
 *
 * Nine gates, where the roadmap's budget assumed a six-NAND edge
 * triggered flip-flop; that design needs a three-input NAND, and every
 * gate here has two inputs. The count matters for the budget and is
 * worth revisiting when the CPU's registers are sized.
 */
export function dFlipFlop(b: CircuitBuilder, d: PinRef, clock: PinRef, name: string): LatchPins {
  const clockBar = b.not(clock, `${name}.clockBar`);
  const master = dLatch(b, d, clockBar, `${name}.master`);
  return dLatch(b, master.q, clock, `${name}.slave`);
}

export interface AdderPins {
  readonly sum: PinRef;
  readonly carry: PinRef;
}

/** A full adder in five gates: two XORs for the sum, two ANDs and an OR for the carry. */
export function fullAdder(b: CircuitBuilder, x: PinRef, y: PinRef, carryIn: PinRef, name: string): AdderPins {
  const half = b.xor(x, y, `${name}.half`);
  const sum = b.xor(half, carryIn, `${name}.sum`);
  const carry = b.or(b.and(x, y, `${name}.both`), b.and(half, carryIn, `${name}.passed`), `${name}.carry`);
  return { sum, carry };
}
