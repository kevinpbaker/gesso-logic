/**
 * A flat netlist, as typed arrays.
 *
 * Throwaway, like everything under `src/spike`: this is the smallest
 * shape that lets Phase 0 ask how fast a gate can be evaluated, not the
 * shape Phase 1 will keep. Every gate has two inputs (NOT reads only the
 * first) and drives exactly one net, and a net has at most one driver,
 * so "the gate that drives net n" and "the net gate g drives" are both
 * a single array read.
 */

export const NOT = 0;
export const AND = 1;
export const OR = 2;
export const NAND = 3;
export const NOR = 4;
export const XOR = 5;
export const XNOR = 6;
export type GateType = typeof NOT | typeof AND | typeof OR | typeof NAND | typeof NOR | typeof XOR | typeof XNOR;

/**
 * Every gate's truth table, four entries per type, indexed by
 * `type * 4 + a * 2 + b`.
 *
 * A table rather than a switch because the kernel's inner loop is
 * nothing but this lookup: a switch on seven types is a branch the
 * predictor misses about as often as the circuit is irregular, and a
 * load from a 28-byte table is not.
 */
export const TRUTH = new Uint8Array([
  /* NOT  */ 1, 1, 0, 0,
  /* AND  */ 0, 0, 0, 1,
  /* OR   */ 0, 1, 1, 1,
  /* NAND */ 1, 1, 1, 0,
  /* NOR  */ 1, 0, 0, 0,
  /* XOR  */ 0, 1, 1, 0,
  /* XNOR */ 1, 0, 0, 1
]);

export interface Netlist {
  readonly gateCount: number;
  readonly netCount: number;
  readonly type: Uint8Array;
  readonly in0: Int32Array;
  readonly in1: Int32Array;
  readonly out: Int32Array;
  /** Fan-out in CSR form: the gates reading net n are `fanGate[fanStart[n] .. fanStart[n + 1])`. */
  readonly fanStart: Int32Array;
  readonly fanGate: Int32Array;
  /** A consistent starting state: every gate's output agrees with its inputs. */
  readonly initial: Uint8Array;
}

/**
 * Builds a netlist gate by gate.
 *
 * Feedback — a latch, a flip-flop — needs a net before its driver
 * exists, so `net()` hands out an undriven net and `drive()` attaches a
 * gate to it later. A net nobody drives is an input.
 */
export class NetlistBuilder {
  private readonly types: number[] = [];
  private readonly ins0: number[] = [];
  private readonly ins1: number[] = [];
  private readonly outs: number[] = [];
  private readonly driven: boolean[] = [];
  private readonly hints: number[] = [];

  get gateCount(): number {
    return this.types.length;
  }

  get netCount(): number {
    return this.driven.length;
  }

  /** A new net. `hint` is its value before the first settle. */
  net(hint = 0): number {
    this.driven.push(false);
    this.hints.push(hint);
    return this.driven.length - 1;
  }

  drive(net: number, type: GateType, a: number, b: number = a): number {
    if (this.driven[net]) {
      throw new Error(`Net ${net} already has a driver.`);
    }
    this.driven[net] = true;
    this.types.push(type);
    this.ins0.push(a);
    this.ins1.push(b);
    this.outs.push(net);
    return net;
  }

  gate(type: GateType, a: number, b: number = a): number {
    return this.drive(this.net(), type, a, b);
  }

  not(a: number): number {
    return this.gate(NOT, a);
  }
  and(a: number, b: number): number {
    return this.gate(AND, a, b);
  }
  or(a: number, b: number): number {
    return this.gate(OR, a, b);
  }
  nand(a: number, b: number): number {
    return this.gate(NAND, a, b);
  }
  nor(a: number, b: number): number {
    return this.gate(NOR, a, b);
  }
  xor(a: number, b: number): number {
    return this.gate(XOR, a, b);
  }

  compile(): Netlist {
    const gateCount = this.types.length;
    const netCount = this.driven.length;
    const type = Uint8Array.from(this.types);
    const in0 = Int32Array.from(this.ins0);
    const in1 = Int32Array.from(this.ins1);
    const out = Int32Array.from(this.outs);

    // Fan-out, packed contiguously. A gate whose two inputs are the
    // same net (a NOT) is listed once, so a change on that net wakes it
    // once.
    const counts = new Int32Array(netCount + 1);
    for (let g = 0; g < gateCount; g++) {
      counts[in0[g] + 1]++;
      if (in1[g] !== in0[g]) {
        counts[in1[g] + 1]++;
      }
    }
    const fanStart = new Int32Array(netCount + 1);
    for (let n = 0; n < netCount; n++) {
      fanStart[n + 1] = fanStart[n] + counts[n + 1];
    }
    const fill = fanStart.slice(0, netCount);
    const fanGate = new Int32Array(fanStart[netCount]);
    for (let g = 0; g < gateCount; g++) {
      fanGate[fill[in0[g]]++] = g;
      if (in1[g] !== in0[g]) {
        fanGate[fill[in1[g]]++] = g;
      }
    }

    const initial = settleAsynchronously(gateCount, type, in0, in1, out, Uint8Array.from(this.hints));
    return { gateCount, netCount, type, in0, in1, out, fanStart, fanGate, initial };
  }
}

/**
 * A starting state that is already settled.
 *
 * Under unit delay an SR latch that starts with Q and Q̅ equal
 * oscillates forever, because both halves flip on the same tick. Real
 * hardware breaks that symmetry with noise; this breaks it by updating
 * one gate at a time (Gauss–Seidel rather than Jacobi) until nothing
 * changes, starting from the builder's hints. The kernel then starts
 * from a state in which every gate agrees with its inputs.
 */
function settleAsynchronously(
  gateCount: number,
  type: Uint8Array,
  in0: Int32Array,
  in1: Int32Array,
  out: Int32Array,
  value: Uint8Array
): Uint8Array {
  for (let pass = 0; pass < 1000; pass++) {
    let changed = false;
    for (let g = 0; g < gateCount; g++) {
      const next = TRUTH[(type[g] << 2) | (value[in0[g]] << 1) | value[in1[g]]];
      if (value[out[g]] !== next) {
        value[out[g]] = next;
        changed = true;
      }
    }
    if (!changed) {
      return value;
    }
  }
  throw new Error('The netlist never settled from its hints.');
}
