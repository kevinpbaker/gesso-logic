import { type ComponentGeometry, type Geometry, type WireGeometry } from '../app/CircuitContract';
import { boundsOf, boxOf, LAYOUT, pinAt, route, sizeOf, slotOf, type Box, type KindLayout, type Point, type Shape } from '../app/Layout';
import type { PinRef, Rotation } from '../sim/Circuit';
import { GATE_KINDS, isGate, MATRIX_HEIGHT, MATRIX_WIDTH, PINS, type Kind } from '../sim/Primitives';

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
  output: 10,
  button: 11,
  probe: 12,
  hex: 13,
  seg7: 14,
  chip: 15,
  split: 16,
  join: 17,
  rom: 18,
  matrix: 19,
  tunnel: 20,
  note: 21
};
export const KINDS: readonly Kind[] = [...GATE_KINDS, 'input', 'clock', 'constant', 'output', 'button', 'probe', 'hex', 'seg7', 'chip', 'split', 'join', 'rom', 'matrix', 'tunnel', 'note'];

export class SceneIndex {
  readonly componentCount: number;
  readonly kind: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** The net a component shows: a gate's or source's output, an output's input. -1 while it does not compile. */
  readonly valueNet: Int32Array;
  /** A chip's body and pins, from its definition; null for every other kind. */
  readonly shapes: readonly (KindLayout | null)[];
  /** A chip's definition name; null for every other kind. */
  readonly chipNames: readonly (string | null)[];
  /** Each component's width in bits. */
  readonly widths: Uint8Array;
  /**
   * The nets a component shows more than one of, in order: a hex or
   * seven-segment display's pins, or the bits of a wide switch, constant,
   * LED, probe or hex display, least significant first. Null for
   * everything that shows one bit, or none.
   */
  readonly displayNets: readonly (Int32Array | null)[];
  readonly labels: readonly (string | null)[];
  /** Each component's id, and its index by id. */
  readonly ids: readonly string[];
  readonly indexOf: ReadonlyMap<string, number>;
  /** Quarter turns clockwise, 0–3. */
  readonly turns: Uint8Array;
  /** Each wire's id, and its geometry: its two ends, and the corners it was bent to. */
  readonly wireIds: readonly string[];
  readonly wireEnds: readonly WireGeometry[];

  readonly wireCount: number;
  /** Each wire's route, flattened: points `wireStart[w] .. wireStart[w + 1]`, x then y. */
  readonly wireStart: Int32Array;
  readonly wirePoints: Float32Array;
  readonly wireNet: Int32Array;
  /** Each wire's width in bits, and a bus's nets, least significant first; null for a one-bit wire. */
  readonly wireWidth: Uint8Array;
  readonly wireBits: readonly (Int32Array | null)[];

  /** The world the circuit covers. */
  readonly bounds: Box;

  /** Each component's geometry entry. */
  readonly entries: readonly ComponentGeometry[];
  /** Each component's box, and each wire's route: shared with the scene before wherever the edit left them alone. */
  readonly placed: readonly Placed[];
  readonly routes: readonly Route[];
  /** Which build this is, for telling what it reused. */
  readonly build = ++builds;
  /**
   * Where the drawing differs from the scene this was built after: see
   * `changedAreas`. Empty for a scene built after none.
   */
  readonly changed: readonly Box[];

  private readonly componentGrid: Grids;
  private readonly wireGrid: Grids;
  private readonly componentStamp: Uint32Array;
  private readonly wireStamp: Uint32Array;
  private epoch = 0;

