import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Circuit } from '../sim/Circuit';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { writeCircuit, readCircuit } from '../sim/CircuitFile';
import { chipInterface } from '../sim/Chips';
import { compile } from '../sim/Netlist';
import { Simulator } from '../sim/Simulator';
import { decoderName, generatedFiles, ram, registerFile, type Generated } from './Generators';
import { ramScene } from './Scenes';

/**
 * A generated part as it is used: an instance of it between switches and
 * LEDs of its pins' widths, compiled like any document.
 */
function part(generated: Generated, name: string) {
  const { chips, ...top } = generated;
  const all: Record<string, Circuit> = { ...chips, [name]: top as Circuit };
  const face = chipInterface(top as Circuit);
  const b = new CircuitBuilder();
  const dut = b.chip('dut', name);
  for (const pin of face.inputs) b.connect(b.input(pin.name, 0, pin.width), { component: dut, pin: pin.name });
  const widths = new Map(face.outputs.map(pin => [pin.name, pin.width]));
  for (const pin of face.outputs) b.output(pin.name, { component: dut, pin: pin.name }, pin.width);
  const netlist = compile({ ...b.build(), chips: all });
  const sim = new Simulator(netlist);
  expect(sim.settle().settled).toBe(true);
  return {
    gates: netlist.gateCount,
    face,
    set(values: Record<string, number>) {
      for (const [pin, value] of Object.entries(values)) sim.set(pin, value);
      expect(sim.settle().settled).toBe(true);
    },
    get(pin: string): number {
      const width = widths.get(pin)!;
      let value = 0;
      for (let i = 0; i < width; i++) value |= sim.read(pin, width === 1 ? 'in' : `in[${i}]`) << i;
      return value;
    },
    cycle() {
      expect(sim.cycle().settled).toBe(true);
    },
    sim
  };
}

describe('the RAM generator', () => {
  it('makes a 128-byte RAM that holds a byte at every address', () => {
    const r = part(ram(128), 'RAM 128');
    expect(r.face.inputs.map(p => `${p.name}${p.width > 1 ? `[${p.width}]` : ''}`)).toEqual(['A[7]', 'D[8]', 'we', 'rst']);
    expect(r.face.outputs.map(p => p.name)).toEqual(['Q']);
    const pattern = (address: number) => (address * 37 + 11) & 0xff;
    // Reset first: the latches wake however document order leaves them.
    r.set({ rst: 1 });
    r.set({ rst: 0 });
    for (let address = 0; address < 128; address++) {
      r.set({ A: address });
      expect(r.get('Q'), `0x${address.toString(16)} after reset`).toBe(0);
    }
    // Write: address and data steady, then a pulse on `we`.
    for (let address = 0; address < 128; address++) {
      r.set({ A: address, D: pattern(address) });
      r.set({ we: 1 });
      r.set({ we: 0 });
    }
    for (let address = 0; address < 128; address++) {
      r.set({ A: address });
      expect(r.get('Q'), `0x${address.toString(16)}`).toBe(pattern(address));
    }
    // A second pass, every byte changed, in reverse.
    for (let address = 127; address >= 0; address--) {
      r.set({ A: address, D: pattern(address) ^ 0xff });
      r.set({ we: 1 });
      r.set({ we: 0 });
    }
    for (let address = 0; address < 128; address++) {
      r.set({ A: address });
      expect(r.get('Q'), `0x${address.toString(16)}, rewritten`).toBe(pattern(address) ^ 0xff);
    }
    // Reset clears it all again.
    r.set({ rst: 1 });
    r.set({ rst: 0 });
    for (let address = 0; address < 128; address += 7) {
      r.set({ A: address });
      expect(r.get('Q')).toBe(0);
    }
  });

  it('holds while `we` is low, whatever D and A do', () => {
    const r = part(ram(128), 'RAM 128');
    r.set({ rst: 1 });
    r.set({ rst: 0 });
    r.set({ A: 5, D: 0x5a });
    r.set({ we: 1 });
    r.set({ we: 0 });
    for (let address = 0; address < 128; address++) r.set({ A: address, D: address });
    r.set({ A: 5 });
    expect(r.get('Q')).toBe(0x5a);
  });

  it('costs what the budget says', () => {
    // 128 bytes of 42 gates; eight rows of 16 selects and a 16-way OR
    // tree; a 4 → 16 decoder (two 2 → 4s and 16 ANDs, 28 gates) and a
    // 3 → 8 (a 1 → 2, a 2 → 4 and 8 ANDs, 15); an 8-way OR tree; the
    // reset gating on D. ROADMAP's CPU budget is built from this.
    expect(part(ram(128), 'RAM 128').gates).toBe(128 * 42 + 8 * (16 + 15 * 8) + 28 + 15 + 7 * 8 + 9);
  });

  it('makes the other sizes, down to one row', () => {
    for (const bytes of [16, 32, 256]) {
      const r = part(ram(bytes), `RAM ${bytes}`);
      r.set({ rst: 1 });
      r.set({ rst: 0 });
      for (const address of [0, bytes - 1, bytes >> 1]) {
        r.set({ A: address, D: address ^ 0xa5 });
        r.set({ we: 1 });
        r.set({ we: 0 });
      }
      for (const address of [0, bytes - 1, bytes >> 1]) {
        r.set({ A: address });
        expect(r.get('Q'), `${bytes} bytes, 0x${address.toString(16)}`).toBe(address ^ 0xa5);
      }
    }
    expect(() => ram(100)).toThrow('A RAM is 16, 32, 64, 128 or 256 bytes, not 100.');
  });

  it('decodes with shared partial decoders', () => {
    const { chips } = ram(128);
    expect(Object.keys(chips).filter(name => name.startsWith('decoder')).sort()).toEqual([decoderName(1), decoderName(2), decoderName(3), decoderName(4)].sort());
  });
});

