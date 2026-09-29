import type { Circuit, PinRef } from '../sim/Circuit';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { dFlipFlop } from '../sim/Parts';
import type { GateKind } from '../sim/Primitives';

/**
 * Circuits the application starts with, until Phase 6 opens files.
 *
 * `benchScene` is Phase 0's 10,000-gate scene made real: the same 100-row
 * grid of gates, each reading two gates a little to its left — mostly one
 * to three columns back, one in twenty much further, so long wires cross
 * tiles as a real layout's would. What Phase 0 faked with a timer
 * flipping random nets is here a 10-bit ripple counter driving the first
 * column, so running the clock sends real activity rippling rightwards
 * through real gates. It is the scene Phase 3's exit is measured on.
 */

export const BENCH = {
  rows: 100,
  columns: 99,
  counterBits: 10,
  /** Grid units between neighbouring gates; a gate is 4 × 4. */
  pitch: 6
};

const KINDS: readonly GateKind[] = ['and', 'or', 'nand', 'nor', 'xor', 'xnor'];

export function benchScene(seed = 7): Circuit {
  const random = mulberry32(seed);
  const b = new CircuitBuilder();
  const { rows, columns, counterBits, pitch } = BENCH;

  // The counter, stacked in a column to the left of the grid.
  let clock = b.clock('clk');
  b.position('clk', -pitch * 4, 0);
  const bits: PinRef[] = [];
  for (let bit = 0; bit < counterBits; bit++) {
    const loop = b.gate('not', `count${bit}.loop`);
    const ff = dFlipFlop(b, loop.out, clock, `count${bit}`);
    b.connect(ff.q, loop.a);
    bits.push(ff.q);
    clock = ff.qBar;
    const names = ['loop', 'clockBar', 'master.sBar', 'master.rBar', 'master.q', 'master.qBar', 'slave.sBar', 'slave.rBar', 'slave.q', 'slave.qBar'];
    names.forEach((name, n) => b.position(`count${bit}.${name}`, -pitch * 3 + (n % 5) * pitch * 0.75, bit * pitch * 1.5 + Math.floor(n / 5) * 5));
  }

  // The grid. A gate's id is its row and column, so a spec or a person
  // can find one.
  const out: PinRef[][] = [];
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const id = `g${row}.${column}`;
      const gate = b.gate(KINDS[Math.floor(random() * KINDS.length)]!, id);
      b.position(id, column * pitch, row * pitch);
      (out[row] ??= [])[column] = gate.out;
      for (const pin of [gate.a, gate.b]) {
        if (column === 0) {
          b.connect(bits[Math.floor(random() * counterBits)]!, pin);
          continue;
        }
        const far = random() < 0.05;
        const back = 1 + Math.floor(random() * Math.min(column, far ? 20 : 3));
        const reach = far ? 20 : 2;
        const sourceRow = Math.min(rows - 1, Math.max(0, row + Math.floor(random() * (2 * reach + 1)) - reach));
        b.connect(out[sourceRow]![column - back]!, pin);
      }
    }
  }
  return b.build();
}

/** A small seeded PRNG, so the scene is the same every time. */
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
