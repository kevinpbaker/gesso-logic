import type { Kind } from '../sim/Primitives';

/**
 * Where things are: component boxes, pin positions and wire routes, in
 * grid units.
 *
 * Pure and shared, because both workers need the same answers. The
 * application worker needs extents, to publish the signals a viewport
 * can see. The render worker needs them to draw. A difference between
 * the two would be a wire drawn in a place whose value was never sent.
 *
 * Every pin sits on a grid point, so Phase 4 can snap wires to pins by
 * rounding. A component's `x` and `y` are its box's top-left corner.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface KindLayout {
  readonly width: number;
  readonly height: number;
  /** Each pin's offset from the component's origin. */
  readonly pins: Readonly<Record<string, Point>>;
}

const GATE: KindLayout = { width: 4, height: 4, pins: { a: { x: 0, y: 1 }, b: { x: 0, y: 3 }, out: { x: 4, y: 2 } } };
const SOURCE: KindLayout = { width: 2, height: 2, pins: { out: { x: 2, y: 1 } } };

export const LAYOUT: Readonly<Record<Kind, KindLayout>> = {
  not: { width: 4, height: 4, pins: { a: { x: 0, y: 2 }, out: { x: 4, y: 2 } } },
  and: GATE,
  or: GATE,
  nand: GATE,
  nor: GATE,
  xor: GATE,
  xnor: GATE,
  input: SOURCE,
  clock: SOURCE,
  constant: SOURCE,
  output: { width: 2, height: 2, pins: { in: { x: 0, y: 1 } } }
};

export function boxOf(kind: Kind, x: number, y: number): Box {
  const layout = LAYOUT[kind];
  return { left: x, top: y, right: x + layout.width, bottom: y + layout.height };
}

export function pinAt(kind: Kind, x: number, y: number, pin: string): Point {
  const offset = LAYOUT[kind].pins[pin] ?? { x: 0, y: 0 };
  return { x: x + offset.x, y: y + offset.y };
}

/**
 * An orthogonal route from a driver's pin to a reader's, as corner
 * points including both ends.
 *
 * Forward — the reader to the right — it is three segments: across, down
 * or up in the channel just left of the reader, across. The vertical run
 * steps half a unit further left per `slot`, so the two wires into one
 * gate do not run on top of each other. Backward — feedback, a latch —
 * it leaves right, drops below both pins, runs back and climbs in. Real
 * routing, around other components, is Phase 4's; this only has to be
 * the same in both workers and readable.
 */
export function route(from: Point, to: Point, slot = 0): Point[] {
  if (to.x >= from.x + 1) {
    const channel = Math.max(from.x + 0.5, to.x - 1 - slot * 0.5);
    if (from.y === to.y) {
      return [from, to];
    }
    return [from, { x: channel, y: from.y }, { x: channel, y: to.y }, to];
  }
  const below = Math.max(from.y, to.y) + 3 + slot * 0.5;
  const out = from.x + 1 + slot * 0.5;
  const back = to.x - 1 - slot * 0.5;
  return [from, { x: out, y: from.y }, { x: out, y: below }, { x: back, y: below }, { x: back, y: to.y }, to];
}

/** Which vertical channel a reader pin's wire runs in; see `route`. */
export function slotOf(pin: string): number {
  return pin === 'b' ? 1 : 0;
}

export function boundsOf(points: readonly Point[]): Box {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { x, y } of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { left, top, right, bottom };
}

export function intersects(a: Box, b: Box): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}
