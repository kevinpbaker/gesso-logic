/**
 * The fake circuit spikes 1 and 2 draw and publish.
 *
 * Geometry only: 10,000 gates on a 100 × 100 grid, two inputs and one
 * output each, and a wire from each input back to the output of a gate
 * a little to its left — mostly one to three columns away, one in
 * twenty much further, so there are long wires crossing tiles as a real
 * layout would have. It is a pure function of nothing, so the
 * application worker and the render worker each build their own copy
 * and nothing about geometry crosses the barrier: Phase 0 is measuring
 * the signals, and geometry is the key that changes on an edit.
 *
 * **Net ids are spatial.** Each gate drives one net, and the net's id is
 * laid out in 16 × 16-gate blocks of 256, so a chunk of 256 nets is one
 * patch of the canvas. That is the property the packed-chunk wire shape
 * depends on: the chunks a viewport needs are the blocks it overlaps, a
 * handful rather than every chunk with one visible net in it.
 */

export const COLUMNS = 100;
export const ROWS = 100;
export const PITCH = 64;
export const GATE_WIDTH = 32;
export const GATE_HEIGHT = 24;
export const BLOCK = 16;
export const BLOCKS_X = Math.ceil(COLUMNS / BLOCK);
export const BLOCKS_Y = Math.ceil(ROWS / BLOCK);
export const CHUNK = BLOCK * BLOCK;
export const WORLD_WIDTH = COLUMNS * PITCH;
export const WORLD_HEIGHT = ROWS * PITCH;
/** The spatial index's cell, in world units. */
export const CELL = 256;
const CELLS_X = Math.ceil(WORLD_WIDTH / CELL);
const CELLS_Y = Math.ceil(WORLD_HEIGHT / CELL);

export interface Scene {
  readonly gateCount: number;
  /** One past the highest net id; ids in partial blocks are skipped. */
  readonly netCount: number;
  /** Per gate: its top-left corner in world units, and the net it drives. */
  readonly gateX: Float32Array;
  readonly gateY: Float32Array;
  readonly gateNet: Int32Array;
  readonly gateType: Uint8Array;
  /**
   * Per wire, an orthogonal route of three segments:
   * (x0, y0) → (xm, y0) → (xm, y1) → (x1, y1). `wireNet` is the net
   * that drives it, which is what decides its colour.
   */
  readonly wireCount: number;
  readonly wireX0: Float32Array;
  readonly wireY0: Float32Array;
  readonly wireXm: Float32Array;
  readonly wireX1: Float32Array;
  readonly wireY1: Float32Array;
  readonly wireNet: Int32Array;
  /** Gates and wires by spatial cell, CSR, for culling to a rectangle. */
  readonly cellGateStart: Int32Array;
  readonly cellGates: Int32Array;
  readonly cellWireStart: Int32Array;
  readonly cellWires: Int32Array;
}

export function netOf(column: number, row: number): number {
  const block = Math.floor(row / BLOCK) * BLOCKS_X + Math.floor(column / BLOCK);
  return block * CHUNK + (row % BLOCK) * BLOCK + (column % BLOCK);
}

