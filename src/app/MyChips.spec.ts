import { describe, expect, it } from 'vitest';

import type { DocumentSummary, LevelView, MyChipsView } from './CircuitContract';
import { CircuitService, MINE } from './CircuitService';
import { MyChips } from './MyChips';
import { adderScene } from './Scenes';
import type { VersionStore } from './Versions';

class MapStore implements VersionStore {
  readonly data = new Map<string, string>();
  read(key: string) {
    return Promise.resolve({ value: this.data.get(key) ?? null });
  }
  write(key: string, value: string) {
    this.data.set(key, value);
    return Promise.resolve();
  }
  remove(key: string) {
    this.data.delete(key);
    return Promise.resolve();
  }
}

describe('my chips', () => {
  it('keeps a chip with the chips it is made of, replaces it by name, and reads it back elsewhere', async () => {
    const store = new MapStore();
    const adder = adderScene();
    const name = Object.keys(adder.chips!).find(n => adder.chips![n]!.components.some(c => c.kind === 'chip')) ?? Object.keys(adder.chips!)[0]!;
    const mine = new MyChips(store);
    expect(await mine.save(adder, name)).toBe(true);
    expect(await mine.save(adder, 'no such chip')).toBe(false);
    await mine.save(adder, name);
    const again = new MyChips(store);
    await again.load();
    expect(again.list.map(c => c.name)).toEqual([name]);
    expect(again.get(name)!.circuit.components).toEqual(adder.chips![name]!.components);
    await again.remove(name);
    expect(again.list).toEqual([]);
    expect([...store.data.keys()]).toEqual(['index']);
  });

  it('brings a kept chip into another document when placed, numbering it past one of the same name', async () => {
    const mineStore = new MapStore();
    const service = new CircuitService({ schedule: () => {}, store: new MapStore(), myChips: mineStore });
    let view!: MyChipsView;
    let level!: LevelView;
    let document!: DocumentSummary;
    service.myChipsView.subscribe(v => (view = v));
    service.levelView.subscribe(v => (level = v));
    service.document.subscribe(d => (document = d));
    await service.restore();
    service.loadScene('adder');
    const name = document.chips[0]!.name;
    await service.saveMyChip(name);
    expect(view.chips.map(c => c.name)).toEqual([name]);
    expect(view.chips[0]!.shape.width).toBeGreaterThan(0);

    service.loadScene('empty');
    service.place('chip', 0, 0, 'c1', undefined, `${MINE}${name}`);
    expect(level.parts[0]).toMatchObject({ id: 'c1', kind: 'chip', chip: name });
    expect(document.chips.map(c => c.name)).toContain(name);
    // A document whose chip of that name is something else keeps it, and gets the kept one numbered.
    service.loadScene('empty');
    service.place('and', 0, 0, 'g1');
    service.makeChip(['g1'], name);
    service.place('chip', 10, 10, 'c2', undefined, `${MINE}${name}`);
    expect(level.parts.find(p => p.id === 'c2')!.chip).toBe(`${name} 2`);
    expect(document.chips.map(c => c.name)).toEqual(expect.arrayContaining([name, `${name} 2`]));
    service.place('chip', 0, 0, 'nope', undefined, `${MINE}never kept`);
    expect(level.parts.some(p => p.id === 'nope')).toBe(false);
  });
});
