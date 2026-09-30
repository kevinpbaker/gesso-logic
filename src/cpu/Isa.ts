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
  /** What it does, in words, for someone who does not read the notation yet. */
  readonly about: string;
}

/** Clock cycles an instruction takes: fetch, then execute. The same for every one. */
export const CYCLES = 2;

const row = (opcode: number, mnemonic: string, mode: Mode, flags: string, effect: string, about: string): Instruction => ({
  opcode,
  mnemonic,
  mode,
  z: flags[0] as FlagEffect,
  c: flags[1] as FlagEffect,
  n: flags[2] as FlagEffect,
  effect,
  about
});

/** The ALU's operations, in opcode order within each operand form. */
export const ALU_OPS = ['ADD', 'SUB', 'AND', 'OR', 'XOR', 'CMP'] as const;
/** Each operation's flags, effect and words; `v` in the effect and `the value` in the words stand for the operand. */
const ALU_EFFECT: Record<(typeof ALU_OPS)[number], [string, string, string]> = {
  ADD: ['***', 'A ← A + v; C ← carry out', 'Adds the value to A. C is set when the sum is too big for a byte.'],
  SUB: ['***', 'A ← A − v; C ← 1 when no borrow (A ≥ v)', 'Subtracts the value from A. C is set when A was at least the value.'],
  AND: ['*-*', 'A ← A ∧ v', 'Keeps only the bits of A that are also set in the value.'],
  OR: ['*-*', 'A ← A ∨ v', 'Sets in A every bit that is set in the value.'],
  XOR: ['*-*', 'A ← A ⊕ v', 'Flips the bits of A that are set in the value.'],
  CMP: ['***', 'A − v, flags only; C ← 1 when A ≥ v', 'Compares A with the value without changing A: Z when equal, C when A is at least the value.']
};
const ALU_FORMS: readonly [number, Mode, string, string][] = [
  [0x30, 'imm', 'k', 'the number k'],
  [0x40, 'b', 'B', 'B'],
  [0x50, 'abs', 'M[a]', 'the byte at address a']
];

