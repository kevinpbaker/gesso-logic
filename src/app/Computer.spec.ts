import { describe, expect, it } from 'vitest';

import { assemble } from '../cpu/Assembler';
import { Emulator } from '../cpu/Emulator';
import { FRAMEBUFFER } from '../cpu/Isa';
import type { Circuit } from '../sim/Circuit';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { chipInterface } from '../sim/Chips';
import { compile } from '../sim/Netlist';
import { Simulator } from '../sim/Simulator';
import { memoryAndPorts, TIMER_BITS } from './Generators';
import { computerScene, DIAGONAL } from './Scenes';

function bench() {
  const { chips, ...top } = memoryAndPorts();
  const face = chipInterface(top as Circuit);
  const b = new CircuitBuilder();
  const dut = b.chip('io', 'memory and ports');
  for (const pin of face.inputs) b.connect(b.input(pin.name, 0, pin.width), { component: dut, pin: pin.name });
  const widths = new Map(face.outputs.map(pin => [pin.name, pin.width]));
  for (const pin of face.outputs) b.output(pin.name, { component: dut, pin: pin.name }, pin.width);
  const netlist = compile({ ...b.build(), chips: { ...chips, 'memory and ports': top as Circuit } });
  const sim = new Simulator(netlist);
  const settle = () => expect(sim.settle().settled).toBe(true);
  settle();
  const get = (pin: string) => {
    const width = widths.get(pin)!;
    let v = 0;
    for (let i = 0; i < width; i++) v |= sim.read(pin, width === 1 ? 'in' : `in[${i}]`) << i;
    return v >>> 0;
  };
  const set = (values: Record<string, number>) => {
    for (const [pin, value] of Object.entries(values)) sim.set(pin, value);
    settle();
  };
  return { gates: netlist.gateCount, face, get, set };
}

describe('memory and ports', () => {
  it('has the pins the CPU and the devices need', () => {
    const io = bench();
    expect(io.face.inputs.map(p => p.name)).toEqual(['ADDR', 'D', 'K', 'we', 'out', 'table', 'port', 'T', 'up', 'down', 'rst', 'clk']);
    expect(io.face.outputs.map(p => p.name)).toEqual(['M', ...Array.from({ length: 16 }, (_, y) => `F${y}`), 'S0', 'S1']);
  });

  it('reads and writes RAM below 0x80, and the screen is its top half, a row four bytes', () => {
    const io = bench();
    io.set({ rst: 1 });
    io.set({ rst: 0 });
    const write = (address: number, value: number) => {
      io.set({ ADDR: address, D: value });
      io.set({ we: 1 });
      io.set({ we: 0 });
    };
    write(0x10, 0x5a);
    write(0x40, 0x01); // pixel (0, 0)
    write(0x43, 0x80); // pixel (31, 0)
    write(0x7f, 0x80); // pixel (31, 15)
    write(0x90, 0x77); // nothing there
    io.set({ ADDR: 0x10 });
    expect(io.get('M')).toBe(0x5a);
    io.set({ ADDR: 0x90 });
    expect(io.get('M')).toBe(0);
    io.set({ ADDR: 0x10 }); // 0x90 didn't write 0x10's twin
    expect(io.get('M')).toBe(0x5a);
    expect(io.get('F0').toString(16)).toBe((0x80000001).toString(16));
    expect(io.get('F15')).toBe(0x80000000);
    expect(io.get('F7')).toBe(0);
  });

  it('puts the ROM’s table byte or the input port on M when asked', () => {
    const io = bench();
    io.set({ T: 0xa5, table: 1 });
    expect(io.get('M')).toBe(0xa5);
    io.set({ table: 0, port: 1, K: 0, up: 1, down: 0 });
    expect(io.get('M')).toBe(1);
    io.set({ up: 0, down: 1 });
    expect(io.get('M')).toBe(2);
    io.set({ K: 2 });
    expect(io.get('M')).toBe(0);
  });

  it('latches OUT 0 and OUT 1 while the strobe is up for that port', () => {
    const io = bench();
    io.set({ rst: 1 });
    io.set({ rst: 0 });
    // The data holds while the strobe falls, as the CPU's does: it
    // changes only after.
    io.set({ K: 0, D: 3 });
    io.set({ out: 1 });
    io.set({ out: 0 });
    io.set({ K: 1, D: 9 });
    io.set({ out: 1 });
    io.set({ out: 0 });
    io.set({ D: 0xff });
    expect([io.get('S0'), io.get('S1')]).toEqual([3, 9]);
    // A port with nothing on it: the port number settles before the
    // strobe rises, as it does in the CPU, where K is the instruction's.
    io.set({ K: 2 });
    io.set({ out: 1 });
    io.set({ out: 0 });
    expect([io.get('S0'), io.get('S1')]).toEqual([3, 9]);
    io.set({ rst: 1 });
    io.set({ rst: 0 });
    expect([io.get('S0'), io.get('S1')]).toEqual([0, 0]);
  });

  it('ticks: IN 1 is the timer’s top bit, which turns over every 512 cycles', () => {
    const io = bench();
    io.set({ rst: 1, clk: 1 });
    io.set({ clk: 0 });
    io.set({ rst: 0, port: 1, K: 1 });
    const half = 1 << (TIMER_BITS - 1);
    const seen: number[] = [];
    for (let cycle = 1; cycle <= 2 * half; cycle++) {
      io.set({ clk: 1 });
      io.set({ clk: 0 });
      if (cycle === half - 1 || cycle === half || cycle === 2 * half - 1 || cycle === 2 * half) seen.push(io.get('M'));
    }
    expect(seen).toEqual([0, 1, 1, 0]);
  }, 60_000);
});

