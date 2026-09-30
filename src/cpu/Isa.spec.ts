import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { disassemble } from './Assembler';
import { INSTRUCTION_GROUPS, INSTRUCTIONS, written } from './Isa';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('the ISA', () => {
  it('is the table in ISA.md, row for row: opcode, instruction and flags', () => {
    const text = readFileSync(join(HERE, '../../ISA.md'), 'utf8');
    const rows = [...text.matchAll(/^\| `([0-9A-F]{2})` \| `([^`]+)` \| ([-*]) ([-*]) ([-*]) \|/gm)].map(m => m.slice(1, 6).join(' '));
    const table = INSTRUCTIONS.map(i =>
      [i.opcode.toString(16).toUpperCase().padStart(2, '0'), written(i), i.z, i.c, i.n].join(' ')
    );
    expect(rows).toEqual(table);
  });

  it('gives every opcode one instruction, and every mnemonic each form once', () => {
    expect(new Set(INSTRUCTIONS.map(i => i.opcode)).size).toBe(INSTRUCTIONS.length);
    expect(new Set(INSTRUCTIONS.map(i => `${i.mnemonic} ${i.mode}`)).size).toBe(INSTRUCTIONS.length);
    expect(INSTRUCTIONS.every(i => i.opcode >= 0 && i.opcode <= 0xff)).toBe(true);
  });

  it('puts every instruction in one group of the reference', () => {
    const grouped = INSTRUCTION_GROUPS.flatMap(g => g.instructions);
    expect(grouped.length).toBe(INSTRUCTIONS.length);
    expect(new Set(grouped).size).toBe(INSTRUCTIONS.length);
  });

  it('says what every instruction does in words', () => {
    for (const i of INSTRUCTIONS) expect(i.about, written(i)).toMatch(/^[A-Z].*\.$/);
  });

  it('halts on an empty ROM word', () => {
    expect(disassemble(0x0000)).toBe('HLT');
  });
});
