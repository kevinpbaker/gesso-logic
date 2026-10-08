import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assemble } from '../cpu/Assembler';
import { compile } from '../sim/Netlist';
import { Simulator } from '../sim/Simulator';
import { History } from './History';
import { computerScene } from './Scenes';

const games = join(dirname(fileURLToPath(import.meta.url)), '../cpu/games');

/** Runs a simulator from a keyframe to `cycle`, giving the logged inputs on the way, as the service replays. */
function replay(simulator: Simulator, history: History, cycle: number): Uint8Array {
  const plan = history.plan(cycle)!;
  simulator.restore(plan.from.values, plan.from.cycle);
  let next = 0;
  while (simulator.cycles < cycle) {
    while (next < plan.inputs.length && plan.inputs[next]!.cycle === simulator.cycles) {
      simulator.set(plan.inputs[next]!.id, plan.inputs[next]!.value);
      next++;
    }
    simulator.cycle();
  }
  return simulator.value;
}

describe('history', () => {
  it('keeps a keyframe every so often, within its budget, and starts afresh on a skipped cycle', () => {
    const history = new History(64, 4);
    const values = (n: number) => new Uint8Array(16).fill(n);
    for (let cycle = 1; cycle <= 20; cycle++) history.record(cycle, values(cycle));
    // Keyframes at 1, 5, 9, 13, 17 of 16 bytes; a budget of 64 keeps the newest four.
    expect([history.first, history.last]).toEqual([5, 20]);
    expect(history.plan(11)?.from.cycle).toBe(9);
    expect(history.plan(4)).toBeNull();
    history.record(30, values(30));
    expect([history.first, history.last]).toEqual([30, 30]);
  });

  it('has any cycle of Pong on gates again exactly, with the paddle moved on the way', () => {
    const pong = assemble(readFileSync(join(games, 'pong.asm'), 'utf8'));
    const netlist = compile(computerScene(Array.from(pong.rom)));
    const live = new Simulator(netlist);
    const history = new History();
    const seen = new Map<number, Uint8Array>();
    const press = (cycle: number) => (cycle % 900 < 300 ? 1 : 0);
    for (let cycle = 0; cycle < 3000; cycle++) {
      const up = press(live.cycles);
      if (live.cycles === 0 || up !== press(live.cycles - 1)) {
        history.input(live.cycles, 'up', up);
        live.set('up', up);
      }
      live.cycle();
      history.record(live.cycles, live.value);
      if (live.cycles % 337 === 0) seen.set(live.cycles, live.value.slice());
    }
    const again = new Simulator(netlist);
    for (const [cycle, values] of seen) {
      expect(Buffer.from(replay(again, history, cycle)).equals(Buffer.from(values)), `cycle ${cycle}`).toBe(true);
    }
  }, 60_000);
});
