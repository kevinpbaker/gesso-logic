import type { Circuit, PinRef } from './Circuit';
import { CircuitBuilder } from './CircuitBuilder';
import { dFlipFlop, dLatch, fullAdder } from './Parts';

/**
 * The standard library: the parts the CPU is built from, each a chip
 * made of gates.
 *
 * Every definition here is an ordinary circuit whose switches are its
 * inputs and whose LEDs are its outputs (see `Chips.ts`), built in code
 * so that its gates are exactly what the spec in `Library.spec.ts`
 * exhausts or samples. Parts use one another where a person drawing them
 * would — the adder/subtractor is eight full adders, the register eight
 * flip-flops behind eight muxes — so opening one shows the parts it was
 * made from, and the gate count is honest by construction. Where the CPU
 * wants a bus, the pins are buses.
 *
 * Positions are left to the application, which lays each definition out
 * when it brings it into a document; nothing here knows what a canvas is.
 *
 * A clocked part's clock is its `clk` pin: wire a clock to it, and a
 * cycle is a rising edge. Every flip-flop takes its input on that edge.
 */

export const LIBRARY_ORDER = [
  'half adder',
  'full adder',
  'add/sub 8',
  'mux 2',
  'mux 4',
  'mux 2 ×8',
  'mux 4 ×8',
  'decoder 3→8',
  'D latch',
  'D flip-flop',
  'register 8',
  'counter 8'
] as const;

export type LibraryName = (typeof LIBRARY_ORDER)[number];

/** One line a part, for the palette's tooltip and the roadmap. */
export const LIBRARY_NOTES: Readonly<Record<LibraryName, string>> = {
  'half adder': 's = a ⊕ b, c = a · b',
  'full adder': 's and cout of a + b + cin',
  'add/sub 8': 'S = A + B, or A − B when sub is high; cout is the carry, or not-borrow',
  'mux 2': 'y = a, or b when s is high',
  'mux 4': 'y = one of a, b, c, d, by the 2-bit S',
  'mux 2 ×8': 'Y = A, or B when s is high, 8 bits wide',
  'mux 4 ×8': 'Y = one of A, B, C, D by S, 8 bits wide',
  'decoder 3→8': 'Y has bit A high, and only that one, while en is high',
  'D latch': 'q follows d while en is high, and holds when it falls',
  'D flip-flop': 'q takes d on the rising edge of clk',
  'register 8': 'Q takes D on the rising edge of clk while load is high, and holds otherwise',
  'counter 8': 'on the rising edge of clk: Q ← 0 when clr, D when load, Q + 1 when inc, else Q'
};

/** Every library definition, by name. Built fresh each call; they are small. */
export function library(): Record<LibraryName, Circuit> {
  const chips = {} as Record<LibraryName, Circuit>;
  chips['half adder'] = halfAdder();
  chips['full adder'] = fullAdderPart();
  chips['add/sub 8'] = addSub8();
  chips['mux 2'] = mux2();
  chips['mux 4'] = mux4();
  chips['mux 2 ×8'] = muxWide(2);
  chips['mux 4 ×8'] = muxWide(4);
  chips['decoder 3→8'] = decoder3to8();
  chips['D latch'] = dLatchPart();
  chips['D flip-flop'] = dFlipFlopPart();
  chips['register 8'] = register8();
  chips['counter 8'] = counter8();
  return chips;
}

/** The library definitions a part needs, itself included, by name. */
export function libraryWithDependencies(name: LibraryName): Record<string, Circuit> {
  const all = library();
  const needed: Record<string, Circuit> = {};
  const visit = (part: string) => {
    if (needed[part] !== undefined) return;
    const definition = all[part as LibraryName];
    if (definition === undefined) return;
    needed[part] = definition;
    for (const c of definition.components) {
      if (c.kind === 'chip' && c.chip !== undefined) visit(c.chip);
    }
  };
  visit(name);
  return needed;
}

function halfAdder(): Circuit {
  const b = new CircuitBuilder();
  const a = b.input('a');
  const x = b.input('b');
  b.output('s', b.xor(a, x, 'ha.sum'));
  b.output('c', b.and(a, x, 'ha.carry'));
  return b.build();
}

function fullAdderPart(): Circuit {
  const b = new CircuitBuilder();
  const { sum, carry } = fullAdder(b, b.input('a'), b.input('b'), b.input('cin'), 'fa');
  b.output('s', sum);
  b.output('cout', carry);
  return b.build();
}

