import type { Geometry } from '../app/CircuitContract';
import { boundsOf, boxOf, LAYOUT, pinAt, route, sizeOf, slotOf, type Box, type Point } from '../app/Layout';
import type { PinRef, Rotation } from '../sim/Circuit';
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
  /** Each component's id, and its index by id. */
  readonly ids: readonly string[];
  readonly indexOf: ReadonlyMap<string, number>;
  /** Quarter turns clockwise, 0–3. */
  readonly turns: Uint8Array;
  /** Each wire's id and its two ends. */
  readonly wireIds: readonly string[];
  readonly wireEnds: readonly { readonly from: PinRef; readonly to: PinRef }[];

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
    this.ids = ids;
    this.indexOf = indexOf;
    this.turns = new Uint8Array(ids.length);
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
      this.turns[n] = c.rotation / 90;
      this.valueNet[n] = (c.kind === 'output' ? c.nets.in : c.nets.out) ?? -1;
      labels.push(isGate(c.kind) ? null : (c.label ?? id));
      boxes.push(boxOf(c.kind, c.x, c.y, c.rotation));
    });
    this.labels = labels;

    const starts: number[] = [0];
    const points: number[] = [];
    const nets: number[] = [];
    const wireBoxes: Box[] = [];
    const wireIds: string[] = [];
    const wireEnds: { from: PinRef; to: PinRef }[] = [];
    for (const [wireId, wire] of Object.entries(geometry.wires)) {
      const from = geometry.components[wire.from.component];
      const to = geometry.components[wire.to.component];
      if (from === undefined || to === undefined || !indexOf.has(wire.from.component)) {
        continue;
      }
      const path = route(
        pinAt(from.kind, from.x, from.y, wire.from.pin, from.rotation),
        pinAt(to.kind, to.x, to.y, wire.to.pin, to.rotation),
        slotOf(wire.to.pin)
      );
      for (const p of path) {
        points.push(p.x, p.y);
      }
      starts.push(points.length);
      nets.push(wire.net);
      wireIds.push(wireId);
      wireEnds.push({ from: wire.from, to: wire.to });
      wireBoxes.push(boundsOf(path));
    }
    this.wireCount = nets.length;
    this.wireStart = Int32Array.from(starts);
    this.wirePoints = Float32Array.from(points);
    this.wireNet = Int32Array.from(nets);
    this.wireIds = wireIds;
    this.wireEnds = wireEnds;

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

  kindOf(component: number): Kind {
    return KINDS[this.kind[component]!]!;
  }

  rotationOf(component: number): Rotation {
    return (this.turns[component]! * 90) as Rotation;
  }

  /** Width and height as drawn: a quarter turn swaps them. */
  width(component: number): number {
    return sizeOf(this.kindOf(component), this.rotationOf(component)).width;
  }

  height(component: number): number {
    return sizeOf(this.kindOf(component), this.rotationOf(component)).height;
  }

  /** The pins a component has, where they are now. */
  pins(component: number): { readonly pin: string; readonly at: Point }[] {
    const kind = this.kindOf(component);
    return Object.keys(LAYOUT[kind].pins).map(pin => ({
      pin,
      at: pinAt(kind, this.x[component]!, this.y[component]!, pin, this.rotationOf(component))
    }));
  }

  // -------------------------------------------------------------------------
  // Hit testing, in grid units
  // -------------------------------------------------------------------------

  /** The topmost component whose box holds a point, or -1. */
  componentAt(p: Point): number {
    let found = -1;
    this.forEach(
      { left: p.x, top: p.y, right: p.x, bottom: p.y },
      c => {
        const x = this.x[c]!;
        const y = this.y[c]!;
        if (p.x >= x && p.x <= x + this.width(c) && p.y >= y && p.y <= y + this.height(c)) {
          found = Math.max(found, c);
        }
      },
      null
    );
    return found;
  }

  /** The pin nearest a point within `radius` units, or null. */
  pinNear(p: Point, radius: number): PinRef | null {
    let best: PinRef | null = null;
    let bestDistance = radius;
    this.forEach(
      { left: p.x - radius, top: p.y - radius, right: p.x + radius, bottom: p.y + radius },
      c => {
        for (const { pin, at } of this.pins(c)) {
          const d = Math.hypot(at.x - p.x, at.y - p.y);
          if (d <= bestDistance) {
            bestDistance = d;
            best = { component: this.ids[c]!, pin };
          }
        }
      },
      null
    );
    return best;
  }

  /** The wire whose route passes within `tolerance` units of a point, or -1. */
  wireNear(p: Point, tolerance: number): number {
    let best = -1;
    let bestDistance = tolerance;
    this.forEach({ left: p.x - tolerance, top: p.y - tolerance, right: p.x + tolerance, bottom: p.y + tolerance }, null, w => {
      const pts = this.wirePoints;
      for (let i = this.wireStart[w]!; i + 3 < this.wireStart[w + 1]!; i += 2) {
        const d = distanceToSegment(p, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!);
        if (d <= bestDistance) {
          bestDistance = d;
          best = w;
        }
      }
    });
    return best;
  }

  /** Every component whose box lies wholly inside a rectangle: what a marquee selects. */
  componentsIn(area: Box): number[] {
    const found: number[] = [];
    this.forEach(
      area,
      c => {
        const x = this.x[c]!;
        const y = this.y[c]!;
        if (x >= area.left && y >= area.top && x + this.width(c) <= area.right && y + this.height(c) <= area.bottom) {
          found.push(c);
        }
      },
      null
    );
    return found;
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

function distanceToSegment(p: Point, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.y - y0) * dy) / length));
  return Math.hypot(p.x - (x0 + t * dx), p.y - (y0 + t * dy));
}

