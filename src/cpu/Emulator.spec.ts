import { describe, expect, it } from 'vitest';

import { assemble } from './Assembler';
import { Emulator, EmulatorError } from './Emulator';
import { CYCLES } from './Isa';

describe('the emulator', () => {
  it('counts two cycles an instruction, and leaves PC past the HLT', () => {
    const emulator = new Emulator(assemble('NOP\nNOP\nHLT').rom);
    emulator.run();
    expect(emulator.instructions).toBe(3);
    expect(emulator.cycles).toBe(3 * CYCLES);
    expect(emulator.state.pc).toBe(3);
    expect(emulator.step()).toBe(0);
  });

  it('wraps the PC from the last ROM word to the first', () => {
    const emulator = new Emulator(assemble('HLT\n.org 0xFF\nNOP').rom);
    emulator.state.pc = 0xff;
    emulator.run();
    expect(emulator.state.pc).toBe(1);
  });

  it('stops on a reserved opcode, naming it and where', () => {
    const emulator = new Emulator([0x0100, 0x0200]);
    expect(() => emulator.run()).toThrow(new EmulatorError(1, 'Opcode 0x02 at 0x01 is not an instruction.'));
  });

  it('gives up on a program that never halts, rather than hanging', () => {
    const emulator = new Emulator(assemble('loop: JMP loop').rom);
    expect(() => emulator.run(1000)).toThrow(/Still running after 1000 instructions/);
  });

  it('resets every register, flag and byte of RAM', () => {
    const emulator = new Emulator(assemble('LDA #0xFF\nSTA 0x7F\nADD #1\nLDX #3\nCALL 0\nHLT').rom);
    for (let i = 0; i < 5; i++) emulator.step();
    expect(emulator.state.l).toBe(5);
    emulator.reset();
    expect(emulator.state).toEqual({ a: 0, b: 0, x: 0, pc: 0, l: 0, z: false, c: false, n: false, halted: false });
    expect(emulator.ram.every(b => b === 0)).toBe(true);
    expect(emulator.cycles).toBe(0);
  });
});
