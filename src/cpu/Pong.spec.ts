import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PongHarness, TICK_CYCLES, type PongState } from './PongHarness';

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'games/pong.asm'), 'utf8');

/** What the screen should show for a state: two paddles and a ball, each flipped on. */
function expectedScreen(state: PongState): string {
  const lit = new Set<string>();
  const flip = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (lit.has(key)) lit.delete(key);
    else lit.add(key);
  };
  for (let row = 0; row < 4; row++) {
    flip(1, state.left + row);
    flip(30, state.right + row);
  }
  flip(state.ball.x, state.ball.y);
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = '';
    for (let x = 0; x < 32; x++) row += lit.has(`${x},${y}`) ? '#' : '.';
    rows.push(row);
  }
  return rows.join('\n');
}

/** Plays frames, checking after every one that the screen is the game's state and the frame's work fit in it. */
function play(game: PongHarness, frames: number, each?: (state: PongState, frame: number) => void): void {
  let before = game.state;
  for (let n = 0; n < frames; n++) {
    game.frame();
    const state = game.state;
    expect(game.screen(), `frame ${n}`).toBe(expectedScreen(state));
    // A frame's work fits between two turns of the tick — but for a new
    // game's, which clears the screen and redraws the paddles once.
    const restarted = state.scores[0] + state.scores[1] === 0 && before.scores[0] + before.scores[1] > 0;
    if (!restarted) expect(game.lastWork, `frame ${n}'s work`).toBeLessThan(TICK_CYCLES);
    before = state;
    expect(state.ball.y).toBeGreaterThanOrEqual(0);
    expect(state.ball.y).toBeLessThanOrEqual(15);
    expect(state.left).toBeLessThanOrEqual(12);
    expect(state.right).toBeLessThanOrEqual(12);
    each?.(state, n);
  }
}

describe('Pong, on the emulator', () => {
  it('fits in the ROM with room to spare: under 256 words, tables and all', () => {
    const game = new PongHarness(SOURCE);
    expect(game.program.size).toBeLessThan(256);
  });

  it('starts with the paddles in the middle and the ball served from the centre', () => {
    const game = new PongHarness(SOURCE);
    const state = game.state;
    expect([state.left, state.right, state.ball.x, state.scores]).toEqual([6, 6, 16, [0, 0]]);
    expect(game.screen()).toBe(expectedScreen(state));
  });

  it('moves the player’s paddle with the buttons, and stops it at the edges', () => {
    const game = new PongHarness(SOURCE);
    game.up = true;
    play(game, 40);
    expect(game.state.left).toBe(0);
    game.up = false;
    game.down = true;
    play(game, 60);
    expect(game.state.left).toBe(12);
  }, 60_000);

  it('bounces the ball off the walls; a player parked at the bottom loses to 11, the score stays up, and it starts again', () => {
    const game = new PongHarness(SOURCE);
    // Parked at the bottom, the paddle misses nearly everything.
    game.down = true;
    let wallBounces = 0;
    let before = game.state;
    play(game, 6000, state => {
      if (state.ball.dy !== before.ball.dy) wallBounces++;
      before = state;
    });
    expect(wallBounces).toBeGreaterThan(10);
    // The CPU counted up to 11 (the parked paddle may still return a ball
    // that comes to it, so the player may score a point or two), and the
    // game began again.
    // The displays are hex, and the scores BCD, so they read 10 and 11.
    const right = game.outs.filter(([port]) => port === 1).map(([, value]) => value);
    expect(right.slice(0, 14)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0x10, 0x11, 0, 1]);
  }, 120_000);

  it('can be beaten: a player who follows the ball returns it and scores, and the CPU returns some', () => {
    const game = new PongHarness(SOURCE);
    let leftReturns = 0;
    let rightReturns = 0;
    let before = game.state;
    play(game, 6000, state => {
      // Follow the ball, a row at a time: keep it level with the paddle's middle.
      game.up = state.ball.y < state.left + 1;
      game.down = state.ball.y > state.left + 2;
      if (before.ball.dx === -1 && state.ball.dx === 1 && state.ball.x === 2) leftReturns++;
      if (before.ball.dx === 1 && state.ball.dx === -1 && state.ball.x === 29) rightReturns++;
      before = state;
    });
    expect(leftReturns).toBeGreaterThan(20);
    // And the CPU returns some too: it follows the ball, a beat behind.
    expect(rightReturns).toBeGreaterThan(10);
    expect(game.shown[0] > 0 || game.state.scores[0] > 0).toBe(true);
  }, 120_000);
});
