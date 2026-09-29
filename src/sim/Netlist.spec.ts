import { describe, expect, it } from 'vitest';

import { CIRCUIT_VERSION, type Circuit } from './Circuit';
import { CircuitBuilder } from './CircuitBuilder';
import { CircuitError, compile } from './Netlist';

function errorOf(circuit: Circuit): CircuitError {
  try {
    compile(circuit);
  } catch (error) {
    if (error instanceof CircuitError) {
      return error;
    }
    throw error;
  }
  throw new Error('compile did not throw');
}

describe('compile', () => {
  it('makes one net of every pin a chain of wires joins', () => {
    // One input fanned out to three gates by three wires: one net.
    const b = new CircuitBuilder();
    const x = b.input('x');
    b.not(x, 'a');
    b.not(x, 'b');
    b.not(x, 'c');
    const netlist = compile(b.build());

    const nets = ['x.out', 'a.a', 'b.a', 'c.a'].map(pin => netlist.pinNet.get(pin));
    expect(new Set(nets).size).toBe(1);
    expect(netlist.fanStart[nets[0]! + 1] - netlist.fanStart[nets[0]!]).toBe(3);
  });

  it('gives an unwired pin a net of its own', () => {
    const b = new CircuitBuilder();
    b.gate('and', 'g');
    const netlist = compile(b.build());

    expect(netlist.netCount).toBe(3);
    expect(netlist.floating).toHaveLength(2);
  });

  it('numbers nets and gates the same way every time', () => {
    const build = () => {
      const b = new CircuitBuilder();
      b.output('sum', b.xor(b.input('x'), b.input('y'), 's'));
      return compile(b.build());
    };
    const first = build();
    const second = build();

    expect([...second.pinNet]).toEqual([...first.pinNet]);
    expect(second.netNames).toEqual(first.netNames);
  });

  it('names a net after the pin that drives it', () => {
    const b = new CircuitBuilder();
    b.output('q', b.nand(b.input('x'), b.input('y'), 'gate'));
    const netlist = compile(b.build());

    expect(netlist.netNames[netlist.pinNet.get('gate.out')!]).toBe('gate.out');
    expect(netlist.netNames[netlist.pinNet.get('q.in')!]).toBe('gate.out');
  });

  it('refuses two drivers on one net, naming both', () => {
    const b = new CircuitBuilder();
    const x = b.input('x');
    const y = b.input('y');
    const g = b.gate('not', 'g');
    b.connect(x, g.a);
    b.connect(y, g.a);

    const error = errorOf(b.build());

    expect(error.code).toBe('short');
    expect(error.message).toBe('x.out and y.out both drive the same net.');
  });

  it('refuses a wire to a pin the component does not have, saying which it has', () => {
    const circuit: Circuit = {
      version: CIRCUIT_VERSION,
      components: [
        { id: 'x', kind: 'input', x: 0, y: 0 },
        { id: 'n', kind: 'not', x: 4, y: 0 }
      ],
      wires: [{ id: 'w0', from: { component: 'x', pin: 'out' }, to: { component: 'n', pin: 'b' } }]
    };

    const error = errorOf(circuit);

    expect(error.code).toBe('unknown-pin');
    expect(error.message).toBe("Wire 'w0' names pin 'b' on not 'n', which has a, out.");
  });

  it('refuses a wire to a component that is not there, and a repeated id', () => {
    expect(
      errorOf({
        version: CIRCUIT_VERSION,
        components: [{ id: 'x', kind: 'input', x: 0, y: 0 }],
        wires: [{ id: 'w0', from: { component: 'x', pin: 'out' }, to: { component: 'gone', pin: 'a' } }]
      }).code
    ).toBe('unknown-component');
    expect(
      errorOf({
        version: CIRCUIT_VERSION,
        components: [
          { id: 'x', kind: 'input', x: 0, y: 0 },
          { id: 'x', kind: 'not', x: 0, y: 0 }
        ],
        wires: []
      }).code
    ).toBe('duplicate-id');
  });

  it('is plain data, so it survives a structured clone', () => {
    // The document crosses the worker barrier in Phase 2; nothing in it
    // may be a class or a function.
    const b = new CircuitBuilder();
    b.output('q', b.nand(b.input('x'), b.constant(1), 'g'));
    const circuit = b.build();

    expect(structuredClone(circuit)).toEqual(circuit);
    expect(JSON.parse(JSON.stringify(circuit))).toEqual(circuit);
  });
});
