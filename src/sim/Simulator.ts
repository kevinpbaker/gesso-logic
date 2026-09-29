import { pinKey, type Netlist } from './Netlist';
import { TRUTH } from './Primitives';

/**
 * Runs a netlist: two-state logic, unit delay, event-driven.
 *
 * **Unit delay.** Every gate reads its inputs as they were when the tick
 * began, and its new output is visible from the next tick. That is what
 * lets an SR latch built from two NANDs behave, and what makes the
 * result independent of the order gates are evaluated in.
 *
 * **Event-driven.** A tick evaluates only the gates reading a net that
 * changed on the tick before. Phase 0 measured this 26× faster than
 * evaluating every gate every tick, on a CPU-shaped circuit. Changes are
 * gathered while gates are evaluated and applied after, which is the
 * unit delay.
 *
 * **Settling, and when it never comes.** `settle` runs ticks until
 * nothing changes. A loop that never stops changing — a ring
 * oscillator, or a latch that lost a race — is stopped after a limit and
 * reported with the nets that are ringing, not hung on. Phase 0's first
 * circuit rang from a hold-time violation, and a report that named no
 * net would have taken much longer to act on.
 */

export interface RingingNet {
  readonly net: number;
  /** The net's driver, as `label.pin`. */
  readonly name: string;
}

export type SettleResult =
  | { readonly settled: true; readonly ticks: number }
  | { readonly settled: false; readonly ticks: number; readonly ringing: readonly RingingNet[] };

export interface CycleResult {
  readonly settled: boolean;
  readonly rise: SettleResult;
  readonly fall: SettleResult;
}

/** Ticks `settle` runs before it calls a circuit oscillating. */
export const SETTLE_LIMIT = 10_000;
/** Ticks watched after the limit, to see which nets are ringing. */
const RING_WINDOW = 64;
/** Passes the power-on settle makes before handing a circuit to the unit-delay kernel. */
const POWER_ON_PASSES = 100;

export class Simulator {
  readonly netlist: Netlist;
  /** Every net's value, indexed by net. Read it; drive nets only through `set` and `setClock`. */
  readonly value: Uint8Array;
  /** Ticks run since construction. */
  ticks = 0;
  /** Gate evaluations since construction. */
  evaluations = 0;
  /** Full clock cycles run by `cycle`, carried across `adopt`. */
  cycles = 0;
  /** The level the clocks were last driven to. */
  private clockLevel: 0 | 1 = 0;

  private readonly stamp: Uint32Array;
  private epoch = 0;
  /** Nets that changed on the last tick, or were driven since it: what the next tick evaluates. */
  private readonly changed: Int32Array;
  private changedCount = 0;
  private readonly nextNet: Int32Array;
  private readonly nextValue: Uint8Array;
  /** True until a tick has evaluated every gate once; see `powerOn`. */
  private everything = false;

  constructor(netlist: Netlist) {
    this.netlist = netlist;
    this.value = new Uint8Array(netlist.netCount);
    this.stamp = new Uint32Array(netlist.gateCount);
    this.changed = new Int32Array(netlist.netCount);
    this.nextNet = new Int32Array(netlist.netCount);
    this.nextValue = new Uint8Array(netlist.netCount);
    this.powerOn();
  }

  /** The value on a pin, by component id and pin name. */
  read(component: string, pin = 'out'): 0 | 1 {
    return this.value[this.net(component, pin)] as 0 | 1;
  }

  /** The net a pin is on. */
  net(component: string, pin = 'out'): number {
    const net = this.netlist.pinNet.get(pinKey({ component, pin }));
    if (net === undefined) {
      throw new Error(`No pin '${pin}' on a component '${component}'.`);
    }
    return net;
  }

  /** Drives an input. Takes effect on the next tick. */
  /** Sets a switch: a bit, or for one wider than a bit a number, least significant bit first. */
  set(input: string, value: number): void {
    const source = this.netlist.inputs.get(input);
    if (source === undefined) {
      throw new Error(`'${input}' is not an input.`);
    }
    source.nets.forEach((net, bit) => this.drive(net, ((value >>> bit) & 1) as 0 | 1));
  }

  /** Drives every clock. Takes effect on the next tick. */
  setClock(value: 0 | 1): void {
    this.clockLevel = value;
    for (const net of this.netlist.clocks) {
      this.drive(net, value);
    }
  }

  /**
   * Takes over the state of a simulator for an earlier version of the
   * same circuit, so an edit does not reset what the circuit remembers.
   *
   * Nets are renumbered on every compile, so values are matched by pin:
   * every pin that exists in both netlists carries its old value onto
   * its new net. A latch's Q and Q̅ are pins, so a latch keeps its bit,
   * and an input keeps what a person last set it to. Constants take the
   * document's value, which the edit may have changed. Every gate is
   * then due on the next tick: where the edit changed nothing the
   * values already agree and nothing moves, and where it changed
   * something the new gates settle from there.
   */
  adopt(previous: Simulator): void {
    for (const [pin, net] of this.netlist.pinNet) {
      const old = previous.netlist.pinNet.get(pin);
      if (old !== undefined) {
        this.value[net] = previous.value[old];
      }
    }
    for (const { nets, value } of this.netlist.constants.values()) {
      nets.forEach((net, bit) => (this.value[net] = (value >>> bit) & 1));
    }
    this.clockLevel = previous.clockLevel;
    for (const net of this.netlist.clocks) {
      this.value[net] = this.clockLevel;
    }
    this.cycles = previous.cycles;
    this.changedCount = 0;
    this.everything = true;
  }

  /** Whether a tick would do anything: a net changed and its readers have not seen it yet. */
  get pending(): boolean {
    return this.everything || this.changedCount > 0;
  }

