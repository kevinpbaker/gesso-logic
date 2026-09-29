import type { PaintSurface } from 'gesso-core';

import type { Box } from '../app/Layout';
import { signalOf } from '../app/SignalPacking';
import type { SceneIndex } from './SceneIndex';

/**
 * Drawing a rectangle of the circuit onto a `PaintSurface`, in grid
 * units, as the three layers of a tile.
 *
 *   - **under** — the dot grid, and at the blocks level of detail the
 *     wires, unlit. Changes on an edit.
 *   - **live** — whatever shows a value: wires in their colours, the
 *     insides of switches and LEDs, and at the blocks level the gates
 *     themselves. Changes whenever a chunk it reads changes.
 *   - **over** — gate symbols and the outlines of everything else.
 *     Changes on an edit.
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
 *     thin. The live value moves onto the gate — its body is filled by
 *     its output — and wires stay unlit in the static layer. Phase 3's
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
  const started = performance.now();
  // Dots every unit when that is at least twelve pixels, every four
  // units when that is, and none below.
  const spacing = scale >= 12 ? 1 : scale * 4 >= 12 ? 4 : 0;
  if (spacing > 0) {
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
  if (detailAt(scale) !== 'full') {
    surface.lineWidth(Math.min(1.5, scale / 2) / scale);
    surface.beginPath();
    scene.forEach(area, null, w => traceWire(surface, scene, w));
    surface.strokeColor('border');
    surface.stroke();
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
    // Gate bodies filled by their output, switches and LEDs by theirs.
    scene.forEach(area, c => sort(scene.valueNet[c]!, c), null);
    for (const [items, color] of [
      [low, 'surface'],
      [unknown, 'placeholder'],
      [high, 'primary']
    ] as const) {
      if (items.length === 0) continue;
      surface.beginPath();
      for (const c of items) {
        if (scene.isGate(c)) {
          traceGateBody(surface, scene.kind[c]!, scene.x[c]!, scene.y[c]!);
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
  const detail = detailAt(scale);
  if (detail === 'blocks') {
    return;
  }
  const started = performance.now();
  const gates: number[] = [];
  const others: number[] = [];
  scene.forEach(area, c => (scene.isGate(c) ? gates : others).push(c), null);

  // Bodies: one path, outlined — and filled only at full detail, because
  // at the gates level the live layer beneath fills them with their value.
  surface.beginPath();
  for (const g of gates) {
    traceGateBody(surface, scene.kind[g]!, scene.x[g]!, scene.y[g]!);
  }
  if (detail === 'full') {
    surface.fillColor('surface');
    surface.fill();
  }
  surface.strokeColor('text');
  surface.lineWidth(1.2 / scale);
  surface.stroke();

  // Pin stubs and the XOR's second curve: lines, never filled.
  surface.beginPath();
  for (const g of gates) {
    traceGateLines(surface, scene.kind[g]!, scene.x[g]!, scene.y[g]!);
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
  paintTiming.recordMs += performance.now() - started;
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