export function buildScene(seed = 7): Scene {
  const random = mulberry32(seed);
  const gateCount = COLUMNS * ROWS;
  const gateX = new Float32Array(gateCount);
  const gateY = new Float32Array(gateCount);
  const gateNet = new Int32Array(gateCount);
  const gateType = new Uint8Array(gateCount);
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const g = row * COLUMNS + column;
      gateX[g] = column * PITCH + (PITCH - GATE_WIDTH) / 2;
      gateY[g] = row * PITCH + (PITCH - GATE_HEIGHT) / 2;
      gateNet[g] = netOf(column, row);
      gateType[g] = Math.floor(random() * 7);
    }
  }

  const x0: number[] = [];
  const y0: number[] = [];
  const xm: number[] = [];
  const x1: number[] = [];
  const y1: number[] = [];
  const nets: number[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let column = 1; column < COLUMNS; column++) {
      const g = row * COLUMNS + column;
      for (let pin = 0; pin < 2; pin++) {
        const far = random() < 0.05;
        const back = far ? 1 + Math.floor(random() * Math.min(column, 20)) : 1 + Math.floor(random() * Math.min(column, 3));
        const reach = far ? 20 : 2;
        const sourceRow = clamp(row + Math.floor(random() * (2 * reach + 1)) - reach, 0, ROWS - 1);
        const source = sourceRow * COLUMNS + (column - back);
        const sx = gateX[source] + GATE_WIDTH;
        const sy = gateY[source] + GATE_HEIGHT / 2;
        const tx = gateX[g];
        const ty = gateY[g] + (pin === 0 ? 6 : GATE_HEIGHT - 6);
        x0.push(sx);
        y0.push(sy);
        // The vertical run sits in the channel left of the sink, offset
        // per pin so two wires into one gate do not draw on top of each
        // other all the way down.
        xm.push(tx - 8 - pin * 6);
        x1.push(tx);
        y1.push(ty);
        nets.push(gateNet[source]);
      }
    }
  }
  const wireCount = nets.length;
  const wireX0 = Float32Array.from(x0);
  const wireY0 = Float32Array.from(y0);
  const wireXm = Float32Array.from(xm);
  const wireX1 = Float32Array.from(x1);
  const wireY1 = Float32Array.from(y1);

  const gateCells = index(gateCount, g => [gateX[g], gateY[g], gateX[g] + GATE_WIDTH, gateY[g] + GATE_HEIGHT]);
  const wireCells = index(wireCount, w => [
    Math.min(wireX0[w], wireXm[w]),
    Math.min(wireY0[w], wireY1[w]),
    Math.max(wireX1[w], wireXm[w]),
    Math.max(wireY0[w], wireY1[w])
  ]);

  return {
    gateCount,
    netCount: BLOCKS_X * BLOCKS_Y * CHUNK,
    gateX,
    gateY,
    gateNet,
    gateType,
    wireCount,
    wireX0,
    wireY0,
    wireXm,
    wireX1,
    wireY1,
    wireNet: Int32Array.from(nets),
    cellGateStart: gateCells.start,
    cellGates: gateCells.items,
    cellWireStart: wireCells.start,
    cellWires: wireCells.items
  };
}

/** Buckets items into every spatial cell their bounding box touches. */
function index(count: number, bounds: (i: number) => [number, number, number, number]): { start: Int32Array; items: Int32Array } {
  const lists: number[][] = Array.from({ length: CELLS_X * CELLS_Y }, () => []);
  for (let i = 0; i < count; i++) {
    const [left, top, right, bottom] = bounds(i);
    for (let cy = cellY(top); cy <= cellY(bottom); cy++) {
      for (let cx = cellX(left); cx <= cellX(right); cx++) {
        lists[cy * CELLS_X + cx].push(i);
      }
    }
  }
  const start = new Int32Array(lists.length + 1);
  lists.forEach((list, c) => (start[c + 1] = start[c] + list.length));
  const items = new Int32Array(start[lists.length]);
  lists.forEach((list, c) => items.set(list, start[c]));
  return { start, items };
}

const cellX = (x: number) => clamp(Math.floor(x / CELL), 0, CELLS_X - 1);
const cellY = (y: number) => clamp(Math.floor(y / CELL), 0, CELLS_Y - 1);

/**
 * Calls `visit` once for each gate and each wire that may intersect a
 * world rectangle, deduplicated with the caller's stamp arrays.
 *
 * May, not does: the index is by cell, and a cell is coarser than a
 * gate. Drawing a little outside the rectangle costs nothing — the
 * bitmap clips it — and testing every wire exactly would cost more.
 */
export class SceneQuery {
  private readonly scene: Scene;
  private readonly gateStamp: Uint32Array;
  private readonly wireStamp: Uint32Array;
  private epoch = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    this.gateStamp = new Uint32Array(scene.gateCount);
    this.wireStamp = new Uint32Array(scene.wireCount);
  }

  forEach(
    left: number,
    top: number,
    right: number,
    bottom: number,
    gate: ((g: number) => void) | null,
    wire: ((w: number) => void) | null
  ): void {
    const s = this.scene;
    const epoch = ++this.epoch;
    const x0 = cellX(left);
    const x1 = cellX(right);
    const y0 = cellY(top);
    const y1 = cellY(bottom);
    if (left > WORLD_WIDTH || top > WORLD_HEIGHT || right < 0 || bottom < 0) {
      return;
    }
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * CELLS_X + cx;
        if (gate !== null) {
          for (let i = s.cellGateStart[c]; i < s.cellGateStart[c + 1]; i++) {
            const g = s.cellGates[i];
            if (this.gateStamp[g] !== epoch) {
              this.gateStamp[g] = epoch;
              gate(g);
            }
          }
        }
        if (wire !== null) {
          for (let i = s.cellWireStart[c]; i < s.cellWireStart[c + 1]; i++) {
            const w = s.cellWires[i];
            if (this.wireStamp[w] !== epoch) {
              this.wireStamp[w] = epoch;
              wire(w);
            }
          }
        }
      }
    }
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
