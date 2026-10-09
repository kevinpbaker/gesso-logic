import type { PaintSurface } from 'gesso-core';

import { NOTE_FONT, NOTE_LINE, type Box } from '../app/Layout';
import { signalOf } from '../app/SignalPacking';
import { MATRIX_WIDTH } from '../sim/Primitives';
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
/** Parts that show no one value of their own: chips, ROMs, and a bus's splits and joins. */
const WIRING: ReadonlySet<string> = new Set(['chip', 'split', 'join', 'rom', 'tunnel', 'note']);

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
  const thin = Math.min(1.5, scale / 2) / scale;
  const buses: number[] = [];
  surface.lineWidth(thin);
  surface.beginPath();
  scene.forEach(area, null, w => (scene.wireWidth[w]! > 1 ? buses.push(w) : traceWire(surface, scene, w)));
  surface.strokeColor('border');
  surface.stroke();
  if (buses.length > 0) {
    surface.lineWidth(thin * BUS_THICKNESS);
    surface.beginPath();
    for (const w of buses) traceWire(surface, scene, w);
    surface.stroke();
    if (detail === 'gates') drawBusMarks(surface, scene, buses, scale);
  }
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
    const displays: number[] = [];
    scene.forEach(
      area,
      c => {
        if (scene.displayNets[c] !== null) displays.push(c);
        else if (!WIRING.has(scene.kindOf(c))) sort(scene.valueNet[c]!, c);
      },
      null
    );
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
          traceInside(surface, scene, c);
        }
      }
      surface.fillColor(color);
      surface.fill();
    }
    drawDisplays(surface, scene, displays, chunks, scale);
    paintTiming.recordMs += performance.now() - started;
    return;
  }
  if (detail === 'blocks') {
    // Every component as a block filled by the value it shows; a chip,
    // which shows no one value, as a block of its own colour.
    // A note is words, and at this size there are none to read.
    scene.forEach(area, c => (scene.kindOf(c) === 'note' ? undefined : WIRING.has(scene.kindOf(c)) ? low.push(c) : sort(scene.valueNet[c]!, c)), null);
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

  const buses: number[] = [];
  scene.forEach(area, null, w => (scene.wireWidth[w]! > 1 ? buses.push(w) : sort(scene.wireNet[w]!, w)));
  const width = 1.5 / scale;
  // A bus is lit while its value is not zero, and unknown until every
  // bit of it has arrived.
  const busGroups: [number[], number[], number[]] = [[], [], []];
  for (const w of buses) {
    const value = busValue(scene.wireBits[w]!, chunks);
    busGroups[value === null ? 1 : value === 0 ? 0 : 2].push(w);
  }
  for (const [items, color] of [
    [busGroups[0], 'border'],
    [busGroups[1], 'placeholder'],
    [busGroups[2], 'primary']
  ] as const) {
    if (items.length === 0) continue;
    surface.lineWidth(width * BUS_THICKNESS);
    surface.beginPath();
    for (const w of items) traceWire(surface, scene, w);
    surface.strokeColor(color);
    surface.stroke();
  }
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

  // The insides of switches, buttons, clocks, constants, LEDs and probes.
  high.length = 0;
  low.length = 0;
  unknown.length = 0;
  const displays: number[] = [];
  scene.forEach(
    area,
    c => {
      if (scene.displayNets[c] !== null) displays.push(c);
      else if (!scene.isGate(c) && !WIRING.has(scene.kindOf(c))) sort(scene.valueNet[c]!, c);
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
      traceInside(surface, scene, c);
    }
    surface.fillColor(color);
    surface.fill();
  }
  drawDisplays(surface, scene, displays, chunks, scale);
  if (scale >= LABELS_FROM) {
    // A probe says its value in so many words, on top of its colour.
    const style = { fontSize: 1.3, align: 'center' as const, fontWeight: 600 };
    for (const [items, text, color] of [
      [low, '0', 'text'],
      [high, '1', 'surface'],
      [unknown, '?', 'text']
    ] as const) {
      for (const c of items) {
        if (scene.kindOf(c) !== 'probe') continue;
        surface.fillColor(color);
        surface.text(text, scene.x[c]! + scene.width(c) / 2, scene.y[c]! + scene.height(c) / 2 + 0.45, style);
      }
    }
  }
  paintTiming.recordMs += performance.now() - started;
}

