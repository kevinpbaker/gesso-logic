import { describe, expect, it } from 'vitest';

import { Analyser } from './Analyser';

/** Net values with nets 0..3 holding a 4-bit count, least significant first, and net 4 its bit 0 again. */
function nets(count: number): Uint8Array {
  const v = new Uint8Array(5);
  for (let i = 0; i < 4; i++) v[i] = (count >> i) & 1;
  v[4] = count & 1;
  return v;
}

function counting(capacity = 16) {
  const a = new Analyser(capacity);
  a.configure([
    { id: 'count', name: 'count', width: 4, nets: [0, 1, 2, 3] },
    { id: 'bit0', name: 'bit0', width: 1, nets: [4] }
  ]);
  return a;
}

describe('the logic analyser', () => {
  it('keeps the last cycles in a ring, and reads any held one back', () => {
    const a = counting(16);
    for (let cycle = 1; cycle <= 20; cycle++) a.record(cycle, nets(cycle));
    expect([a.first, a.last]).toEqual([5, 20]);
    expect(a.valueAt('count', 5)).toBe(5);
    expect(a.valueAt('count', 20)).toBe(4);
    expect(a.valueAt('bit0', 19)).toBe(1);
    expect(a.valueAt('count', 4)).toBeNull();
  });

  it('gives a window a column a cycle when zoomed in, and folds cycles into columns when not', () => {
    const a = counting(64);
    for (let cycle = 0; cycle < 32; cycle++) a.record(cycle, nets(cycle));
    // Four cycles in four columns: every value.
    expect(a.window(8, 4, 100)).toEqual({ start: 8, step: 1, count: 4, data: { count: '8,9,A,B', bit0: '0101' } });
    // Thirty-two cycles in eight columns: bit 0 changes in every column,
    // the count too, and cycles past what is held are nothing.
    const wide = a.window(16, 32, 8);
    expect(wide.step).toBe(4);
    expect(wide.data['bit0']).toBe('****....');
    expect(wide.data['count']).toBe('*,*,*,*,.,.,.,.');
  });

  it('pauses on its trigger the cycle the trace becomes the value, and not while it stays so', () => {
    const a = counting(64);
    a.setTrigger({ trace: 'count', value: 3 });
    const fired = [1, 2, 3, 3, 4, 3].map((count, i) => a.record(i, nets(count)));
    expect(fired).toEqual([false, false, true, false, false, true]);
    a.setTrigger({ trace: 'nothing', value: 1 });
    expect(a.armed).toBeNull();
  });

  it('keeps each trace’s history through a change of traces, gives a new one none, and starts afresh on a skipped cycle', () => {
    const a = new Analyser(64);
    a.configure([{ id: 'count', name: 'count', width: 4, nets: [0, 1, 2, 3] }]);
    for (let cycle = 0; cycle < 10; cycle++) a.record(cycle, nets(cycle));
    // A trace added mid-run: the count keeps its history, and bit 0 is
    // recorded from the next cycle on.
    a.configure([
      { id: 'count', name: 'count', width: 4, nets: [0, 1, 2, 3] },
      { id: 'bit0', name: 'bit0', width: 1, nets: [4] }
    ]);
    expect([a.first, a.last]).toEqual([0, 9]);
    expect(a.valueAt('count', 7)).toBe(7);
    expect(a.valueAt('bit0', 7)).toBeNull();
    a.record(10, nets(10));
    a.record(11, nets(11));
    expect(a.valueAt('bit0', 11)).toBe(1);
    expect(a.window(8, 4, 100).data).toEqual({ count: '8,9,A,B', bit0: '..01' });

    // A trace whose nets changed is a new one.
    a.configure([
      { id: 'count', name: 'count', width: 4, nets: [3, 2, 1, 0] },
      { id: 'bit0', name: 'bit0', width: 1, nets: [4] }
    ]);
    expect(a.valueAt('count', 11)).toBeNull();
    expect(a.valueAt('bit0', 11)).toBe(1);

    // A skipped cycle starts every trace afresh, from that cycle.
    a.record(20, nets(20));
    expect([a.first, a.last]).toEqual([20, 20]);
    expect(a.valueAt('count', 20)).toBe(2);
    expect(a.valueAt('bit0', 20)).toBe(0);
  });

  it('fires on the first cycle of a trace added mid-run as on a fresh analyser’s, not by its slot from before it was traced', () => {
    const a = new Analyser(64);
    a.configure([{ id: 'count', name: 'count', width: 4, nets: [0, 1, 2, 3] }]);
    a.record(0, nets(1));
    a.configure([
      { id: 'count', name: 'count', width: 4, nets: [0, 1, 2, 3] },
      { id: 'bit0', name: 'bit0', width: 1, nets: [4] }
    ]);
    // Its slot from before it was traced reads 0; that is no value it had.
    a.setTrigger({ trace: 'bit0', value: 0 });
    expect(a.record(1, nets(2))).toBe(true);
    expect(a.record(2, nets(4))).toBe(false);
  });
});

