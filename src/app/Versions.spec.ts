import { describe, expect, it } from 'vitest';

import type { DocumentSummary, VersionsView } from './CircuitContract';
import { CircuitService } from './CircuitService';
import { MAX_VERSIONS, VERSION_EVERY_MS, Versions, type VersionStore } from './Versions';

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

const record = (file: string) => ({ file, name: null, handle: null });

describe('versions', () => {
  it('keeps copies newest first, not the same one twice running, and reads them back after a reload', async () => {
    const store = new MapStore();
    let now = 1000;
    const versions = new Versions(store, () => now++);
    await versions.load();
    await versions.keep(record('one'), 'opened', 1);
    expect(await versions.keep(record('one'), 'editing', 1)).toBeNull();
    await versions.keep(record('two'), 'editing', 2);
    expect(versions.list.map(v => [v.reason, v.parts])).toEqual([
      ['editing', 2],
      ['opened', 1]
    ]);

    const again = new Versions(store);
    await again.load();
    expect(again.list.map(v => v.id)).toEqual(versions.list.map(v => v.id));
    expect((await again.read(again.list[1]!.id))?.file).toBe('one');
    // Ids go on from the highest kept.
    await again.keep(record('three'), 'replaced', 3);
    expect(again.list[0]!.id).toBe(3);
  });

  it('lets the oldest go past the limit, and their files with them', async () => {
    const store = new MapStore();
    const versions = new Versions(store);
    await versions.load();
    for (let i = 0; i < MAX_VERSIONS + 3; i++) await versions.keep(record(`v${i}`), 'editing', i);
    expect(versions.list).toHaveLength(MAX_VERSIONS);
    expect(versions.list.at(-1)!.parts).toBe(3);
    expect(store.data.has('version-1')).toBe(false);
    expect(store.data.has(`version-${MAX_VERSIONS + 3}`)).toBe(true);
  });

  it('starts an empty list from an index that cannot be read', async () => {
    const store = new MapStore();
    store.data.set('index', '{not json');
    const versions = new Versions(store);
    await versions.load();
    expect(versions.list).toEqual([]);
  });
});

describe('versions in the service', () => {
  async function service() {
    const versions = new MapStore();
    let clock = 0;
    const autosaves: (() => void)[] = [];
    const s = new CircuitService({
      schedule: () => {},
      store: new MapStore(),
      versions,
      delay: run => (autosaves.push(run), () => {}),
      wallClock: () => clock
    });
    let view!: VersionsView;
    let document!: DocumentSummary;
    s.versionsView.subscribe(v => (view = v));
    s.document.subscribe(d => (document = d));
    await s.restore();
    return { s, view: () => view, document: () => document, autosave: () => autosaves.splice(0).forEach(run => run()), tick: (ms: number) => (clock += ms) };
  }
  const settled = () => new Promise(resolve => setTimeout(resolve, 0));

  it('keeps the document before its first change, while it changes, and before it is replaced', async () => {
    const { s, view, autosave, tick } = await service();
    s.loadScene('adder');
    s.place('and', 0, 40, 'g1');
    await settled();
    expect(view().entries.map(e => e.reason)).toEqual(['opened']);

    // A minute on, the autosave keeps nothing new; five minutes on, it does.
    tick(60_000);
    s.place('and', 0, 50, 'g2');
    autosave();
    await settled();
    expect(view().entries).toHaveLength(1);
    tick(VERSION_EVERY_MS);
    s.place('and', 0, 60, 'g3');
    autosave();
    await settled();
    expect(view().entries.map(e => e.reason)).toEqual(['editing', 'opened']);

    // Replaced unchanged since the last copy, nothing new is kept; changed, it is.
    s.loadScene('counter');
    await settled();
    expect(view().entries).toHaveLength(2);
    s.place('and', 0, 70, 'g4');
    s.loadScene('adder');
    await settled();
    expect(view().entries.map(e => e.reason)).toEqual(['replaced', 'opened', 'editing', 'opened']);
  });

  it('restores an earlier version, keeping what was open first', async () => {
    const { s, view, document } = await service();
    s.loadScene('adder');
    const parts = document().components;
    s.place('and', 0, 40, 'g1');
    s.loadScene('counter');
    await settled();
    const opened = view().entries.find(e => e.reason === 'opened')!;
    await s.restoreVersion(opened.id);
    await settled();
    expect(document().components).toBe(parts);
    expect(document().dirty).toBe(true);
    expect(view().entries[0]!.reason).toBe('restored');
    expect(document().message).toMatch(/^Restored an earlier version/);
  });
});
