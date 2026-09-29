import { disassemble } from '../cpu/Assembler';
import { Emulator } from '../cpu/Emulator';
import { INSTRUCTIONS, PORTS, RAM_SIZE, ROM_SIZE } from '../cpu/Isa';
import { compile, type Netlist } from '../sim/Netlist';
import { Simulator } from '../sim/Simulator';
import { ROW_BYTES, TIMER_BITS } from './Generators';
import { computerScene } from './Scenes';

/**
 * Lockstep: the gate-level computer and the reference emulator run the
 * same ROM side by side, and after every instruction everything the ISA
 * says a program can see is compared — PC, A, B, X, the flags, whether
 * it has halted, every byte of RAM and both output ports. The first
 * difference stops the run and says where: the instruction, the clock
 * cycle, what differs and in which bit.
 *
 * The gate side is the whole computer, `computerScene`: the CPU chip,
 * the ROM, memory and ports, all gates but the ROM. Its state is read
 * straight off nets — the datapath's pins, the RAM's latches — so
 * nothing is compared that a probe on the canvas wouldn't show.
 *
 * The emulator's devices are the hardware's, exactly:
 *
 *   - the buttons read what the gate side's buttons are set to;
 *   - the frame tick is bit 9 of the count of clock edges since reset.
 *     Reset is the first edge; the instruction with `cycles` before it
 *     executes in the cycle after edge `cycles + 1`, which is the count
 *     the timer shows while `IN` reads it.
 */

export interface Divergence {
  /** Instructions completed before the one that diverged. */
  readonly instruction: number;
  /** The clock cycle it finished on, counting the reset edge as cycle 1. */
  readonly cycle: number;
  /** Where the instruction was, and what it was. */
  readonly pc: number;
  readonly text: string;
  /** What differs: `A`, `Z`, `RAM[0x45]`, `OUT 1`, … */
  readonly what: string;
  readonly gates: number;
  readonly emulator: number;
  /** The lowest bit that differs, for a byte. */
  readonly bit: number | null;
  readonly message: string;
}

/** The buttons a step is taken with. */
export interface Buttons {
  readonly up: boolean;
  readonly down: boolean;
}

export class Lockstep {
  readonly emulator: Emulator;
  readonly sim: Simulator;
  readonly netlist: Netlist;
  /** Instructions each side has run. */
  instructions = 0;
  private readonly rom: Uint16Array;
  private buttons: Buttons = { up: false, down: false };
  private readonly outs = [0, 0];
  private readonly nets: {
    pc: Int32Array;
    a: Int32Array;
    b: Int32Array;
    x: Int32Array;
    z: number;
    c: number;
    n: number;
    halted: number;
    ram: Int32Array[];
    out: Int32Array[];
  };

  constructor(program: ArrayLike<number>) {
    this.rom = new Uint16Array(ROM_SIZE);
    this.rom.set(Array.from(program).slice(0, ROM_SIZE));
    this.emulator = new Emulator(this.rom, {
      read: port => {
        if (port === 0) return (this.buttons.up ? 1 : 0) | (this.buttons.down ? 2 : 0);
        if (port === 1) return ((this.emulator.cycles + 1) >> (TIMER_BITS - 1)) & 1;
        return 0;
      },
      write: (port, value) => {
        if (port < 2) this.outs[port] = value;
      }
    });
    this.netlist = compile(computerScene([...this.rom]));
    this.sim = new Simulator(this.netlist);
    const net = (component: string, pin: string) => {
      const found = this.netlist.netOfPin(component, pin);
      if (found === undefined) throw new Error(`No pin ${component}.${pin} to watch.`);
      return found;
    };
    const byte = (component: string, pin: string) => Int32Array.from({ length: 8 }, (_, i) => net(component, `${pin}[${i}]`));
    this.nets = {
      pc: byte('cpu', 'PC'),
      a: byte('cpu', 'A'),
      b: byte('cpu', 'B'),
      x: byte('cpu', 'X'),
      z: net('cpu/datapath', 'Z'),
      c: net('cpu/datapath', 'C'),
      n: net('cpu/datapath', 'N'),
      halted: net('cpu', 'halted'),
      ram: Array.from({ length: RAM_SIZE }, (_, address) =>
        byte(`memory/RAM/row ${Math.floor(address / ROW_BYTES)}/byte ${address % ROW_BYTES}`, 'P')
      ),
      out: [byte('memory', 'S0'), byte('memory', 'S1')]
    };
    // Power on, and the first clock edge, which is the reset.
    this.sim.settle();
    this.sim.cycle();
  }

  /** Runs one instruction on each side, and compares. */
  step(buttons: Buttons = this.buttons): Divergence | null {
    if (buttons.up !== this.buttons.up) this.sim.set('up', buttons.up ? 1 : 0);
    if (buttons.down !== this.buttons.down) this.sim.set('down', buttons.down ? 1 : 0);
    this.buttons = buttons;
    const pc = this.emulator.state.pc;
    const word = this.rom[pc]!;
    this.emulator.step();
    this.sim.cycle();
    this.sim.cycle();
    this.instructions++;
    return this.compare(pc, word);
  }

