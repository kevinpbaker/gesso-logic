/**
 * Pong on the reference emulator, in the terminal: Phase 19's harness,
 * for playing the game before it runs on gates.
 *
 *   pnpm pong                 → at 30 kHz, the game's intended speed
 *   pnpm pong 60000           → at another clock rate
 *
 * ↑ / ↓ (or w / s) move your paddle, on the left; q quits. A terminal
 * sends a held key as a stream of presses, so a press holds the button
 * for a moment, which is enough to feel like holding it.
 */
import { readFileSync } from 'node:fs';

import { PongHarness } from '../src/cpu/PongHarness.ts';

const HZ = Number(process.argv[2] ?? 30_000);
const HOLD_MS = 150;

if (!process.stdin.isTTY) {
  console.error('pnpm pong needs a terminal to read keys from.');
  process.exit(1);
}

const game = new PongHarness(readFileSync('src/cpu/games/pong.asm', 'utf8'));
let upUntil = 0;
let downUntil = 0;

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (key: string) => {
  const now = performance.now();
  if (key === 'q' || key === '\u0003') quit();
  if (key === '\u001b[A' || key === 'w') upUntil = now + HOLD_MS;
  if (key === '\u001b[B' || key === 's') downUntil = now + HOLD_MS;
});

const quit = () => {
  clearInterval(timer);
  process.stdout.write('\u001b[?25h\n');
  process.exit(0);
};

/** Two pixel rows a text line, with half blocks. */
function render(): string {
  const lines: string[] = [];
  const [left, right] = game.shown;
  lines.push(`  you ${String(left).padStart(2)}   ·   ${String(right).padEnd(2)} cpu      ${(HZ / 1000).toFixed(0)} kHz, ↑↓ to move, q to quit`);
  lines.push(`  ┌${'─'.repeat(32)}┐`);
  for (let y = 0; y < 16; y += 2) {
    let row = '';
    for (let x = 0; x < 32; x++) {
      const top = game.pixel(x, y);
      const bottom = game.pixel(x, y + 1);
      row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`  │${row}│`);
  }
  lines.push(`  └${'─'.repeat(32)}┘`);
  return lines.join('\n');
}

const started = performance.now();
const startCycles = game.emulator.cycles;
process.stdout.write('\u001b[2J\u001b[?25l');
const timer = setInterval(() => {
  const now = performance.now();
  game.up = now < upUntil;
  game.down = now < downUntil;
  const target = startCycles + ((now - started) / 1000) * HZ;
  while (game.emulator.cycles < target) game.emulator.step();
  process.stdout.write(`\u001b[H${render()}`);
}, 1000 / 60);
