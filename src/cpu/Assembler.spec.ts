import { describe, expect, it } from 'vitest';

import { assemble, AssemblyError, disassemble, readRomImage, romImage } from './Assembler';
import { INSTRUCTIONS } from './Isa';

/** The problems an assembly reports, as `line: message`. */
function problems(source: string): string[] {
  try {
    assemble(source);
  } catch (error) {
    if (error instanceof AssemblyError) return error.problems.map(p => `${p.line}: ${p.message}`);
    throw error;
  }
  return [];
}

describe('the assembler', () => {
  it('encodes every instruction, and disassembles it back', () => {
    for (const instruction of INSTRUCTIONS) {
      const word = (instruction.opcode << 8) | (instruction.mode === 'port' ? 2 : instruction.mode === 'none' || instruction.mode === 'b' ? 0 : 0x5a);
      const text = disassemble(word);
      expect(assemble(text).rom[0], text).toBe(word);
    }
  });

  it('resolves labels forwards and backwards, and constants in terms of each other', () => {
    const { rom, symbols, size } = assemble(`
      TOP = END - 1
      END = 0x80
      back:   JMP ahead
              LDA #TOP
      ahead:  JMP back
    `);
    expect([...rom.slice(0, size)]).toEqual([0x7002, 0x107f, 0x7000]);
    expect(symbols.get('TOP')).toBe(0x7f);
    expect(symbols.get('ahead')).toBe(2);
  });

  it('reads numbers in each base, characters, sums, and negatives as two’s complement', () => {
    const { rom } = assemble(`
      LDA #10
      LDA #0x1F
      LDA #0b101
      LDA #'A'
      LDA #3 + 4 - 2
      LDA #-1
      LDA #';'   ; a semicolon in quotes is not a comment
    `);
    expect([...rom.slice(0, 7)].map(w => w & 0xff)).toEqual([10, 0x1f, 5, 65, 5, 0xff, 59]);
  });

  it('puts .byte values in words of their own, and .org moves on', () => {
    const { rom, size, symbols } = assemble(`
            NOP
      data: .byte 1, 2, 'z'
            .org 0x10
      here: HLT
            .byte 0xFF
    `);
    expect([...rom.slice(0, 4)]).toEqual([0x0100, 1, 2, 122]);
    expect(symbols.get('here')).toBe(0x10);
    expect(rom[0x11]).toBe(0xff);
    expect(size).toBe(0x12);
  });

  it('knows each mnemonic’s forms: case-blind, with B and X', () => {
    const { rom } = assemble(`
      lda 0x10,x
      add b
      Sta 0x20,X
      ldt 0x30,X
    `);
    expect([...rom.slice(0, 4)]).toEqual([0x1210, 0x4000, 0x2120, 0x1c30]);
  });

  it('reports every error, each with its line', () => {
    expect(
      problems(`LDA #1
        FROB 3
        LDB 0x10,X
        LDA #300
        JMP nowhere
        again: NOP
        again: NOP
        OUT 7
        B = 3
        .word 5
        HLT 1
        LDA #1 +`)
    ).toEqual([
      "2: 'FROB' is not an instruction.",
      '3: LDB has no indexed form; it takes #value or an address.',
      "4: The value 300 doesn't fit in a byte.",
      "5: 'nowhere' is not defined.",
      "7: 'again' is already defined, on line 6.",
      '8: There is no port 7; ports are 0 to 3.',
      "9: 'B' can't be a name: it is a register.",
      "10: '.word' is not a directive. There are .byte and .org.",
      '11: HLT has no address form; it takes no operand.',
      "12: '1 +' is not a value."
    ]);
  });

  it('refuses a constant defined in terms of itself, and a program too big for the ROM', () => {
    expect(problems('A1 = A2\nA2 = A1\nLDA #A1')).toEqual(["2: 'A1' is defined in terms of itself."]);
    expect(problems(Array(257).fill('NOP').join('\n'))[0]).toBe('257: The program is past the end of the ROM, which holds 256 words.');
    expect(problems('NOP\nNOP\n.org 1')).toEqual(['3: .org 0x01 would go back, to before 0x02.']);
    expect(problems('.org LATER\nLATER = 4')[0]).toMatch(/^1: \.org needs a value made of numbers and names defined above it/);
  });

  it('writes a ROM image that reads back the same, and refuses a bad one', () => {
    const { rom } = assemble('start: LDA #0x12\nJMP start\n.org 0xFF\n.byte 0xAB');
    const image = romImage(rom);
    expect(image.split('\n')[0]).toBe('1012 7000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000');
    expect(readRomImage(image)).toEqual(rom);
    expect(readRomImage('# a comment\n1012   7000')[1]).toBe(0x7000);
    expect(() => readRomImage('1012 zz')).toThrow("Word 1 of the ROM image, 'zz', is not four hex digits.");
  });
});
