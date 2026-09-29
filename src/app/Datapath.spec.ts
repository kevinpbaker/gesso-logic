import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assemble } from '../cpu/Assembler';
import { ALU_OP, EXECUTE, FETCH, RIGHT, taken, type Lines } from '../cpu/Control';
import { Emulator } from '../cpu/Emulator';
import { RAM_SIZE } from '../cpu/Isa';
import type { Circuit } from '../sim/Circuit';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { chipInterface } from '../sim/Chips';
import { compile } from '../sim/Netlist';
import { Simulator } from '../sim/Simulator';
import { datapath } from './Generators';

/**
 * The datapath driven from switches, as Phase 15 has it: an instance
 * between a switch for every input pin and an LED for every output,
 * with the control lines set by hand — here, by the spec, from the
 * control table.
 */
function bench() {
  const { chips, ...top } = datapath();
  const face = chipInterface(top as Circuit);
  const b = new CircuitBuilder();
  const dut = b.chip('dp', 'datapath');
  for (const pin of face.inputs) b.connect(b.input(pin.name, 0, pin.width), { component: dut, pin: pin.name });
  const widths = new Map(face.outputs.map(pin => [pin.name, pin.width]));
  for (const pin of face.outputs) b.output(pin.name, { component: dut, pin: pin.name }, pin.width);
  const netlist = compile({ ...b.build(), chips: { ...chips, datapath: top as Circuit } });
  const sim = new Simulator(netlist);
  const settle = () => expect(sim.settle().settled).toBe(true);
  settle();
  const get = (pin: string) => {
    const width = widths.get(pin)!;
    let v = 0;
    for (let i = 0; i < width; i++) v |= sim.read(pin, width === 1 ? 'in' : `in[${i}]`) << i;
    return v;
  };
  const set = (values: Record<string, number>) => {
    for (const [pin, value] of Object.entries(values)) sim.set(pin, value);
    settle();
  };
  const tick = () => set({ clk: 1 }) ?? set({ clk: 0 });
  return { gates: netlist.gateCount, face, get, set, tick };
}

/** The switch settings for a cycle's lines; every line not raised is low. */
function switches(lines: Lines, flags: { z: boolean; c: boolean; n: boolean }): Record<string, number> {
  return {
    ir: lines.ir ? 1 : 0,
    inc: lines.inc ? 1 : 0,
    jump: lines.jump !== undefined && taken(lines.jump, flags) ? 1 : 0,
    ret: lines.ret ? 1 : 0,
    link: lines.link ? 1 : 0,
    la: lines.la ? 1 : 0,
    lb: lines.lb ? 1 : 0,
    lx: lines.lx ? 1 : 0,
    lzn: lines.lzn ? 1 : 0,
    lc: lines.lc ? 1 : 0,
    op: ALU_OP[lines.op ?? 'PASS_R'],
    left: lines.left === 'X' ? 1 : 0,
    right: RIGHT[lines.right ?? 'ZERO'],
    index: lines.index ? 1 : 0
  };
}

