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
  let clipboard = '';
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
      tabulate: record('tabulate')
    },
    panBy: record('panBy'),
    value: () => 0,
    copyText: text => (clipboard = text),
    changed: () => {}
  });
  const at = (x: number, y: number) => ({ x: x * SCALE, y: y * SCALE });
  return { editor, sent, at, clipboard: () => clipboard };
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

    expect(sent).toEqual([['place', 'xor', 18, 18, 'xor1']]);
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

  it('copies a selection and pastes it under fresh ids with its inner wires', () => {
    const { editor, sent, at, clipboard } = setup();
    editor.keyDown('a', true, false);
    editor.keyDown('c', true, false);
    editor.pointerMove(at(30, 30));
    expect(editor.paste(clipboard())).toBe(true);

    const inserted = sent.find(s => s[0] === 'insert')![1] as { components: { id: string; x: number }[]; wires: unknown[] };
    expect(inserted.components.map(c => c.id).sort()).toEqual(['and1', 'button1', 'input1', 'output1']);
    expect(Math.min(...inserted.components.map(c => c.x))).toBe(30);
    expect(inserted.wires).toHaveLength(1);
    expect(editor.paste('not a circuit')).toBe(false);
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
      ['place', 'probe', 13, -1, 'probe1'],
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
