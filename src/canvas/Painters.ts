import type { PaintSurface } from 'gesso-core';

import type { Box } from '../app/Layout';
import { signalOf } from '../app/SignalPacking';
import type { SceneIndex } from './SceneIndex';

/**
 * Drawing a rectangle of the circuit onto a `PaintSurface`, in grid
 * units, as the three layers of a tile.
 *
 *   - **under** — below full detail, the dot grid and the wires,
 *     unlit, and at the gates level the gate symbols too. Changes on an
 *     edit.
 *   - **live** — whatever shows a value: wires in their colours, the
 *     insides of switches and LEDs, the gates' lit cores, and at the
 *     blocks level the gates themselves. Changes whenever a chunk it
 *     reads changes.
 *   - **over** — at full detail only, the grid and the gate symbols
 *     over the lit wires. Changes on an edit.
 *
 * At most two of the three draw anything at a given level, and an empty
 * layer costs nothing. That matters in software rendering, where the
 * renderer blits every layer's bitmap back onto the canvas every frame:
 * Phase 3's trace found compositing alone past a frame's budget at mid
 * zoom, with nothing changing, when every tile had three.
 *
 * Phase 0 measured why: recording is cheap and rasterising is not, and
 * a layer whose inputs did not change is not rasterised at all. So what
 * changes every frame is kept apart from what changes on an edit.
 *
 * Every stroke is batched by colour: a tile of a thousand wires is three
 * strokes, not a thousand.
 */

/**
 * Three levels of detail, by pixels per grid unit.
 *
 *   - **blocks**, below 2.5: a gate is under ten pixels wide, its symbol
 *     is not readable, and a wire is a pixel. Gates are blocks filled by
 *     their output; wires are drawn once, unlit. Phase 0's level, which
 *     took fit-all from 46 ms to 8.3 ms.
 *   - **gates**, from 2.5 to 6: symbols are readable and wires are still
 *     thin. The live value moves onto the gate — a lit core inside its
 *     body — and wires stay unlit in the static layer. Phase 3's
 *     bench found full detail here cost 18–20 ms in software rendering,
 *     almost all of it re-stroking four thousand wires every frame;
 *     filling two thousand gate bodies is the same information for the
 *     cost of a fill.
 *   - **full**, from 6: wires carry their colour.
 */
export const BLOCKS_BELOW = 2.5;
export const WIRES_FROM = 6;

export type Detail = 'blocks' | 'gates' | 'full';

export function detailAt(scale: number): Detail {
  return scale < BLOCKS_BELOW ? 'blocks' : scale < WIRES_FROM ? 'gates' : 'full';
}
/** At or above this, switches and LEDs carry their labels. */
const LABELS_FROM = 10;

/** Milliseconds spent inside the painters since the last read: the recording half of the render phase. */
export const paintTiming = { recordMs: 0 };


export function paintUnder(surface: PaintSurface, scene: SceneIndex, area: Box, scale: number): void {
  const detail = detailAt(scale);
  // At full detail this layer is empty, and an empty layer makes no
  // bitmap and costs no composite: the grid moves to the over layer.
  if (detail === 'full') {
    return;
  }
  const started = performance.now();
  drawGrid(surface, area, scale);
  surface.lineWidth(Math.min(1.5, scale / 2) / scale);
  surface.beginPath();
  scene.forEach(area, null, w => traceWire(surface, scene, w));
  surface.strokeColor('border');
  surface.stroke();
  if (detail === 'gates') {
    // The gates themselves, filled and outlined once here rather than in
    // a layer of their own: the live layer's lit cores sit inside the
    // bodies and never touch an outline, so nothing has to be drawn over
    // them.
    drawSymbols(surface, scene, area, scale);
  }
  paintTiming.recordMs += performance.now() - started;
}

