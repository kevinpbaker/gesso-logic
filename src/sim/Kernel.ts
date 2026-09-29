import type { Netlist } from './Netlist';
import { TRUTH } from './Primitives';

/**
 * The simulator's inner loop, in WebAssembly.
 *
 * The same loop in JavaScript peaked at about 130 million gate
 * evaluations a second on Phase 12's benchmark, 32 kHz; this runs it at
 * three times that. The loop is a handful of loads and stores a gate,
 * and what JavaScript added — a bounds check on every typed-array
 * access, a tagged integer on every index — was most of it.
 *
 * There is no toolchain: the module is assembled here, from the opcodes
 * below, once per process, and every simulator instantiates it over a
 * memory of its own. It is a few hundred bytes.
 *
 * **Memory.** A header of base addresses at 0, then the arrays the
 * loop reads, each at an address the header gives, so one module serves
 * every circuit and is compiled once:
 *
 *   - net values, a byte each — the simulator's `value` is a view of
 *     these;
 *   - the truth table, four rows of the gate's two inputs a type;
 *   - each net's fan-out as edges of two words: the gate's other input
 *     net, and its output net with its type above bit 28. Every gate is
 *     symmetric in its inputs (a NOT reads one net twice), so a gate
 *     reached through the net that changed is evaluated from the edge,
 *     and never has a record of its own to fetch;
 *   - where each net's edges start, as byte addresses;
 *   - the nets that changed on the last tick, which the next evaluates;
 *   - the changes a tick found, a word each: net above, value in bit 0.
 *
 * **A tick** is `evaluate`, then `apply`, as in the JavaScript it
 * replaced (`Simulator` holds the story): every edge of every changed
 * net is evaluated against values as they were when the tick began, and
 * the changes are applied after. A gate both of whose inputs changed is
 * reached twice and gives the same answer twice; `apply` finds its net
 * already moved the second time and drops it. A change is written
 * whether or not the output moved and kept only if it did, because
 * whether it moved is a coin toss a branch would lose.
 */

/**
 * The header is at address 0, the truth table after it, and a net's
 * value at its number past that: fixed addresses, which the loop reads
 * as constant offsets rather than adding a base.
 */
const HEADER_WORDS = 8;
const TRUTH_AT = HEADER_WORDS * 4;
const VALUES = TRUTH_AT + 32;
/** An edge's second word: the gate's output net, and its type above. */
export const TYPE_SHIFT = 28;
const OUT_MASK = (1 << TYPE_SHIFT) - 1;

/** The header's words: base addresses, and what a call hands back. */
const HEADER = {
  edgeStart: 1,
  changed: 2,
  found: 3,
  /** Out: nets queued for the next tick when `settle` returned. */
  queued: 4,
  /** Out: edges evaluated by the last call. */
  evaluations: 5,
  /** Out: nets that changed value on the last call. */
  moved: 6
} as const;

export interface Kernel {
  /** Every net's value, a view of the kernel's memory. */
  readonly value: Uint8Array;
  /** The nets the next tick evaluates: the first `count` passed to it. */
  readonly changed: Int32Array;
  /** Where a tick's changes are found, packed `net << 1 | value`, before `apply`. */
  readonly found: Int32Array;
  /** Evaluates the edges of the first `count` changed nets; returns how many changes were found. */
  evaluate(count: number): number;
  /** Applies `count` found changes; returns how many nets are queued for the next tick. */
  apply(count: number): number;
  /** Ticks until nothing is queued or `limit` ticks have run; returns the ticks run. */
  settle(count: number, limit: number): number;
  /** What the last call left in the header. */
  readonly queued: number;
  readonly evaluations: number;
  readonly moved: number;
}

