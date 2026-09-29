import { describe, expect, it } from 'vitest';

import { CircuitBuilder } from '../sim/CircuitBuilder';
import { fullAdder, srLatch } from '../sim/Parts';
import { truthTable } from './TruthTable';

describe('the truth table', () => {
  it('sweeps a full adder, first input most significant', () => {
    const b = new CircuitBuilder();
    const [a, bb, cin] = [b.input('a'), b.input('b'), b.input('cin')];
    const { sum, carry } = fullAdder(b, a, bb, cin, 'fa');
    b.output('s', sum);
    b.output('c', carry);
    const circuit = b.build();

    const result = truthTable(
      circuit,
      circuit.components.map(c => c.id)
    );
    if (!('table' in result)) throw new Error(result.error);
    expect(result.table.inputs).toEqual(['a', 'b', 'cin']);
    expect(result.table.outputs).toEqual(['s', 'c']);
    // (sum, carry) for 000 … 111.
    expect(result.table.rows).toEqual(['00', '10', '10', '01', '10', '01', '01', '11']);
  });

  it('finds the inputs of a selection that leaves its switches out', () => {
    const b = new CircuitBuilder();
    const x = b.input('x');
    const y = b.input('y');
    const g = b.xor(x, y);
    b.output('led', g);
    const circuit = b.build();
    const gate = g.component;

    const result = truthTable(circuit, [gate]);
    if (!('table' in result)) throw new Error(result.error);
    expect(result.table.inputs).toEqual(['x.out', 'y.out']);
    expect(result.table.rows).toEqual(['0', '1', '1', '0']);
  });

  it('refuses more than eight inputs, and says a latch depends on the row before', () => {
    const b = new CircuitBuilder();
    const ins = Array.from({ length: 9 }, (_, i) => b.input(`i${i}`));
    let acc = ins[0]!;
    for (const i of ins.slice(1)) acc = b.and(acc, i);
    b.output('all', acc);
    const wide = b.build();
    expect(truthTable(wide, wide.components.map(c => c.id))).toEqual({
      error: '9 inputs; a table is swept for at most 8'
    });

    const l = new CircuitBuilder();
    const { q } = srLatch(l, l.input('s', 1), l.input('r', 1), 'latch');
    l.output('q', q);
    const latch = l.build();
    const result = truthTable(latch, latch.components.map(c => c.id));
    if (!('table' in result)) throw new Error(result.error);
    expect(result.table.inputs).toEqual(['s', 'r']);
    expect(result.table.rows).toHaveLength(4);
  });
});

describe('the truth table of a chip', () => {
  it('sweeps a full adder chip as it would the gates inside it', async () => {
    const { makeChip } = await import('./DocumentEdits');
    const b = new CircuitBuilder();
    const [a, bb, cin] = [b.input('a'), b.input('b'), b.input('cin')];
    const { sum, carry } = fullAdder(b, a, bb, cin, 'fa');
    b.output('s', sum);
    b.output('c', carry);
    const drawn = b.build();
    // The five gates made into a chip, between the switches and LEDs.
    const circuit = makeChip(drawn, drawn.components.filter(c => c.id.startsWith('fa.')).map(c => c.id), 'adder', 'fa');

    const result = truthTable(circuit, ['fa']);
    if (!('table' in result)) throw new Error(result.error);
    expect(result.table.inputs.map(name => name.replace('.out', ''))).toEqual(['a', 'b', 'cin']);
    expect(result.table.outputs).toEqual(['s', 'c']);
    expect(result.table.rows).toEqual(['00', '10', '10', '01', '10', '01', '01', '11']);
  });
});

describe('the truth table of a bus', () => {
  it('sweeps a chip with bus pins bit by bit, naming the bits', () => {
    // A chip ANDing two 2-bit buses, bit for bit.
    const inside = new CircuitBuilder();
    const a = inside.split('as', 2);
    const b2 = inside.split('bs', 2);
    const y = inside.join('ys', 2);
    inside.connect(inside.input('A', 0, 2), { component: a, pin: 'in' });
    inside.connect(inside.input('B', 0, 2), { component: b2, pin: 'in' });
    for (let i = 0; i < 2; i++) {
      inside.connect(inside.and({ component: a, pin: `b${i}` }, { component: b2, pin: `b${i}` }, `g${i}`), { component: y, pin: `b${i}` });
    }
    inside.output('Y', { component: y, pin: 'out' }, 2);

    const top = new CircuitBuilder();
    const chip = top.chip('c', 'and2');
    top.connect(top.input('A', 0, 2), { component: chip, pin: 'A' });
    top.connect(top.input('B', 0, 2), { component: chip, pin: 'B' });
    top.output('Y', { component: chip, pin: 'Y' }, 2);
    const circuit = { ...top.build(), chips: { and2: inside.build() } };

    const result = truthTable(circuit, ['c']);
    if (!('table' in result)) throw new Error(result.error);
    expect(result.table.inputs).toHaveLength(4);
    expect(result.table.outputs).toEqual(['Y[0]', 'Y[1]']);
    // Columns A[0], A[1], B[0], B[1]: A = 0b11 and B = 0b01 is row 0b1110, and Y = A & B = 0b01.
    expect(result.table.rows[0b1110]).toBe('10');
    expect(result.table.rows[0b1111]).toBe('11');
    expect(result.table.rows[0b1010]).toBe('10');
    expect(result.table.rows[0b0101]).toBe('01');
  });
});