describe('the register file generator', () => {
  it('loads each register on the clock edge while its line is high, and only that one', () => {
    const r = part(registerFile(), 'register file');
    expect(r.face.inputs.map(p => p.name)).toEqual(['D', 'load A', 'load B', 'load X', 'clk']);
    expect(r.face.outputs.map(p => p.name)).toEqual(['A', 'B', 'X']);
    const tick = () => {
      r.set({ clk: 1 });
      r.set({ clk: 0 });
    };
    r.set({ D: 0x11, 'load A': 1 });
    tick();
    r.set({ D: 0x22, 'load A': 0, 'load B': 1 });
    tick();
    r.set({ D: 0x33, 'load B': 0, 'load X': 1 });
    tick();
    r.set({ D: 0x44, 'load X': 0 });
    tick();
    expect([r.get('A'), r.get('B'), r.get('X')]).toEqual([0x11, 0x22, 0x33]);
    r.set({ 'load A': 1, 'load X': 1 });
    tick();
    expect([r.get('A'), r.get('B'), r.get('X')]).toEqual([0x44, 0x22, 0x44]);
    expect(r.gates).toBe(3 * 104);
  });
});

describe('the generated files', () => {
  const circuits = join(dirname(fileURLToPath(import.meta.url)), '../../circuits');
  for (const [name, generated] of Object.entries(generatedFiles())) {
    it(`circuits/${name} is what the generator makes: run pnpm generate if not`, () => {
      const text = readFileSync(join(circuits, name), 'utf8');
      expect(text).toBe(writeCircuit(generated));
      // And it reads back as a document that compiles.
      expect(compile(readCircuit(text)).gateCount).toBeGreaterThan(0);
    });
  }
});

describe('the RAM scene', () => {
  it('is the generated RAM as a chip, between switches, buttons and displays', () => {
    const scene = ramScene();
    expect(scene.components.find(c => c.id === 'ram')).toMatchObject({ kind: 'chip', chip: 'RAM 128' });
    expect(compile(scene).gateCount).toBe(6572);
  });
});
