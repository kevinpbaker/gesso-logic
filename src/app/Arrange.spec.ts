import { describe, expect, it } from 'vitest';

import { CIRCUIT_VERSION, type Circuit } from '../sim/Circuit';
import { arrange } from './DocumentEdits';

/** Three gates (4 × 4) scattered, and a wide switch (4 × 2). */
function scattered(): Circuit {
  return {
    version: CIRCUIT_VERSION,
    components: [
      { id: 'g1', kind: 'and', x: 2, y: 0 },
      { id: 'g2', kind: 'or', x: 9, y: 7 },
      { id: 'g3', kind: 'xor', x: 30, y: 3 },
      { id: 's', kind: 'input', x: 5, y: 20, width: 8 }
    ],
    wires: []
  };
}
const at = (c: Circuit) => Object.fromEntries(c.components.map(p => [p.id, [p.x, p.y]]));

describe('arranging parts', () => {
  it('lines up edges and middles, by each part’s box', () => {
    const ids = ['g1', 'g2', 'g3'];
    expect(at(arrange(scattered(), ids, 'left'))).toMatchObject({ g1: [2, 0], g2: [2, 7], g3: [2, 3] });
    expect(at(arrange(scattered(), ids, 'right'))).toMatchObject({ g1: [30, 0], g2: [30, 7], g3: [30, 3] });
    expect(at(arrange(scattered(), ids, 'top'))).toMatchObject({ g1: [2, 0], g2: [9, 0], g3: [30, 0] });
    // Middles: the switch, two units tall, sits with its middle on the gates'.
    expect(at(arrange(scattered(), ['g1', 's'], 'middle'))).toMatchObject({ g1: [2, 9], s: [5, 10] });
    expect(at(arrange(scattered(), ['g1', 'g3'], 'centre'))).toMatchObject({ g1: [16, 0], g3: [16, 3] });
  });

  it('spaces three or more evenly between the two at the ends', () => {
    const spaced = at(arrange(scattered(), ['g1', 'g2', 'g3'], 'across'));
    // From 2 to 34, three gates of 4: 20 units free, 10 between each.
    expect(spaced).toMatchObject({ g1: [2, 0], g2: [16, 7], g3: [30, 3] });
    // Down, they overlap: 11 units for 12 of gates, half a unit back each.
    expect(at(arrange(scattered(), ['g1', 'g2', 'g3'], 'down'))).toMatchObject({ g1: [2, 0], g3: [30, 4], g2: [9, 7] });
  });

  it('changes nothing for too few parts, or parts already lined up', () => {
    const circuit = scattered();
    expect(arrange(circuit, ['g1'], 'left')).toBe(circuit);
    expect(arrange(circuit, ['g1', 'g2'], 'across')).toBe(circuit);
    const lined = arrange(circuit, ['g1', 'g2'], 'left');
    expect(arrange(lined, ['g1', 'g2'], 'left')).toBe(lined);
  });
});
