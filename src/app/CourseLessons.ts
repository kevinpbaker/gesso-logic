import type { Kind } from '../sim/Primitives';

/**
 * The course: a computer's parts built one at a time from NAND gates,
 * each lesson a chip made from the chips of the lessons before it.
 *
 * Only words and rules here — no circuits — so the page can show the
 * lessons without the simulator. `Course.ts` builds each lesson's circuit
 * and grades it. A lesson's tests are `CircuitTests.ts` text, its circuit
 * starts with a switch for each input and an LED for each output, named
 * as the tests name them, and a lesson passes when its tests do and it
 * uses only the parts it allows.
 */

export interface Lesson {
  readonly id: string;
  readonly title: string;
  /** What the finished circuit is called as a chip, in the lessons after it. */
  readonly chip: string;
  /** What to build and why, a paragraph a string. */
  readonly brief: readonly string[];
  /** A nudge for someone stuck, short of the answer. */
  readonly hint: string;
  readonly inputs: readonly { readonly name: string; readonly width?: number }[];
  readonly outputs: readonly { readonly name: string; readonly width?: number }[];
  /** Parts it may use besides switches, LEDs, probes, constants, notes and named wires: kinds, and chips of earlier lessons. */
  readonly kinds: readonly Kind[];
  readonly chips: readonly string[];
  readonly tests: string;
}