export function paintLive(
  surface: PaintSurface,
  scene: SceneIndex,
  area: Box,
  scale: number,
  chunks: Readonly<Record<string, string>>
): void {
  const started = performance.now();
  const high: number[] = [];
  const low: number[] = [];
  const unknown: number[] = [];
  const sort = (net: number, item: number) => {
    const value = net < 0 ? -1 : signalOf(chunks, net);
    (value === 1 ? high : value === 0 ? low : unknown).push(item);
  };

  const detail = detailAt(scale);
  if (detail === 'gates') {
    // Each gate shows its output as a lit core: a rectangle inset inside
    // its symbol, which the over layer outlines. A rectangle rather than
    // the curved body, because this layer is rasterised every frame and
    // a CPU fills a rectangle far faster than a curve — Phase 3's bench
    // had mid zoom at 25 ms a frame in software rendering filling two
    // thousand curved bodies. Low is left unfilled; unknown is marked.
    scene.forEach(area, c => sort(scene.valueNet[c]!, c), null);
    for (const [items, color] of [
      [unknown, 'placeholder'],
      [high, 'primary']
    ] as const) {
      if (items.length === 0) continue;
      surface.beginPath();
      for (const c of items) {
        if (scene.isGate(c)) {
          // Inside every symbol: clear of an XOR's second curve, a NOR's
          // pointed front and a NOT's narrowing triangle.
          turned(surface, scene, c, (x, y) => {
            if (scene.kind[c] === 0) {
              surface.rect(x + 0.9, y + 1.6, 1.0, 0.8);
            } else {
              surface.rect(x + 1.4, y + 1.3, 1.0, 1.4);
            }
          });
        } else {
          surface.roundRect(scene.x[c]! + 0.2, scene.y[c]! + 0.2, scene.width(c) - 0.4, scene.height(c) - 0.4, 0.3);
        }
      }
      surface.fillColor(color);
      surface.fill();
    }
    paintTiming.recordMs += performance.now() - started;
    return;
  }
  if (detail === 'blocks') {
    // Every component as a block filled by the value it shows.
    scene.forEach(area, c => sort(scene.valueNet[c]!, c), null);
    for (const [items, color] of [
      [low, 'textMuted'],
      [unknown, 'placeholder'],
      [high, 'primary']
    ] as const) {
      if (items.length === 0) continue;
      surface.beginPath();
      for (const c of items) {
        surface.rect(scene.x[c]!, scene.y[c]!, scene.width(c), scene.height(c));
      }
      surface.fillColor(color);
      surface.fill();
    }
    paintTiming.recordMs += performance.now() - started;
    return;
  }

  scene.forEach(area, null, w => sort(scene.wireNet[w]!, w));
  const width = 1.5 / scale;
  for (const [items, color, thickness] of [
    [low, 'border', width],
    [unknown, 'placeholder', width],
    [high, 'primary', width * 1.5]
  ] as const) {
    if (items.length === 0) continue;
    surface.lineWidth(thickness);
    surface.beginPath();
    for (const w of items) {
      traceWire(surface, scene, w);
    }
    surface.strokeColor(color);
    surface.stroke();
  }

  // The insides of switches, clocks, constants and LEDs.
  high.length = 0;
  low.length = 0;
  unknown.length = 0;
  scene.forEach(
    area,
    c => {
      if (!scene.isGate(c)) sort(scene.valueNet[c]!, c);
    },
    null
  );
  for (const [items, color] of [
    [low, 'controlBackground'],
    [unknown, 'placeholder'],
    [high, 'primary']
  ] as const) {
    if (items.length === 0) continue;
    surface.beginPath();
    for (const c of items) {
      surface.roundRect(scene.x[c]! + 0.2, scene.y[c]! + 0.2, scene.width(c) - 0.4, scene.height(c) - 0.4, 0.3);
    }
    surface.fillColor(color);
    surface.fill();
  }
  paintTiming.recordMs += performance.now() - started;
}

export function paintOver(surface: PaintSurface, scene: SceneIndex, area: Box, scale: number): void {
  // Only full detail draws over the live layer: wires there run under
  // gate symbols, and cross the bodies of gates between their ends.
  if (detailAt(scale) !== 'full') {
    return;
  }
  const started = performance.now();
  // The grid first. It belongs under the wires, but a layer of its own
  // under them would be a whole tile composited every frame for a
  // scatter of dots, and a 1.2 px dot over a wire does not show.
  drawGrid(surface, area, scale);
  drawSymbols(surface, scene, area, scale);
  paintTiming.recordMs += performance.now() - started;
}

/** Dots every unit when that is at least twelve pixels, every four units when that is, and none below. */
function drawGrid(surface: PaintSurface, area: Box, scale: number): void {
  const spacing = scale >= 12 ? 1 : scale * 4 >= 12 ? 4 : 0;
  if (spacing === 0) {
    return;
  }
  const size = 1.2 / scale;
  surface.beginPath();
  for (let y = Math.ceil(area.top / spacing) * spacing; y <= area.bottom; y += spacing) {
    for (let x = Math.ceil(area.left / spacing) * spacing; x <= area.right; x += spacing) {
      surface.rect(x - size / 2, y - size / 2, size, size);
    }
  }
  surface.fillColor('border');
  surface.fill();
}

/** Gate symbols, filled and outlined, and the outlines and labels of everything else. */
function drawSymbols(surface: PaintSurface, scene: SceneIndex, area: Box, scale: number): void {
  const gates: number[] = [];
  const others: number[] = [];
  scene.forEach(area, c => (scene.isGate(c) ? gates : others).push(c), null);

  surface.beginPath();
  for (const g of gates) {
    turned(surface, scene, g, (x, y) => traceGateBody(surface, scene.kind[g]!, x, y));
  }
  surface.fillColor('surface');
  surface.fill();
  surface.strokeColor('text');
  surface.lineWidth(1.2 / scale);
  surface.stroke();

  // Pin stubs and the XOR's second curve: lines, never filled.
  surface.beginPath();
  for (const g of gates) {
    turned(surface, scene, g, (x, y) => traceGateLines(surface, scene.kind[g]!, x, y));
  }
  surface.stroke();

  // Outlines of switches and LEDs, whose insides the live layer fills.
  if (others.length > 0) {
    surface.beginPath();
    for (const c of others) {
      surface.roundRect(scene.x[c]!, scene.y[c]!, scene.width(c), scene.height(c), 0.4);
    }
    surface.stroke();
    if (scale >= LABELS_FROM) {
      surface.fillColor('text');
      const style = { fontSize: 0.7, align: 'center' as const };
      for (const c of others) {
        const label = scene.labels[c];
        if (label !== null && label !== undefined) {
          surface.text(label, scene.x[c]! + scene.width(c) / 2, scene.y[c]! - 0.3, style);
        }
      }
    }
  }
}

