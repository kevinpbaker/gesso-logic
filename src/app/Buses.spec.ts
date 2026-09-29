import { describe, expect, it } from 'vitest';

import { CIRCUIT_VERSION, type Circuit } from '../sim/Circuit';
import { readCircuit, writeCircuit } from '../sim/CircuitFile';
import { CircuitError, compile } from '../sim/Netlist';
import { Simulator } from '../sim/Simulator';
import { connect, setWidth } from './DocumentEdits';
import { ADDER, busAdderScene } from './Scenes';
import { entriesOf, entryOf } from './CircuitContract';

/** A bus's value, read bit by bit off `component.pin[i]`. */
function bus(sim: Simulator, component: string, pin: string, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) value |= sim.read(component, `${pin}[${i}]`) << i;
  return value;
}

describe('buses', () => {
  it('rebuilds the 8-bit adder with bus pins, and it adds, with splits and joins costing no gates', () => {
    const netlist = compile(busAdderScene());
    // Forty in the eight full adders, ten in the carry-in flip-flop and
    // its inverter; the splits and the join are wiring.
    expect(netlist.gateCount).toBe(50);
    const sim = new Simulator(netlist);
    expect(sim.settle().settled).toBe(true);
    const cin = sim.read('CIN.slave.q');
    expect(bus(sim, 'S', 'in', 8)).toBe((ADDER.a + ADDER.b + cin) & 0xff);

    for (const [a, b] of [
      [0xff, 0x01],
      [200, 100],
      [0x0f, 0xf0]
    ] as const) {
      sim.set('A', a);
      sim.set('B', b);
      sim.settle();
      expect(bus(sim, 'S', 'in', 8) | (sim.read('COUT', 'in') << 8)).toBe(a + b + cin);
    }
  });

  it('feeds the hex display the sum, a net per bit', async () => {
    const { CircuitService } = await import('./CircuitService');
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let geometry!: import('./CircuitContract').Geometry;
    service.geometry.subscribe(g => (geometry = g));
    service.load(busAdderScene());
    const sum = entryOf(geometry.components, 'sum')!;
    expect(sum.shape).toMatchObject({ width: 6, pins: { in: { x: 0, y: 3 } } });
    const netlist = compile(busAdderScene());
    for (let i = 0; i < 8; i++) {
      expect(sum.nets[`in[${i}]`]).toBe(netlist.pinNet.get(`add.S[${i}]`));
    }
    const wire = entriesOf(geometry.wires).map(([, entry]) => entry).find(w => w.to.component === 'sum')!;
    expect(wire.width).toBe(8);
    expect(wire.bits).toHaveLength(8);
  });

  it('joins only pins of one width: refused when drawn, when compiled, and when read', () => {
    const circuit: Circuit = {
      version: CIRCUIT_VERSION,
      components: [
        { id: 'a', kind: 'input', x: 0, y: 0, width: 8 },
        { id: 'l', kind: 'output', x: 6, y: 0 }
      ],
      wires: []
    };
    expect(connect(circuit, 'w', { component: 'a', pin: 'out' }, { component: 'l', pin: 'in' })).toBe(circuit);

    const mismatched = { ...circuit, wires: [{ id: 'w', from: { component: 'a', pin: 'out' }, to: { component: 'l', pin: 'in' } }] };
    expect(() => compile(mismatched)).toThrow(CircuitError);
    expect(() => compile(mismatched)).toThrow(/8 bits wide/);
    expect(() => readCircuit(writeCircuit(mismatched))).toThrow(/joins a 8-bit pin to a 1-bit one/);
  });

  it('resizes a part, dropping the wires it leaves mismatched and the bits of a value that no longer fit', () => {
    const circuit: Circuit = {
      version: CIRCUIT_VERSION,
      components: [
        { id: 'a', kind: 'input', x: 0, y: 0, width: 8, value: 0xab },
        { id: 'l', kind: 'output', x: 6, y: 0, width: 8 }
      ],
      wires: [{ id: 'w', from: { component: 'a', pin: 'out' }, to: { component: 'l', pin: 'in' } }]
    };
    const narrowed = setWidth(circuit, ['a'], 4);
    expect(narrowed.components[0]).toMatchObject({ width: 4, value: 0xb });
    expect(narrowed.wires).toEqual([]);
    const both = setWidth(circuit, ['a', 'l'], 4);
    expect(both.wires).toHaveLength(1);
    expect(setWidth(circuit, ['a'], 8)).toBe(circuit);
    expect(setWidth(circuit, ['a'], 33)).toBe(circuit);
  });

  it('writes widths to a file and reads them back, refusing a width where none belongs', () => {
    const scene = busAdderScene();
    expect(readCircuit(writeCircuit(scene))).toEqual(scene);
    const data = JSON.parse(writeCircuit(scene));
    const gate = data.components.find((c: { kind: string }) => c.kind === 'not');
    gate.width = 4;
    expect(() => readCircuit(JSON.stringify(data))).toThrow(/a not has no width/);
    const big = JSON.parse(writeCircuit(scene));
    big.components.find((c: { id: string }) => c.id === 'A').value = 256;
    expect(() => readCircuit(JSON.stringify(big))).toThrow(/fits in 8 bits/);
  });
});