export function createKernel(netlist: Netlist): Kernel {
  const { type, in0, in1, out, fanStart, fanGate, netCount, gateCount } = netlist;
  const edgeCount = fanGate.length;
  let at = 0;
  const region = (bytes: number) => {
    const start = at;
    at += Math.ceil(bytes / 8) * 8;
    return start;
  };
  const header = region(HEADER_WORDS * 4);
  const truth = region(32);
  region(netCount);
  const edges = region(edgeCount * 8);
  const edgeStart = region((netCount + 1) * 4);
  const changed = region(netCount * 4);
  // A change an evaluation at most, and one written past the last kept.
  const found = region((Math.max(edgeCount, gateCount) + 1) * 4);
  const memory = new WebAssembly.Memory({ initial: Math.max(1, Math.ceil(at / 65536)) });
  const buffer = memory.buffer;
  const words = new Int32Array(buffer);

  new Uint8Array(buffer, truth, TRUTH.length).set(TRUTH);
  for (let n = 0; n < netCount; n++) {
    words[(edgeStart >> 2) + n] = edges + fanStart[n]! * 8;
    for (let f = fanStart[n]!; f < fanStart[n + 1]!; f++) {
      const g = fanGate[f]!;
      words[(edges >> 2) + f * 2] = in0[g] === n ? in1[g]! : in0[g]!;
      words[(edges >> 2) + f * 2 + 1] = (type[g]! << TYPE_SHIFT) | out[g]!;
    }
  }
  words[(edgeStart >> 2) + netCount] = edges + edgeCount * 8;
  const h = header >> 2;
  words[h + HEADER.edgeStart] = edgeStart;
  words[h + HEADER.changed] = changed;
  words[h + HEADER.found] = found;

  const exports = new WebAssembly.Instance(kernelModule(), { kernel: { memory } }).exports as {
    evaluate(count: number): number;
    apply(count: number): number;
    settle(count: number, limit: number): number;
  };
  return {
    value: new Uint8Array(buffer, VALUES, netCount),
    changed: new Int32Array(buffer, changed, netCount),
    found: new Int32Array(buffer, found, Math.max(edgeCount, gateCount) + 1),
    evaluate: exports.evaluate,
    apply: exports.apply,
    settle: exports.settle,
    get queued() {
      return words[h + HEADER.queued]!;
    },
    get evaluations() {
      return words[h + HEADER.evaluations]!;
    },
    get moved() {
      return words[h + HEADER.moved]!;
    }
  };
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

let compiled: WebAssembly.Module | null = null;

/** The kernel's module, compiled the first time a simulator asks. */
function kernelModule(): WebAssembly.Module {
  compiled ??= new WebAssembly.Module(assemble());
  return compiled;
}

// Opcodes, as the WebAssembly binary format numbers them.
const I32 = 0x7f;
const op = {
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  end: 0x0b,
  br: 0x0c,
  brIf: 0x0d,
  call: 0x10,
  get: 0x20,
  set: 0x21,
  tee: 0x22,
  load: 0x28,
  load8: 0x2d,
  store: 0x36,
  store8: 0x3a,
  const: 0x41,
  eqz: 0x45,
  ne: 0x47,
  geU: 0x4f,
  gtS: 0x4a,
  add: 0x6a,
  sub: 0x6b,
  and: 0x71,
  or: 0x72,
  xor: 0x73,
  shl: 0x74,
  shrU: 0x76
} as const;
const VOID = 0x40;

function sleb(n: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) return [...bytes, b];
    bytes.push(b | 0x80);
  }
}

function uleb(n: number): number[] {
  const bytes: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    bytes.push(b);
  } while (n !== 0);
  return bytes;
}

const get = (local: number) => [op.get, ...uleb(local)];
const set = (local: number) => [op.set, ...uleb(local)];
const tee = (local: number) => [op.tee, ...uleb(local)];
const i32 = (n: number) => [op.const, ...sleb(n)];
/** A 32-bit load or store at a constant offset from the address on the stack. */
const load = (offset = 0) => [op.load, 2, ...uleb(offset)];
const load8 = (offset = 0) => [op.load8, 0, ...uleb(offset)];
const store = (offset = 0) => [op.store, 2, ...uleb(offset)];
const store8 = (offset = 0) => [op.store8, 0, ...uleb(offset)];
/** `while (!(condition)) { body }`, the condition an exit test. */
const loop = (exitIf: number[], body: number[]) => [op.block, VOID, op.loop, VOID, ...exitIf, op.brIf, 1, ...body, op.br, 0, op.end, op.end];

