import { describe, expect, it } from 'vitest';

import type { Geometry } from '../app/CircuitContract';
import { CircuitService } from '../app/CircuitService';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { Editor, type EditorDeps } from './Editor';
import { SceneIndex } from './SceneIndex';

/**
 * The editor, driven by pointer and key events in screen pixels, with a
 * camera of 16 pixels a unit at the origin and a real scene index built
 * from a real service's geometry. What it sends is recorded rather than
 * applied: the editor asks for edits, and these specs check it asks for
 * the right ones.
 */
const SCALE = 16;

function setup(button = 'push', wire?: (b: CircuitBuilder) => void, deps: Partial<EditorDeps> = {}) {
  const b = new CircuitBuilder();
  b.input('a');
  b.button(button);
  b.gate('and', 'g');
  b.output('led', { component: 'g', pin: 'out' });
  wire?.(b);
  const circuit = b.build();
  const placed = {
    ...circuit,
    components: circuit.components.map(c =>
      c.id === 'a'
        ? { ...c, x: 0, y: 0 }
        : c.id === button
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
      openProgram: record('openProgram'),
      copy: record('copy'),
      duplicate: record('duplicate')
    },
    chipShape: () => undefined,
    panBy: record('panBy'),
    value: () => 0,
    changed: () => {},
    ...deps
  });
  const at = (x: number, y: number) => ({ x: x * SCALE, y: y * SCALE });
  return { editor, sent, at };
}

