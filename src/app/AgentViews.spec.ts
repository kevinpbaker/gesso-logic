import { describe, expect, it } from 'vitest';

import { CIRCUIT_VERSION } from '../sim/Circuit';
import type { LevelView, Readings } from './CircuitContract';
import { CircuitService } from './CircuitService';

/** What an agent reads instead of the canvas's geometry and signals. */
describe('the views an agent reads', () => {
  function service() {
    const s = new CircuitService({ schedule: () => {} });
    let level!: LevelView;
    let readings!: Readings;
    s.levelView.subscribe(v => (level = v));
    s.readings.subscribe(v => (readings = v));
    s.load({
      version: CIRCUIT_VERSION,
      components: [
        { id: 'a', kind: 'input', x: 0, y: 0, label: 'left' },
        { id: 'b', kind: 'input', x: 0, y: 4 },
        { id: 'g', kind: 'and', x: 6, y: 0 },
        { id: 'led', kind: 'output', x: 14, y: 1 }
      ],
      wires: [
        { id: 'w1', from: { component: 'a', pin: 'out' }, to: { component: 'g', pin: 'a' } },
        { id: 'w2', from: { component: 'b', pin: 'out' }, to: { component: 'g', pin: 'b' } },
        { id: 'w3', from: { component: 'g', pin: 'out' }, to: { component: 'led', pin: 'in' }, via: [{ x: 11, y: 2 }] }
      ]
    });
    return { s, level: () => level, readings: () => readings };
  }

  it('lists the level’s parts with their pins, and its wires as the pins they join', () => {
    const { s, level } = service();
    expect(level().path).toBe('the top level');
    expect(level().parts.find(p => p.id === 'g')).toEqual({ id: 'g', kind: 'and', x: 6, y: 0, inputs: ['a', 'b'], outputs: ['out'] });
    expect(level().parts[0]).toMatchObject({ id: 'a', label: 'left', inputs: [], outputs: ['out'] });
    expect(level().wires).toEqual([
      { id: 'w1', from: 'a.out', to: 'g.a' },
      { id: 'w2', from: 'b.out', to: 'g.b' },
      { id: 'w3', from: 'g.out', to: 'led.in', bent: true }
    ]);
    s.place('or', 6, 8, 'o');
    expect(level().parts.at(-1)).toMatchObject({ id: 'o', kind: 'or' });
  });

  it('reads what the switches and the LED show, as they change', () => {
    const { s, readings } = service();
    expect(readings()).toEqual({ a: 0, b: 0, led: 0 });
    s.setInput('a', 1);
    s.setInput('b', 1);
    expect(readings()).toEqual({ a: 1, b: 1, led: 1 });
  });
});
