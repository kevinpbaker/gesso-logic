import { describe, expect, it } from 'vitest';

import type { DocumentSummary, Geometry } from './CircuitContract';
import { CircuitService } from './CircuitService';
import { libraryChips } from './LibraryParts';

describe('the library in a document', () => {
  it('places a part the document lacks by bringing it in, with the parts it is made of, and opens it', () => {
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: DocumentSummary;
    let geometry!: Geometry;
    service.document.subscribe(d => (summary = d));
    service.geometry.subscribe(g => (geometry = g));
    service.loadScene('empty');
    expect(summary.library.map(p => p.name)).toContain('counter 8');

    service.place('chip', 0, 0, 'pc', undefined, 'counter 8');
    expect(summary.chips.map(c => c.name)).toEqual(['D flip-flop', 'counter 8', 'half adder', 'mux 2']);
    expect(summary.error).toBeNull();
    expect(summary.gates).toBe(129);
    expect(geometry.components['pc']).toMatchObject({ kind: 'chip', chip: 'counter 8' });

    // A second is the same chip, not another copy of it.
    service.place('chip', 0, 30, 'pc2', undefined, 'counter 8');
    expect(summary.chips).toHaveLength(4);
    expect(summary.gates).toBe(258);

    // Openable like anything else, and laid out.
    service.openChip('pc');
    expect(Object.keys(geometry.components)).toContain('ff0');
    const xs = Object.values(geometry.components).map(c => c.x);
    expect(new Set(xs).size).toBeGreaterThan(3);
  });

  it('lays every part out once', () => {
    const chips = libraryChips();
    expect(Object.keys(chips)).toHaveLength(12);
    expect(libraryChips()).toBe(chips);
  });
});
