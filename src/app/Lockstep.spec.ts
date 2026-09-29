import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assemble } from '../cpu/Assembler';
import { Lockstep, pongPlayer, randomButtons, randomProgram } from './Lockstep';

/**
 * Phase 18: the gate-level computer in lockstep with the emulator. The
 * test programs, then fuzzed ones, then faults put in on purpose, to see
 * the first divergence named. `pnpm lockstep` runs the fuzzer for a
 * minute; this runs it for a few seconds, in every `pnpm test`.
 */
const programs = join(dirname(fileURLToPath(import.meta.url)), '../cpu/programs');

describe('lockstep', () => {
  for (const file of readdirSync(programs).filter(f => f.endsWith('.asm'))) {
    it(`runs ${file} with no divergence, to the halt`, () => {
      const source = readFileSync(join(programs, file), 'utf8');
      const lockstep = new Lockstep(assemble(source).rom);
      // io.asm reads the buttons: hold one down, as its `;<` line does for port 0's low bits.
      const buttons = file === 'io.asm' ? () => ({ up: false, down: true }) : undefined;
      const divergence = lockstep.run(10_000, buttons);
      expect(divergence?.message ?? null).toBe(null);
      expect(lockstep.emulator.state.halted).toBe(true);
    }, 120_000);
  }

  it('plays Pong on gates in step with the emulator, through the first points', () => {
    // `pnpm lockstep` plays a whole game; this, the first few points.
    const pong = assemble(readFileSync(join(programs, '../games/pong.asm'), 'utf8'));
    const lockstep = new Lockstep(pong.rom);
    const player = pongPlayer(lockstep, pong.symbols);
    const [sl, sr] = [pong.symbols.get('SL')!, pong.symbols.get('SR')!];
    while (lockstep.emulator.ram[sl]! + lockstep.emulator.ram[sr]! < 2) {
      const divergence = lockstep.step(player());
      expect(divergence?.message ?? null).toBe(null);
      expect(lockstep.instructions).toBeLessThan(400_000);
    }
  }, 120_000);

  it('runs random programs with random buttons, with no divergence', () => {
    const started = performance.now();
    let instructions = 0;
    let seed = 1;
    // A few seconds' worth here; `pnpm lockstep` runs the full minute.
    while (performance.now() - started < 8_000) {
      const lockstep = new Lockstep(randomProgram(seed));
      const divergence = lockstep.run(3_000, randomButtons(seed));
      expect(divergence?.message ?? null, `seed ${seed}`).toBe(null);
      instructions += lockstep.instructions;
      seed++;
    }
    expect(instructions).toBeGreaterThan(10_000);
  }, 120_000);

  it('reads the frame tick as the hardware keeps it', () => {
    // Waits for the tick to go high, then low, then counts it.
    const program = assemble(`
      wait1:  IN 1
              CMP #1
              JNZ wait1
      wait0:  IN 1
              CMP #0
              JNZ wait0
              LDA #0x77
              OUT 0
              HLT
    `).rom;
    const lockstep = new Lockstep(program);
    expect(lockstep.run(5_000)?.message ?? null).toBe(null);
    expect(lockstep.emulator.state.halted).toBe(true);
    expect(lockstep.emulator.cycles).toBeGreaterThan(1024);
  }, 120_000);

  it('names the first divergence: the instruction, the cycle, the place and the bit', () => {
    const lockstep = new Lockstep(assemble('LDA #1\nSTA 0x45\nADD #1\nSTA 0x46\nHLT').rom);
    expect(lockstep.step()).toBe(null);
    expect(lockstep.step()).toBe(null);
    // A latch flipped behind the CPU's back: bit 2 of the byte at 0x45.
    lockstep.sim.force(lockstep.netlist.netOfPin('memory/RAM/row 4/byte 5', 'P[2]')!, 1);
    const divergence = lockstep.step();
    expect(divergence).toMatchObject({ instruction: 3, cycle: 7, pc: 2, text: 'ADD #0x01', what: 'RAM[0x45]', gates: 5, emulator: 1, bit: 2 });
    expect(divergence!.message).toBe(
      'Diverged at instruction 3, cycle 7: ADD #0x01 at 0x02 left RAM[0x45] 0x05 on gates and 0x01 in the emulator, first in bit 2.'
    );
  });

  it('catches a register that differs', () => {
    const lockstep = new Lockstep(assemble('LDX #3\nINX\nHLT').rom);
    expect(lockstep.step()).toBe(null);
    lockstep.emulator.state.x = 7;
    expect(lockstep.step()).toMatchObject({ what: 'X', gates: 4, emulator: 8, bit: 2 });
  });
});