describe('the computer', () => {
  it('draws a diagonal on the matrix, a pixel at a time, as the emulator does', () => {
    const scene = computerScene(DIAGONAL);
    const sim = new Simulator(compile(scene));
    sim.settle();
    sim.cycle();
    const row = (y: number) => {
      let v = 0;
      for (let x = 0; x < 32; x++) v |= sim.read('screen', `r${y}[${x}]`) << x;
      return v >>> 0;
    };
    const lit = () => Array.from({ length: 16 }, (_, y) => row(y)).reduce((n, r) => n + r.toString(2).split('1').length - 1, 0);
    const counts: number[] = [];
    let cycles = 0;
    while (sim.read('halted', 'in') === 0 && cycles < 5000) {
      expect(sim.cycle().settled).toBe(true);
      cycles++;
      const n = lit();
      if (counts[counts.length - 1] !== n) counts.push(n);
    }
    expect(sim.read('halted', 'in')).toBe(1);
    // One pixel more at a time, from none to sixteen.
    expect(counts).toEqual(Array.from({ length: 17 }, (_, i) => i));
    const emulator = new Emulator(assemble(DIAGONAL).rom);
    emulator.run();
    for (let y = 0; y < 16; y++) {
      const bytes = emulator.ram.slice(FRAMEBUFFER + 4 * y, FRAMEBUFFER + 4 * y + 4);
      const expected = (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
      expect(row(y), `row ${y}`).toBe(expected);
      expect(expected, `row ${y}`).toBe((1 << y) >>> 0);
    }
    expect(cycles).toBe(2 * emulator.instructions);
  }, 120_000);

  it('writes its ports and reads its buttons through the real strobe timing', () => {
    const program = `
        IN 0            ; the buttons
        OUT 0
        LDA #0x42
        OUT 1
        LDA #0x99       ; A moves on right after the OUT
        STA 0x20
        HLT
    `;
    const sim = new Simulator(compile(computerScene(program)));
    sim.settle();
    sim.set('up', 1);
    sim.cycle();
    for (let cycles = 0; sim.read('halted', 'in') === 0 && cycles < 100; cycles++) expect(sim.cycle().settled).toBe(true);
    const byte = (id: string) => [0, 1, 2, 3, 4, 5, 6, 7].reduce((v, i) => v | (sim.read(id, `in[${i}]`) << i), 0);
    expect([byte('left'), byte('right')]).toEqual([1, 0x42]);
  });
});
