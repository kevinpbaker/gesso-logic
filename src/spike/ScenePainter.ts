import type { PaintSurface } from 'gesso-core';

import { signalOf, type Signals } from './CircuitContract';
import { GATE_HEIGHT, GATE_WIDTH, SceneQuery, type Scene } from './Scene';

/**
 * Draws a world rectangle of the fake circuit onto a `PaintSurface`.
 *
 * Split in two because the layers change at different rates: gates move
 * only on an edit, wires change colour every frame. The canvas decides
 * whether the two are separate `Paint` nodes (tiles) or one (single);
 * this only knows how to draw a rectangle of each.
 *
 * Wires are drawn as three batched paths — high, low, and not yet known
 * — so a tile of a thousand wires is three strokes, not a thousand.
 */

/** Below this many screen pixels per world unit, a gate is a filled block and nothing else. */
export const DETAIL_SCALE = 0.3;
/** At or above this, gates carry their type as a label. */
const LABEL_SCALE = 0.9;
const LABELS = ['NOT', 'AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR'];

export interface WireCounts {
  drawn: number;
  missing: number;
}

/**
 * Milliseconds spent inside the painters since the last read.
 *
 * A painter runs inside the render phase, when the picture cache finds
 * its inputs moved and records it again; what the render phase costs
 * beyond this is replaying the recording onto a canvas and
 * rasterising it. Splitting the two is what says whether the fix is
 * fewer ops or fewer pixels.
 */
export const paintTiming = { recordMs: 0 };

export class ScenePainter {
  private readonly query: SceneQuery;
  private readonly scene: Scene;
  private high: Int32Array;
  private low: Int32Array;
  private unknown: Int32Array;

  constructor(scene: Scene) {
    this.scene = scene;
    this.query = new SceneQuery(scene);
    this.high = new Int32Array(scene.wireCount);
    this.low = new Int32Array(scene.wireCount);
    this.unknown = new Int32Array(scene.wireCount);
  }

  gates(surface: PaintSurface, left: number, top: number, right: number, bottom: number, scale: number): number {
    const started = performance.now();
    try {
      return this.drawGates(surface, left, top, right, bottom, scale);
    } finally {
      paintTiming.recordMs += performance.now() - started;
    }
  }

  wires(
    surface: PaintSurface,
    left: number,
    top: number,
    right: number,
    bottom: number,
    scale: number,
    signals: Signals
  ): WireCounts {
    const started = performance.now();
    try {
      return this.drawWires(surface, left, top, right, bottom, scale, signals);
    } finally {
      paintTiming.recordMs += performance.now() - started;
    }
  }

  /**
   * The `blocks` level of detail's two layers, for zooms where a wire is
   * a pixel or less and its colour cannot be read anyway: every wire
   * once, unlit, in a layer that never changes, and the live values
   * shown on the gates instead — each a block filled by its output.
   * Ten thousand rects per snapshot rather than twenty thousand
   * three-segment polylines.
   */
  staticWires(surface: PaintSurface, left: number, top: number, right: number, bottom: number, scale: number): void {
    const started = performance.now();
    let count = 0;
    this.query.forEach(left, top, right, bottom, null, w => (this.low[count++] = w));
    surface.lineWidth(Math.max(1.5, 1.2 / scale));
    this.stroke(surface, this.low, count, 'border');
    paintTiming.recordMs += performance.now() - started;
  }

  liveGates(surface: PaintSurface, left: number, top: number, right: number, bottom: number, signals: Signals): number {
    const started = performance.now();
    const { gateX, gateY, gateNet } = this.scene;
    let highCount = 0;
    let lowCount = 0;
    let unknownCount = 0;
    this.query.forEach(left, top, right, bottom, g => {
      const value = signalOf(signals, gateNet[g]);
      if (value === 1) this.high[highCount++] = g;
      else if (value === 0) this.low[lowCount++] = g;
      else this.unknown[unknownCount++] = g;
    }, null);
    const fill = (gates: Int32Array, count: number, color: string) => {
      if (count === 0) return;
      surface.beginPath();
      for (let i = 0; i < count; i++) {
        const g = gates[i];
        surface.rect(gateX[g], gateY[g], GATE_WIDTH, GATE_HEIGHT);
      }
      surface.fillColor(color);
      surface.fill();
    };
    fill(this.low, lowCount, 'textMuted');
    fill(this.unknown, unknownCount, 'placeholder');
    fill(this.high, highCount, 'primary');
    paintTiming.recordMs += performance.now() - started;
    return unknownCount;
  }

  private drawGates(surface: PaintSurface, left: number, top: number, right: number, bottom: number, scale: number): number {
    const { gateX, gateY, gateType } = this.scene;
    let count = 0;
    if (scale < DETAIL_SCALE) {
      surface.beginPath();
      this.query.forEach(left, top, right, bottom, g => {
        surface.rect(gateX[g], gateY[g], GATE_WIDTH, GATE_HEIGHT);
        count++;
      }, null);
      surface.fillColor('textMuted');
      surface.fill();
      return count;
    }
    const visible: number[] = [];
    this.query.forEach(left, top, right, bottom, g => visible.push(g), null);
    count = visible.length;
    surface.beginPath();
    for (const g of visible) {
      surface.roundRect(gateX[g], gateY[g], GATE_WIDTH, GATE_HEIGHT, 4);
    }
    surface.fillColor('surface');
    surface.fill();
    surface.strokeColor('text');
    surface.lineWidth(Math.max(1, 1 / scale));
    surface.stroke();
    if (scale >= LABEL_SCALE) {
      const style = { fontSize: 9, align: 'center' as const };
      surface.fillColor('text');
      for (const g of visible) {
        surface.text(LABELS[gateType[g]], gateX[g] + GATE_WIDTH / 2, gateY[g] + GATE_HEIGHT / 2 + 3, style);
      }
    }
    return count;
  }

  private drawWires(
    surface: PaintSurface,
    left: number,
    top: number,
    right: number,
    bottom: number,
    scale: number,
    signals: Signals
  ): WireCounts {
    const { wireNet } = this.scene;
    let highCount = 0;
    let lowCount = 0;
    let unknownCount = 0;
    const high = this.high;
    const low = this.low;
    const unknown = this.unknown;
    this.query.forEach(left, top, right, bottom, null, w => {
      const value = signalOf(signals, wireNet[w]);
      if (value === 1) {
        high[highCount++] = w;
      } else if (value === 0) {
        low[lowCount++] = w;
      } else {
        unknown[unknownCount++] = w;
      }
    });
    const width = Math.max(1.5, 1.2 / scale);
    surface.lineWidth(width);
    this.stroke(surface, low, lowCount, 'border');
    this.stroke(surface, unknown, unknownCount, 'placeholder');
    surface.lineWidth(width * 1.4);
    this.stroke(surface, high, highCount, 'primary');
    return { drawn: highCount + lowCount + unknownCount, missing: unknownCount };
  }

  private stroke(surface: PaintSurface, wires: Int32Array, count: number, color: string): void {
    if (count === 0) {
      return;
    }
    const { wireX0, wireY0, wireXm, wireX1, wireY1 } = this.scene;
    surface.beginPath();
    for (let i = 0; i < count; i++) {
      const w = wires[i];
      surface.moveTo(wireX0[w], wireY0[w]);
      surface.lineTo(wireXm[w], wireY0[w]);
      surface.lineTo(wireXm[w], wireY1[w]);
      surface.lineTo(wireX1[w], wireY1[w]);
    }
    surface.strokeColor(color);
    surface.stroke();
  }
}