  constructor(geometry: Geometry, previous: SceneIndex | null = null) {
    const build = this.build;
    // Geometry comes in buckets, and an edit replaces the few it touched:
    // every other bucket is the object it was, and its parts and wires
    // are read from what the last build made of it, with no lookup per
    // entry. See `GEOMETRY_BUCKETS`.
    const componentBuckets = Object.values(geometry.components).map(bucket => {
      let digest = placedDigests.get(bucket);
      if (digest === undefined) {
        digest = Object.keys(bucket).map(id => {
          const entry = bucket[id]!;
          // An entry the edit kept, in a bucket it touched, is the same
          // entry and keeps its `Placed`.
          let place = placedCache.get(entry);
          if (place === undefined) placedCache.set(entry, (place = placeOf(id, entry, build)));
          return place;
        });
        placedDigests.set(bucket, digest);
      }
      return digest;
    });
    const placed = componentBuckets.flat();
    const count = placed.length;
    this.placed = placed;
    this.componentCount = count;
    this.ids = placed.map(p => p.id);
    this.entries = placed.map(p => p.entry);
    this.indexOf = new Map(this.ids.map((id, n) => [id, n]));
    this.turns = new Uint8Array(count);
    this.kind = new Uint8Array(count);
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.valueNet = new Int32Array(count);
    this.widths = new Uint8Array(count);
    const labels: (string | null)[] = new Array(count);
    const displayNets: (Int32Array | null)[] = new Array(count);
    const shapes: (KindLayout | null)[] = new Array(count);
    const chipNames: (string | null)[] = new Array(count);
    const boxes: Box[] = new Array(count);
    for (let n = 0; n < count; n++) {
      const place = placed[n]!;
      const c = place.entry;
      place.used = build;
      this.kind[n] = KIND_INDEX[c.kind];
      this.x[n] = c.x;
      this.y[n] = c.y;
      this.turns[n] = c.rotation / 90;
      this.valueNet[n] = place.valueNet;
      this.widths[n] = c.width;
      displayNets[n] = place.displayNets;
      labels[n] = place.label;
      shapes[n] = c.shape;
      chipNames[n] = c.chip;
      boxes[n] = place.box;
    }
    this.labels = labels;
    this.displayNets = displayNets;
    this.shapes = shapes;
    this.chipNames = chipNames;

    // Wires, likewise by bucket. A cached route stands while both its
    // ends' `Placed` were used by this build — each is still its
    // component's entry — which needs no lookup by id either; only a
    // wire whose end changed is looked up and routed again.
    const wireBuckets = Object.values(geometry.wires).map(bucket => {
      let digest = wireDigests.get(bucket);
      if (digest === undefined) {
        digest = Object.keys(bucket).map(id => ({ id, wire: bucket[id]!, route: routeCache.get(bucket[id]!) ?? null }));
        wireDigests.set(bucket, digest);
      }
      return digest;
    });
    const routes: Route[] = [];
    const wires: WireGeometry[] = [];
    for (const digest of wireBuckets) {
      for (const item of digest) {
        let routed = item.route;
        if (routed === null || routed.from.used !== build || routed.to.used !== build) {
          const wire = item.wire;
          const fromIndex = this.indexOf.get(wire.from.component);
          const toIndex = this.indexOf.get(wire.to.component);
          if (fromIndex === undefined || toIndex === undefined) {
            continue;
          }
          const from = this.entries[fromIndex]!;
          const to = this.entries[toIndex]!;
          const path = route(
            pinAt(from.shape ?? from.kind, from.x, from.y, wire.from.pin, from.rotation),
            pinAt(to.shape ?? to.kind, to.x, to.y, wire.to.pin, to.rotation),
            slotOf(wire.to.pin),
            wire.via
          );
          routed = { id: item.id, from: placed[fromIndex]!, to: placed[toIndex]!, points: path.flatMap(p => [p.x, p.y]), box: boundsOf(path), born: build, used: 0 };
          item.route = routed;
          routeCache.set(wire, routed);
        }
        routed.used = build;
        routes.push(routed);
        wires.push(item.wire);
      }
    }
    const wireCount = routes.length;
    this.wireCount = wireCount;
    this.routes = routes;
    this.wireIds = routes.map(r => r.id);
    this.wireEnds = wires;
    const starts = new Int32Array(wireCount + 1);
    const wireNet = new Int32Array(wireCount);
    const wireWidth = new Uint8Array(wireCount);
    const bitsOfWires: (Int32Array | null)[] = new Array(wireCount);
    const wireBoxes: Box[] = new Array(wireCount);
    for (let w = 0; w < wireCount; w++) {
      const wire = wires[w]!;
      starts[w + 1] = starts[w]! + routes[w]!.points.length;
      wireNet[w] = wire.net;
      wireWidth[w] = wire.width;
      bitsOfWires[w] = wire.bits.length > 0 ? Int32Array.from(wire.bits) : null;
      wireBoxes[w] = routes[w]!.box;
    }
    const points = new Float32Array(starts[wireCount]!);
    for (let w = 0; w < wireCount; w++) points.set(routes[w]!.points, starts[w]!);
    this.wireStart = starts;
    this.wirePoints = points;
    this.wireNet = wireNet;
    this.wireWidth = wireWidth;
    this.wireBits = bitsOfWires;

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
    this.componentGrid = grids(this.bounds, boxes);
    this.wireGrid = grids(this.bounds, wireBoxes);
    this.componentStamp = new Uint32Array(this.componentCount);
    this.wireStamp = new Uint32Array(this.wireCount);
    // Now, while the stamps say what this build reused from the last.
    this.changed = previous === null ? [] : changedAreas(previous, this);
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
    return sizeOf(this.shapeOf(component), this.rotationOf(component)).width;
  }

