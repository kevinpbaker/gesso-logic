import type { Geometry } from '../app/CircuitContract';
import { boundsOf, boxOf, LAYOUT, pinAt, route, slotOf, type Box } from '../app/Layout';
import { GATE_KINDS, isGate, type Kind } from '../sim/Primitives';

/**
 * The render worker's picture of the circuit: `geometry` turned into
 * flat arrays and a spatial index, rebuilt when geometry changes.
 *
 * Painters ask "what is in this rectangle" once per tile per recording,
 * so the answer is a walk over the cells the rectangle covers rather
 * than over every component. Wires are routed here, once per geometry,
 * with the same `route` the application worker uses to decide which
 * signals a viewport can see.
 */

/** Grid units per spatial cell. A gate is 4 units; a cell holds a handful. */
export const CELL = 16;

export const KIND_INDEX: Readonly<Record<Kind, number>> = {
  not: 0,
  and: 1,
  or: 2,
  nand: 3,
  nor: 4,
  xor: 5,
  xnor: 6,
  input: 7,
  clock: 8,
  constant: 9,
  output: 10
};
export const KINDS: readonly Kind[] = [...GATE_KINDS, 'input', 'clock', 'constant', 'output'];

export class SceneIndex {
  readonly componentCount: number;
  readonly kind: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** The net a component shows: a gate's or source's output, an output's input. -1 while it does not compile. */
  readonly valueNet: Int32Array;
  readonly labels: readonly (string | null)[];

  readonly wireCount: number;
  /** Each wire's route, flattened: points `wireStart[w] .. wireStart[w + 1]`, x then y. */
  readonly wireStart: Int32Array;
  readonly wirePoints: Float32Array;
  readonly wireNet: Int32Array;

  /** The world the circuit covers. */
  readonly bounds: Box;

  private readonly cellsX: number;
  private readonly cellsY: number;
  private readonly originX: number;
  private readonly originY: number;
  private readonly cellComponentStart: Int32Array;
  private readonly cellComponents: Int32Array;
  private readonly cellWireStart: Int32Array;
  private readonly cellWires: Int32Array;
  private readonly componentStamp: Uint32Array;
  private readonly wireStamp: Uint32Array;
  private epoch = 0;

