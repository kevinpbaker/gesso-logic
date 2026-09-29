import { describe, expect, it } from 'vitest';

import { boxOf, pinAt, route } from './Layout';

describe('layout', () => {
  it('turns a gate about its box, a quarter turn at a time', () => {
    // A 4 × 4 AND: inputs on the left at y 1 and 3, output on the right.
    expect([0, 90, 180, 270].map(r => pinAt('and', 10, 20, 'out', r as 0 | 90 | 180 | 270))).toEqual([
      { x: 14, y: 22 }, // facing right
      { x: 12, y: 24 }, // facing down
      { x: 10, y: 22 }, // facing left
      { x: 12, y: 20 } // facing up
    ]);
    expect(pinAt('and', 10, 20, 'a', 90)).toEqual({ x: 13, y: 20 });
  });

  it('swaps a box’s sides on a quarter turn, and keeps its corner', () => {
    // A switch is 2 × 2 and stays so; a NOT is 4 × 4. Neither is a good
    // test of swapping, so use the one pin that moves off-centre.
    expect(boxOf('input', 5, 5, 90)).toEqual({ left: 5, top: 5, right: 7, bottom: 7 });
    expect(pinAt('input', 5, 5, 'out', 90)).toEqual({ x: 6, y: 7 });
  });

  it('keeps every pin on a grid point under every rotation', () => {
    for (const kind of ['not', 'and', 'input', 'output'] as const) {
      for (const r of [0, 90, 180, 270] as const) {
        for (const pin of ['a', 'b', 'out', 'in']) {
          const p = pinAt(kind, 3, 7, pin, r);
          expect(Number.isInteger(p.x) && Number.isInteger(p.y), `${kind} ${pin} at ${r}`).toBe(true);
        }
      }
    }
  });

  it('routes a forward wire in three segments and a backward one around', () => {
    expect(route({ x: 0, y: 0 }, { x: 10, y: 4 })).toEqual([
      { x: 0, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 4 },
      { x: 10, y: 4 }
    ]);
    expect(route({ x: 10, y: 0 }, { x: 0, y: 4 })).toHaveLength(6);
  });
});
