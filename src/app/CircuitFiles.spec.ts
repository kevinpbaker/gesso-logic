import { describe, expect, it } from 'vitest';

import { writeCircuit } from '../sim/CircuitFile';
import type { DocumentSummary, SaveRequest } from './CircuitContract';
import { AUTOSAVE_KEY, CircuitService, type AutosaveStore } from './CircuitService';
import { counterScene } from './Scenes';

/** A store in a map, and a delay fired by hand. */
function harness(stored: Map<string, string> = new Map(), gate: Promise<void> = Promise.resolve()) {
  const store: AutosaveStore = {
    read: async key => {
      await gate;
      return { value: stored.get(key) ?? null };
    },
    write: async (key, value) => void stored.set(key, value)
  };
  let pending: (() => void) | null = null;
  const service = new CircuitService({
    schedule: () => {},
    now: () => 0,
    store,
    delay: run => {
      pending = run;
      return () => (pending = null);
    }
  });
  let summary!: DocumentSummary;
  service.document.subscribe(d => (summary = d));
  let saving!: SaveRequest;
  service.saving.subscribe(s => (saving = s));
  let running = false;
  service.status.subscribe(s => (running = s.running));
  const flush = () => {
    const run = pending;
    pending = null;
    run?.();
  };
  return { service, stored, flush, summary: () => summary, saving: () => saving, running: () => running };
}

describe('files', () => {
  it('opens a file, and says why one will not', () => {
    const { service, summary } = harness();
    service.open(writeCircuit(counterScene()), 'counter.gessologic.json', 7);
    expect(summary()).toMatchObject({ name: 'counter.gessologic.json', handle: 7, dirty: false, gates: 110, error: null });

    service.open('{"format":"gessologic","version":1,"components":[{"id":"x","kind":"flux","x":0,"y":0}],"wires":[]}', 'bad.json', null);
    expect(summary().message).toBe('Couldn\'t open bad.json: components[0].kind: "flux" is not a part');
    // The document that was open stays open.
    expect(summary().name).toBe('counter.gessologic.json');
  });

  it('hands a save over as text, and is clean once it is written', () => {
    const { service, summary, saving } = harness();
    service.place('and', 0, 0, 'g');
    expect(summary().dirty).toBe(true);

    service.requestSave(false);
    expect(saving()).toMatchObject({ serial: 1, name: 'circuit.gessologic.json', handle: null });
    expect(saving().text).toContain('"kind":"and"');

    service.finishSave({ name: 'mine.gessologic.json', handle: 3 }, 'Saved mine.gessologic.json');
    expect(saving().serial).toBe(0);
    expect(summary()).toMatchObject({ name: 'mine.gessologic.json', handle: 3, dirty: false });

    // Save writes back to the file; Save As asks where.
    service.requestSave(false);
    expect(saving().handle).toBe(3);
    service.requestSave(true);
    expect(saving().handle).toBe(null);
  });

  it('comes back after a reload: the circuit, the file, running from reset, where the view was', async () => {
    const first = harness();
    await first.service.restore();
    first.service.open(writeCircuit(counterScene()), 'counter.gessologic.json', 5);
    first.service.place('not', 100, 100, 'extra');
    first.service.run();
    first.service.rememberCamera(12, 34, 8);
    // Nothing is written until changes stop.
    expect(first.stored.has(AUTOSAVE_KEY)).toBe(false);
    first.flush();
    expect(first.stored.has(AUTOSAVE_KEY)).toBe(true);

    const second = harness(first.stored);
    await second.service.restore();
    expect(second.summary()).toMatchObject({
      name: 'counter.gessologic.json',
      handle: 5,
      dirty: true,
      gates: 111,
      camera: { x: 12, y: 34, scale: 8 }
    });
    expect(second.running()).toBe(true);
  });

  it('does not write over the autosave before it has read it, nor at all without being asked', async () => {
    const stored = new Map([[AUTOSAVE_KEY, 'kept']]);
    const { service, flush } = harness(stored);
    service.place('and', 0, 0, 'g');
    flush();
    expect(stored.get(AUTOSAVE_KEY)).toBe('kept');
    // An autosave that cannot be read is treated as none, and then replaced.
    await service.restore();
    service.place('or', 8, 0, 'h');
    flush();
    expect(stored.get(AUTOSAVE_KEY)).toContain('"kind\\":\\"or\\"');
  });
});

describe('the autosave, restored late', () => {
  it('does not replace a document loaded while it was being read', async () => {
    const saved = harness();
    await saved.service.restore();
    saved.service.open(writeCircuit(counterScene()), 'counter.gessologic.json', 5);
    saved.flush();

    // A slow store: the read answers only when released.
    let release!: () => void;
    const slow = harness(saved.stored, new Promise<void>(resolve => (release = resolve)));

    const restoring = slow.service.restore();
    slow.service.loadScene('empty');
    release();
    await restoring;
    expect(slow.summary()).toMatchObject({ components: 0, name: null });
  });
});
