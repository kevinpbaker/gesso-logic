import { TRUTH, type Netlist } from './Netlist.ts';

/**
 * Two ways to advance a unit-delay circuit by one tick, so Phase 0 can
 * price them against each other.
 *
 * Both are two-state and unit-delay, as the roadmap decided: every gate
 * reads its inputs as they were at the start of the tick and its new
 * output is visible from the next one. They differ only in which gates
 * they bother to evaluate.
 */
export interface Kernel {
  readonly value: Uint8Array;
  /** Gate evaluations since construction. */
  readonly evaluations: number;
  /** Drives an input net. Takes effect on the next tick. */
  set(net: number, value: 0 | 1): void;
  /** Advances one tick; returns how many nets changed. */
  tick(): number;
}

/**
 * Event-driven: only the gates reading a net that changed last tick.
 *
 * The changed nets are a list, the gates they wake are deduplicated
 * with a per-gate stamp rather than a set, and the next tick's changes
 * are gathered into flat arrays and applied after every gate has been
 * evaluated — which is what makes it unit delay rather than "whatever
 * order the queue happened to run in".
 */
export class EventKernel implements Kernel {
  readonly value: Uint8Array;
  evaluations = 0;

  private readonly net: Netlist;
  private readonly stamp: Uint32Array;
  private epoch = 0;
  private changed: Int32Array;
  private changedCount = 0;
  private readonly nextNet: Int32Array;
  private readonly nextValue: Uint8Array;
  /**
   * Per-gate evaluation and change counts, when asked for. Null in
   * every timed run: it is here to say where the evaluations go, and a
   * branch on a null in the inner loop is the price of not keeping a
   * second copy of the kernel for it.
   */
  readonly profile: { readonly evaluated: Uint32Array; readonly changed: Uint32Array } | null;

  constructor(net: Netlist, profile = false) {
    this.net = net;
    this.profile = profile
      ? { evaluated: new Uint32Array(net.gateCount), changed: new Uint32Array(net.gateCount) }
      : null;
    this.value = net.initial.slice();
    this.stamp = new Uint32Array(net.gateCount);
    this.changed = new Int32Array(net.netCount);
    this.nextNet = new Int32Array(net.netCount);
    this.nextValue = new Uint8Array(net.netCount);
  }

  set(net: number, value: 0 | 1): void {
    if (this.value[net] !== value) {
      this.value[net] = value;
      this.changed[this.changedCount++] = net;
    }
  }

  tick(): number {
    const { type, in0, in1, out, fanStart, fanGate } = this.net;
    const value = this.value;
    const stamp = this.stamp;
    const nextNet = this.nextNet;
    const nextValue = this.nextValue;
    const epoch = ++this.epoch;
    const profile = this.profile;
    let nextCount = 0;
    let evaluations = 0;

    for (let i = 0; i < this.changedCount; i++) {
      const n = this.changed[i];
      const end = fanStart[n + 1];
      for (let f = fanStart[n]; f < end; f++) {
        const g = fanGate[f];
        if (stamp[g] === epoch) {
          continue;
        }
        stamp[g] = epoch;
        evaluations++;
        const result = TRUTH[(type[g] << 2) | (value[in0[g]] << 1) | value[in1[g]]];
        const o = out[g];
        if (profile !== null) {
          profile.evaluated[g]++;
          profile.changed[g] += result ^ value[o];
        }
        if (result !== value[o]) {
          nextNet[nextCount] = o;
          nextValue[nextCount] = result;
          nextCount++;
        }
      }
    }

    // Applied after the sweep, never during it: a gate evaluated later
    // in this tick must still see the value its input had when the tick
    // began. One driver per net means no net appears twice here.
    const changed = this.changed;
    for (let i = 0; i < nextCount; i++) {
      value[nextNet[i]] = nextValue[i];
      changed[i] = nextNet[i];
    }
    this.changedCount = nextCount;
    this.evaluations += evaluations;
    return nextCount;
  }
}

/**
 * Oblivious: every gate, every tick, double-buffered.
 *
 * No queue, no dedupe, no branches beyond the loop — the baseline an
 * event-driven kernel has to beat by skipping enough idle gates to pay
 * for its bookkeeping. Its evaluations per second will look enormous;
 * the number to compare is cycles per second.
 */
export class SweepKernel implements Kernel {
  value: Uint8Array;
  evaluations = 0;

  private readonly net: Netlist;
  private back: Uint8Array;
  private readonly inputs: Int32Array;
  private readonly inputValue: Uint8Array;
  private inputCount = 0;

  constructor(net: Netlist) {
    this.net = net;
    this.value = net.initial.slice();
    this.back = net.initial.slice();
    this.inputs = new Int32Array(net.netCount);
    this.inputValue = new Uint8Array(net.netCount);
  }

  set(net: number, value: 0 | 1): void {
    // Undriven nets are never written by the sweep, so an input only
    // has to be written into both buffers.
    this.value[net] = value;
    this.back[net] = value;
    this.inputs[this.inputCount] = net;
    this.inputValue[this.inputCount++] = value;
  }

  tick(): number {
    const { gateCount, type, in0, in1, out } = this.net;
    const value = this.value;
    const back = this.back;
    let changed = 0;
    for (let g = 0; g < gateCount; g++) {
      const result = TRUTH[(type[g] << 2) | (value[in0[g]] << 1) | value[in1[g]]];
      const o = out[g];
      back[o] = result;
      changed += result ^ value[o];
    }
    this.value = back;
    this.back = value;
    this.evaluations += gateCount;
    this.inputCount = 0;
    return changed;
  }
}

/**
 * One full clock cycle: rise, settle, fall, settle.
 *
 * "Settle" is quiescence, not a fixed tick count, which is what "as
 * fast as the machine allows" means for a clock: the next edge comes
 * the tick after the last gate stops moving. `maxTicks` is the
 * oscillation guard, and a cycle that hits it throws rather than
 * reporting a speed for a circuit that never stopped.
 */
export function runCycle(kernel: Kernel, clock: number, maxTicks = 10_000): number {
  let ticks = 0;
  for (const level of [1, 0] as const) {
    kernel.set(clock, level);
    let moving = 1;
    // The sweep kernel reports no change on the tick an input was set,
    // because the input was written directly; one forced tick covers it.
    let forced = true;
    while (moving > 0 || forced) {
      forced = false;
      moving = kernel.tick();
      if (++ticks > maxTicks) {
        throw new Error(`No quiescence within ${maxTicks} ticks: the circuit oscillates.`);
      }
    }
  }
  return ticks;
}
