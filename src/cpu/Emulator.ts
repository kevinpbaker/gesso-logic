import { BY_OPCODE, CYCLES, PORTS, RAM_SIZE, ROM_SIZE } from './Isa';

/**
 * The reference emulator: the ISA at instruction level. It is the truth
 * the gate-level CPU is held to in lockstep (Phase 18), so it is written
 * to be read, not to be fast — one `switch` on the mnemonic, each case
 * the line of `ISA.md` it implements.
 */

/** What the CPU's devices do. A port with no handler reads 0 and ignores writes. */
export interface Devices {
  read?(port: number): number;
  write?(port: number, value: number): void;
}

export interface CpuState {
  a: number;
  b: number;
  x: number;
  pc: number;
  /** The link register: where `RET` returns to. */
  l: number;
  z: boolean;
  c: boolean;
  n: boolean;
  halted: boolean;
}

export class EmulatorError extends Error {
  readonly pc: number;

  constructor(pc: number, message: string) {
    super(message);
    this.name = 'EmulatorError';
    this.pc = pc;
  }
}

export class Emulator {
  readonly rom: Uint16Array;
  readonly ram = new Uint8Array(RAM_SIZE);
  readonly state: CpuState = { a: 0, b: 0, x: 0, pc: 0, l: 0, z: false, c: false, n: false, halted: false };
  /** Clock cycles run, and instructions. */
  cycles = 0;
  instructions = 0;
  private readonly devices: Devices;

  constructor(rom: ArrayLike<number>, devices: Devices = {}) {
    if (rom.length > ROM_SIZE) {
      throw new Error(`A ROM holds ${ROM_SIZE} words, not ${rom.length}.`);
    }
    this.rom = new Uint16Array(ROM_SIZE);
    this.rom.set(Array.from(rom, w => w & 0xffff));
    this.devices = devices;
  }

  /** Reset: every register, flag and byte of RAM cleared, as the hardware's reset line does. */
  reset(): void {
    Object.assign(this.state, { a: 0, b: 0, x: 0, pc: 0, l: 0, z: false, c: false, n: false, halted: false });
    this.ram.fill(0);
    this.cycles = 0;
    this.instructions = 0;
  }

  /** A data read: RAM below `RAM_SIZE`, 0 above. */
  load(address: number): number {
    return address < RAM_SIZE ? this.ram[address]! : 0;
  }

  store(address: number, value: number): void {
    if (address < RAM_SIZE) this.ram[address] = value & 0xff;
  }

  /** Runs one instruction; returns the cycles it took, 0 when halted. */
  step(): number {
    const s = this.state;
    if (s.halted) return 0;
    const at = s.pc;
    const word = this.rom[at]!;
    const opcode = word >> 8;
    const k = word & 0xff;
    const instruction = BY_OPCODE.get(opcode);
    if (instruction === undefined) {
      throw new EmulatorError(at, `Opcode 0x${hex(opcode)} at 0x${hex(at)} is not an instruction.`);
    }
    // Fetch: the word is in IR and PC has moved on.
    s.pc = (at + 1) & 0xff;
    const operand = (): number => {
      switch (instruction.mode) {
        case 'imm':
          return k;
        case 'abs':
          return this.load(k);
        case 'absX':
          return this.load((k + s.x) & 0xff);
        case 'b':
          return s.b;
        default:
          throw new Error(`${instruction.mnemonic} has no value operand.`);
      }
    };
    const zn = (v: number) => {
      s.z = v === 0;
      s.n = (v & 0x80) !== 0;
    };
    const subtract = (v: number) => {
      const r = (s.a - v) & 0xff;
      s.c = s.a >= v;
      zn(r);
      return r;
    };

    switch (instruction.mnemonic) {
      case 'HLT':
        s.halted = true;
        break;
      case 'NOP':
        break;
      case 'LDA':
        s.a = operand();
        break;
      case 'LDB':
        s.b = operand();
        break;
      case 'LDX':
        s.x = operand();
        break;
      case 'LDT':
        s.a = this.rom[(k + s.x) & 0xff]! & 0xff;
        break;
      case 'STA':
        this.store(instruction.mode === 'absX' ? (k + s.x) & 0xff : k, s.a);
        break;
      case 'TAX':
        s.x = s.a;
        break;
      case 'TXA':
        s.a = s.x;
        break;
      case 'TAB':
        s.b = s.a;
        break;
      case 'TBA':
        s.a = s.b;
        break;
      case 'ADD': {
        const sum = s.a + operand();
        s.c = sum > 0xff;
        s.a = sum & 0xff;
        zn(s.a);
        break;
      }
      case 'SUB':
        s.a = subtract(operand());
        break;
      case 'CMP':
        subtract(operand());
        break;
      case 'AND':
        s.a &= operand();
        zn(s.a);
        break;
      case 'OR':
        s.a |= operand();
        zn(s.a);
        break;
      case 'XOR':
        s.a ^= operand();
        zn(s.a);
        break;
      case 'SHL':
        s.c = (s.a & 0x80) !== 0;
        s.a = (s.a << 1) & 0xff;
        zn(s.a);
        break;
      case 'SHR':
        s.c = (s.a & 1) !== 0;
        s.a >>= 1;
        zn(s.a);
        break;
      case 'INX':
        s.x = (s.x + 1) & 0xff;
        zn(s.x);
        break;
      case 'DEX':
        s.x = (s.x - 1) & 0xff;
        zn(s.x);
        break;
      case 'JMP':
        s.pc = k;
        break;
      case 'JZ':
        if (s.z) s.pc = k;
        break;
      case 'JNZ':
        if (!s.z) s.pc = k;
        break;
      case 'JC':
        if (s.c) s.pc = k;
        break;
      case 'JNC':
        if (!s.c) s.pc = k;
        break;
      case 'JN':
        if (s.n) s.pc = k;
        break;
      case 'JNN':
        if (!s.n) s.pc = k;
        break;
      case 'CALL':
        s.l = s.pc;
        s.pc = k;
        break;
      case 'RET':
        s.pc = s.l;
        break;
      case 'IN':
        s.a = k < PORTS ? (this.devices.read?.(k) ?? 0) & 0xff : 0;
        break;
      case 'OUT':
        if (k < PORTS) this.devices.write?.(k, s.a);
        break;
      default:
        throw new Error(`The emulator does not implement ${instruction.mnemonic}.`);
    }
    this.cycles += CYCLES;
    this.instructions++;
    return CYCLES;
  }

  /** Runs until `HLT`, or throws after `limit` instructions. */
  run(limit = 1_000_000): void {
    for (let i = 0; i < limit; i++) {
      if (this.state.halted) return;
      this.step();
    }
    if (!this.state.halted) {
      throw new EmulatorError(this.state.pc, `Still running after ${limit} instructions, at 0x${hex(this.state.pc)}.`);
    }
  }
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}