describe('the analyser, when traces are reordered', () => {
  it('keeps the history of a trace that only moved in the list', () => {
    const a = counting(64);
    for (let cycle = 0; cycle < 10; cycle++) a.record(cycle, nets(cycle));
    a.configure([
      { id: 'bit0', name: 'bit0', width: 1, nets: [4] },
      { id: 'count', name: 'count', width: 4, nets: [0, 1, 2, 3] }
    ]);
    expect(a.valueAt('count', 7)).toBe(7);
    expect(a.valueAt('bit0', 7)).toBe(1);
  });
});

describe('the analyser on the counter', () => {
  it('shows the counter’s four bits, and its count as a staircase', async () => {
    const { CircuitService } = await import('./CircuitService');
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let view!: import('./CircuitContract').AnalyserView;
    service.analyserView.subscribe(v => (view = v));
    service.loadScene('counter');
    service.setAnalyserView(null, 20, 400);
    expect(view.traces.map(t => t.name)).toEqual(expect.arrayContaining(['bit0', 'bit1', 'bit2', 'bit3', 'count value']));

    service.setInput('reset', 1);
    service.step();
    service.setInput('reset', 0);
    for (let i = 0; i < 20; i++) service.step();

    // The last twenty cycles, a column each: the count climbs by one a
    // cycle, and bit 0 alternates.
    expect(view.following).toBe(true);
    expect(view.step).toBe(1);
    const count = view.data['count value']!.split(',').map(v => Number.parseInt(v, 16));
    expect(count).toEqual(Array.from({ length: 20 }, (_, i) => (i + 1) % 16));
    expect(view.data['bit0']).toBe('10101010101010101010');
  });
});

describe('a scrubbed window, as the history moves on', () => {
  it('slides forward with the oldest cycle held rather than showing overwritten cycles', async () => {
    const { CircuitService } = await import('./CircuitService');
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let view!: import('./CircuitContract').AnalyserView;
    service.analyserView.subscribe(v => (view = v));
    service.loadScene('counter');
    service.setAnalyserView(0, 16, 16);
    for (let i = 0; i < 40; i++) service.step();
    expect(view.following).toBe(false);
    expect(view.start).toBe(Math.max(0, view.first));
    expect(view.data['bit0']!.includes('.')).toBe(false);
  });
});

describe('the analyser, gone back', () => {
  it('forgets the cycles after one gone back to, and records on from it', () => {
    const a = counting(64);
    for (let cycle = 0; cycle < 20; cycle++) a.record(cycle, nets(cycle));
    a.truncate(9);
    expect([a.first, a.last]).toEqual([0, 9]);
    expect(a.valueAt('count', 9)).toBe(9);
    a.record(10, nets(3));
    expect([a.first, a.last]).toEqual([0, 10]);
    expect(a.valueAt('count', 10)).toBe(3);
    a.truncate(-5);
    expect(a.last).toBe(a.first - 1);
  });
});
