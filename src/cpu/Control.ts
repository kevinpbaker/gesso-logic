import { INSTRUCTIONS, type Instruction } from './Isa';

/**
 * The control table: which of the datapath's control lines each
 * instruction raises on each of its two cycles. Phase 15 drives the
 * datapath from switches set by this table; Phase 16 turns the same
 * table into gates, one row an opcode, and holds the gates to it.
 *
 * The datapath (see `datapath` in `src/app/Generators.ts`) writes every
 * register from the ALU's result `Y`: a load is the ALU passing its right
 * operand through, a transfer passing its left, so there is one bus into
 * the registers and the flags change only where `lzn` and `lc` say so.
 */

/** The ALU's operations, by the code on its `op` pins. */
export const ALU_OP = {
  ADD: 0,
  SUB: 1,
  AND: 2,
  OR: 3,
  XOR: 4,
  /** Y ← R */
  PASS_R: 5,
  /** Y ← L */
  PASS_L: 6,
  INC: 7,
  DEC: 8,
  SHL: 9,
  SHR: 10
} as const;
export type AluOp = keyof typeof ALU_OP;

/** The ALU's right operand, by the code on the datapath's `right` pins. */
export const RIGHT = { K: 0, B: 1, M: 2, ZERO: 3 } as const;
export type Right = keyof typeof RIGHT;

/** When a jump is taken: always, or on a flag. */
export type Condition = 'always' | 'Z' | 'NZ' | 'C' | 'NC' | 'N' | 'NN';

/** What `M`, the datapath's data input, carries on a cycle: a RAM byte, a ROM table byte, or a port. */
export type Source = 'ram' | 'table' | 'port';

export interface Lines {
  /** IR ← the ROM word at PC. */
  readonly ir?: boolean;
  /** PC ← PC + 1. */
  readonly inc?: boolean;
  /** PC ← K, or L with `ret`, when the condition holds. */
  readonly jump?: Condition;
  readonly ret?: boolean;
  /** L ← PC. */
  readonly link?: boolean;
  /** A, B, X ← Y. */
  readonly la?: boolean;
  readonly lb?: boolean;
  readonly lx?: boolean;
  /** Z and N ← the ALU's; C ← the ALU's. */
  readonly lzn?: boolean;
  readonly lc?: boolean;
  readonly op?: AluOp;
  /** The ALU's left operand is X, not A. */
  readonly left?: 'X';
  readonly right?: Right;
  /** The data address is K + X, not K. */
  readonly index?: boolean;
  /** What drives `M`. */
  readonly source?: Source;
  /** RAM[address] ← A, while the clock is low. */
  readonly store?: boolean;
  /** The port K ← A. */
  readonly out?: boolean;
  /** Stop. */
  readonly halt?: boolean;
}

/** Every instruction's first cycle: fetch. */
export const FETCH: Lines = { ir: true, inc: true };

const ALU_OF: Record<string, AluOp> = { ADD: 'ADD', SUB: 'SUB', AND: 'AND', OR: 'OR', XOR: 'XOR', CMP: 'SUB' };
const RIGHT_OF: Record<string, Right> = { imm: 'K', b: 'B', abs: 'M', absX: 'M' };
const CONDITION_OF: Record<string, Condition> = { JMP: 'always', JZ: 'Z', JNZ: 'NZ', JC: 'C', JNC: 'NC', JN: 'N', JNN: 'NN' };

/** An instruction's second cycle: execute. */
export function execute(instruction: Instruction): Lines {
  const { mnemonic, mode } = instruction;
  const memory = mode === 'abs' || mode === 'absX' ? { source: 'ram' as const, ...(mode === 'absX' ? { index: true } : {}) } : {};
  const load = (register: 'la' | 'lb' | 'lx'): Lines => ({ [register]: true, op: 'PASS_R', right: RIGHT_OF[mode]!, ...memory });
  switch (mnemonic) {
    case 'HLT':
      return { halt: true };
    case 'NOP':
      return {};
    case 'LDA':
      return load('la');
    case 'LDB':
      return load('lb');
    case 'LDX':
      return load('lx');
    case 'LDT':
      return { la: true, op: 'PASS_R', right: 'M', index: true, source: 'table' };
    case 'STA':
      return { store: true, ...memory };
    case 'TAX':
      return { lx: true, op: 'PASS_L' };
    case 'TXA':
      return { la: true, op: 'PASS_L', left: 'X' };
    case 'TAB':
      return { lb: true, op: 'PASS_L' };
    case 'TBA':
      return { la: true, op: 'PASS_R', right: 'B' };
    case 'ADD':
    case 'SUB':
    case 'AND':
    case 'OR':
    case 'XOR':
    case 'CMP':
      return {
        ...(mnemonic === 'CMP' ? {} : { la: true }),
        lzn: true,
        ...(instruction.c === '*' ? { lc: true } : {}),
        op: ALU_OF[mnemonic]!,
        right: RIGHT_OF[mode]!,
        ...memory
      };
    case 'SHL':
    case 'SHR':
      return { la: true, lzn: true, lc: true, op: mnemonic };
    case 'INX':
      return { lx: true, lzn: true, op: 'INC', left: 'X' };
    case 'DEX':
      return { lx: true, lzn: true, op: 'DEC', left: 'X' };
    case 'CALL':
      return { jump: 'always', link: true };
    case 'RET':
      return { jump: 'always', ret: true };
    case 'IN':
      return { la: true, op: 'PASS_R', right: 'M', source: 'port' };
    case 'OUT':
      return { out: true };
    default:
      if (CONDITION_OF[mnemonic] !== undefined) return { jump: CONDITION_OF[mnemonic] };
      throw new Error(`No control lines for ${mnemonic}.`);
  }
}

/** Every opcode's execute lines, by opcode. */
export const EXECUTE: ReadonlyMap<number, Lines> = new Map(INSTRUCTIONS.map(i => [i.opcode, execute(i)]));

/** Whether a jump's condition holds on these flags. */
export function taken(condition: Condition, flags: { z: boolean; c: boolean; n: boolean }): boolean {
  switch (condition) {
    case 'always':
      return true;
    case 'Z':
      return flags.z;
    case 'NZ':
      return !flags.z;
    case 'C':
      return flags.c;
    case 'NC':
      return !flags.c;
    case 'N':
      return flags.n;
    case 'NN':
      return !flags.n;
  }
}