/**
 * Where an edit changed the drawing: the old and new boxes of every
 * component that moved, turned, changed kind, appeared or went, and the
 * old and new bounds of every wire whose route changed. Tiles outside
 * these are left alone, so moving one gate redraws the tiles around it
 * and not the other ten thousand gates' worth.
 */
export function changedAreas(before: SceneIndex, after: SceneIndex): Box[] {
  const areas: Box[] = [];
  const boxOf = (s: SceneIndex, c: number): Box => ({
    left: s.x[c]!,
    top: s.y[c]!,
    right: s.x[c]! + s.width(c),
    bottom: s.y[c]! + s.height(c)
  });
  for (let c = 0; c < after.componentCount; c++) {
    const was = before.indexOf.get(after.ids[c]!);
    if (
      was === undefined ||
      before.x[was] !== after.x[c] ||
      before.y[was] !== after.y[c] ||
      before.kind[was] !== after.kind[c] ||
      before.turns[was] !== after.turns[c]
    ) {
      areas.push(boxOf(after, c));
      if (was !== undefined) areas.push(boxOf(before, was));
    }
  }
  for (let c = 0; c < before.componentCount; c++) {
    if (!after.indexOf.has(before.ids[c]!)) areas.push(boxOf(before, c));
  }
  const routes = (s: SceneIndex) => {
    const byId = new Map<string, { key: string; box: Box }>();
    for (let w = 0; w < s.wireCount; w++) {
      const points = Array.from(s.wirePoints.subarray(s.wireStart[w]!, s.wireStart[w + 1]!));
      const xs = points.filter((_, i) => i % 2 === 0);
      const ys = points.filter((_, i) => i % 2 === 1);
      byId.set(s.wireIds[w]!, {
        key: points.join(','),
        box: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
      });
    }
    return byId;
  };
  const old = routes(before);
  const now = routes(after);
  for (const [id, route] of now) {
    const was = old.get(id);
    if (was === undefined || was.key !== route.key) {
      areas.push(route.box);
      if (was !== undefined) areas.push(was.box);
    }
  }
  for (const [id, route] of old) {
    if (!now.has(id)) areas.push(route.box);
  }
  // Half a unit of margin: strokes and bubbles reach past their boxes.
  return areas.map(a => ({ left: a.left - 0.5, top: a.top - 0.5, right: a.right + 0.5, bottom: a.bottom + 0.5 }));
}