/** The part of a switch, button, clock, LED or probe that shows its value: a push button's is round. */
function traceInside(surface: PaintSurface, scene: SceneIndex, c: number): void {
  const x = scene.x[c]!;
  const y = scene.y[c]!;
  const width = scene.width(c);
  const height = scene.height(c);
  if (scene.kindOf(c) === 'button') {
    const r = Math.min(width, height) / 2 - 0.3;
    surface.moveTo(x + width / 2 + r, y + height / 2);
    surface.arc(x + width / 2, y + height / 2, r, 0, Math.PI * 2);
    surface.closePath();
  } else {
    surface.roundRect(x + 0.2, y + 0.2, width - 0.4, height - 0.4, 0.3);
  }
}

/**
 * Segments of a seven-segment display in its unturned 5 × 8 box, as
 * rectangles `[x, y, width, height]`, in pin order: a across the top,
 * then clockwise, g across the middle.
 */
const T = 0.55;
const L = 1.5;
const R = 4.3;
const TOP = 1;
const MID = 4;
const BOTTOM = 7;
const G = 0.25;
const SEGMENTS: readonly (readonly [number, number, number, number])[] = [
  [L + G, TOP, R - L - 2 * G, T], // a
  [R - T, TOP + G, T, MID - TOP - G], // b
  [R - T, MID + G / 2, T, BOTTOM - MID - G / 2], // c
  [L + G, BOTTOM - T, R - L - 2 * G, T], // d
  [L, MID + G / 2, T, BOTTOM - MID - G / 2], // e
  [L, TOP + G, T, MID - TOP - G], // f
  [L + G, MID - T / 2, R - L - 2 * G, T] // g
];

/**
 * Hex and seven-segment displays, which read several nets rather than
 * one. Drawn in the live layer at every level but blocks, because a
 * display's whole point is to be read from across the room: a 5 × 8
 * display is twenty pixels tall at the gates level, and legible.
 */
function drawDisplays(
  surface: PaintSurface,
  scene: SceneIndex,
  displays: readonly number[],
  chunks: Readonly<Record<string, string>>,
  scale: number
): void {
  if (displays.length === 0) return;
  const valueOf = (net: number) => (net < 0 ? -1 : signalOf(chunks, net));
  const lit: [number, number][] = [];
  const dark: [number, number][] = [];
  for (const c of displays) {
    const nets = scene.displayNets[c]!;
    if (scene.kindOf(c) === 'seg7' || scene.kindOf(c) === 'matrix') {
      nets.forEach((net, s) => (valueOf(net) === 1 ? lit : dark).push([c, s]));
    }
  }
  for (const [items, color] of [
    [dark, 'controlBackground'],
    [lit, 'primary']
  ] as const) {
    if (items.length === 0) continue;
    surface.beginPath();
    for (const [c, s] of items) {
      turned(surface, scene, c, (x, y) => {
        if (scene.kindOf(c) === 'matrix') {
          // A pixel a unit, inset a little so neighbours read as dots.
          surface.rect(x + 1.1 + (s % MATRIX_WIDTH), y + 1.1 + Math.floor(s / MATRIX_WIDTH), 0.8, 0.8);
          return;
        }
        const [sx, sy, w, h] = SEGMENTS[s]!;
        surface.rect(x + sx, y + sy, w, h);
      });
    }
    surface.fillColor(color);
    surface.fill();
  }
  // A hex display's digits, and a wide part's value, in hex. Text is
  // not worth drawing below a few pixels a unit, where a digit would be a
  // smudge; the face stays blank.
  if (scale < BLOCKS_BELOW) return;
  const digitStyle = { fontSize: 3.6, align: 'center' as const, fontWeight: 700, fontFamily: 'monospace' };
  const valueStyle = { fontSize: 1.1, align: 'center' as const, fontWeight: 700, fontFamily: 'monospace' };
  for (const c of displays) {
    const kind = scene.kindOf(c);
    if (kind === 'seg7' || kind === 'matrix') continue;
    const nets = scene.displayNets[c]!;
    const value = busValue(nets, chunks);
    const text = busHex(value, nets.length);
    surface.fillColor(kind === 'hex' || (value ?? 0) !== 0 ? 'primary' : 'text');
    turned(surface, scene, c, (x, y) => {
      if (kind === 'hex') {
        const width = scene.turns[c]! % 2 === 1 ? scene.height(c) : scene.width(c);
        surface.text(text, x + 0.4 + (width - 0.4) / 2, y + 4.3, digitStyle);
      } else {
        const turnedWidth = scene.turns[c]! % 2 === 1 ? scene.height(c) : scene.width(c);
        const turnedHeight = scene.turns[c]! % 2 === 1 ? scene.width(c) : scene.height(c);
        // A wide value fits its box: past four digits it takes two rows,
        // and the type shrinks until a row fits. A 32-bit bus is eight
        // digits, and at the size of two they ran out of the box.
        const rows = valueRows(text);
        const fontSize = Math.min(valueStyle.fontSize, (turnedWidth - 0.4) / (Math.max(...rows.map(r => r.length)) * MONO_ADVANCE), (turnedHeight - 0.3) / (rows.length * 1.1));
        rows.forEach((row, i) => {
          const middle = turnedHeight / 2 + (i - (rows.length - 1) / 2) * fontSize * 1.1;
          surface.text(row, x + turnedWidth / 2, y + middle + 0.36 * fontSize, { ...valueStyle, fontSize });
        });
      }
    });
  }
}