  /** Advances one tick; returns how many nets changed on it. */
  tick(): number {
    const { type, in0, in1, out, fanStart, fanGate, gateCount } = this.netlist;
    const value = this.value;
    const nextNet = this.nextNet;
    const nextValue = this.nextValue;
    let count = 0;
    let evaluations = 0;
    const evaluate = (g: number) => {
      evaluations++;
      const result = TRUTH[(type[g] << 2) | (value[in0[g]] << 1) | value[in1[g]]];
      if (result !== value[out[g]]) {
        nextNet[count] = out[g];
        nextValue[count] = result;
        count++;
      }
    };

    if (this.everything) {
      this.everything = false;
      for (let g = 0; g < gateCount; g++) {
        evaluate(g);
      }
    } else {
      const stamp = this.stamp;
      const epoch = ++this.epoch;
      for (let i = 0; i < this.changedCount; i++) {
        const n = this.changed[i];
        for (let f = fanStart[n]; f < fanStart[n + 1]; f++) {
          const g = fanGate[f];
          if (stamp[g] !== epoch) {
            stamp[g] = epoch;
            evaluate(g);
          }
        }
      }
    }

    // Applied after every gate has been evaluated, never during: a gate
    // later in this tick must see its inputs as they were when the tick
    // began. One driver per net means no net appears twice here. A net
    // no gate reads is not queued for the next tick, so a circuit whose
    // last change lands on an output is quiet at once, and `settle`
    // counts exactly its propagation delay.
    let queued = 0;
    for (let i = 0; i < count; i++) {
      const n = nextNet[i];
      value[n] = nextValue[i];
      if (fanStart[n + 1] > fanStart[n]) {
        this.changed[queued++] = n;
      }
    }
    this.changedCount = queued;
    this.ticks++;
    this.evaluations += evaluations;
    return count;
  }

  /**
   * Runs ticks until nothing changes, or until `limit` ticks have passed
   * and the circuit is called oscillating.
   *
   * An oscillating result names the nets that changed at least twice
   * in the ticks after the limit: the loop itself, not everything
   * downstream of it that merely follows once.
   */
  settle(limit = SETTLE_LIMIT): SettleResult {
    let ticks = 0;
    while (this.pending) {
      if (ticks >= limit) {
        return { settled: false, ticks, ringing: this.ringing() };
      }
      this.tick();
      ticks++;
    }
    return { settled: true, ticks };
  }

  /**
   * One full clock cycle: rise and settle, fall and settle.
   *
   * An input set since the last cycle settles first, before the edge. A
   * switch flipped while the circuit runs is flipped between cycles, and
   * a circuit expects its inputs steady at the edge; raising the clock
   * in the same tick as the input changes is a setup-time violation the
   * person did not commit, and a counter's reset released that way is
   * missed or not by a race of gate delays.
   */
  cycle(limit = SETTLE_LIMIT): CycleResult {
    if (this.pending) {
      const inputs = this.settle(limit);
      if (!inputs.settled) {
        return { settled: false, rise: inputs, fall: inputs };
      }
    }
    this.setClock(1);
    const rise = this.settle(limit);
    this.setClock(0);
    const fall = this.settle(limit);
    this.cycles++;
    return { settled: rise.settled && fall.settled, rise, fall };
  }

  private drive(net: number, value: 0 | 1): void {
    const { fanStart } = this.netlist;
    if (this.value[net] !== value) {
      this.value[net] = value;
      if (fanStart[net + 1] > fanStart[net]) {
        this.changed[this.changedCount++] = net;
      }
    }
  }

  private ringing(): RingingNet[] {
    const toggles = new Uint16Array(this.netlist.netCount);
    for (let t = 0; t < RING_WINDOW && this.pending; t++) {
      this.tick();
      for (let i = 0; i < this.changedCount; i++) {
        toggles[this.changed[i]]++;
      }
    }
    const nets: RingingNet[] = [];
    for (let net = 0; net < toggles.length; net++) {
      if (toggles[net] >= 2) {
        nets.push({ net, name: this.netlist.netNames[net] });
      }
    }
    // By name, because a person reads this: net numbers follow each
    // net's first pin, which says nothing to anyone.
    return nets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * The state the circuit wakes up in.
   *
   * Sources take their values, and every gate is then settled one at a
   * time, in document order, until a pass changes nothing. One at a
   * time rather than in lockstep because lockstep is exactly what makes
   * an SR latch that starts with Q and Q̅ both low ring forever: both
   * halves flip on the same tick, every tick. Real hardware breaks that
   * symmetry with noise; document order breaks it here, deterministically.
   * Which way a latch falls is then an accident of order, which is why a
   * circuit that cares — a CPU — clears its latches with a reset line.
   *
   * A circuit that has no settled state at all, a ring oscillator, never
   * finishes a pass. It is handed to the unit-delay kernel with every
   * gate due, so the first `settle` sees it ring and says so.
   */
  private powerOn(): void {
    const { type, in0, in1, out, gateCount, constants, inputs } = this.netlist;
    const value = this.value;
    for (const { nets, value: v } of [...constants.values(), ...inputs.values()]) {
      nets.forEach((net, bit) => (value[net] = (v >>> bit) & 1));
    }
    for (let pass = 0; pass < POWER_ON_PASSES; pass++) {
      let moved = false;
      for (let g = 0; g < gateCount; g++) {
        const result = TRUTH[(type[g] << 2) | (value[in0[g]] << 1) | value[in1[g]]];
        if (value[out[g]] !== result) {
          value[out[g]] = result;
          moved = true;
        }
      }
      if (!moved) {
        return;
      }
    }
    this.everything = true;
  }
}
