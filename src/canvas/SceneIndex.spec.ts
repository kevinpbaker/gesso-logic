import { describe, expect, it } from 'vitest';

import type { Geometry } from '../app/CircuitContract';
import { CircuitService } from '../app/CircuitService';
import { adderScene } from '../app/Scenes';
import { benchmarkCpu } from '../sim/Benchmark';
import { SceneIndex } from './SceneIndex';

/** A scene's contents as plain data, for comparing one built from what the last build made with one built from nothing. */
function contents(scene: SceneIndex) {
  return {
    ids: scene.ids,
    kind: [...scene.kind],
    x: [...scene.x],
    y: [...scene.y],
    turns: [...scene.turns],
    valueNet: [...scene.valueNet],
    widths: [...scene.widths],
    labels: scene.labels,
    displayNets: scene.displayNets.map(nets => (nets === null ? null : [...nets])),
    wireIds: scene.wireIds,
    wireStart: [...scene.wireStart],
    wirePoints: [...scene.wirePoints],
    wireNet: [...scene.wireNet],
    wireWidth: [...scene.wireWidth],
    wireBits: scene.wireBits.map(bits => (bits === null ? null : [...bits])),
    bounds: scene.bounds
  };
}

/**
 * What changed, worked out the slow way — every part and every route of
 * both scenes compared by id and by value — as `changedAreas` did before
 * it read what the build reused.
 */
function changedByValue(before: SceneIndex, after: SceneIndex): string[] {
  const box = (s: SceneIndex, c: number) => ({ left: s.x[c]!, top: s.y[c]!, right: s.x[c]! + s.width(c), bottom: s.y[c]! + s.height(c) });
  const areas: { left: number; top: number; right: number; bottom: number }[] = [];
  for (let c = 0; c < after.componentCount; c++) {
    const was = before.indexOf.get(after.ids[c]!);
    if (was === undefined || before.x[was] !== after.x[c] || before.y[was] !== after.y[c] || before.kind[was] !== after.kind[c] || before.turns[was] !== after.turns[c]) {
      areas.push(box(after, c));
      if (was !== undefined) areas.push(box(before, was));
    }
  }
  for (let c = 0; c < before.componentCount; c++) if (!after.indexOf.has(before.ids[c]!)) areas.push(box(before, c));
  const routes = (s: SceneIndex) =>
    new Map(s.wireIds.map((id, w) => [id, Array.from(s.wirePoints.subarray(s.wireStart[w]!, s.wireStart[w + 1]!)).join(',')]));
  const old = routes(before);
  const now = routes(after);
  const route = (s: SceneIndex, id: string) => s.routes[s.wireIds.indexOf(id)]!.box;
  for (const [id, points] of now) {
    const was = old.get(id);
    if (was !== points) {
      areas.push(route(after, id));
      if (was !== undefined) areas.push(route(before, id));
    }
  }
  for (const id of old.keys()) if (!now.has(id)) areas.push(route(before, id));
  return areas.map(a => `${a.left - 0.5},${a.top - 0.5},${a.right + 0.5},${a.bottom + 0.5}`);
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

describe('the scene index, built from the last', () => {
  // The canvas builds each scene from what the last build made of the
  // geometry buckets an edit left alone. That must be the scene a build
  // from nothing gives, and its changed areas must cover every part and
  // route that moved.
  for (const [name, circuit, edits] of [
    ['an adder of adder chips', adderScene(), 120],
    ['the ten-thousand-gate benchmark', benchmarkCpu(), 12]
  ] as const) {
    it(`matches a fresh build, and reports what moved: ${name}`, () => {
      const service = new CircuitService({ schedule: () => {}, now: () => 0 });
      service.load(circuit);
      let geometry!: Geometry;
      service.geometry.subscribe(g => (geometry = g));
      let scene = new SceneIndex(geometry);
      const random = seeded(3);
      for (let step = 0; step < edits; step++) {
        const level = (service as unknown as { level(): { circuit: typeof circuit } }).level().circuit;
        const any = <T>(list: readonly T[]) => list[random(list.length)]!;
        const choice = random(6);
        if (choice === 0 && level.wires.length > 0) service.remove([any(level.wires).id]);
        else if (choice === 1) service.moveBy([any(level.components).id], random(3) - 1, random(3) - 1);
        else if (choice === 2) service.undo();
        else if (choice === 3) service.rotate([any(level.components).id]);
        else if (choice === 4 && level.components.length > 0) service.remove([any(level.components).id]);
        else service.redo();
        const before = scene;
        scene = new SceneIndex(geometry, before);
        // A copy of the geometry shares no objects with any build.
        expect(contents(scene), `after edit ${step}`).toEqual(contents(new SceneIndex(structuredClone(geometry))));
        const reported = new Set(scene.changed.map(a => `${a.left},${a.top},${a.right},${a.bottom}`));
        for (const area of changedByValue(before, scene)) expect(reported, `after edit ${step}`).toContain(area);
      }
    }, 60_000);
  }
});
