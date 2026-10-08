import { pinKey, type Netlist } from './Netlist';
import { createKernel, type Kernel } from './Kernel';
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
 * unit delay. The loop that does it is WebAssembly: see `Kernel.ts`.
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

  /** The inner loop, and the memory it runs in: net values, fan-out, and the nets due on the next tick. */
  private readonly kernel: Kernel;
  /** How many of `kernel.changed` the next tick evaluates: nets that changed on the last tick, or were driven since. */
  private changedCount = 0;
  /** True until a tick has evaluated every gate once; see `powerOn`. */
  private everything = false;

  /** Nets a ROM reads: when one changes, the ROM is looked up again. See `tick`. */
  private readonly romInput: Uint8Array;

  constructor(netlist: Netlist) {
    this.netlist = netlist;
    const romInputs = netlist.roms.flatMap(rom => [...rom.address, ...rom.table]);
    this.kernel = createKernel(netlist, netlist.roms.length * 24, [...new Set(romInputs)]);
    this.value = this.kernel.value;
    this.romInput = new Uint8Array(netlist.netCount);
    for (const net of romInputs) this.romInput[net] = 1;
    this.powerOn();
  }

  /** The value on a pin, by component id and pin name. */
  read(component: string, pin = 'out'): 0 | 1 {
    return this.value[this.net(component, pin)] as 0 | 1;
  }

  /** The net a pin is on. */
  net(component: string, pin = 'out'): number {
    const net = this.netlist.netOfPin(component, pin);
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

  /**
   * Sets any net, as if something had driven it, and wakes what reads
   * it: for giving a memory built of latches its contents, which a
   * document cannot say. Takes effect on the next tick; a gate driving
   * the net may drive it back.
   */
  force(net: number, value: 0 | 1): void {
    this.drive(net, value);
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
    const carried = this.netlist.carriedFrom;
    if (carried !== null && this.netlist.numberedAgainst === previous.netlist) {
      // Numbered against the previous netlist: each net says which old
      // net's value it carries on, so the state moves across as a copy.
      for (let net = 0; net < carried.length; net++) {
        const old = carried[net]!;
        if (old >= 0) this.value[net] = previous.value[old]!;
      }
    } else {
      for (const [pin, net] of this.netlist.pinNet) {
        const old = previous.netlist.pinNet.get(pin);
        if (old !== undefined) {
          this.value[net] = previous.value[old];
        }
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

  /**
   * Puts the simulator where it was at the end of a cycle, from every
   * net's value then: the clock low, as `cycle` leaves it, and nothing
   * pending, as a settled cycle leaves it. A cycle's end is the whole of
   * a circuit's state — latches and RAM are gates, a ROM is read-only —
   * so running on from here runs as the original did, given the same
   * inputs: what `History` replays.
   */
  restore(values: Uint8Array, cycles: number): void {
    this.value.set(values);
    this.clockLevel = 0;
    this.cycles = cycles;
    this.changedCount = 0;
    this.everything = false;
  }

  /** Whether a tick would do anything: a net changed and its readers have not seen it yet. */
  get pending(): boolean {
    return this.everything || this.changedCount > 0;
  }

  /** Advances one tick; returns how many nets changed on it. */
  tick(): number {
    const kernel = this.kernel;
    // A ROM is due when an address it reads changed on the last tick, as
    // a gate is; its words are looked up here, in JavaScript, and its
    // changes join the gates' — applied with them, visible next tick.
    let romsDue = this.everything && this.netlist.roms.length > 0;
    if (!romsDue && this.netlist.roms.length > 0) {
      for (let i = 0; i < this.changedCount && !romsDue; i++) romsDue = this.romInput[kernel.changed[i]!] === 1;
    }
    let found: number;
    if (this.everything) {
      // Every gate once, from its record: power-on handed over a circuit
      // with no settled state, or an edit made every gate due.
      this.everything = false;
      const { type, in0, in1, out, gateCount } = this.netlist;
      const value = this.value;
      const changes = kernel.found;
      found = 0;
      for (let g = 0; g < gateCount; g++) {
        const result = TRUTH[(type[g]! << 2) | (value[in0[g]!]! << 1) | value[in1[g]!]!]!;
        const o = out[g]!;
        changes[found] = (o << 1) | result;
        found += result ^ value[o]!;
      }
      this.evaluations += gateCount;
    } else {
      found = kernel.evaluate(this.changedCount);
      this.evaluations += kernel.evaluations;
    }
    if (romsDue) found = this.lookUp(found);
    this.changedCount = kernel.apply(found);
    this.ticks++;
    return kernel.moved;
  }

  /** Every ROM's outputs as its addresses say, written after the `found` changes already in the kernel's list. */
  private lookUp(found: number): number {
    const value = this.value;
    const changes = this.kernel.found;
    const read = (nets: Int32Array) => {
      let v = 0;
      for (let i = 0; i < nets.length; i++) v |= value[nets[i]!]! << i;
      return v;
    };
    const drive = (nets: Int32Array, word: number) => {
      for (let i = 0; i < nets.length; i++) {
        const bit = (word >> i) & 1;
        const net = nets[i]!;
        changes[found] = (net << 1) | bit;
        found += bit ^ value[net]!;
      }
    };
    for (const rom of this.netlist.roms) {
      drive(rom.data, rom.words[read(rom.address)]!);
      drive(rom.tableData, rom.words[read(rom.table)]! & 0xff);
    }
    return found;
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
    if (this.everything && limit > 0) {
      this.tick();
      ticks++;
    }
    if (this.netlist.roms.length > 0) {
      // A ROM is looked up between ticks, which the kernel's own settle
      // loop has no room for: a circuit with one settles a tick at a time.
      while (this.changedCount > 0 && ticks < limit) {
        this.tick();
        ticks++;
      }
    } else if (this.changedCount > 0 && ticks < limit) {
      const kernel = this.kernel;
      const run = kernel.settle(this.changedCount, limit - ticks);
      ticks += run;
      this.ticks += run;
      this.evaluations += kernel.evaluations;
      this.changedCount = kernel.queued;
    }
    if (this.pending) {
      return { settled: false, ticks, ringing: this.ringing() };
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
      if (fanStart[net + 1] > fanStart[net] || this.romInput[net] === 1) {
        this.kernel.changed[this.changedCount++] = net;
      }
    }
  }

  private ringing(): RingingNet[] {
    const toggles = new Uint16Array(this.netlist.netCount);
    for (let t = 0; t < RING_WINDOW && this.pending; t++) {
      this.tick();
      for (let i = 0; i < this.changedCount; i++) {
        toggles[this.kernel.changed[i]!]!++;
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
      for (const rom of this.netlist.roms) {
        for (const [from, to, mask] of [
          [rom.address, rom.data, 0xffff],
          [rom.table, rom.tableData, 0xff]
        ] as const) {
          let address = 0;
          from.forEach((net, i) => (address |= value[net]! << i));
          const word = rom.words[address]! & mask;
          to.forEach((net, i) => {
            const bit = (word >> i) & 1;
            if (value[net] !== bit) {
              value[net] = bit;
              moved = true;
            }
          });
        }
      }
      if (!moved) {
        return;
      }
    }
    this.everything = true;
  }
}