export function paintOver(surface: PaintSurface, scene: SceneIndex, area: Box, scale: number, grid = true): void {
  // Only full detail draws over the live layer: wires there run under
  // gate symbols, and cross the bodies of gates between their ends.
  if (detailAt(scale) !== 'full') {
    return;
  }
  const started = performance.now();
  // The grid first. It belongs under the wires, but a layer of its own
  // under them would be a whole tile composited every frame for a
  // scatter of dots, and a 1.2 px dot over a wire does not show.
  if (grid) drawGrid(surface, area, scale);
  drawSymbols(surface, scene, area, scale);
  const buses: number[] = [];
  scene.forEach(area, null, w => {
    if (scene.wireWidth[w]! > 1) buses.push(w);
  });
  drawBusMarks(surface, scene, buses, scale);
  paintTiming.recordMs += performance.now() - started;
}

/** How much thicker a bus is drawn than a one-bit wire. */
const BUS_THICKNESS = 3;

/** A bus's value from its bits, least significant first; null until every bit is known. */
export function busValue(bits: Int32Array, chunks: Readonly<Record<string, string>>): number | null {
  let value = 0;
  for (let i = 0; i < bits.length; i++) {
    const net = bits[i]!;
    const bit = net < 0 ? -1 : signalOf(chunks, net);
    if (bit < 0) return null;
    value |= bit << i;
  }
  return value >>> 0;
}

/** A bus's value in hex, as many digits as its width needs. */
export function busHex(value: number | null, width: number): string {
  const digits = Math.max(1, Math.ceil(width / 4));
  return value === null ? '?'.repeat(digits) : value.toString(16).toUpperCase().padStart(digits, '0');
}

/** A monospace digit's width, in ems. */
const MONO_ADVANCE = 0.62;

/** A value's digits as the rows a part's face shows them in: one row up to four, else two, the high half on top. */
export function valueRows(text: string): string[] {
  if (text.length <= 4) return [text];
  const split = text.length - Math.ceil(text.length / 2);
  return [text.slice(0, split), text.slice(split)];
}

/**
 * The mark a drawn bus carries: a short slash across it a little way
 * from its driver, and its width beside the slash, as a schematic marks
 * one. Static, so in the layer that changes on an edit.
 */