describe('the editor', () => {
  it('holds a button named for an arrow while the arrow is held, with nothing selected', () => {
    const { editor, sent, at } = setup('up');
    expect(editor.keyDown('ArrowUp', false, false)).toBe(true);
    expect(editor.keyDown('ArrowUp', false, false)).toBe(true); // the key's repeat
    editor.keyUp('ArrowUp');
    // No button is named `down`, so ArrowDown is not taken.
    expect(editor.keyDown('ArrowDown', false, false)).toBe(false);
    expect(sent).toEqual([
      ['setInput', 'up', 1],
      ['setInput', 'up', 0]
    ]);
    // With a selection, the arrows nudge it, as they always have.
    editor.pointerDown(at(8, 2), 1, false);
    editor.pointerUp(at(8, 2));
    sent.length = 0;
    editor.keyDown('ArrowUp', false, false);
    expect(sent.map(s => s[0])).toEqual(['moveBy']);
  });

  it('draws a wire from a pin to a pin', () => {
    const { editor, sent, at } = setup();
    // The switch's output is at (2, 1); the AND's first input at (6, 1).
    editor.pointerDown(at(2, 1), 1, false);
    editor.pointerMove(at(4, 1));
    editor.pointerMove(at(6, 1));
    editor.pointerUp(at(6, 1));

    expect(sent).toEqual([['connect', { component: 'a', pin: 'out' }, { component: 'g', pin: 'a' }, 'w1']]);
  });

  it('ends a wire let go on a part’s body at its nearest input, and one let go nearby at the pin', () => {
    // The gate's inputs are at (6, 1) and (6, 3); let go inside its body,
    // well away from either, as on a chip's pin name.
    const { editor, sent, at } = setup();
    editor.pointerDown(at(2, 1), 1, false);
    editor.pointerMove(at(5, 1));
    editor.pointerUp(at(8.5, 1.4));
    editor.pointerDown(at(2, 1), 1, false);
    editor.pointerMove(at(5, 3));
    editor.pointerUp(at(8.5, 2.8));
    // A pixel or ten from a pin, off the part, still reaches it: 16 pixels
    // at 16 a unit is a unit.
    editor.pointerDown(at(2, 1), 1, false);
    editor.pointerMove(at(5, 3));
    editor.pointerUp(at(5.2, 3.3));
    expect(sent.map(s => s.slice(1, 3))).toEqual([
      [{ component: 'a', pin: 'out' }, { component: 'g', pin: 'a' }],
      [{ component: 'a', pin: 'out' }, { component: 'g', pin: 'b' }],
      [{ component: 'a', pin: 'out' }, { component: 'g', pin: 'b' }]
    ]);
  });

  it('ends a wire let go just beside a part at the pin level with the pointer', () => {
    // 1.2 units left of the gate's edge: more than 16 pixels from either
    // input at 16 a unit, but within 24 of the part.
    const { editor, sent, at } = setup();
    editor.pointerDown(at(2, 1), 1, false);
    editor.pointerMove(at(4, 3));
    editor.pointerUp(at(4.8, 2.7));
    expect(sent.map(s => s[2])).toEqual([{ component: 'g', pin: 'b' }]);
  });

  it('picks the next of overlapping wires with each click in the same place, and with Tab', () => {
    // Two wires leave the switch's output together, for the gate's two
    // inputs: where they overlap, a click is ambiguous.
    const { editor, at } = setup('push', b => {
      b.connect({ component: 'a', pin: 'out' }, { component: 'g', pin: 'a' });
      b.connect({ component: 'a', pin: 'out' }, { component: 'g', pin: 'b' });
    });
    const click = () => {
      editor.pointerDown(at(2.6, 1), 1, false);
      editor.pointerUp(at(2.6, 1));
      return [...editor.selection];
    };
    const first = click();
    expect(editor.hint).toMatch(/^Wire 1 of 2 here: a\.out → g\.(a|b) · click again or Tab for the next/);
    const second = click();
    expect(second).not.toEqual(first);
    expect(editor.hint).toMatch(/^Wire 2 of 2 here/);
    expect(click()).toEqual(first);
    expect(editor.keyDown('Tab', false, false)).toBe(true);
    expect([...editor.selection]).toEqual(second);
    // A click somewhere else starts over.
    editor.pointerDown(at(12, 12), 1, false);
    editor.pointerUp(at(12, 12));
    expect(editor.keyDown('Tab', false, false)).toBe(false);
  });

  it('draws no wire let go on the part it started from', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(10, 2), 1, false); // the gate's output
    editor.pointerMove(at(12, 4));
    editor.pointerUp(at(8, 2));
    expect(sent).toEqual([]);
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

describe('another level', () => {
  it('forgets the selection, the hover and any gesture of the level before', () => {
    const { editor, sent, at } = setup();
    editor.pointerDown(at(7, 2), 1, false);
    editor.pointerUp(at(7, 2));
    expect([...editor.selection]).toEqual(['g']);
    editor.pointerMove(at(10, 2));
    editor.pointerDown(at(10, 2), 1, false);
    editor.pointerMove(at(12, 4));
    editor.forget();
    expect(editor.selection.size).toBe(0);
    expect(editor.hoverCard()).toBeNull();
    // The wire under way went with it: letting go draws nothing, and Delete deletes nothing.
    editor.pointerUp(at(14, 2));
    editor.keyDown('Delete', false, false);
    expect(sent.filter(([name]) => name === 'connect' || name === 'remove')).toEqual([]);
  });
});

describe('the tooltip on a pin', () => {
  it('names a gate’s pin, says what it does and shows its value', () => {
    const { editor, at } = setup('push', undefined, { value: () => 1 });
    editor.pointerMove(at(10, 2));
    expect(editor.hoverCard()).toEqual({ title: 'g.out', about: 'AND gate · output', note: '1 when a and b are both 1', value: '1' });
    editor.pointerMove(at(6, 3));
    expect(editor.hoverCard()?.note).toBe('Second input');
  });

  it('says what a switch or LED’s note says, as the pin it is in a chip', () => {
    const { editor, at } = setup('push', b => b.describe({ led: 'Lights when both are on' }));
    editor.pointerMove(at(14, 2));
    expect(editor.hoverCard()).toMatchObject({ title: 'led.in', about: 'LED · input', note: 'Lights when both are on' });
  });

  it('shows nothing away from a pin, while a wire is drawn, or once the pointer has left', () => {
    const { editor, at } = setup();
    editor.pointerMove(at(3, 6));
    expect(editor.hoverCard()).toBeNull();
    editor.pointerMove(at(10, 2));
    expect(editor.hoverCard()).not.toBeNull();
    editor.pointerLeave();
    expect(editor.hoverCard()).toBeNull();
    // A press with no move before it is over what it lands on.
    editor.pointerMove(at(10, 2));
    editor.pointerDown(at(3, 6), 1, false);
    editor.pointerUp(at(3, 6));
    expect(editor.hoverCard()).toBeNull();
    editor.pointerMove(at(10, 2));
    editor.pointerDown(at(10, 2), 1, false);
    editor.pointerMove(at(12, 4));
    expect(editor.hoverCard()).toBeNull();
  });
});

describe('the editor, from the menus', () => {
  it('rotates, makes a chip and deletes the selection the way the keys do', () => {
    const { editor, sent } = setup();
    editor.selectOnly(['g', 'a', 'nothing']);
    expect([...editor.selection].sort()).toEqual(['a', 'g']);
    editor.rotateSelection();
    editor.makeChip();
    expect(sent).toContainEqual(['rotate', ['g', 'a']]);
    expect(sent.find(s => s[0] === 'makeChip')).toBeDefined();
    // Made into a chip, the parts are no longer selected here.
    expect(editor.hasSelection).toBe(false);
    editor.selectAll();
    editor.deleteSelection();
    expect(sent.find(s => s[0] === 'remove')).toBeDefined();
    expect(editor.hasSelection).toBe(false);
  });

  it('says what the keys do for what is selected', () => {
    const { editor } = setup();
    expect(editor.hint).toMatch(/Drag from a pin/);
    editor.selectOnly(['a']);
    expect(editor.hint).toMatch(/flip it/);
    editor.selectOnly(['a', 'g']);
    expect(editor.hint).toMatch(/M make a chip/);
    editor.startPlacing('and');
    expect(editor.placing).toEqual({ what: 'and', chip: null });
    expect(editor.hint).toMatch(/Esc stops/);
    editor.cancel();
    expect(editor.placing).toBeNull();
  });
});