export const INSTRUCTIONS: readonly Instruction[] = [
  row(0x00, 'HLT', 'none', '---', 'stop; PC is left past the HLT', 'Stops the program.'),
  row(0x01, 'NOP', 'none', '---', 'nothing', 'Does nothing for one instruction.'),

  row(0x10, 'LDA', 'imm', '---', 'A ← k', 'Loads the number k into A.'),
  row(0x11, 'LDA', 'abs', '---', 'A ← M[a]', 'Loads A from the byte at address a.'),
  row(0x12, 'LDA', 'absX', '---', 'A ← M[a + X]', 'Loads A from address a plus X: the X-th byte of a list.'),
  row(0x14, 'LDB', 'imm', '---', 'B ← k', 'Loads the number k into B.'),
  row(0x15, 'LDB', 'abs', '---', 'B ← M[a]', 'Loads B from the byte at address a.'),
  row(0x18, 'LDX', 'imm', '---', 'X ← k', 'Loads the number k into X.'),
  row(0x19, 'LDX', 'abs', '---', 'X ← M[a]', 'Loads X from the byte at address a.'),
  row(0x1c, 'LDT', 'table', '---', 'A ← low byte of ROM[t + X]', 'Reads the X-th entry of a .byte table in the program into A.'),

  row(0x20, 'STA', 'abs', '---', 'M[a] ← A', 'Stores A at address a.'),
  row(0x21, 'STA', 'absX', '---', 'M[a + X] ← A', 'Stores A at address a plus X: the X-th byte of a list.'),

  row(0x28, 'TAX', 'none', '---', 'X ← A', 'Copies A into X.'),
  row(0x29, 'TXA', 'none', '---', 'A ← X', 'Copies X into A.'),
  row(0x2a, 'TAB', 'none', '---', 'B ← A', 'Copies A into B.'),
  row(0x2b, 'TBA', 'none', '---', 'A ← B', 'Copies B into A.'),

  ...ALU_FORMS.flatMap(([base, mode, v, words]) =>
    ALU_OPS.map((op, i) => {
      const [flags, effect, about] = ALU_EFFECT[op];
      return row(base + i, op, mode, flags, effect.replaceAll('v', v), about.replaceAll('the value', words));
    })
  ),

  row(0x60, 'SHL', 'none', '***', 'C ← A bit 7; A ← A << 1', 'Shifts A one bit left, doubling it; the bit that falls off goes into C.'),
  row(0x61, 'SHR', 'none', '***', 'C ← A bit 0; A ← A >> 1, a 0 shifted in', 'Shifts A one bit right, halving it; the bit that falls off goes into C.'),
  row(0x62, 'INX', 'none', '*-*', 'X ← X + 1', 'Adds 1 to X.'),
  row(0x63, 'DEX', 'none', '*-*', 'X ← X − 1', 'Takes 1 from X.'),

  row(0x70, 'JMP', 'target', '---', 'PC ← t', 'Jumps to t.'),
  row(0x71, 'JZ', 'target', '---', 'PC ← t if Z', 'Jumps to t if Z is set: the last calculation gave 0.'),
  row(0x72, 'JNZ', 'target', '---', 'PC ← t if not Z', 'Jumps to t if Z is clear: the last calculation did not give 0.'),
  row(0x73, 'JC', 'target', '---', 'PC ← t if C', 'Jumps to t if C is set: a carry, or A was at least the value compared.'),
  row(0x74, 'JNC', 'target', '---', 'PC ← t if not C', 'Jumps to t if C is clear: no carry, or A was less than the value compared.'),
  row(0x75, 'JN', 'target', '---', 'PC ← t if N', 'Jumps to t if N is set: the last calculation had bit 7 set.'),
  row(0x76, 'JNN', 'target', '---', 'PC ← t if not N', 'Jumps to t if N is clear: the last calculation had bit 7 clear.'),
  row(0x78, 'CALL', 'target', '---', 'L ← PC; PC ← t', 'Calls the subroutine at t, remembering where to come back to.'),
  row(0x79, 'RET', 'none', '---', 'PC ← L', 'Returns from a subroutine to just after its CALL.'),

  row(0x80, 'IN', 'port', '---', 'A ← port p', 'Reads port p into A: the buttons, or the frame tick.'),
  row(0x81, 'OUT', 'port', '---', 'port p ← A', 'Writes A to port p: a score display.')
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

/** How `ISA.md` writes an operand form, with the operand's letter: `#k`, `a,X`, `t`. */
const WRITTEN: Record<Mode, string> = {
  none: '',
  imm: '#k',
  abs: 'a',
  absX: 'a,X',
  b: 'B',
  target: 't',
  port: 'p',
  table: 't,X'
};

/** An instruction as `ISA.md`'s table writes it: `LDA a,X`. */
export function written(instruction: Instruction): string {
  return `${instruction.mnemonic} ${WRITTEN[instruction.mode]}`.trim();
}

/** The instructions by what they do, for the reference in the Help menu. Each opcode is in exactly one. */
export const INSTRUCTION_GROUPS: readonly { readonly title: string; readonly instructions: readonly Instruction[] }[] = (
  [
    ['Loads', 0x10, 0x1f],
    ['Stores', 0x20, 0x27],
    ['Transfers', 0x28, 0x2f],
    ['Arithmetic and logic', 0x30, 0x5f],
    ['Shifts and counting', 0x60, 0x6f],
    ['Jumps and calls', 0x70, 0x7f],
    ['Input and output', 0x80, 0x8f],
    ['Control', 0x00, 0x0f]
  ] as const
).map(([title, from, to]) => ({ title, instructions: INSTRUCTIONS.filter(i => i.opcode >= from && i.opcode <= to) }));
