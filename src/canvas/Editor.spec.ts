import { describe, expect, it } from 'vitest';

import type { Geometry } from '../app/CircuitContract';
import { CircuitService } from '../app/CircuitService';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { Editor } from './Editor';
import { SceneIndex } from './SceneIndex';

/**
 * The editor, driven by pointer and key events in screen pixels, with a
 * camera of 16 pixels a unit at the origin and a real scene index built
 * from a real service's geometry. What it sends is recorded rather than
 * applied: the editor asks for edits, and these specs check it asks for
 * the right ones.
 */
const SCALE = 16;

function setup() {
  const b = new CircuitBuilder();
  b.input('a');
  b.button('push');
  b.gate('and', 'g');
  b.output('led', { component: 'g', pin: 'out' });
  const circuit = b.build();
  const placed = {
    ...circuit,
    components: circuit.components.map(c =>
      c.id === 'a'
        ? { ...c, x: 0, y: 0 }
        : c.id === 'push'
          ? { ...c, x: 0, y: 10 }
          : c.id === 'g'
            ? { ...c, x: 6, y: 0 }
            : { ...c, x: 14, y: 1 }
    )
  };
  const service = new CircuitService({ schedule: () => {}, now: () => 0 });
  service.load(placed);
  let geometry!: Geometry;
  service.geometry.subscribe(g => (geometry = g));
  const scene = new SceneIndex(geometry);
  const sent: [string, ...unknown[]][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      sent.push([name, ...args]);
    };
  const editor = new Editor({
    scene: () => scene,
    toWorld: p => ({ x: p.x / SCALE, y: p.y / SCALE }),
    scale: () => SCALE,
    send: {
      place: record('place'),
      connect: record('connect'),
      moveBy: record('moveBy'),
      rotate: record('rotate'),
      remove: record('remove'),
      insert: record('insert'),
      undo: record('undo'),
      redo: record('redo'),
      setInput: record('setInput'),
      tabulate: record('tabulate'),
      makeChip: record('makeChip'),
      openChip: record('openChip'),
      copy: record('copy'),
      duplicate: record('duplicate')
    },
    chipShape: () => undefined,
    panBy: record('panBy'),
    value: () => 0,
    changed: () => {}
  });
  const at = (x: number, y: number) => ({ x: x * SCALE, y: y * SCALE });
  return { editor, sent, at };
}

