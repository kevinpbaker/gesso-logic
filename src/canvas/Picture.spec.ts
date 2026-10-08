import { lightTheme } from 'gesso-core';
import { describe, expect, it } from 'vitest';

import { CircuitService } from '../app/CircuitService';
import { pictureArea, pictureScene, pictureSvg, pngScale } from './Picture';

function adder() {
  const service = new CircuitService({ schedule: () => {} });
  service.loadScene('adder');
  let geometry!: Parameters<typeof pictureScene>[0];
  let chunks!: Readonly<Record<string, string>>;
  service.geometry.subscribe(v => (geometry = v)).unsubscribe();
  service.signals.subscribe(v => (chunks = v.chunks)).unsubscribe();
  return { geometry, chunks };
}

describe('a picture of the circuit', () => {
  it('draws the level in SVG, every part and wire, framed with a margin and no grid', () => {
    const { geometry, chunks } = adder();
    const scene = pictureScene(geometry, null);
    const svg = pictureSvg(scene, chunks, lightTheme);
    const area = pictureArea(scene);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`width="${(area.right - area.left) * 16}"`);
    expect(area.left).toBeLessThan(scene.bounds.left);
    // Symbols and wires are paths; labels are text.
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThan(5);
    expect(svg).toContain('</text>');
    expect(svg).not.toContain('NaN');
  });

  it('draws only the parts selected, and the wires between them', () => {
    const { geometry } = adder();
    const all = pictureScene(geometry, null);
    const two = new Set(all.ids.slice(0, 2));
    const some = pictureScene(geometry, two);
    expect(some.componentCount).toBe(2);
    expect(some.wireEnds.every(w => two.has(w.from.component) && two.has(w.to.component))).toBe(true);
  });

  it('makes a PNG of a huge circuit at fewer pixels a unit, rather than past what a canvas can hold', () => {
    const { geometry } = adder();
    const scene = pictureScene(geometry, null);
    expect(pngScale(scene, 32)).toBe(32);
    const huge = { ...scene, bounds: { left: 0, top: 0, right: 4000, bottom: 3000 } } as typeof scene;
    expect(pngScale(huge, 32)).toBeLessThan(4);
  });
});
