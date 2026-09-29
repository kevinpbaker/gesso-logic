import { describe, expect, it } from 'vitest';

import { benchmarkCpu } from '../sim/Benchmark';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { entriesOf, entryOf, type Geometry } from './CircuitContract';
import { CircuitService } from './CircuitService';
import { adderScene } from './Scenes';

/** Geometry as plain entries by id, for comparing however it is bucketed. */
function flat(geometry: Geometry) {
  const sorted = <T>(entries: [string, T][]) => Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)));
  return { components: sorted(entriesOf(geometry.components)), wires: sorted(entriesOf(geometry.wires)), level: geometry.level };
}

/** What `geometryNow` builds with nothing to patch from. */
function rebuilt(service: CircuitService): Geometry {
  const inside = service as unknown as { geometryCache: unknown; geometryNow(): Geometry };
  const cache = inside.geometryCache;
  inside.geometryCache = null;
  const geometry = inside.geometryNow();
  inside.geometryCache = cache;
  return geometry;
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return (below: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * below);
  };
}

describe('patched geometry', () => {
  // The service publishes geometry patched from the last — the entries an
  // edit touched, in the buckets they are in. Whatever the edit, that must
  // be what building it from nothing gives.
  for (const [name, circuit, edits] of [
    ['an adder of adder chips', adderScene(), 150],
    ['the ten-thousand-gate benchmark', benchmarkCpu(), 40]
  ] as const) {
    it(`matches a rebuild after every edit: ${name}`, () => {
      const service = new CircuitService({ schedule: () => {}, now: () => 0 });
      service.load(circuit);
      let geometry!: Geometry;
      service.geometry.subscribe(g => (geometry = g));
      const random = seeded(12);
      let placed = 0;
      for (let step = 0; step < edits; step++) {
        const level = (service as unknown as { level(): { circuit: typeof circuit } }).level().circuit;
        const components = level.components;
        const wires = level.wires;
        const any = <T>(list: readonly T[]) => list[random(list.length)]!;
        const choice = random(10);
        if (choice === 0 && wires.length > 0) service.remove([any(wires).id]);
        else if (choice === 1 && components.length > 0) service.remove([any(components).id]);
        else if (choice === 2) service.moveBy([any(components).id], 1, 0);
        else if (choice === 3) service.undo();
        else if (choice === 4) service.redo();
        else if (choice === 5) service.rotate([any(components).id]);
        else if (choice === 6) service.place('and', 200 + placed * 4, -20, `new${placed++}`);
        else if (choice === 7) {
          // Joins a free gate's input to some output, merging or
          // re-driving a net.
          const gate = components.find(c => c.kind === 'and' && !wires.some(w => w.to.component === c.id && w.to.pin === 'a'));
          const source = components.find(c => c.kind === 'not');
          if (gate !== undefined && source !== undefined) service.connect({ component: source.id, pin: 'out' }, { component: gate.id, pin: 'a' });
        } else if (choice === 8) {
          const chip = components.find(c => c.kind === 'chip');
          if (chip !== undefined) service.openChip(chip.id);
          else service.closeChip(0);
        } else service.closeChip(0);
        expect(flat(geometry), `after edit ${step}`).toEqual(flat(rebuilt(service)));
      }
    }, 60_000);
  }

  it('moves a wire to the net its driver was renumbered onto', () => {
    // A net keeps its number on the side of its first pin, in document
    // order. Cut the wire from a gate to a part placed before it, and the
    // number stays with that part; the gate's side is renumbered, and so
    // is every other wire it drives — which no edit to those wires said.
    const b = new CircuitBuilder();
    const early = b.gate('and', 'early');
    const late = b.gate('and', 'late');
    const source = b.input('x');
    const gate = b.not(source, 'g');
    b.connect(gate, early.a);
    b.connect(gate, late.a);
    const circuit = b.build();
    const cut = circuit.wires.find(w => w.to.component === 'early')!;
    const kept = circuit.wires.find(w => w.to.component === 'late')!;
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    service.load(circuit);
    let geometry!: Geometry;
    service.geometry.subscribe(g => (geometry = g));
    const before = entryOf(geometry.wires, kept.id)!.net;
    service.remove([cut.id]);
    expect(entryOf(geometry.wires, kept.id)!.net).not.toBe(before);
    expect(flat(geometry)).toEqual(flat(rebuilt(service)));
    service.undo();
    expect(flat(geometry)).toEqual(flat(rebuilt(service)));
  });
});
