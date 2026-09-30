/**
 * Phase 18's lockstep, at length: every test program, then random
 * programs with random buttons for a given time, the gate-level computer
 * and the emulator compared after every instruction. Stops at the first
 * divergence, prints it, and exits 1.
 *
 *   pnpm lockstep              → a minute of fuzzing
 *   pnpm lockstep 10           → ten seconds
 */
import { readdirSync, readFileSync } from 'node:fs';

import { Lockstep, pongPlayer, randomButtons, randomProgram } from '../src/app/Lockstep.ts';
import { assemble } from '../src/cpu/Assembler.ts';
import { bcd } from '../src/cpu/PongHarness.ts';

const seconds = Number(process.argv[2] ?? 60);
const programs = 'src/cpu/programs';

const fail = (what: string, message: string) => {
  console.error(`${what}: ${message}`);
  process.exit(1);
};

for (const file of readdirSync(programs).filter(f => f.endsWith('.asm'))) {
  const lockstep = new Lockstep(assemble(readFileSync(`${programs}/${file}`, 'utf8')).rom);
  const divergence = lockstep.run(10_000, file === 'io.asm' ? () => ({ up: false, down: true }) : undefined);
  if (divergence !== null) fail(file, divergence.message);
  console.log(`${file}: ${lockstep.instructions} instructions, no divergence`);
}

// A whole game of Pong, to 11, against a player about as good as the CPU.
{
  const pong = assemble(readFileSync('src/cpu/games/pong.asm', 'utf8'));
  const lockstep = new Lockstep(pong.rom);
  const player = pongPlayer(lockstep, pong.symbols);
  const [sl, sr] = [pong.symbols.get('SL')!, pong.symbols.get('SR')!];
  const began = performance.now();
  let scores = [0, 0];
  while (Math.max(...scores) < 11) {
    const divergence = lockstep.step(player());
    if (divergence !== null) fail('pong.asm', divergence.message);
    scores = [bcd(lockstep.emulator.ram[sl]!), bcd(lockstep.emulator.ram[sr]!)];
    if (lockstep.instructions > 3_000_000) fail('pong.asm', 'no one reached 11 in three million instructions');
  }
  console.log(
    `pong.asm: a game to ${scores.join('–')}, ${lockstep.instructions.toLocaleString('en')} instructions ` +
      `(${(lockstep.emulator.cycles / 18_000).toFixed(0)} s of play at 18 kHz) in ${((performance.now() - began) / 1000).toFixed(0)} s, no divergence`
  );
}

const started = performance.now();
let seed = Number(process.env['SEED'] ?? Date.now() % 1_000_000);
let programsRun = 0;
let instructions = 0;
while (performance.now() - started < seconds * 1000) {
  const lockstep = new Lockstep(randomProgram(seed));
  const divergence = lockstep.run(5_000, randomButtons(seed));
  if (divergence !== null) fail(`random program, seed ${seed}`, divergence.message);
  programsRun++;
  instructions += lockstep.instructions;
  seed++;
}
const elapsed = (performance.now() - started) / 1000;
console.log(
  `fuzzed ${programsRun} random programs, ${instructions.toLocaleString('en')} instructions ` +
    `(${Math.round(instructions / elapsed).toLocaleString('en')} a second) in ${elapsed.toFixed(0)} s: no divergence`
);