  height(component: number): number {
    return sizeOf(this.shapeOf(component), this.rotationOf(component)).height;
  }

  /** The pins a component has, where they are now. */
  pins(component: number): { readonly pin: string; readonly at: Point }[] {
    const shape = this.shapeOf(component);
    const layout = typeof shape === 'string' ? LAYOUT[shape] : shape;
    return Object.keys(layout.pins).map(pin => ({
      pin,
      at: pinAt(shape, this.x[component]!, this.y[component]!, pin, this.rotationOf(component))
    }));
  }

  /**
   * Whether a pin drives its net: an output of its kind, or on a chip,
   * a pin down the right of the unturned body, where a chip's outputs are.
   */
  drives(component: number, pin: string): boolean {
    const shape = this.shapes[component];
    if (shape === null || shape === undefined) {
      return PINS[this.kindOf(component)].outputs.includes(pin);
    }
    return shape.pins[pin]?.x === shape.width;
  }

  /** What the layout functions take for this component: its kind, or a chip's body. */
  shapeOf(component: number): Shape {
    return this.shapes[component] ?? this.kindOf(component);
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

  /**
   * The component whose box, grown by `margin` on every side, holds a
   * point, nearest the point if several do — one it is inside beats one
   * it is only near — or -1. `skip` leaves a component out.
   */
  componentNear(p: Point, margin: number, skip?: number): number {
    let found = -1;
    let bestDistance = Infinity;
    this.forEach(
      { left: p.x - margin, top: p.y - margin, right: p.x + margin, bottom: p.y + margin },
      c => {
        if (c === skip) return;
        const x = this.x[c]!;
        const y = this.y[c]!;
        const dx = Math.max(x - p.x, 0, p.x - (x + this.width(c)));
        const dy = Math.max(y - p.y, 0, p.y - (y + this.height(c)));
        const d = Math.hypot(dx, dy);
        if (d <= margin && d < bestDistance) {
          bestDistance = d;
          found = c;
        }
      },
      null
    );
    return found;
  }

  /** The pin nearest a point within `radius` units, or null. */
  pinNear(p: Point, radius: number, accept?: (c: number, pin: string) => boolean): PinRef | null {
    let best: PinRef | null = null;
    let bestDistance = radius;
    this.forEach(
      { left: p.x - radius, top: p.y - radius, right: p.x + radius, bottom: p.y + radius },
      c => {
        for (const { pin, at } of this.pins(c)) {
          if (accept !== undefined && !accept(c, pin)) continue;
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

  /** A component's pin nearest a point, however far, among those `accept` takes; null if it takes none. */
  nearestPinOf(c: number, p: Point, accept?: (pin: string) => boolean): PinRef | null {
    let best: PinRef | null = null;
    let bestDistance = Infinity;
    for (const { pin, at } of this.pins(c)) {
      if (accept !== undefined && !accept(pin)) continue;
      const d = Math.hypot(at.x - p.x, at.y - p.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = { component: this.ids[c]!, pin };
      }
    }
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

  /**
   * Every wire whose route passes within `tolerance` units of a point,
   * nearest first — the wires a click there could mean, where wires
   * overlap. Ties keep the scene's order, so the list is the same each
   * time it is asked.
   */
  wiresNear(p: Point, tolerance: number): number[] {
    const found: { w: number; d: number }[] = [];
    this.forEach({ left: p.x - tolerance, top: p.y - tolerance, right: p.x + tolerance, bottom: p.y + tolerance }, null, w => {
      const pts = this.wirePoints;
      let nearest = Infinity;
      for (let i = this.wireStart[w]!; i + 3 < this.wireStart[w + 1]!; i += 2) {
        nearest = Math.min(nearest, distanceToSegment(p, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!));
      }
      if (nearest <= tolerance) found.push({ w, d: nearest });
    });
    // Near enough to the same distance is the same: overlapping wires
    // differ by a rounding error, and should cycle in a fixed order.
    return found.sort((a, b) => (Math.abs(a.d - b.d) < 1e-6 ? a.w - b.w : a.d - b.d)).map(f => f.w);
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
    if (area.right < this.bounds.left || area.left > this.bounds.right || area.bottom < this.bounds.top || area.top > this.bounds.bottom) {
      return;
    }
    if (component !== null) {
      const stamp = this.componentStamp;
      const visit = (c: number) => {
        if (stamp[c] !== epoch) {
          stamp[c] = epoch;
          component(c);
        }
      };
      this.componentGrid.fine.visit(area, visit);
      this.componentGrid.coarse.visit(area, visit);
    }
    if (wire !== null) {
      const stamp = this.wireStamp;
      const visit = (w: number) => {
        if (stamp[w] !== epoch) {
          stamp[w] = epoch;
          wire(w);
        }
      };
      this.wireGrid.fine.visit(area, visit);
      this.wireGrid.coarse.visit(area, visit);
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
        for (const n of this.displayNets[c] ?? []) {
          if (n >= 0) nets.add(n);
        }
      },
      w => {
        const net = this.wireNet[w]!;
        if (net >= 0) nets.add(net);
        for (const bit of this.wireBits[w] ?? []) {
          if (bit >= 0) nets.add(bit);
        }
      }
    );
    return [...nets].sort((a, b) => a - b);
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
function changedAreas(before: SceneIndex, after: SceneIndex): Box[] {
  const areas: Box[] = [];
  // What `after` reused from `before` is the same object, stamped with
  // `after`'s build as it was reused, and what it made afresh was born
  // in that build. So what is gone is what `before` has that was not
  // stamped, and what is new is what was born — found without a set of
  // thirty thousand. Only those are compared, by id and by value: a part
  // whose entry is new because its nets were renumbered is drawn the
  // same, and redraws nothing.
  const build = after.build;
  const gone = new Map<string, Placed>();
  for (const place of before.placed) if (place.used !== build) gone.set(place.id, place);
  for (const place of after.placed) {
    if (place.born !== build) continue;
    const was = gone.get(place.id);
    if (was !== undefined) {
      gone.delete(place.id);
      const old = was.entry;
      const entry = place.entry;
      if (old.x === entry.x && old.y === entry.y && old.kind === entry.kind && old.rotation === entry.rotation && old.label === entry.label && old.shape === entry.shape && old.width === entry.width) {
        continue;
      }
      areas.push(was.box);
    }
    areas.push(place.box);
  }
  for (const place of gone.values()) areas.push(place.box);

  const goneRoutes = new Map<string, Route>();
  for (const route of before.routes) if (route.used !== build) goneRoutes.set(route.id, route);
  for (const route of after.routes) {
    if (route.born !== build) continue;
    const was = goneRoutes.get(route.id);
    if (was !== undefined) {
      goneRoutes.delete(route.id);
      if (was.points.length === route.points.length && was.points.every((v, i) => v === route.points[i])) continue;
      areas.push(was.box);
    }
    areas.push(route.box);
  }
  for (const route of goneRoutes.values()) areas.push(route.box);
  // Half a unit of margin: strokes and bubbles reach past their boxes.
  return areas.map(a => ({ left: a.left - 0.5, top: a.top - 0.5, right: a.right + 0.5, bottom: a.bottom + 0.5 }));
}

/** A wire's route, and the ends it was routed between. */
export interface Route {
  readonly id: string;
  readonly from: Placed;
  readonly to: Placed;
  /** x then y. */
  readonly points: readonly number[];
  readonly box: Box;
  /** The build that made it, and the last that used it. */
  readonly born: number;
  used: number;
}

/** A component's entry, and what the scene reads from it that takes working out. */
export interface Placed {
  readonly id: string;
  readonly entry: ComponentGeometry;
  readonly box: Box;
  readonly valueNet: number;
  readonly displayNets: Int32Array | null;
  readonly label: string | null;
  /** The build that made it, and the last that used it. */
  readonly born: number;
  used: number;
}

let builds = 0;
const routeCache = new WeakMap<WireGeometry, Route>();
const placedCache = new WeakMap<ComponentGeometry, Placed>();
const placedDigests = new WeakMap<object, Placed[]>();
const wireDigests = new WeakMap<object, { readonly id: string; readonly wire: WireGeometry; route: Route | null }[]>();

function placeOf(id: string, c: ComponentGeometry, build: number): Placed {
  const busPin = c.kind === 'input' || c.kind === 'constant' ? 'out' : 'in';
  return {
    id,
    entry: c,
    box: boxOf(c.shape ?? c.kind, c.x, c.y, c.rotation),
    valueNet: (c.kind === 'output' || c.kind === 'probe' ? c.nets.in : c.nets.out) ?? -1,
    displayNets:
      c.width > 1 && (c.kind === 'input' || c.kind === 'constant' || c.kind === 'output' || c.kind === 'probe' || c.kind === 'hex')
        ? Int32Array.from({ length: c.width }, (_, i) => c.nets[`${busPin}[${i}]`] ?? -1)
        : c.kind === 'hex' || c.kind === 'seg7'
          ? Int32Array.from(PINS[c.kind].inputs, pin => c.nets[pin] ?? -1)
          : c.kind === 'matrix'
            ? Int32Array.from({ length: MATRIX_WIDTH * MATRIX_HEIGHT }, (_, i) => c.nets[`r${Math.floor(i / MATRIX_WIDTH)}[${i % MATRIX_WIDTH}]`] ?? -1)
            : null,
    label: isGate(c.kind) ? null : (c.label ?? id),
    born: build,
    used: 0
  };
}

/**
 * Items spread over more fine cells than this go in the coarse grid. A
 * wire running the height of the benchmark's RAM crossed a hundred and
 * fifty cells, and twenty thousand wires filled the index with a million
 * entries — half of every rebuild.
 */
const SPREAD = 8;
const COARSE = CELL * 8;

interface Grids {
  readonly fine: Grid;
  readonly coarse: Grid;
}

function grids(bounds: Box, boxes: readonly Box[]): Grids {
  const fine = new Grid(bounds, CELL);
  const coarse = new Grid(bounds, COARSE);
  const wide = new Uint8Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) wide[i] = fine.cellsCovered(boxes[i]!) > SPREAD ? 1 : 0;
  return { fine: fine.fill(boxes, wide, 0), coarse: coarse.fill(boxes, wide, 1) };
}

/** A uniform grid over the scene's bounds: each cell's items, packed. */
class Grid {
  private readonly originX: number;
  private readonly originY: number;
  private readonly cellsX: number;
  private readonly cellsY: number;
  private readonly size: number;
  private start = new Int32Array(1);
  private items = new Int32Array(0);

  constructor(bounds: Box, size: number) {
    this.size = size;
    this.originX = Math.floor(bounds.left / size) * size;
    this.originY = Math.floor(bounds.top / size) * size;
    this.cellsX = Math.max(1, Math.ceil((bounds.right - this.originX) / size) + 1);
    this.cellsY = Math.max(1, Math.ceil((bounds.bottom - this.originY) / size) + 1);
  }

  cellsCovered(box: Box): number {
    return (this.cellY(box.bottom) - this.cellY(box.top) + 1) * (this.cellX(box.right) - this.cellX(box.left) + 1);
  }

  /** Fills the grid with the boxes whose `group` is `take`. */
  fill(boxes: readonly Box[], group: Uint8Array, take: number): this {
    // Each box's cells, worked out once for both passes.
    const range = new Int32Array(boxes.length * 4);
    const counts = new Int32Array(this.cellsX * this.cellsY + 1);
    for (let n = 0; n < boxes.length; n++) {
      if (group[n] !== take) continue;
      const box = boxes[n]!;
      const x0 = this.cellX(box.left);
      const x1 = this.cellX(box.right);
      const y0 = this.cellY(box.top);
      const y1 = this.cellY(box.bottom);
      range[n * 4] = x0;
      range[n * 4 + 1] = x1;
      range[n * 4 + 2] = y0;
      range[n * 4 + 3] = y1;
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) counts[cy * this.cellsX + cx + 1]!++;
    }
    for (let i = 1; i < counts.length; i++) counts[i]! += counts[i - 1]!;
    const fill = counts.slice(0, -1);
    const items = new Int32Array(counts[counts.length - 1]!);
    for (let n = 0; n < boxes.length; n++) {
      if (group[n] !== take) continue;
      const x0 = range[n * 4]!;
      const x1 = range[n * 4 + 1]!;
      for (let cy = range[n * 4 + 2]!, y1 = range[n * 4 + 3]!; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) items[fill[cy * this.cellsX + cx]!++] = n;
      }
    }
    this.start = counts;
    this.items = items;
    return this;
  }

  /** Each item in a cell the area covers; an item in several, once a cell. */
  visit(area: Box, each: (index: number) => void): void {
    if (this.items.length === 0) return;
    const x0 = this.cellX(area.left);
    const x1 = this.cellX(area.right);
    for (let cy = this.cellY(area.top), y1 = this.cellY(area.bottom); cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = cy * this.cellsX + cx;
        for (let i = this.start[cell]!; i < this.start[cell + 1]!; i++) each(this.items[i]!);
      }
    }
  }

  private cellX(x: number): number {
    return Math.min(this.cellsX - 1, Math.max(0, Math.floor((x - this.originX) / this.size)));
  }

  private cellY(y: number): number {
    return Math.min(this.cellsY - 1, Math.max(0, Math.floor((y - this.originY) / this.size)));
  }
}
