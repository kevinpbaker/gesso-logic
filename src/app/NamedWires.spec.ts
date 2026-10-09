import { describe, expect, it } from 'vitest';

import { place, sameConnectivity, setLabel } from './DocumentEdits';
import { noteShape, shapeOf } from './Layout';
import { CIRCUIT_VERSION, type Circuit } from '../sim/Circuit';
import { readCircuit, writeCircuit } from '../sim/CircuitFile';
import { compile, CircuitError } from '../sim/Netlist';
import { Simulator } from '../sim/Simulator';

/** A switch into a named wire, and the same name, elsewhere, into an LED: no wire between them. */
function tagged(far = 'clk', width?: number): Circuit {
  return {
    version: CIRCUIT_VERSION,
    components: [
      { id: 's', kind: 'input', x: 0, y: 0, ...(width === undefined ? {} : { width }) },
      { id: 't1', kind: 'tunnel', x: 4, y: 0, label: 'clk', ...(width === undefined ? {} : { width }) },
      { id: 't2', kind: 'tunnel', x: 40, y: 20, label: far, ...(width === undefined ? {} : { width }), rotation: 180 },
      { id: 'led', kind: 'output', x: 44, y: 20, ...(width === undefined ? {} : { width }) },
      { id: 'n', kind: 'note', x: 0, y: 10, label: 'The clock goes everywhere\nwithout a wire' }
    ],
    wires: [
      { id: 'w1', from: { component: 's', pin: 'out' }, to: { component: 't1', pin: 'io' } },
      { id: 'w2', from: { component: 't2', pin: 'io' }, to: { component: 'led', pin: 'in' } }
    ]
  };
}

describe('named wires', () => {
  it('join every wire of one name on a level, as though a wire ran between them', () => {
    const sim = new Simulator(compile(tagged()));
    sim.settle();
    expect(sim.read('led', 'in')).toBe(0);
    sim.set('s', 1);
    sim.settle();
    expect(sim.read('led', 'in')).toBe(1);
  });

  it('join nothing to a wire of another name, and carry a bus bit for bit', () => {
    const apart = new Simulator(compile(tagged('data')));
    apart.set('s', 1);
    apart.settle();
    expect(apart.read('led', 'in')).toBe(0);
    const bus = new Simulator(compile(tagged('clk', 8)));
    bus.set('s', 0xa5);
    bus.settle();
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(i => bus.read('led', `in[${i}]`)).reverse().join('')).toBe('10100101');
  });

  it('refuse two of one name and different widths, saying which', () => {
    const mixed = tagged();
    const wider = { ...mixed, components: mixed.components.map(c => (c.id === 't2' ? { ...c, width: 4 } : c)) };
    expect(() => compile(wider)).toThrow(CircuitError);
    expect(() => compile(wider)).toThrow(/named 'clk' are 1 and 4 bits wide/);
  });

  it('are a new netlist when renamed, and start with a name no other has', () => {
    const circuit = tagged();
    expect(sameConnectivity(circuit, setLabel(circuit, null, 't2', 'data'))).toBe(false);
    expect(sameConnectivity(circuit, setLabel(circuit, null, 'n', 'other words'))).toBe(true);
    const placed = place(place(circuit, 't3', 'tunnel', 0, 30), 't4', 'tunnel', 0, 34);
    expect(placed.components.slice(-2).map(c => c.label)).toEqual(['net1', 'net2']);
    expect(place(circuit, 'n2', 'note', 0, 40).components.at(-1)!.label).toBe('Note');
  });
});

describe('notes', () => {
  it('are sized to their words, compile to nothing, and keep their lines in the file', () => {
    const circuit = tagged();
    expect(shapeOf(circuit.components[4]!, undefined)).toEqual(noteShape('The clock goes everywhere\nwithout a wire'));
    expect(noteShape('a\nb\nc').height).toBeGreaterThan(noteShape('a').height);
    expect(compile(circuit).gateCount).toBe(0);
    const again = readCircuit(writeCircuit(circuit));
    expect(again.components[4]!.label).toBe('The clock goes everywhere\nwithout a wire');
    expect(again.components[2]).toMatchObject({ kind: 'tunnel', label: 'clk', rotation: 180 });
  });
});