describe('the datapath', () => {
  it('has a pin for every control line', () => {
    const d = bench();
    expect(d.face.inputs.map(p => p.name)).toEqual(['I', 'M', 'ir', 'inc', 'jump', 'ret', 'link', 'la', 'lb', 'lx', 'lzn', 'lc', 'op', 'left', 'right', 'index', 'rst', 'clk']);
    expect(d.face.outputs.map(p => p.name)).toEqual(['PC', 'OP', 'K', 'ADDR', 'A', 'B', 'X', 'L', 'Z', 'C', 'N']);
  });

  it('loads two registers and adds them, by switches', () => {
    // Phase 15's exit, as a person would do it at the bench.
    const d = bench();
    d.set({ rst: 1 });
    d.tick();
    d.set({ rst: 0 });
    // IR ← a word with K = 0x12; then A ← K.
    d.set({ I: 0x0012, ir: 1 });
    d.tick();
    d.set({ ir: 0, op: ALU_OP.PASS_R, right: RIGHT.K, la: 1 });
    d.tick();
    // K = 0x30; B ← K.
    d.set({ la: 0, I: 0x0030, ir: 1 });
    d.tick();
    d.set({ ir: 0, lb: 1 });
    d.tick();
    // A ← A + B, flags too.
    d.set({ lb: 0, op: ALU_OP.ADD, right: RIGHT.B, la: 1, lzn: 1, lc: 1 });
    d.tick();
    expect([d.get('A'), d.get('B'), d.get('Z'), d.get('C'), d.get('N')]).toEqual([0x42, 0x30, 0, 0, 0]);
  });

  it('resets every register and flag on a clock edge', () => {
    const d = bench();
    d.set({ I: 0xffff, M: 0xff, ir: 1, inc: 1, la: 1, lb: 1, lx: 1, lzn: 1, lc: 1, link: 1, op: ALU_OP.PASS_R, right: RIGHT.M });
    d.tick();
    d.tick();
    d.set({ rst: 1 });
    d.tick();
    expect(['PC', 'OP', 'K', 'A', 'B', 'X', 'L', 'Z', 'C', 'N'].map(pin => d.get(pin))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  // Every test program, the datapath driven cycle by cycle from the
  // control table by a control unit written in JavaScript, with the ROM,
  // RAM and ports behind `I` and `M` in JavaScript too; held to the
  // emulator after every instruction.
  const programs = join(dirname(fileURLToPath(import.meta.url)), '../cpu/programs');
  for (const file of readdirSync(programs).filter(f => f.endsWith('.asm'))) {
    it(`runs ${file} in step with the emulator`, () => {
      const source = readFileSync(join(programs, file), 'utf8');
      const inputs = new Map(
        source
          .split('\n')
          .filter(line => line.startsWith(';<'))
          .flatMap(line => line.slice(2).trim().split(/\s+/))
          .map(pair => pair.split('=') as [string, string])
          .map(([k, v]) => [Number(k.slice(2)), Number(v)])
      );
      const { rom } = assemble(source);
      const emulator = new Emulator(rom, { read: port => inputs.get(port) ?? 0 });
      const ram = new Uint8Array(RAM_SIZE);
      const d = bench();
      d.set({ rst: 1 });
      d.tick();
      d.set({ rst: 0 });
      for (let n = 0; n < 5000 && !emulator.state.halted; n++) {
        const pc = d.get('PC');
        // Fetch.
        d.set({ ...switches(FETCH, { z: false, c: false, n: false }), I: rom[pc]! });
        d.tick();
        // Execute.
        const lines = EXECUTE.get(d.get('OP'))!;
        const flags = { z: d.get('Z') === 1, c: d.get('C') === 1, n: d.get('N') === 1 };
        d.set(switches(lines, flags));
        const address = d.get('ADDR');
        const m = lines.source === 'ram' ? (address < RAM_SIZE ? ram[address]! : 0) : lines.source === 'table' ? rom[address]! & 0xff : lines.source === 'port' ? (inputs.get(d.get('K')) ?? 0) : 0;
        d.set({ M: m });
        if (lines.store && address < RAM_SIZE) ram[address] = d.get('A');
        d.tick();
        emulator.step();
        const s = emulator.state;
        const at = `after ${n + 1} instructions, at 0x${pc.toString(16)}`;
        expect(
          { pc: d.get('PC'), a: d.get('A'), b: d.get('B'), x: d.get('X'), z: d.get('Z') === 1, c: d.get('C') === 1, n: d.get('N') === 1 },
          at
        ).toEqual({ pc: s.pc, a: s.a, b: s.b, x: s.x, z: s.z, c: s.c, n: s.n });
        expect([...ram], at).toEqual([...emulator.ram]);
        if (lines.halt) break;
      }
      expect(emulator.state.halted).toBe(true);
    }, 60_000);
  }

  it('costs what its parts do', () => {
    // Registers: A, B, X (the register file), IR's two bytes and L, 104
    // each; PC, a counter, 129; the flags, 43. The ALU, 245. Muxes: left,
    // PC source and address at 32, right at 96. The index adder, 48. The
    // reset clears, 9 a byte loaded, and 6 ORs putting reset on loads.
    expect(bench().gates).toBe(6 * 104 + 129 + 43 + 245 + 3 * 32 + 96 + 48 + 4 * 9 + 6);
  });
});