/**
 * Eight full adders; B passes through an XOR with `sub`, which also
 * carries in, so A − B is A + ¬B + 1. `cout` is the carry out: for a
 * subtraction, high when there was no borrow, as a 6502's carry is.
 */
function addSub8(): Circuit {
  const b = new CircuitBuilder();
  const a = b.split('A bits', 8);
  const x = b.split('B bits', 8);
  const s = b.join('S bits', 8);
  b.connect(b.input('A', 0, 8), { component: a, pin: 'in' });
  b.connect(b.input('B', 0, 8), { component: x, pin: 'in' });
  const sub = b.input('sub');
  let carry: PinRef = sub;
  for (let i = 0; i < 8; i++) {
    const fa = b.chip(`fa${i}`, 'full adder');
    b.connect({ component: a, pin: `b${i}` }, { component: fa, pin: 'a' });
    b.connect(b.xor({ component: x, pin: `b${i}` }, sub, `inv${i}`), { component: fa, pin: 'b' });
    b.connect(carry, { component: fa, pin: 'cin' });
    b.connect({ component: fa, pin: 's' }, { component: s, pin: `b${i}` });
    carry = { component: fa, pin: 'cout' };
  }
  b.output('S', { component: s, pin: 'out' }, 8);
  b.output('cout', carry);
  return b.build();
}

/** y = a·¬s + b·s: four gates. */
function muxGates(b: CircuitBuilder, a: PinRef, x: PinRef, s: PinRef, notS: PinRef, name: string): PinRef {
  return b.or(b.and(a, notS, `${name}.a`), b.and(x, s, `${name}.b`), `${name}.y`);
}

function mux2(): Circuit {
  const b = new CircuitBuilder();
  const a = b.input('a');
  const x = b.input('b');
  const s = b.input('s');
  b.output('y', muxGates(b, a, x, s, b.not(s, 'ns'), 'm'));
  return b.build();
}

/** Two 2-way muxes on S bit 0, and a third on bit 1. */
function mux4(): Circuit {
  const b = new CircuitBuilder();
  const [a, x, c, d] = ['a', 'b', 'c', 'd'].map(name => b.input(name));
  const s = b.split('S bits', 2);
  b.connect(b.input('S', 0, 2), { component: s, pin: 'in' });
  const s0 = { component: s, pin: 'b0' };
  const s1 = { component: s, pin: 'b1' };
  const low = b.chip('lo', 'mux 2');
  const high = b.chip('hi', 'mux 2');
  const out = b.chip('out', 'mux 2');
  for (const [mux, first, second] of [
    [low, a, x],
    [high, c, d]
  ] as const) {
    b.connect(first!, { component: mux, pin: 'a' });
    b.connect(second!, { component: mux, pin: 'b' });
    b.connect(s0, { component: mux, pin: 's' });
  }
  b.connect({ component: low, pin: 'y' }, { component: out, pin: 'a' });
  b.connect({ component: high, pin: 'y' }, { component: out, pin: 'b' });
  b.connect(s1, { component: out, pin: 's' });
  b.output('y', { component: out, pin: 'y' });
  return b.build();
}

/** A 2- or 4-way mux eight bits wide: a one-bit mux per bit, the select shared. */
function muxWide(ways: 2 | 4): Circuit {
  const b = new CircuitBuilder();
  const names = ways === 2 ? ['A', 'B'] : ['A', 'B', 'C', 'D'];
  const splits = names.map(name => {
    const split = b.split(`${name} bits`, 8);
    b.connect(b.input(name, 0, 8), { component: split, pin: 'in' });
    return split;
  });
  const select = ways === 2 ? b.input('s') : b.input('S', 0, 2);
  const y = b.join('Y bits', 8);
  const part = ways === 2 ? 'mux 2' : 'mux 4';
  const dataPins = ways === 2 ? ['a', 'b'] : ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 8; i++) {
    const mux = b.chip(`m${i}`, part);
    splits.forEach((split, k) => b.connect({ component: split, pin: `b${i}` }, { component: mux, pin: dataPins[k]! }));
    b.connect(select, { component: mux, pin: ways === 2 ? 's' : 'S' });
    b.connect({ component: mux, pin: 'y' }, { component: y, pin: `b${i}` });
  }
  b.output('Y', { component: y, pin: 'out' }, 8);
  return b.build();
}