function assemble(): Uint8Array<ArrayBuffer> {
  const field = (word: number) => [...i32(0), ...load(word * 4)];
  const store32 = (word: number, value: number[]) => [...i32(0), ...value, ...store(word * 4)];

  // evaluate(count) -> found
  // locals: 0 count, 1 at (changed, walking), 2 n, 3 self, 4 e, 5 last, 6 word,
  //         7 result, 8 foundAt (walking), 9 end (of changed), 10 foundStart, 11 evaluations
  const evaluate = [
    ...field(HEADER.changed), ...tee(1), ...get(0), ...i32(2), op.shl, op.add, ...set(9),
    ...field(HEADER.found), ...tee(8), ...set(10),
    ...loop([...get(1), ...get(9), op.geU], [
      // n = *at; self = value[n] << 1
      ...get(1), ...load(), ...tee(2),
      ...load8(VALUES), ...i32(1), op.shl, ...set(3),
      // e = edgeStart[n], last = edgeStart[n + 1]
      ...field(HEADER.edgeStart), ...get(2), ...i32(2), op.shl, op.add, ...tee(5), ...load(), ...set(4),
      ...get(5), ...load(4), ...set(5),
      ...get(11), ...get(5), ...get(4), op.sub, ...i32(3), op.shrU, op.add, ...set(11),
      ...loop([...get(4), ...get(5), op.geU], [
        ...get(4), ...load(4), ...set(6),
        // result = truth[type << 2 | self | value[other]]
        ...get(6), ...i32(TYPE_SHIFT), op.shrU, ...i32(2), op.shl, ...get(3), op.or,
        ...get(4), ...load(), ...load8(VALUES), op.or,
        ...load8(TRUTH_AT), ...set(7),
        // *foundAt = out << 1 | result; foundAt += (result ^ value[out]) * 4
        ...get(8),
        ...get(6), ...i32(OUT_MASK), op.and, ...tee(6), ...i32(1), op.shl, ...get(7), op.or, ...store(),
        ...get(8), ...get(7), ...get(6), ...load8(VALUES), op.xor, ...i32(2), op.shl, op.add, ...set(8),
        ...get(4), ...i32(8), op.add, ...set(4)
      ]),
      ...get(1), ...i32(4), op.add, ...set(1)
    ]),
    ...store32(HEADER.evaluations, get(11)),
    ...get(8), ...get(10), op.sub, ...i32(2), op.shrU
  ];

  // apply(count) -> queued
  // locals: 0 count, 1 at (found, walking), 2 n, 3 v, 4 queuedAt (walking),
  //         5 edgeAt, 6 end (of found), 7 changedStart, 8 moved
  const apply = [
    ...field(HEADER.found), ...tee(1), ...get(0), ...i32(2), op.shl, op.add, ...set(6),
    ...field(HEADER.changed), ...tee(4), ...set(7),
    ...loop([...get(1), ...get(6), op.geU], [
      ...get(1), ...load(), ...tee(3),
      ...i32(1), op.shrU, ...set(2),
      ...get(3), ...i32(1), op.and, ...set(3),
      ...get(2), ...load8(VALUES), ...get(3), op.ne,
      op.if, VOID,
        ...get(2), ...get(3), ...store8(VALUES),
        ...get(8), ...i32(1), op.add, ...set(8),
        // Queued only if something reads it.
        ...field(HEADER.edgeStart), ...get(2), ...i32(2), op.shl, op.add, ...tee(5), ...load(4), ...get(5), ...load(), op.gtS,
        op.if, VOID,
          ...get(4), ...get(2), ...store(),
          ...get(4), ...i32(4), op.add, ...set(4),
        op.end,
      op.end,
      ...get(1), ...i32(4), op.add, ...set(1)
    ]),
    ...store32(HEADER.moved, get(8)),
    ...get(4), ...get(7), op.sub, ...i32(2), op.shrU
  ];

  // settle(count, limit) -> ticks
  // locals: 0 count, 1 limit, 2 ticks, 3 evaluations, 4 moved
  const settle = [
    ...loop([...get(0), op.eqz, ...get(2), ...get(1), op.geU, op.or], [
      ...get(0), op.call, 0, op.call, 1, ...set(0),
      ...get(3), ...field(HEADER.evaluations), op.add, ...set(3),
      ...get(4), ...field(HEADER.moved), op.add, ...set(4),
      ...get(2), ...i32(1), op.add, ...set(2)
    ]),
    ...store32(HEADER.queued, get(0)),
    ...store32(HEADER.evaluations, get(3)),
    ...store32(HEADER.moved, get(4)),
    ...get(2)
  ];

  const body = (locals: number, code: number[]) => {
    const bytes = [1, ...uleb(locals), I32, ...code, op.end];
    return [...uleb(bytes.length), ...bytes];
  };
  const section = (id: number, content: number[]) => [id, ...uleb(content.length), ...content];
  const name = (text: string) => [...uleb(text.length), ...[...text].map(c => c.charCodeAt(0))];
  return new Uint8Array([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    // Types: (i32) -> i32, (i32, i32) -> i32.
    ...section(1, [2, 0x60, 1, I32, 1, I32, 0x60, 2, I32, I32, 1, I32]),
    // Imports: kernel.memory.
    ...section(2, [1, ...name('kernel'), ...name('memory'), 0x02, 0x00, 0x01]),
    // Functions: evaluate, apply, settle.
    ...section(3, [3, 0, 0, 1]),
    ...section(7, [3, ...name('evaluate'), 0x00, 0, ...name('apply'), 0x00, 1, ...name('settle'), 0x00, 2]),
    ...section(10, [3, ...body(11, evaluate), ...body(9, apply), ...body(3, settle)])
  ]);
}
