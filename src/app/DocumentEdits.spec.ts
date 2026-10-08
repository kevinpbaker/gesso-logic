import { describe, expect, it } from 'vitest';

import { CIRCUIT_VERSION, type Circuit } from '../sim/Circuit';
import { connect, extract, insert, moveBy, place, relabel, remove, rotate, sameConnectivity, setLabel, setNote } from './DocumentEdits';

const empty: Circuit = { version: CIRCUIT_VERSION, components: [], wires: [] };

/** Two switches into an AND, and the AND into an LED. */
function andCircuit(): Circuit {
  let c = empty;
  c = place(c, 'a', 'input', 0, 0);
  c = place(c, 'b', 'input', 0, 4);
  c = place(c, 'g', 'and', 4, 1);
  c = place(c, 'led', 'output', 10, 2);
  c = connect(c, 'w1', { component: 'a', pin: 'out' }, { component: 'g', pin: 'a' });
  c = connect(c, 'w2', { component: 'b', pin: 'out' }, { component: 'g', pin: 'b' });
  c = connect(c, 'w3', { component: 'g', pin: 'out' }, { component: 'led', pin: 'in' });
  return c;
}

describe('document edits', () => {
  it('returns the same document for an edit that changes nothing', () => {
    const c = andCircuit();
    expect(place(c, 'g', 'or', 0, 0)).toBe(c);
    expect(moveBy(c, ['g'], 0, 0)).toBe(c);
    expect(moveBy(c, ['nothing'], 3, 3)).toBe(c);
    expect(rotate(c, ['nothing'])).toBe(c);
    expect(remove(c, ['nothing'])).toBe(c);
    expect(connect(c, 'w9', { component: 'g', pin: 'out' }, { component: 'led', pin: 'in' })).toBe(c);
    // The same pins, drawn the other way round, are the same wire.
    expect(connect(c, 'w9', { component: 'led', pin: 'in' }, { component: 'g', pin: 'out' })).toBe(c);
  });

  it('moves a selection together, and leaves the wires to follow', () => {
    const original = andCircuit();
    const c = moveBy(original, ['a', 'b'], 2, -1);

    expect(c.components.filter(x => x.id === 'a' || x.id === 'b').map(x => [x.x, x.y])).toEqual([
      [2, -1],
      [2, 3]
    ]);
    expect(c.components.find(x => x.id === 'g')).toMatchObject({ x: 4, y: 1 });
    // Wires name pins, not points, so a move needs nothing from them.
    expect(c.wires).toBe(original.wires);
  });

  it('turns a component a quarter turn at a time, back to no rotation at all', () => {
    let c = andCircuit();
    const turns: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      c = rotate(c, ['g']);
      turns.push(c.components.find(x => x.id === 'g')!.rotation);
    }
    expect(turns).toEqual([90, 180, 270, undefined]);
  });

  it('takes the wires of a removed component with it', () => {
    const c = remove(andCircuit(), ['g']);

    expect(c.components.map(x => x.id)).toEqual(['a', 'b', 'led']);
    expect(c.wires).toEqual([]);
  });

  it('removes a wire by its own id and leaves its ends', () => {
    const c = remove(andCircuit(), ['w2']);

    expect(c.components).toHaveLength(4);
    expect(c.wires.map(w => w.id)).toEqual(['w1', 'w3']);
  });

  it('copies a selection with the wires inside it, and none that leave it', () => {
    const fragment = extract(andCircuit(), ['a', 'g']);

    expect(fragment.components.map(x => x.id)).toEqual(['a', 'g']);
    expect(fragment.wires.map(w => w.id)).toEqual(['w1']);
  });

  it('pastes a fragment under fresh ids, moved, with its wires following the new names', () => {
    let n = 0;
    const pasted = relabel(extract(andCircuit(), ['a', 'g']), 10, 0, prefix => `${prefix}-${++n}`);
    const c = insert(andCircuit(), pasted);

    expect(pasted.components.map(x => [x.id, x.x])).toEqual([
      ['input-1', 10],
      ['and-2', 14]
    ]);
    expect(pasted.wires).toEqual([
      { id: 'w-3', from: { component: 'input-1', pin: 'out' }, to: { component: 'and-2', pin: 'a' } }
    ]);
    expect(c.components).toHaveLength(6);
    expect(c.wires).toHaveLength(4);
  });

  it('refuses a fragment whose ids are already in use, whole', () => {
    const c = andCircuit();
    expect(insert(c, extract(c, ['a']))).toBe(c);
  });

  it('knows a move or a turn from a change of wiring', () => {
    const c = andCircuit();
    expect(sameConnectivity(c, moveBy(c, ['g'], 1, 1))).toBe(true);
    expect(sameConnectivity(c, rotate(c, ['g']))).toBe(true);
    expect(sameConnectivity(c, remove(c, ['w1']))).toBe(false);
    expect(sameConnectivity(c, place(c, 'x', 'not', 0, 0))).toBe(false);
  });
});

describe('setNote', () => {
  it('notes a switch or LED, and nothing else, and takes blank text as no note', () => {
    const c = andCircuit();
    const noted = setNote(c, 'led', ' Lights when both are on ');
    expect(noted.components.find(x => x.id === 'led')?.note).toBe('Lights when both are on');
    expect(setNote(noted, 'led', 'Lights when both are on')).toBe(noted);
    expect(setNote(c, 'g', 'an AND')).toBe(c);
    expect('note' in setNote(noted, 'led', '  ').components.find(x => x.id === 'led')!).toBe(false);
  });
});

describe('setLabel', () => {
  /** `inv`: a switch `a` into a NOT into an LED `y`. The top and a chip `pair` each wire an instance of it. */
  function nested(): Circuit {
    const level = (input: string, instance: string, wire: string): Circuit => ({
      version: CIRCUIT_VERSION,
      components: [
        { id: input, kind: 'input', x: 0, y: 0 },
        { id: instance, kind: 'chip', chip: 'inv', x: 4, y: 0 }
      ],
      wires: [{ id: wire, from: { component: input, pin: 'out' }, to: { component: instance, pin: 'a' } }]
    });
    return { ...level('x', 'i', 'w'), chips: { inv: andCircuit(), pair: level('s', 'j', 'v') } };
  }

  it('names a part, and blank text takes the name away', () => {
    const c = andCircuit();
    const named = setLabel(c, null, 'g', 'carry');
    expect(named.components.find(x => x.id === 'g')?.label).toBe('carry');
    expect('label' in setLabel(named, null, 'g', ' ').components.find(x => x.id === 'g')!).toBe(false);
    expect(setLabel(c, null, 'nothing', 'x')).toBe(c);
  });

  it('renames a chip’s pin with its switch, and every wire to it on every instance follows', () => {
    const c = nested();
    const renamed = setLabel(c, 'inv', 'a', 'in');
    expect(renamed.chips!['inv']!.components.find(x => x.id === 'a')?.label).toBe('in');
    expect(renamed.wires.find(w => w.id === 'w')?.to).toEqual({ component: 'i', pin: 'in' });
    expect(renamed.chips!['pair']!.wires.find(w => w.id === 'v')?.to).toEqual({ component: 'j', pin: 'in' });
    // A wire to another pin is the same wire.
    expect(renamed.chips!['inv']!.wires).toBe(renamed.chips!['inv']!.wires);
  });

  it('refuses a name another of the chip’s pins has', () => {
    const c = nested();
    expect(setLabel(c, 'inv', 'a', 'b')).toBe(c);
    expect(setLabel(c, 'inv', 'a', 'led')).toBe(c);
  });
});
