import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { disassemble } from './Assembler';
import { INSTRUCTIONS, type Mode } from './Isa';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The operand as `ISA.md` writes it. */
const WRITTEN: Record<Mode, string> = { none: '', imm: '#k', abs: 'a', absX: 'a,X', b: 'B', target: 't', port: 'p', table: 't,X' };

describe('the ISA', () => {
  it('is the table in ISA.md, row for row: opcode, instruction and flags', () => {
    const text = readFileSync(join(HERE, '../../ISA.md'), 'utf8');
    const rows = [...text.matchAll(/^\| `([0-9A-F]{2})` \| `([^`]+)` \| ([-*]) ([-*]) ([-*]) \|/gm)].map(m => m.slice(1, 6).join(' '));
    const table = INSTRUCTIONS.map(i =>
      [i.opcode.toString(16).toUpperCase().padStart(2, '0'), `${i.mnemonic} ${WRITTEN[i.mode]}`.trim(), i.z, i.c, i.n].join(' ')
    );
    expect(rows).toEqual(table);
  });

  it('gives every opcode one instruction, and every mnemonic each form once', () => {
    expect(new Set(INSTRUCTIONS.map(i => i.opcode)).size).toBe(INSTRUCTIONS.length);
    expect(new Set(INSTRUCTIONS.map(i => `${i.mnemonic} ${i.mode}`)).size).toBe(INSTRUCTIONS.length);
    expect(INSTRUCTIONS.every(i => i.opcode >= 0 && i.opcode <= 0xff)).toBe(true);
  });

  it('halts on an empty ROM word', () => {
    expect(disassemble(0x0000)).toBe('HLT');
  });
});