  /** Steps until a divergence, a halt, or `limit` instructions. */
  run(limit: number, buttons?: (instruction: number) => Buttons): Divergence | null {
    for (let i = 0; i < limit && !this.emulator.state.halted; i++) {
      const divergence = this.step(buttons?.(this.instructions) ?? this.buttons);
      if (divergence !== null) return divergence;
    }
    return null;
  }

  private compare(pc: number, word: number): Divergence | null {
    const value = this.sim.value;
    const read = (nets: Int32Array) => {
      let v = 0;
      for (let i = 0; i < nets.length; i++) v |= value[nets[i]!]! << i;
      return v;
    };
    const s = this.emulator.state;
    const checks: [string, number, number][] = [
      ['PC', read(this.nets.pc), s.pc],
      ['A', read(this.nets.a), s.a],
      ['B', read(this.nets.b), s.b],
      ['X', read(this.nets.x), s.x],
      ['Z', value[this.nets.z]!, s.z ? 1 : 0],
      ['C', value[this.nets.c]!, s.c ? 1 : 0],
      ['N', value[this.nets.n]!, s.n ? 1 : 0],
      ['halted', value[this.nets.halted]!, s.halted ? 1 : 0]
    ];
    for (const [what, gates, emulator] of checks) {
      if (gates !== emulator) return this.divergence(pc, word, what, gates, emulator);
    }
    for (let address = 0; address < RAM_SIZE; address++) {
      const gates = read(this.nets.ram[address]!);
      if (gates !== this.emulator.ram[address]) {
        return this.divergence(pc, word, `RAM[0x${hex(address)}]`, gates, this.emulator.ram[address]!);
      }
    }
    for (let port = 0; port < 2; port++) {
      const gates = read(this.nets.out[port]!);
      if (gates !== this.outs[port]) return this.divergence(pc, word, `OUT ${port}`, gates, this.outs[port]!);
    }
    return null;
  }

  private divergence(pc: number, word: number, what: string, gates: number, emulator: number): Divergence {
    const text = disassemble(word);
    const differing = gates ^ emulator;
    const bit = what.length === 1 && 'ZCN'.includes(what) ? null : differing === 0 ? null : 31 - Math.clz32(differing & -differing);
    const cycle = 1 + 2 * this.instructions;
    const message =
      `Diverged at instruction ${this.instructions}, cycle ${cycle}: ${text} at 0x${hex(pc)} left ${what} ` +
      `0x${hex(gates)} on gates and 0x${hex(emulator)} in the emulator` +
      (bit === null ? '.' : `, first in bit ${bit}.`);
    return { instruction: this.instructions, cycle, pc, text, what, gates, emulator, bit, message };
  }
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

// ---------------------------------------------------------------------------
// The fuzzer
// ---------------------------------------------------------------------------

/**
 * A random program: every ROM word a random instruction the ISA defines
 * with a random operand — a port number in range, anything else any
 * byte. `HLT` is left out but for a rare one, so most programs run the
 * whole instruction budget, jumping about wherever the dice say.
 */
export function randomProgram(seed: number): Uint16Array {
  const random = seeded(seed);
  const rom = new Uint16Array(ROM_SIZE);
  const choices = INSTRUCTIONS.filter(i => i.mnemonic !== 'HLT');
  for (let at = 0; at < ROM_SIZE; at++) {
    if (random(200) === 0) continue; // HLT
    const instruction = choices[random(choices.length)]!;
    const operand = instruction.mode === 'port' ? random(PORTS) : random(256);
    rom[at] = (instruction.opcode << 8) | operand;
  }
  return rom;
}

/** Buttons that change now and then, from a seed. */
export function randomButtons(seed: number): (instruction: number) => Buttons {
  const random = seeded(seed);
  let buttons: Buttons = { up: false, down: false };
  return () => {
    if (random(16) === 0) buttons = { up: random(2) === 1, down: random(2) === 1 };
    return buttons;
  };
}

function seeded(seed: number): (below: number) => number {
  let a = seed >>> 0;
  return below => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * below);
  };
}

// ---------------------------------------------------------------------------
// Pong
// ---------------------------------------------------------------------------

/**
 * A player for Pong, reading the game from the emulator's RAM by the
 * program's names: it goes for the ball only once it's coming and within
 * `reach` columns of the left edge. At 5 it plays about as the CPU does,
 * and a game is close — the CPU won one 11–9.
 */
export function pongPlayer(lockstep: Lockstep, symbols: ReadonlyMap<string, number>, reach = 5): () => Buttons {
  const ram = lockstep.emulator.ram;
  const at = (name: string) => {
    const address = symbols.get(name);
    if (address === undefined) throw new Error(`Pong has no '${name}'.`);
    return address;
  };
  const [bx, by, dx, pl] = [at('BX'), at('BY'), at('DX'), at('PL')];
  return () => {
    const coming = ram[dx] === 0xff && ram[bx]! < reach;
    return { up: coming && ram[by]! < ram[pl]! + 1, down: coming && ram[by]! > ram[pl]! + 2 };
  };
}