describe('the editor', () => {
  it('draws a wire from a pin to a pin', () => {
    const { editor, sent, at } = setup();
    // The switch's output is at (2, 1); the AND's first input at (6, 1).
    editor.pointerDown(at(2, 1), 1, false);
    editor.pointerMove(at(4, 1));
    editor.pointerMove(at(6, 1));
    editor.pointerUp(at(6, 1));

    expect(sent).toEqual([['connect', { component: 'a', pin: 'out' }, { component: 'g', pin: 'a' }, 'w1']]);
  });

  it('draws the wire for a flick with no move reported between press and release', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(2, 1), 1, false);
    editor.pointerUp(at(6, 1));

    expect(sent.map(s => s[0])).toEqual(['connect']);
  });

  it('draws nothing for a wire released on empty ground', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(2, 1), 1, false);
    editor.pointerMove(at(4, 8));
    editor.pointerUp(at(4, 8));

    expect(sent).toEqual([]);
  });

  it('drags a component on the grid, as one gesture', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(8, 2), 1, false);
    editor.pointerMove(at(9.4, 2));
    editor.pointerMove(at(11, 3));
    editor.pointerUp(at(11, 3));

    const moves = sent.filter(s => s[0] === 'moveBy');
    expect(moves.map(s => [s[2], s[3]])).toEqual([
      [1, 0],
      [2, 1]
    ]);
    expect(new Set(moves.map(s => s[4])).size).toBe(1);
    expect(editor.selection).toEqual(new Set(['g']));
  });

  it('selects with a marquee what lies wholly inside it', () => {
    const { editor, at } = setup();
    editor.pointerDown(at(-1, -1), 1, false);
    editor.pointerMove(at(11, 5));
    editor.pointerUp(at(11, 5));

    expect(editor.selection).toEqual(new Set(['a', 'g']));
  });

  it('flips a switch on a second click, not the first', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(1, 1), 1, false);
    editor.pointerUp(at(1, 1));
    expect(sent).toEqual([]);

    editor.pointerDown(at(1, 1), 1, false);
    editor.pointerUp(at(1, 1));
    expect(sent).toEqual([['setInput', 'a', 1]]);
  });

  it('places a part picked up by its key, centred on the click', () => {
    const { editor, sent, at } = setup();
    editor.keyDown('x', false, false);
    editor.pointerDown(at(20, 20), 1, false);

    expect(sent).toEqual([['place', 'xor', 18, 18, 'xor1', undefined, undefined]]);
    expect(editor.selection).toEqual(new Set(['xor1']));
  });

  it('undoes, redoes, rotates and deletes by key', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(8, 2), 1, false);
    editor.pointerUp(at(8, 2));
    editor.keyDown('r', false, false);
    editor.keyDown('Delete', false, false);
    editor.keyDown('z', true, false);
    editor.keyDown('z', true, true);

    expect(sent).toEqual([['rotate', ['g']], ['remove', ['g']], ['undo'], ['redo']]);
  });

  it('asks for a copy of the selection, and pastes text under fresh ids with its inner wires and chips', () => {
    const { editor, sent, at } = setup();
    editor.keyDown('a', true, false);
    editor.keyDown('c', true, false);
    expect(sent.at(-1)![0]).toBe('copy');
    expect((sent.at(-1)![1] as string[]).sort()).toEqual(['a', 'g', 'led', 'push']);

    // Text as the application worker writes it: parts, a wire, and the
    // chip one of them uses.
    const text = JSON.stringify({
      gessologic: 1,
      components: [
        { id: 'k', kind: 'input', x: 0, y: 0, label: 'key' },
        { id: 'box', kind: 'chip', chip: 'inverter', x: 6, y: 0 }
      ],
      wires: [{ id: 'w9', from: { component: 'k', pin: 'out' }, to: { component: 'box', pin: 'in' } }],
      chips: { inverter: { version: 1, components: [], wires: [] } }
    });
    editor.pointerMove(at(30, 30));
    expect(editor.paste(text)).toBe(true);
    const inserted = sent.find(s => s[0] === 'insert')![1] as {
      components: { id: string; x: number; label?: string; chip?: string }[];
      wires: { from: { component: string } }[];
      chips: Record<string, unknown>;
    };
    expect(inserted.components.map(c => c.id).sort()).toEqual(['chip1', 'input1']);
    expect(inserted.components.find(c => c.id === 'input1')).toMatchObject({ x: 30, label: 'key' });
    expect(inserted.components.find(c => c.id === 'chip1')).toMatchObject({ chip: 'inverter' });
    expect(inserted.wires[0]!.from.component).toBe('input1');
    expect(Object.keys(inserted.chips)).toEqual(['inverter']);
    expect(editor.paste('not a circuit')).toBe(false);
  });

  it('duplicates under ids it picks, and selects the copies', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(8, 2), 1, false);
    editor.pointerUp(at(8, 2));
    editor.keyDown('d', true, false);
    expect(sent).toEqual([['duplicate', ['g'], { g: 'and1' }, 2, 2]]);
    expect(editor.selection).toEqual(new Set(['and1']));
  });

  it('pans with the middle button, and with space held', () => {
    const { editor, sent } = setup();
    editor.pointerDown({ x: 100, y: 100 }, 4, false);
    editor.pointerMove({ x: 90, y: 80 });
    editor.pointerUp({ x: 90, y: 80 });
    editor.keyDown(' ', false, false);
    editor.pointerDown({ x: 100, y: 100 }, 1, false);
    editor.pointerMove({ x: 110, y: 100 });

    expect(sent).toEqual([
      ['panBy', 10, 20],
      ['panBy', -10, 0]
    ]);
  });

  it('stops panning with the right button once no button is held, with no release reported', () => {
    const { editor, sent } = setup();
    editor.pointerDown({ x: 100, y: 100 }, 2, false);
    editor.pointerMove({ x: 90, y: 80 }, 2);
    editor.pointerMove({ x: 80, y: 60 }, 0);
    editor.pointerMove({ x: 70, y: 40 }, 0);

    expect(sent).toEqual([['panBy', 10, 20]]);
  });

  it('holds a selected push button down for as long as the press lasts', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(1, 11), 1, false);
    editor.pointerUp(at(1, 11));
    expect(sent).toEqual([]);

    editor.pointerDown(at(1, 11), 1, false);
    expect(sent).toEqual([['setInput', 'push', 1]]);
    editor.pointerUp(at(1, 11));
    expect(sent).toEqual([
      ['setInput', 'push', 1],
      ['setInput', 'push', 0]
    ]);
  });

  it('clips a probe dropped on a wire to the pin driving it', () => {
    const { editor, sent, at } = setup();
    // The AND's output wire runs from (10, 2) to the LED at (14, 2).
    editor.keyDown('p', false, false);
    editor.pointerDown(at(12, 2), 1, false);

    expect(sent).toEqual([
      ['place', 'probe', 13, -1, 'probe1', undefined, undefined, undefined],
      ['connect', { component: 'g', pin: 'out' }, { component: 'probe1', pin: 'in' }, 'w1']
    ]);
  });

  it('asks for the truth table of the selection', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(8, 2), 1, false);
    editor.pointerUp(at(8, 2));
    editor.keyDown('t', false, false);

    expect(sent).toEqual([['tabulate', ['g']]]);
  });
});