export const LESSONS: readonly Lesson[] = [
  {
    id: 'not',
    title: 'NOT from NAND',
    chip: 'NOT',
    brief: [
      'Every part of the computer can be built from one gate: NAND, which is 0 only when both its inputs are 1.',
      'Start small. Build NOT — out is the opposite of a — from a single NAND.'
    ],
    hint: 'A NAND with the same signal on both inputs is 0 only when that signal is 1.',
    inputs: [{ name: 'a' }],
    outputs: [{ name: 'out' }],
    kinds: ['nand'],
    chips: [],
    tests: 'a | out\n0 | 1\n1 | 0\n'
  },
  {
    id: 'and',
    title: 'AND',
    chip: 'AND',
    brief: [
      'AND is 1 only when a and b are both 1: exactly the opposite of NAND.',
      'Your NOT is in the palette now, under This circuit’s chips — or use the NOT gate, now that you have built one.'
    ],
    hint: 'AND is NOT of NAND.',
    inputs: [{ name: 'a' }, { name: 'b' }],
    outputs: [{ name: 'out' }],
    kinds: ['nand'],
    chips: ['NOT'],
    tests: 'a b | out\n0 0 | 0\n0 1 | 0\n1 0 | 0\n1 1 | 1\n'
  },
  {
    id: 'or',
    title: 'OR',
    chip: 'OR',
    brief: ['OR is 1 when a or b, or both, is 1.', 'There is a neat way with NAND and NOT: think about when OR is 0.'],
    hint: 'OR is 0 only when both are 0 — NAND of the two inputs, each turned over.',
    inputs: [{ name: 'a' }, { name: 'b' }],
    outputs: [{ name: 'out' }],
    kinds: ['nand'],
    chips: ['NOT'],
    tests: 'a b | out\n0 0 | 0\n0 1 | 1\n1 0 | 1\n1 1 | 1\n'
  },
  {
    id: 'xor',
    title: 'XOR',
    chip: 'XOR',
    brief: ['XOR is 1 when a and b differ. It is how a computer adds a column of bits.', 'You have NAND, NOT, AND and OR to choose from.'],
    hint: 'a and b differ when at least one is 1 (OR) and not both are (NAND): both of those at once.',
    inputs: [{ name: 'a' }, { name: 'b' }],
    outputs: [{ name: 'out' }],
    kinds: ['nand'],
    chips: ['NOT', 'AND', 'OR'],
    tests: 'a b | out\n0 0 | 0\n0 1 | 1\n1 0 | 1\n1 1 | 0\n'
  },
  {
    id: 'half adder',
    title: 'Half adder',
    chip: 'half adder',
    brief: [
      'Adding two bits gives a two-bit answer: a sum, s, and a carry, c, which is 1 only for 1 + 1.',
      'That is the first step of every adder in the computer.'
    ],
    hint: 'Look at the table: s is one of your chips, and so is c.',
    inputs: [{ name: 'a' }, { name: 'b' }],
    outputs: [{ name: 's' }, { name: 'c' }],
    kinds: [],
    chips: ['XOR', 'AND'],
    tests: 'a b | s c\n0 0 | 0 0\n0 1 | 1 0\n1 0 | 1 0\n1 1 | 0 1\n'
  },
  {
    id: 'full adder',
    title: 'Full adder',
    chip: 'full adder',
    brief: [
      'A column in the middle of a sum adds three bits: a, b, and the carry in from the column to its right, cin.',
      'Build it from two half adders: one adds a and b, the other adds cin to that.'
    ],
    hint: 'There is a carry out when either half adder carries.',
    inputs: [{ name: 'a' }, { name: 'b' }, { name: 'cin' }],
    outputs: [{ name: 's' }, { name: 'cout' }],
    kinds: [],
    chips: ['half adder', 'OR'],
    tests:
      'a b cin | s cout\n0 0 0 | 0 0\n0 0 1 | 1 0\n0 1 0 | 1 0\n0 1 1 | 0 1\n1 0 0 | 1 0\n1 0 1 | 0 1\n1 1 0 | 0 1\n1 1 1 | 1 1\n'
  },
  {
    id: 'adder 4',
    title: 'A 4-bit adder',
    chip: 'adder 4',
    brief: [
      'Now add numbers. A and B are 4-bit buses, 0 to 15; S is their sum and cout the carry out of the top bit.',
      'Chain four full adders, the carry of each into the next. A split turns a bus into its bits, and a join turns bits back into a bus.'
    ],
    hint: 'Bit 0 adds A[0], B[0] and cin; its carry goes to bit 1’s cin, and so on up. The last carry is cout.',
    inputs: [{ name: 'A', width: 4 }, { name: 'B', width: 4 }, { name: 'cin' }],
    outputs: [{ name: 'S', width: 4 }, { name: 'cout' }],
    kinds: ['split', 'join'],
    chips: ['full adder'],
    tests: 'A B cin | S cout\n0 0 0 | 0 0\n3 4 0 | 7 0\n5 5 1 | 11 0\n15 1 0 | 0 1\n9 6 1 | 0 1\n15 15 1 | 15 1\n'
  },
  {
    id: 'mux 2',
    title: 'A multiplexer',
    chip: 'mux 2',
    brief: [
      'A multiplexer picks: y is a while s is 0, and b while s is 1. The CPU uses them to choose which register an instruction reads.',
      'Build it from NOT, AND and OR.'
    ],
    hint: 'One AND lets a through only while s is 0; another lets b through only while s is 1. At most one of them is ever on.',
    inputs: [{ name: 'a' }, { name: 'b' }, { name: 's' }],
    outputs: [{ name: 'y' }],
    kinds: [],
    chips: ['NOT', 'AND', 'OR'],
    tests: 'a b s | y\n0 0 0 | 0\n1 0 0 | 1\n0 1 0 | 0\n1 1 0 | 1\n0 0 1 | 0\n1 0 1 | 0\n0 1 1 | 1\n1 1 1 | 1\n'
  },
  {
    id: 'D latch',
    title: 'Memory: a D latch',
    chip: 'D latch',
    brief: [
      'Everything so far forgets: its output is only ever its inputs now. Memory comes from a loop.',
      'A D latch remembers one bit. While en is 1, q follows d; when en goes to 0, q keeps the last value. qn is always the opposite of q.',
      'Build it from NAND gates and NOT. Rows of the tests now run in order, so they test what it remembers.'
    ],
    hint: 'Two NANDs, each feeding the other, hold a bit. Two more, gated by en, decide which of them to push low.',
    inputs: [{ name: 'd' }, { name: 'en' }],
    outputs: [{ name: 'q' }, { name: 'qn' }],
    kinds: ['nand'],
    chips: ['NOT'],
    tests:
      '# While en is 1, q follows d.\nd en | q qn\n1 1 | 1 0\n0 1 | 0 1\n# With en at 0, q keeps its value whatever d does.\n0 0 | 0 1\n1 0 | 0 1\n1 1 | 1 0\n1 0 | 1 0\n0 0 | 1 0\n'
  },
  {
    id: 'D flip-flop',
    title: 'A D flip-flop',
    chip: 'D flip-flop',
    brief: [
      'A latch is open for as long as en is 1. The computer needs memory that changes at one instant: the moment the clock rises.',
      'A D flip-flop takes d into q when clk goes from 0 to 1, and holds it until the next rise.',
      'Build it from two D latches: the first open while clk is 0, the second while clk is 1.'
    ],
    hint: 'The first latch follows d while clk is 0 and freezes as it rises; the second copies the first while clk is 1.',
    inputs: [{ name: 'd' }, { name: 'clk' }],
    outputs: [{ name: 'q' }, { name: 'qn' }],
    kinds: [],
    chips: ['D latch', 'NOT'],
    tests:
      '# q takes d as clk rises…\nd clk | q qn\n1 0 | x x\n1 1 | 1 0\n# …and holds it while clk is 1 or falls, whatever d does.\n0 1 | 1 0\n0 0 | 1 0\n0 1 | 0 1\n1 0 | 0 1\n1 1 | 1 0\n'
  }
];

/** After the last lesson: where the pieces went. */
export const COURSE_END = [
  'That is every kind of part the computer is made of. Its registers are D flip-flops with a mux in front, its ALU is adders and muxes, and its control is gates.',
  'Open the computer and look inside: it is the same chips, many of them.'
];

export function lessonById(id: string): Lesson | undefined {
  return LESSONS.find(lesson => lesson.id === id);
}
