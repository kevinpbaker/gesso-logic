import { describe, expect, it } from 'vitest';

import { CircuitBuilder } from './CircuitBuilder';
import { readCircuit, writeCircuit } from './CircuitFile';
import { compile } from './Netlist';
import { Simulator } from './Simulator';

/** A ROM between two address switches and two LED buses. */
function romBench(words: number[]) {
  const b = new CircuitBuilder();
  const rom = b.rom('rom', words);
  b.connect(b.input('A', 0, 8), { component: rom, pin: 'A' });
  b.connect(b.input('T', 0, 8), { component: rom, pin: 'T' });
  b.output('D', { component: rom, pin: 'D' }, 16);
  b.output('Q', { component: rom, pin: 'Q' }, 8);
  return b.build();
}

describe('the ROM', () => {
  it('reads a word at each port, a tick after its address changes', () => {
    const sim = new Simulator(compile(romBench([0x1234, 0xabcd, 0x00ff])));
    const read = (pin: string, width: number) => {
      let v = 0;
      for (let i = 0; i < width; i++) v |= sim.read(pin, `in[${i}]`) << i;
      return v;
    };
    // At power-on, address 0.
    expect([read('D', 16), read('Q', 8)]).toEqual([0x1234, 0x34]);
    sim.set('A', 1);
    sim.set('T', 2);
    expect(sim.settle()).toEqual({ settled: true, ticks: 1 });
    expect([read('D', 16), read('Q', 8)]).toEqual([0xabcd, 0xff]);
    // An address past the words given reads 0.
    sim.set('A', 200);
    sim.settle();
    expect(read('D', 16)).toBe(0);
  });

  it('keeps its words through a file', () => {
    const circuit = romBench([1, 2, 3]);
    expect(readCircuit(writeCircuit(circuit)).components.find(c => c.kind === 'rom')?.rom).toEqual([1, 2, 3]);
    const bad = writeCircuit(circuit).replace('"rom":[1,2,3]', '"rom":[1,2,70000]');
    expect(() => readCircuit(bad)).toThrow('components[0].rom: not a list of at most 256 words from 0 to 0xFFFF');
  });
});
