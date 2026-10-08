import { describe, expect, it } from 'vitest';

import { CIRCUIT_VERSION, type Circuit } from '../sim/Circuit';
import { readCircuit, writeCircuit } from '../sim/CircuitFile';
import { makeChip, moveBy, relabel, extract, sameConnectivity, setVia, straighten } from './DocumentEdits';
import { bend, route, routeVia, simplify } from './Layout';

const p = (x: number, y: number) => ({ x, y });

describe('a wire bent by hand', () => {
  it('routes through its corners, square at every turn', () => {
    expect(route(p(0, 0), p(10, 4), 0, [p(3, 0), p(3, 8), p(7, 8), p(7, 4)])).toEqual([p(0, 0), p(3, 0), p(3, 8), p(7, 8), p(7, 4), p(10, 4)]);
    // An end moved since: across out of the driver, down then across
    // into the reader; the spike up to the corner and back turns nothing.
    expect(routeVia(p(0, 2), p(10, 6), [p(4, 0)])).toEqual([p(0, 2), p(4, 2), p(4, 6), p(10, 6)]);
    expect(route(p(0, 0), p(10, 4), 0, [])).toEqual(route(p(0, 0), p(10, 4), 0));
  });

  it('leaves out points that turn nothing', () => {
    expect(simplify([p(0, 0), p(0, 0), p(2, 0), p(5, 0), p(5, 3), p(5, 3)])).toEqual([p(0, 0), p(5, 0), p(5, 3)]);
  });

  it('moves a middle segment across itself, and its neighbours with it', () => {
    const points = [p(0, 0), p(4, 0), p(4, 6), p(10, 6)];
    expect(bend(points, 1, 2)).toEqual([p(0, 0), p(6, 0), p(6, 6), p(10, 6)]);
  });

  it('keeps a stub at a pin when the segment moved starts there', () => {
    const points = [p(0, 0), p(4, 0), p(4, 6), p(10, 6)];
    expect(bend(points, 0, -3)).toEqual([p(0, 0), p(1, 0), p(1, -3), p(4, -3), p(4, 6), p(10, 6)]);
    expect(bend(points, 2, 2)).toEqual([p(0, 0), p(4, 0), p(4, 8), p(9, 8), p(9, 6), p(10, 6)]);
  });
});

function twoGates(): Circuit {
  return {
    version: CIRCUIT_VERSION,
    components: [
      { id: 'a', kind: 'input', x: 0, y: 0 },
      { id: 'g', kind: 'not', x: 10, y: 0 },
      { id: 'h', kind: 'not', x: 20, y: 0 }
    ],
    wires: [
      { id: 'w1', from: { component: 'a', pin: 'out' }, to: { component: 'g', pin: 'a' }, via: [p(5, 1), p(5, 6), p(8, 6), p(8, 2)] },
      { id: 'w2', from: { component: 'g', pin: 'out' }, to: { component: 'h', pin: 'a' } }
    ]
  };
}

describe('bent wires in edits', () => {
  it('bends and straightens, as edits that keep the netlist', () => {
    const circuit = twoGates();
    const bent = setVia(circuit, 'w2', [p(16, 2), p(16, 9)]);
    expect(bent.wires[1]!.via).toEqual([p(16, 2), p(16, 9)]);
    expect(sameConnectivity(circuit, bent)).toBe(true);
    expect(setVia(bent, 'w2', [p(16, 2), p(16, 9)])).toBe(bent);
    expect(setVia(circuit, 'nope', [p(1, 1)])).toBe(circuit);
    const straight = straighten(bent, ['g']);
    expect(straight.wires.every(w => w.via === undefined)).toBe(true);
    expect(straighten(bent, ['w2']).wires[0]!.via).toBeDefined();
    expect(straighten(straight, [])).toBe(straight);
  });

  it('carries a wire’s corners with its ends, and leaves them when only one end moves', () => {
    const circuit = twoGates();
    expect(moveBy(circuit, ['a', 'g'], 3, 1).wires[0]!.via).toEqual([p(8, 2), p(8, 7), p(11, 7), p(11, 3)]);
    expect(moveBy(circuit, ['g'], 3, 1).wires[0]!.via).toEqual(circuit.wires[0]!.via);
  });

  it('carries them into a copy, and into a chip made of the parts', () => {
    const copied = relabel(extract(twoGates(), ['a', 'g']), 10, 0, (prefix, old) => `${prefix}-${old}`);
    expect(copied.wires[0]!.via![0]).toEqual(p(15, 1));
    const made = makeChip(twoGates(), ['a', 'g'], 'pair', 'chip1');
    expect(made.chips!['pair']!.wires.find(w => w.id === 'w1')!.via![0]).toEqual(p(5, 1));
  });

  it('keeps them in the file', () => {
    const again = readCircuit(writeCircuit(twoGates()));
    expect(again.wires[0]!.via).toEqual(twoGates().wires[0]!.via);
    expect(again.wires[1]!.via).toBeUndefined();
    expect(writeCircuit(twoGates())).toContain('"via":[[5,1],[5,6],[8,6],[8,2]]');
    const bad = writeCircuit(twoGates()).replace('"via":[[5,1]', '"via":[[5,"x"]');
    expect(() => readCircuit(bad)).toThrow(/wires\[0\]\.via/);
  });
});