  constructor(geometry: Geometry) {
    const ids = Object.keys(geometry.components);
    const indexOf = new Map(ids.map((id, n) => [id, n]));
    this.componentCount = ids.length;
    this.kind = new Uint8Array(ids.length);
    this.x = new Float32Array(ids.length);
    this.y = new Float32Array(ids.length);
    this.valueNet = new Int32Array(ids.length);
    const labels: (string | null)[] = [];
    const boxes: Box[] = [];
    ids.forEach((id, n) => {
      const c = geometry.components[id]!;
      this.kind[n] = KIND_INDEX[c.kind];
      this.x[n] = c.x;
      this.y[n] = c.y;
      this.valueNet[n] = (c.kind === 'output' ? c.nets.in : c.nets.out) ?? -1;
      labels.push(isGate(c.kind) ? null : (c.label ?? id));
      boxes.push(boxOf(c.kind, c.x, c.y));
    });
    this.labels = labels;

    const starts: number[] = [0];
    const points: number[] = [];
    const nets: number[] = [];
    const wireBoxes: Box[] = [];
    for (const wire of Object.values(geometry.wires)) {
      const from = geometry.components[wire.from.component];
      const to = geometry.components[wire.to.component];
      if (from === undefined || to === undefined || !indexOf.has(wire.from.component)) {
        continue;
      }
      const path = route(
        pinAt(from.kind, from.x, from.y, wire.from.pin),
        pinAt(to.kind, to.x, to.y, wire.to.pin),
        slotOf(wire.to.pin)
      );
      for (const p of path) {
        points.push(p.x, p.y);
      }
      starts.push(points.length);
      nets.push(wire.net);
      wireBoxes.push(boundsOf(path));
    }
    this.wireCount = nets.length;
    this.wireStart = Int32Array.from(starts);
    this.wirePoints = Float32Array.from(points);
    this.wireNet = Int32Array.from(nets);

    // A loop rather than `Math.min(...boxes)`: thirty thousand arguments
    // is past what a call can take.
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const box of [...boxes, ...wireBoxes]) {
      left = Math.min(left, box.left);
      top = Math.min(top, box.top);
      right = Math.max(right, box.right);
      bottom = Math.max(bottom, box.bottom);
    }
    this.bounds = left === Infinity ? { left: 0, top: 0, right: 0, bottom: 0 } : { left, top, right, bottom };
    this.originX = Math.floor(this.bounds.left / CELL) * CELL;
    this.originY = Math.floor(this.bounds.top / CELL) * CELL;
    this.cellsX = Math.max(1, Math.ceil((this.bounds.right - this.originX) / CELL) + 1);
    this.cellsY = Math.max(1, Math.ceil((this.bounds.bottom - this.originY) / CELL) + 1);
    const componentCells = this.bucket(boxes);
    const wireCells = this.bucket(wireBoxes);
    this.cellComponentStart = componentCells.start;
    this.cellComponents = componentCells.items;
    this.cellWireStart = wireCells.start;
    this.cellWires = wireCells.items;
    this.componentStamp = new Uint32Array(this.componentCount);
    this.wireStamp = new Uint32Array(this.wireCount);
  }

  isGate(component: number): boolean {
    return this.kind[component]! < GATE_KINDS.length;
  }

  width(component: number): number {
    return LAYOUT[KINDS[this.kind[component]!]!].width;
  }

  height(component: number): number {
    return LAYOUT[KINDS[this.kind[component]!]!].height;
  }

  /**
   * Visits each component and each wire that may meet a rectangle, once
   * each. May, not does: the index is by cell, and drawing a little
   * outside the rectangle costs nothing, because the tile's bitmap clips
   * it.
   */
  forEach(
    area: Box,
    component: ((index: number) => void) | null,
    wire: ((index: number) => void) | null
  ): void {
    const epoch = ++this.epoch;
    const x0 = this.cellX(area.left);
    const x1 = this.cellX(area.right);
    const y0 = this.cellY(area.top);
    const y1 = this.cellY(area.bottom);
    if (area.right < this.bounds.left || area.left > this.bounds.right || area.bottom < this.bounds.top || area.top > this.bounds.bottom) {
      return;
    }
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = cy * this.cellsX + cx;
        if (component !== null) {
          for (let i = this.cellComponentStart[cell]!; i < this.cellComponentStart[cell + 1]!; i++) {
            const c = this.cellComponents[i]!;
            if (this.componentStamp[c] !== epoch) {
              this.componentStamp[c] = epoch;
              component(c);
            }
          }
        }
        if (wire !== null) {
          for (let i = this.cellWireStart[cell]!; i < this.cellWireStart[cell + 1]!; i++) {
            const w = this.cellWires[i]!;
            if (this.wireStamp[w] !== epoch) {
              this.wireStamp[w] = epoch;
              wire(w);
            }
          }
        }
      }
    }
  }

  /** The nets drawn in a rectangle, for a tile's inputs and for counting what has not arrived. */
  netsIn(area: Box): number[] {
    const nets = new Set<number>();
    this.forEach(
      area,
      c => {
        const net = this.valueNet[c]!;
        if (net >= 0) nets.add(net);
      },
      w => {
        const net = this.wireNet[w]!;
        if (net >= 0) nets.add(net);
      }
    );
    return [...nets].sort((a, b) => a - b);
  }

  private cellX(x: number): number {
    return Math.min(this.cellsX - 1, Math.max(0, Math.floor((x - this.originX) / CELL)));
  }

  private cellY(y: number): number {
    return Math.min(this.cellsY - 1, Math.max(0, Math.floor((y - this.originY) / CELL)));
  }

  private bucket(boxes: readonly Box[]): { start: Int32Array; items: Int32Array } {
    const counts = new Int32Array(this.cellsX * this.cellsY + 1);
    const each = (box: Box, visit: (cell: number) => void) => {
      for (let cy = this.cellY(box.top); cy <= this.cellY(box.bottom); cy++) {
        for (let cx = this.cellX(box.left); cx <= this.cellX(box.right); cx++) {
          visit(cy * this.cellsX + cx);
        }
      }
    };
    for (const box of boxes) {
      each(box, cell => counts[cell + 1]!++);
    }
    for (let i = 1; i < counts.length; i++) {
      counts[i]! += counts[i - 1]!;
    }
    const fill = counts.slice(0, -1);
    const items = new Int32Array(counts[counts.length - 1]!);
    boxes.forEach((box, n) => each(box, cell => (items[fill[cell]!++] = n)));
    return { start: counts, items };
  }
}
