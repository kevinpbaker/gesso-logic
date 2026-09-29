import type { Circuit, Component, Rotation } from '../sim/Circuit';
import { pinsOf } from '../sim/Chips';
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

export interface KindLayout {
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
  button: SOURCE,
  output: { width: 2, height: 2, pins: { in: { x: 0, y: 1 } } },
  probe: { width: 2, height: 2, pins: { in: { x: 0, y: 1 } } },
  hex: { width: 4, height: 6, pins: { b0: { x: 0, y: 1 }, b1: { x: 0, y: 2 }, b2: { x: 0, y: 3 }, b3: { x: 0, y: 4 } } },
  // A placeholder: a chip's real shape comes from its definition, by
  // `chipShape`, and is passed to these functions in place of the kind.
  chip: { width: 6, height: 4, pins: {} },
  // Placeholders too: a split's or join's shape depends on its width; see `busShape`.
  split: { width: 2, height: 9, pins: { in: { x: 0, y: 1 } } },
  join: { width: 2, height: 9, pins: { out: { x: 2, y: 1 } } },
  // The ROM: an instruction port and a table port, each an address in
  // on the left and its word out on the right.
  rom: { width: 8, height: 6, pins: { A: { x: 0, y: 1 }, T: { x: 0, y: 3 }, D: { x: 8, y: 1 }, Q: { x: 8, y: 3 } } },
  seg7: {
    width: 5,
    height: 8,
    pins: {
      a: { x: 0, y: 1 },
      b: { x: 0, y: 2 },
      c: { x: 0, y: 3 },
      d: { x: 0, y: 4 },
      e: { x: 0, y: 5 },
      f: { x: 0, y: 6 },
      g: { x: 0, y: 7 }
    }
  }
};

/** A component's size once turned: a quarter turn swaps width and height. */
/**
 * What these functions take to know a part's size and pins: its kind, or
 * for a chip the shape its definition gives it.
 */
export type Shape = Kind | KindLayout;

function layoutOf(shape: Shape): KindLayout {
  return typeof shape === 'string' ? LAYOUT[shape] : shape;
}

/**
 * A chip's body, from its interface: inputs down the left and outputs
 * down the right, two units apart and starting a unit down, as a gate's
 * are; wide enough for its name. Pins sit on grid points, so a chip
 * wires up like any part.
 */
export function chipShape(name: string, inputs: readonly string[], outputs: readonly string[]): KindLayout {
  const rows = Math.max(inputs.length, outputs.length, 1);
  const width = Math.max(6, Math.ceil(name.length * 0.7) + 2);
  const pins: Record<string, Point> = {};
  inputs.forEach((pin, i) => (pins[pin] = { x: 0, y: 1 + 2 * i }));
  outputs.forEach((pin, i) => (pins[pin] = { x: width, y: 1 + 2 * i }));
  return { width, height: Math.max(4, rows * 2), pins };
}

/**
 * A split's or join's body: two units wide, the bus pin a unit down one
 * side and a bit a unit apart down the other, least significant at the
 * top.
 */
export function busShape(kind: 'split' | 'join', bits: readonly string[]): KindLayout {
  const pins: Record<string, Point> = {};
  bits.forEach((bit, i) => (pins[bit] = { x: kind === 'split' ? 2 : 0, y: 1 + i }));
  pins[kind === 'split' ? 'in' : 'out'] = { x: kind === 'split' ? 0 : 2, y: 1 };
  return { width: 2, height: bits.length + 1, pins };
}

/**
 * A component's shape: its kind's, or one its width or definition
 * decides — a chip's body, a split's or join's, a hex display with as
 * many digits as its bus needs, and switches, constants, LEDs and probes
 * wide enough to write a bus's value in.
 */
export function shapeOf(component: Component, chips: Circuit['chips']): Shape {
  const width = component.width ?? 1;
  switch (component.kind) {
    case 'chip': {
      const pins = pinsOf(component, chips);
      return chipShape(component.chip ?? '?', pins.inputs, pins.outputs);
    }
    case 'split':
      return busShape('split', pinsOf(component, chips).outputs);
    case 'join':
      return busShape('join', pinsOf(component, chips).inputs);
    case 'input':
    case 'constant':
      return width > 1 ? { width: 4, height: 2, pins: { out: { x: 4, y: 1 } } } : component.kind;
    case 'output':
    case 'probe':
      return width > 1 ? { width: 4, height: 2, pins: { in: { x: 0, y: 1 } } } : component.kind;
    case 'hex': {
      if (component.width === undefined) return 'hex';
      const digits = Math.max(1, Math.ceil(width / 4));
      return { width: 2 + 2 * digits, height: 6, pins: { in: { x: 0, y: 3 } } };
    }
    default:
      return component.kind;
  }
}

export function sizeOf(shape: Shape, rotation: Rotation = 0): { width: number; height: number } {
  const layout = layoutOf(shape);
  return rotation === 90 || rotation === 270
    ? { width: layout.height, height: layout.width }
    : { width: layout.width, height: layout.height };
}

/** A component's box. `x` and `y` are the turned box's top-left corner, whatever the rotation. */
export function boxOf(shape: Shape, x: number, y: number, rotation: Rotation = 0): Box {
  const size = sizeOf(shape, rotation);
  return { left: x, top: y, right: x + size.width, bottom: y + size.height };
}

/**
 * Where a pin is, with the component turned clockwise about its box.
 * Pins stay on grid points under every rotation, because every box has
 * whole-number sides.
 */
export function pinAt(shape: Shape, x: number, y: number, pin: string, rotation: Rotation = 0): Point {
  const layout = layoutOf(shape);
  const offset = layout.pins[pin] ?? { x: 0, y: 0 };
  const turned = turn(offset, layout.width, layout.height, rotation);
  return { x: x + turned.x, y: y + turned.y };
}

/** A point in a `width` × `height` box, turned clockwise about the box so the result is in the turned box. */
export function turn(p: Point, width: number, height: number, rotation: Rotation): Point {
  switch (rotation) {
    case 90:
      return { x: height - p.y, y: p.x };
    case 180:
      return { x: width - p.x, y: height - p.y };
    case 270:
      return { x: p.y, y: width - p.x };
    default:
      return p;
  }
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