/** Y bit A high while en is: each output an AND of en and the three address bits, true or inverted. */
function decoder3to8(): Circuit {
  const b = new CircuitBuilder();
  const a = b.split('A bits', 3);
  b.connect(b.input('A', 0, 3), { component: a, pin: 'in' });
  const en = b.input('en');
  const bits = [0, 1, 2].map(i => ({ component: a, pin: `b${i}` }));
  const inverted = bits.map((bit, i) => b.not(bit, `n${i}`));
  const y = b.join('Y bits', 8);
  for (let n = 0; n < 8; n++) {
    const pick = (i: number) => ((n >> i) & 1 ? bits[i]! : inverted[i]!);
    const low = b.and(pick(0), pick(1), `y${n}.lo`);
    const high = b.and(pick(2), en, `y${n}.hi`);
    b.connect(b.and(low, high, `y${n}`), { component: y, pin: `b${n}` });
  }
  b.output('Y', { component: y, pin: 'out' }, 8);
  return b.build();
}

function dLatchPart(): Circuit {
  const b = new CircuitBuilder();
  const latch = dLatch(b, b.input('d'), b.input('en'), 'latch');
  b.output('q', latch.q);
  b.output('qn', latch.qBar);
  return b.build();
}

function dFlipFlopPart(): Circuit {
  const b = new CircuitBuilder();
  const ff = dFlipFlop(b, b.input('d'), b.input('clk'), 'ff');
  b.output('q', ff.q);
  b.output('qn', ff.qBar);
  return b.build();
}

/** Per bit: a mux choosing D when load is high and Q otherwise, into a flip-flop. */
function register8(): Circuit {
  const b = new CircuitBuilder();
  const d = b.split('D bits', 8);
  b.connect(b.input('D', 0, 8), { component: d, pin: 'in' });
  const load = b.input('load');
  const clk = b.input('clk');
  const q = b.join('Q bits', 8);
  for (let i = 0; i < 8; i++) {
    const mux = b.chip(`m${i}`, 'mux 2');
    const ff = b.chip(`ff${i}`, 'D flip-flop');
    b.connect({ component: ff, pin: 'q' }, { component: mux, pin: 'a' });
    b.connect({ component: d, pin: `b${i}` }, { component: mux, pin: 'b' });
    b.connect(load, { component: mux, pin: 's' });
    b.connect({ component: mux, pin: 'y' }, { component: ff, pin: 'd' });
    b.connect(clk, { component: ff, pin: 'clk' });
    b.connect({ component: ff, pin: 'q' }, { component: q, pin: `b${i}` });
  }
  b.output('Q', { component: q, pin: 'out' }, 8);
  return b.build();
}

/**
 * Per bit: Q + 1 by a chain of half adders carrying `inc` in, a mux to
 * D when load is high, an AND with ¬clr, and a flip-flop. So clr wins
 * over load, and load over inc.
 */
function counter8(): Circuit {
  const b = new CircuitBuilder();
  const d = b.split('D bits', 8);
  b.connect(b.input('D', 0, 8), { component: d, pin: 'in' });
  const clr = b.input('clr');
  const load = b.input('load');
  const inc = b.input('inc');
  const clk = b.input('clk');
  const keep = b.not(clr, 'keep');
  const q = b.join('Q bits', 8);
  let carry: PinRef = inc;
  for (let i = 0; i < 8; i++) {
    const ff = b.chip(`ff${i}`, 'D flip-flop');
    const ha = b.chip(`ha${i}`, 'half adder');
    const mux = b.chip(`m${i}`, 'mux 2');
    b.connect({ component: ff, pin: 'q' }, { component: ha, pin: 'a' });
    b.connect(carry, { component: ha, pin: 'b' });
    carry = { component: ha, pin: 'c' };
    b.connect({ component: ha, pin: 's' }, { component: mux, pin: 'a' });
    b.connect({ component: d, pin: `b${i}` }, { component: mux, pin: 'b' });
    b.connect(load, { component: mux, pin: 's' });
    b.connect(b.and({ component: mux, pin: 'y' }, keep, `next${i}`), { component: ff, pin: 'd' });
    b.connect(clk, { component: ff, pin: 'clk' });
    b.connect({ component: ff, pin: 'q' }, { component: q, pin: `b${i}` });
  }
  b.output('Q', { component: q, pin: 'out' }, 8);
  return b.build();
}
