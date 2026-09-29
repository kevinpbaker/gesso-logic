/**
 * The instruction set, as data: every opcode, its mnemonic and operand
 * form, and what it does to the flags. `ISA.md` is the prose; this is
 * the table the emulator executes, the assembler encodes and
 * `Isa.spec.ts` holds `ISA.md` to. The gate-level control unit of Phase
 * 16 is checked against it row by row.
 *
 * An instruction is one 16-bit ROM word: the opcode in the high byte,
 * the operand in the low. Every instruction takes two clock cycles, a
 * fetch and an execute.
 */

/**
 * How an instruction reads its operand byte.
 *
 *   - `none`: it has none; the assembler writes 0.
 *   - `imm`: the byte itself, `#value`.
 *   - `abs`: the data address it names, `addr`.
 *   - `absX`: that address plus X, wrapping at 256, `addr,X`.
 *   - `b`: register B, `B`; the operand byte is unused.
 *   - `target`: a ROM address to jump to, `label`.
 *   - `port`: an I/O port number, `0`–`3`.
 *   - `table`: ROM address plus X; the low byte of that word, `table,X`.
 */
export type Mode = 'none' | 'imm' | 'abs' | 'absX' | 'b' | 'target' | 'port' | 'table';

/** A flag and what an instruction does to it: `*` set from the result, `-` left alone. */
export type FlagEffect = '*' | '-';

export interface Instruction {
  readonly opcode: number;
  readonly mnemonic: string;
  readonly mode: Mode;
  readonly z: FlagEffect;
  readonly c: FlagEffect;
  readonly n: FlagEffect;
  /** What it does, in the notation of `ISA.md`. */
  readonly effect: string;
}

/** Clock cycles an instruction takes: fetch, then execute. The same for every one. */
export const CYCLES = 2;

const row = (opcode: number, mnemonic: string, mode: Mode, flags: string, effect: string): Instruction => ({
  opcode,
  mnemonic,
  mode,
  z: flags[0] as FlagEffect,
  c: flags[1] as FlagEffect,
  n: flags[2] as FlagEffect,
  effect
});

/** The ALU's operations, in opcode order within each operand form. */
export const ALU_OPS = ['ADD', 'SUB', 'AND', 'OR', 'XOR', 'CMP'] as const;
const ALU_EFFECT: Record<(typeof ALU_OPS)[number], [string, string]> = {
  ADD: ['***', 'A ← A + v; C ← carry out'],
  SUB: ['***', 'A ← A − v; C ← 1 when no borrow (A ≥ v)'],
  AND: ['*-*', 'A ← A ∧ v'],
  OR: ['*-*', 'A ← A ∨ v'],
  XOR: ['*-*', 'A ← A ⊕ v'],
  CMP: ['***', 'A − v, flags only; C ← 1 when A ≥ v']
};
const ALU_FORMS: readonly [number, Mode, string][] = [
  [0x30, 'imm', 'k'],
  [0x40, 'b', 'B'],
  [0x50, 'abs', 'M[a]']
];

export const INSTRUCTIONS: readonly Instruction[] = [
  row(0x00, 'HLT', 'none', '---', 'stop; PC is left past the HLT'),
  row(0x01, 'NOP', 'none', '---', 'nothing'),

  row(0x10, 'LDA', 'imm', '---', 'A ← k'),
  row(0x11, 'LDA', 'abs', '---', 'A ← M[a]'),
  row(0x12, 'LDA', 'absX', '---', 'A ← M[a + X]'),
  row(0x14, 'LDB', 'imm', '---', 'B ← k'),
  row(0x15, 'LDB', 'abs', '---', 'B ← M[a]'),
  row(0x18, 'LDX', 'imm', '---', 'X ← k'),
  row(0x19, 'LDX', 'abs', '---', 'X ← M[a]'),
  row(0x1c, 'LDT', 'table', '---', 'A ← low byte of ROM[t + X]'),

  row(0x20, 'STA', 'abs', '---', 'M[a] ← A'),
  row(0x21, 'STA', 'absX', '---', 'M[a + X] ← A'),

  row(0x28, 'TAX', 'none', '---', 'X ← A'),
  row(0x29, 'TXA', 'none', '---', 'A ← X'),
  row(0x2a, 'TAB', 'none', '---', 'B ← A'),
  row(0x2b, 'TBA', 'none', '---', 'A ← B'),

  ...ALU_FORMS.flatMap(([base, mode, v]) =>
    ALU_OPS.map((op, i) => row(base + i, op, mode, ALU_EFFECT[op][0], ALU_EFFECT[op][1].replaceAll('v', v)))
  ),

  row(0x60, 'SHL', 'none', '***', 'C ← A bit 7; A ← A << 1'),
  row(0x61, 'SHR', 'none', '***', 'C ← A bit 0; A ← A >> 1, a 0 shifted in'),
  row(0x62, 'INX', 'none', '*-*', 'X ← X + 1'),
  row(0x63, 'DEX', 'none', '*-*', 'X ← X − 1'),

  row(0x70, 'JMP', 'target', '---', 'PC ← t'),
  row(0x71, 'JZ', 'target', '---', 'PC ← t if Z'),
  row(0x72, 'JNZ', 'target', '---', 'PC ← t if not Z'),
  row(0x73, 'JC', 'target', '---', 'PC ← t if C'),
  row(0x74, 'JNC', 'target', '---', 'PC ← t if not C'),
  row(0x75, 'JN', 'target', '---', 'PC ← t if N'),
  row(0x76, 'JNN', 'target', '---', 'PC ← t if not N'),
  row(0x78, 'CALL', 'target', '---', 'L ← PC; PC ← t'),
  row(0x79, 'RET', 'none', '---', 'PC ← L'),

  row(0x80, 'IN', 'port', '---', 'A ← port p'),
  row(0x81, 'OUT', 'port', '---', 'port p ← A')
];

export const BY_OPCODE: ReadonlyMap<number, Instruction> = new Map(INSTRUCTIONS.map(i => [i.opcode, i]));

/** Each mnemonic's forms, by mode. */
export const BY_MNEMONIC: ReadonlyMap<string, ReadonlyMap<Mode, Instruction>> = (() => {
  const map = new Map<string, Map<Mode, Instruction>>();
  for (const instruction of INSTRUCTIONS) {
    let forms = map.get(instruction.mnemonic);
    if (forms === undefined) map.set(instruction.mnemonic, (forms = new Map()));
    forms.set(instruction.mode, instruction);
  }
  return map;
})();

/** The data address space: RAM at `0x00`–`0x7F`, the framebuffer its top half. Above it reads 0 and ignores writes. */
export const RAM_SIZE = 128;
export const FRAMEBUFFER = 0x40;
/** Ports that exist; the rest read 0 and ignore writes. */
export const PORTS = 4;
export const ROM_SIZE = 256;
