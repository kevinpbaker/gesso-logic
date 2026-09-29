import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assemble } from '../cpu/Assembler';
import { ALU_OP, EXECUTE, FETCH, RIGHT, taken, type Lines } from '../cpu/Control';
import { Emulator } from '../cpu/Emulator';
import { INSTRUCTIONS, RAM_SIZE } from '../cpu/Isa';
import type { Circuit } from '../sim/Circuit';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { chipInterface } from '../sim/Chips';
import { compile } from '../sim/Netlist';
import { Simulator } from '../sim/Simulator';
import { controlUnit, cpu, type Generated } from './Generators';
import { computerScene } from './Scenes';

/** A part between switches and LEDs; see Generators.spec. */
function bench(generated: Generated, name: string) {
  const { chips, ...top } = generated;
  const face = chipInterface(top as Circuit);
  const b = new CircuitBuilder();
  const dut = b.chip('dut', name);
  for (const pin of face.inputs) b.connect(b.input(pin.name, 0, pin.width), { component: dut, pin: pin.name });
  const widths = new Map(face.outputs.map(pin => [pin.name, pin.width]));
  for (const pin of face.outputs) b.output(pin.name, { component: dut, pin: pin.name }, pin.width);
  const netlist = compile({ ...b.build(), chips: { ...chips, [name]: top as Circuit } });
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
  return { gates: netlist.gateCount, face, get, set };
}

/** What the control unit's lines should read for a cycle, as numbers on its pins. */
function expected(lines: Lines, flags: { z: boolean; c: boolean; n: boolean }) {
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
    op: lines.op === undefined ? 0 : ALU_OP[lines.op],
    left: lines.left === 'X' ? 1 : 0,
    right: RIGHT[lines.right ?? 'K'],
    index: lines.index ? 1 : 0,
    table: lines.source === 'table' ? 1 : 0,
    port: lines.source === 'port' ? 1 : 0
  };
}

describe('the control unit', () => {
  it('raises what the control table says, for every opcode, on both cycles, whatever the flags', () => {
    const chips: Record<string, Circuit> = {};
    const name = controlUnit(chips);
    const { [name]: top, ...rest } = chips;
    const unit = bench({ ...top!, chips: rest }, name);
    const read = () => Object.fromEntries(Object.keys(expected({}, { z: false, c: false, n: false })).map(k => [k, unit.get(k)]));
    for (const instruction of INSTRUCTIONS) {
      for (let flags = 0; flags < 8; flags++) {
        const f = { z: (flags & 1) === 1, c: (flags & 2) === 2, n: (flags & 4) === 4 };
        unit.set({ OP: instruction.opcode, Z: flags & 1, C: (flags >> 1) & 1, N: flags >> 2, rst: 1 });
        unit.set({ clk: 1 });
        unit.set({ clk: 0, rst: 0 });
        const at = `${instruction.mnemonic} ${instruction.mode}, flags ${flags}`;
        // The clock is low here, so the strobes may show; they're checked below.
        expect(read(), `${at}, fetch`).toEqual(expected(FETCH, f));
        expect(unit.get('halted'), at).toBe(0);
        unit.set({ clk: 1 });
        const lines = EXECUTE.get(instruction.opcode)!;
        // Clock high: the strobes are low whatever the instruction.
        expect([unit.get('we'), unit.get('out')], `${at}, clock high`).toEqual([0, 0]);
        const lineValues = expected(lines, f);
        // `op` and `right` don't matter where nothing is loaded; the
        // table leaves them undefined and the unit leaves them 0.
        expect(read(), `${at}, execute`).toEqual({ ...lineValues, right: lines.right === undefined ? unit.get('right') : lineValues.right });
        unit.set({ clk: 0 });
        expect([unit.get('we'), unit.get('out')], `${at}, clock low`).toEqual([lines.store ? 1 : 0, lines.out ? 1 : 0]);
        unit.set({ clk: 1 });
        unit.set({ clk: 0 });
        expect(unit.get('halted'), `${at}, after`).toBe(lines.halt ? 1 : 0);
      }
    }
  }, 120_000);
});

describe('the CPU', () => {
  const programs = join(dirname(fileURLToPath(import.meta.url)), '../cpu/programs');
  for (const file of readdirSync(programs).filter(f => f.endsWith('.asm'))) {
    it(`runs ${file} in step with the emulator, cycle by cycle`, () => {
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
      const log: number[] = [];
      const emulatorLog: number[] = [];
      const emulator = new Emulator(rom, {
        read: port => inputs.get(port) ?? 0,
        write: (port, value) => port === 3 && emulatorLog.push(value)
      });
      const ram = new Uint8Array(RAM_SIZE);
      const c = bench(cpu(), 'CPU');
      // Memory and devices, in JavaScript: the ROM behind `I`, RAM, the
      // table port or a port behind `M`, and the strobes written through.
      const drive = () => {
        c.set({ I: rom[c.get('PC')]! });
        const address = c.get('ADDR');
        c.set({ M: c.get('table') ? rom[address]! & 0xff : c.get('port') ? (inputs.get(c.get('K') & 3) ?? 0) : address < RAM_SIZE ? ram[address]! : 0 });
      };
      const cycle = () => {
        drive();
        c.set({ clk: 0 });
        if (c.get('we') && c.get('ADDR') < RAM_SIZE) ram[c.get('ADDR')] = c.get('D');
        if (c.get('out') && (c.get('K') & 3) === 3) log.push(c.get('D'));
        c.set({ clk: 1 });
      };
      c.set({ rst: 1, clk: 1 });
      c.set({ clk: 0 });
      c.set({ clk: 1 });
      c.set({ rst: 0 });
      let instructions = 0;
      while (!emulator.state.halted && instructions < 5000) {
        cycle();
        cycle();
        emulator.step();
        instructions++;
        const s = emulator.state;
        const at = `after ${instructions} instructions`;
        expect({ pc: c.get('PC'), a: c.get('A'), b: c.get('B'), x: c.get('X') }, at).toEqual({ pc: s.pc, a: s.a, b: s.b, x: s.x });
        expect([...ram], at).toEqual([...emulator.ram]);
      }
      expect(emulator.state.halted).toBe(true);
      expect(c.get('halted'), 'the CPU halts where the emulator does').toBe(1);
      expect(log).toEqual(emulatorLog);
      // Halted, the clock does nothing.
      const pc = c.get('PC');
      cycle();
      cycle();
      expect(c.get('PC')).toBe(pc);
    }, 120_000);
  }

  it('is the datapath and a control unit inside the budget’s 500 gates', () => {
    expect(bench(cpu(), 'CPU').gates).toBe(1323 + 343);
  });
});

describe('the computer scene', () => {
  it('runs three instructions from its ROM, and halts', () => {
    const sim = new Simulator(compile(computerScene()));
    sim.settle();
    sim.cycle();
    sim.set('rst', 0);
    let cycles = 0;
    while (sim.read('halted', 'in') === 0 && cycles < 100) {
      expect(sim.cycle().settled).toBe(true);
      cycles++;
    }
    const byte = (id: string) => [0, 1, 2, 3, 4, 5, 6, 7].reduce((v, i) => v | (sim.read(id, `in[${i}]`) << i), 0);
    expect(byte('A')).toBe(8);
    expect(cycles).toBe(6);
  });
});