/**
 * Draws a component's unturned shape so it lands turned in place.
 *
 * `trace` is given the corner to draw the unturned shape from. For a
 * component that is not turned that is simply its position, with no
 * transform at all, which keeps the common case — every gate in the
 * bench scene — as cheap as it was. For one that is, the surface is
 * turned about the component's box and the shape is drawn from the
 * origin. A canvas applies the transform as each point is added to the
 * path, so turned and unturned shapes share one path and one fill.
 */
export function turned(surface: PaintSurface, scene: SceneIndex, c: number, trace: (x: number, y: number) => void): void {
  const turns = scene.turns[c]!;
  if (turns === 0) {
    trace(scene.x[c]!, scene.y[c]!);
    return;
  }
  const width = scene.width(c);
  const height = scene.height(c);
  // The unturned box: a quarter turn had swapped its sides.
  const across = turns % 2 === 1 ? height : width;
  const down = turns % 2 === 1 ? width : height;
  surface.save();
  surface.translate(scene.x[c]! + width / 2, scene.y[c]! + height / 2);
  surface.rotate((turns * Math.PI) / 2);
  surface.translate(-across / 2, -down / 2);
  trace(0, 0);
  surface.restore();
}

function traceWire(surface: PaintSurface, scene: SceneIndex, w: number): void {
  const start = scene.wireStart[w]!;
  const end = scene.wireStart[w + 1]!;
  const p = scene.wirePoints;
  surface.moveTo(p[start]!, p[start + 1]!);
  for (let i = start + 2; i < end; i += 2) {
    surface.lineTo(p[i]!, p[i + 1]!);
  }
}

// Gate kinds by their index in `GATE_KINDS`.
const NOT = 0;
const AND = 1;
const OR = 2;
const NAND = 3;
const NOR = 4;
const XOR = 5;
const XNOR = 6;

/**
 * A gate's body in the standard (ANSI) shapes, in its 4 × 4 box: inputs
 * enter at the left edge, the output leaves at (4, 2). A gate with an
 * inverted output ends its body short and adds the bubble.
 */
function traceGateBody(surface: PaintSurface, kind: number, x: number, y: number): void {
  const bubbled = kind === NOT || kind === NAND || kind === NOR || kind === XNOR;
  const end = bubbled ? 3.3 : 3.6;
  if (kind === NOT) {
    surface.moveTo(x + 0.6, y + 0.8);
    surface.lineTo(x + end, y + 2);
    surface.lineTo(x + 0.6, y + 3.2);
    surface.closePath();
  } else if (kind === AND || kind === NAND) {
    const r = 1.4;
    surface.moveTo(x + 0.6, y + 0.6);
    surface.lineTo(x + end - r, y + 0.6);
    surface.arc(x + end - r, y + 2, r, -Math.PI / 2, Math.PI / 2);
    surface.lineTo(x + 0.6, y + 3.4);
    surface.closePath();
  } else {
    // OR, NOR, XOR, XNOR: a concave back and a pointed front.
    const back = kind === XOR || kind === XNOR ? 0.95 : 0.6;
    surface.moveTo(x + back, y + 0.6);
    surface.quadraticCurveTo(x + end - 1, y + 0.6, x + end, y + 2);
    surface.quadraticCurveTo(x + end - 1, y + 3.4, x + back, y + 3.4);
    surface.quadraticCurveTo(x + back + 0.8, y + 2, x + back, y + 0.6);
    surface.closePath();
  }
  if (bubbled) {
    surface.moveTo(x + 4, y + 2);
    surface.arc(x + 3.65, y + 2, 0.35, 0, Math.PI * 2);
    surface.closePath();
  }
}

function traceGateLines(surface: PaintSurface, kind: number, x: number, y: number): void {
  const inputs = kind === NOT ? [2] : [1, 3];
  const curved = kind === OR || kind === NOR || kind === XOR || kind === XNOR;
  for (const at of inputs) {
    surface.moveTo(x, y + at);
    // An OR's back is curved, so its stubs reach a little further in.
    surface.lineTo(x + (curved ? 0.85 + (kind === XOR || kind === XNOR ? 0.35 : 0) : 0.6), y + at);
  }
  if (kind === XOR || kind === XNOR) {
    surface.moveTo(x + 0.55, y + 0.6);
    surface.quadraticCurveTo(x + 1.35, y + 2, x + 0.55, y + 3.4);
  }
  if (kind === AND || kind === OR || kind === XOR) {
    surface.moveTo(x + 3.6, y + 2);
    surface.lineTo(x + 4, y + 2);
  }
}