function drawBusMarks(surface: PaintSurface, scene: SceneIndex, buses: readonly number[], scale: number): void {
  if (buses.length === 0 || scale < BLOCKS_BELOW) return;
  surface.beginPath();
  const labels: [number, number, number][] = [];
  for (const w of buses) {
    const start = scene.wireStart[w]!;
    const p = scene.wirePoints;
    const x0 = p[start]!;
    const y0 = p[start + 1]!;
    const x1 = p[start + 2] ?? x0 + 1;
    const y1 = p[start + 3] ?? y0;
    const length = Math.hypot(x1 - x0, y1 - y0) || 1;
    const along = Math.min(0.8, length / 2);
    const mx = x0 + ((x1 - x0) / length) * along;
    const my = y0 + ((y1 - y0) / length) * along;
    surface.moveTo(mx - 0.3, my + 0.4);
    surface.lineTo(mx + 0.3, my - 0.4);
    labels.push([mx, my, scene.wireWidth[w]!]);
  }
  surface.strokeColor('text');
  surface.lineWidth(1.2 / scale);
  surface.stroke();
  if (scale >= 6) {
    surface.fillColor('textMuted');
    for (const [x, y, width] of labels) {
      surface.text(String(width), x + 0.1, y - 0.5, { fontSize: 0.6, align: 'left' });
    }
  }
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

  // Chips: a body, their definition's name inside it, and at close
  // zoom the names of their pins along its edges. Filled, so the wires
  // under a chip's body do not show through it.
  // A ROM is drawn as a chip named ROM.
  const chips = others.filter(c => scene.kindOf(c) === 'chip' || scene.kindOf(c) === 'rom');
  if (chips.length > 0) {
    surface.beginPath();
    for (const c of chips) {
      surface.roundRect(scene.x[c]!, scene.y[c]!, scene.width(c), scene.height(c), 0.5);
    }
    surface.fillColor('surface');
    surface.fill();
    surface.strokeColor('text');
    surface.lineWidth(1.6 / scale);
    surface.stroke();
    if (scale >= BLOCKS_BELOW) {
      surface.fillColor('text');
      for (const c of chips) {
        const name = scene.kindOf(c) === 'rom' ? 'ROM' : (scene.chipNames[c] ?? '?');
        // Bold runs about seven tenths of its size a character.
        const fontSize = Math.min(1.1, Math.max(0.5, (scene.width(c) - 1.2) / Math.max(1, name.length) / 0.7));
        surface.text(name, scene.x[c]! + scene.width(c) / 2, scene.y[c]! + scene.height(c) / 2 + fontSize * 0.35, {
          fontSize,
          align: 'center',
          fontWeight: 600
        });
      }
    }
    if (scale >= LABELS_FROM) {
      surface.fillColor('textMuted');
      for (const c of chips) {
        const turned = scene.turns[c] !== 0;
        if (turned) continue;
        for (const { pin, at } of scene.pins(c)) {
          const left = at.x <= scene.x[c]! + 0.01;
          surface.text(pin, at.x + (left ? 0.3 : -0.3), at.y + 0.2, { fontSize: 0.55, align: left ? 'left' : 'right' });
        }
      }
    }
  }

  // A bus's splits and joins: filled bars, the bits fanning off one side.
  const bars = others.filter(c => scene.kindOf(c) === 'split' || scene.kindOf(c) === 'join');
  if (bars.length > 0) {
    surface.beginPath();
    for (const c of bars) {
      surface.roundRect(scene.x[c]! + 0.3, scene.y[c]! + 0.3, scene.width(c) - 0.6, scene.height(c) - 0.6, 0.3);
    }
    surface.fillColor('text');
    surface.fill();
  }

  // Named wires: a tag pointing at its pin, its name inside.
  const tags = others.filter(c => scene.kindOf(c) === 'tunnel');
  if (tags.length > 0) {
    surface.beginPath();
    for (const c of tags) {
      const across = scene.turns[c]! % 2 === 1 ? scene.height(c) : scene.width(c);
      turned(surface, scene, c, (x, y) => {
        surface.moveTo(x, y + 1);
        surface.lineTo(x + 1, y + 0.2);
        surface.lineTo(x + across - 0.1, y + 0.2);
        surface.lineTo(x + across - 0.1, y + 1.8);
        surface.lineTo(x + 1, y + 1.8);
        surface.closePath();
      });
    }
    surface.fillColor('surface');
    surface.fill();
    surface.strokeColor('secondary');
    surface.lineWidth(1.4 / scale);
    surface.stroke();
    if (scale >= BLOCKS_BELOW) {
      surface.fillColor('secondary');
      for (const c of tags) {
        surface.text(scene.labels[c] ?? '', scene.x[c]! + scene.width(c) / 2 + 0.4, scene.y[c]! + scene.height(c) / 2 + 0.3, {
          fontSize: 0.85,
          align: 'center',
          fontWeight: 600
        });
      }
    }
  }

  // Notes: their words, a line at a time, on a faint card.
  const notes = others.filter(c => scene.kindOf(c) === 'note');
  if (notes.length > 0 && scale >= BLOCKS_BELOW) {
    surface.fillColor('textMuted');
    for (const c of notes) {
      (scene.labels[c] ?? '').split('\n').forEach((line, i) => {
        surface.text(line, scene.x[c]! + 0.5, scene.y[c]! + 0.3 + NOTE_FONT + i * NOTE_LINE, { fontSize: NOTE_FONT });
      });
    }
  }

  // Outlines of switches and LEDs, whose insides the live layer fills.
  const outlined = others.filter(c => !WIRING.has(scene.kindOf(c)));
  if (outlined.length > 0) {
    surface.beginPath();
    for (const c of outlined) {
      surface.roundRect(scene.x[c]!, scene.y[c]!, scene.width(c), scene.height(c), 0.4);
    }
    surface.strokeColor('text');
    surface.lineWidth(1.2 / scale);
    surface.stroke();
  }
  if (others.length > 0) {
    if (scale >= LABELS_FROM) {
      surface.fillColor('text');
      const style = { fontSize: 0.7, align: 'center' as const };
      for (const c of others) {
        const label = scene.labels[c];
        // A note and a named wire say their words inside, not over.
        if (scene.kindOf(c) === 'note' || scene.kindOf(c) === 'tunnel') continue;
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
