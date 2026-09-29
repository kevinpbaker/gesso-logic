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
