import { describe, expect, it } from 'vitest';

import { CircuitService } from '../app/CircuitService';
import { ringingParts } from './Problems';

describe('ringingParts', () => {
  it('names the part on this level that drives each ringing net', () => {
    const parts = ringingParts({ path: [] }, { ringing: ['n1.out', 'fa3/g1.out', 'fa3/g2.out'] });
    expect(parts).toEqual(['fa3', 'n1']);
  });

  it('takes the path to the level shown off the front', () => {
    const path = [
      { id: 'cpu', chip: 'CPU' },
      { id: 'alu', chip: 'ALU' }
    ];
    expect(ringingParts({ path }, { ringing: ['cpu/alu/x.out', 'cpu/alu/adder/g.out', 'cpu/pc/q.out'] })).toEqual(['adder', 'x']);
  });

  it('has nothing to point at for a ring outside the level shown', () => {
    expect(ringingParts({ path: [{ id: 'fa1', chip: 'full adder' }] }, { ringing: ['fa2/g.out'] })).toEqual([]);
  });

  it('finds a NOT gate wired to itself, from what the service reports', () => {
    const service = new CircuitService({ schedule: () => {} });
    let latest = { ringing: [] as readonly string[] };
    service.status.subscribe(s => (latest = s));
    service.place('not', 0, 0, 'loop');
    service.connect({ component: 'loop', pin: 'out' }, { component: 'loop', pin: 'a' }, 'w1');
    service.step();
    expect(latest.ringing.length).toBeGreaterThan(0);
    expect(ringingParts({ path: [] }, latest)).toEqual(['loop']);
  });
});

describe('a run that stops on an oscillation', () => {
  it('says it stopped, and which net rang', () => {
    const queue: (() => void)[] = [];
    let time = 0;
    const service = new CircuitService({ schedule: run => queue.push(run), now: () => (time += 1) });
    let latest = { running: false, ringing: [] as readonly string[] };
    service.status.subscribe(s => (latest = s));
    service.place('not', 0, 0, 'loop');
    service.connect({ component: 'loop', pin: 'out' }, { component: 'loop', pin: 'a' }, 'w1');
    service.run();
    while (queue.length > 0) queue.shift()!();
    expect(latest.running).toBe(false);
    expect(ringingParts({ path: [] }, latest)).toEqual(['loop']);
  });
});
