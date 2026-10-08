import { describe, expect, it } from 'vitest';

import { CIRCUIT_VERSION, type Circuit } from './Circuit';
import { CircuitBuilder } from './CircuitBuilder';
import { readCircuit, writeCircuit } from './CircuitFile';

function small(): Circuit {
  const b = new CircuitBuilder();
  const g = b.gate('and', 'g');
  b.connect(b.input('a', 1), g.a);
  b.connect(b.clock(), g.b);
  b.output('led', g.out);
  b.describe({ led: 'Lights while the switch is on and the clock is high' });
  const c = b.build();
  return {
    ...c,
    components: c.components.map(x =>
      x.kind === 'clock' ? { ...x, rate: 2 } : x.id === 'g' ? { ...x, rotation: 90 as const } : x
    )
  };
}

describe('the circuit file', () => {
  it('reads back what it writes, every field', () => {
    const circuit = small();
    expect(readCircuit(writeCircuit(circuit))).toEqual(circuit);
  });

  it('keeps the pins traced in the analyser, and checks their shape', () => {
    const circuit = { ...small(), traces: [{ path: ['cpu', 'alu'], pin: { component: 'adder', pin: 'S' } }] };
    expect(readCircuit(writeCircuit(circuit))).toEqual(circuit);
    const bad = JSON.parse(writeCircuit(circuit));
    bad.traces[0].pin = 'S';
    expect(() => readCircuit(JSON.stringify(bad))).toThrow('traces[0].pin: not a component and a pin');
  });

  it('writes a component or a wire a line, so a move diffs as one line', () => {
    const circuit = small();
    const moved = { ...circuit, components: circuit.components.map(c => (c.id === 'g' ? { ...c, x: c.x + 1 } : c)) };
    const before = writeCircuit(circuit).split('\n');
    const after = writeCircuit(moved).split('\n');
    expect(before.filter((line, n) => line !== after[n])).toHaveLength(1);
  });

  it('says where a file is wrong', () => {
    const file = (patch: (data: any) => void) => {
      const data = JSON.parse(writeCircuit(small()));
      patch(data);
      return JSON.stringify(data);
    };
    const failure = (text: string) => {
      try {
        readCircuit(text);
      } catch (e) {
        return (e as Error).message;
      }
      return 'read';
    };
    expect(failure('{')).toMatch(/^not JSON/);
    expect(failure('{"format":"other"}')).toBe('not a gessologic circuit file');
    expect(failure(file(d => (d.version = CIRCUIT_VERSION + 1)))).toMatch(/newer gessologic/);
    expect(failure(file(d => (d.components[1].kind = 'flux')))).toBe('components[1].kind: "flux" is not a part');
    expect(failure(file(d => (d.components[1].x = 1.5)))).toBe('components[1].x: not a whole number');
    expect(failure(file(d => (d.wires[0].to.pin = 'z')))).toBe('wires[0].to: a and has no pin "z"');
    expect(failure(file(d => (d.wires[0].from.component = 'gone')))).toBe('wires[0].from: no component "gone"');
    expect(failure(file(d => (d.wires[0].id = d.components[0].id)))).toMatch(/used twice/);
    expect(failure(file(d => (d.components[0].note = 'an AND')))).toBe('components[0].note: a and is not a pin and has no note');
    expect(failure(file(d => (d.components[3].note = 7)))).toBe('components[3].note: not text');
  });

  it('drops fields it does not know, so a later file that only added some still opens', () => {
    const data = JSON.parse(writeCircuit(small()));
    data.author = 'someone';
    data.components[0].colour = 'red';
    expect(readCircuit(JSON.stringify(data))).toEqual(small());
  });
});
