import { describe, expect, it } from 'vitest';

import { CircuitBuilder } from './CircuitBuilder';
import { chipInterface } from './Chips';
import { library, LIBRARY_ORDER, type LibraryName } from './Library';
import { compile } from './Netlist';
import { Simulator } from './Simulator';

/**
 * Each library part as it is used: one instance, a switch of the right
 * width on every input pin — a clock on `clk` — and an LED on every
 * output, compiled through the same flattening any document goes through.
 */
function part(name: LibraryName) {
  const chips = library();
  const face = chipInterface(chips[name]);
  const b = new CircuitBuilder();
  const dut = b.chip('dut', name);
  for (const pin of face.inputs) {
    const source = pin.name === 'clk' ? b.clock('clk') : b.input(pin.name, 0, pin.width);
    b.connect(source, { component: dut, pin: pin.name });
  }
  const widths = new Map(face.outputs.map(pin => [pin.name, pin.width]));
  for (const pin of face.outputs) {
    b.output(pin.name, { component: dut, pin: pin.name }, pin.width);
  }
  const netlist = compile({ ...b.build(), chips });
  const sim = new Simulator(netlist);
  sim.settle();
  const settle = () => expect(sim.settle().settled).toBe(true);
  return {
    gates: netlist.gateCount,
    /** Sets inputs, and lets the part settle. */
    set(values: Record<string, number>) {
      for (const [pin, value] of Object.entries(values)) sim.set(pin, value);
      settle();
    },
    get(pin: string): number {
      const width = widths.get(pin) ?? 1;
      if (width === 1) return sim.read(pin, 'in');
      let value = 0;
      for (let i = 0; i < width; i++) value |= sim.read(pin, `in[${i}]`) << i;
      return value;
    },
    /** One clock cycle: a rising edge, then the fall. */
    tick() {
      expect(sim.cycle().settled).toBe(true);
    }
  };
}

/** A small seeded PRNG, so a sampled table samples the same rows every run. */
function random(seed: number) {
  let a = seed >>> 0;
  return (below: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * below | 0;
  };
}

describe('the standard library', () => {
  it('costs what the gate budget says, part by part', () => {
    // The CPU's budget is built from these; a change here is a change there.
    const gates: Record<LibraryName, number> = {
      'half adder': 2,
      'full adder': 5,
      'add/sub 8': 48,
      'mux 2': 4,
      'mux 4': 12,
      'mux 2 ×8': 32,
      'mux 4 ×8': 96,
      'decoder 3→8': 27,
      'D latch': 4,
      'D flip-flop': 9,
      'register 8': 104,
      'counter 8': 129
    };
    for (const name of LIBRARY_ORDER) {
      expect(part(name).gates, name).toBe(gates[name]);
    }
  });

  it('half adder: every row', () => {
    const p = part('half adder');
    for (let n = 0; n < 4; n++) {
      const [a, b] = [n & 1, n >> 1];
      p.set({ a, b });
      expect([p.get('s'), p.get('c')]).toEqual([a ^ b, a & b]);
    }
  });

  it('full adder: every row', () => {
    const p = part('full adder');
    for (let n = 0; n < 8; n++) {
      const [a, b, cin] = [n & 1, (n >> 1) & 1, n >> 2];
      p.set({ a, b, cin });
      expect([p.get('s'), p.get('cout')]).toEqual([(a + b + cin) & 1, (a + b + cin) >> 1]);
    }
  });

  it('add/sub 8: the edges and two thousand sampled rows each way', () => {
    const p = part('add/sub 8');
    const next = random(8);
    const rows: [number, number][] = [
      [0, 0],
      [0xff, 0xff],
      [0xff, 0x01],
      [0x80, 0x80],
      [0x01, 0xff],
      [0x7f, 0x01]
    ];
    for (let i = 0; i < 2000; i++) rows.push([next(256), next(256)]);
    for (const [a, b] of rows) {
      p.set({ A: a, B: b, sub: 0 });
      expect([p.get('S'), p.get('cout')], `${a} + ${b}`).toEqual([(a + b) & 0xff, (a + b) >> 8]);
      p.set({ sub: 1 });
      // As a 6502's: carry out high when there was no borrow.
      expect([p.get('S'), p.get('cout')], `${a} - ${b}`).toEqual([(a - b) & 0xff, a >= b ? 1 : 0]);
    }
  });

  it('mux 2 and mux 4: every row', () => {
    const two = part('mux 2');
    for (let n = 0; n < 8; n++) {
      const [a, b, s] = [n & 1, (n >> 1) & 1, n >> 2];
      two.set({ a, b, s });
      expect(two.get('y')).toBe(s ? b : a);
    }
    const four = part('mux 4');
    for (let n = 0; n < 64; n++) {
      const data = [n & 1, (n >> 1) & 1, (n >> 2) & 1, (n >> 3) & 1];
      const S = n >> 4;
      four.set({ a: data[0]!, b: data[1]!, c: data[2]!, d: data[3]!, S });
      expect(four.get('y'), `row ${n}`).toBe(data[S]);
    }
  });

  it('mux 2 ×8 and mux 4 ×8: sampled rows, every select', () => {
    const next = random(4);
    const two = part('mux 2 ×8');
    const four = part('mux 4 ×8');
    for (let i = 0; i < 200; i++) {
      const data = [next(256), next(256), next(256), next(256)];
      for (const s of [0, 1]) {
        two.set({ A: data[0]!, B: data[1]!, s });
        expect(two.get('Y')).toBe(data[s]);
      }
      for (const S of [0, 1, 2, 3]) {
        four.set({ A: data[0]!, B: data[1]!, C: data[2]!, D: data[3]!, S });
        expect(four.get('Y')).toBe(data[S]);
      }
    }
  });

  it('decoder 3→8: every row, enabled and not', () => {
    const p = part('decoder 3→8');
    for (let en = 0; en < 2; en++) {
      for (let A = 0; A < 8; A++) {
        p.set({ A, en });
        expect(p.get('Y'), `A=${A} en=${en}`).toBe(en ? 1 << A : 0);
      }
    }
  });

  it('D latch: follows while enabled, holds when not', () => {
    const p = part('D latch');
    p.set({ en: 1, d: 1 });
    expect([p.get('q'), p.get('qn')]).toEqual([1, 0]);
    p.set({ en: 0 });
    p.set({ d: 0 });
    expect(p.get('q')).toBe(1);
    p.set({ en: 1 });
    expect([p.get('q'), p.get('qn')]).toEqual([0, 1]);
    p.set({ d: 1 });
    expect(p.get('q')).toBe(1);
  });

  it('D flip-flop: takes d on the rising edge, and only then', () => {
    const p = part('D flip-flop');
    p.set({ d: 0 });
    p.tick();
    expect(p.get('q')).toBe(0);
    p.set({ d: 1 });
    expect(p.get('q')).toBe(0);
    p.tick();
    expect([p.get('q'), p.get('qn')]).toEqual([1, 0]);
    p.set({ d: 0 });
    expect(p.get('q')).toBe(1);
    p.tick();
    expect(p.get('q')).toBe(0);
  });

  it('register 8: loads on the edge while load is high, and holds otherwise', () => {
    const p = part('register 8');
    p.set({ D: 0xa5, load: 1 });
    p.tick();
    expect(p.get('Q')).toBe(0xa5);
    p.set({ D: 0x3c, load: 0 });
    p.tick();
    p.tick();
    expect(p.get('Q')).toBe(0xa5);
    p.set({ load: 1 });
    expect(p.get('Q')).toBe(0xa5);
    p.tick();
    expect(p.get('Q')).toBe(0x3c);
  });

  it('counter 8: clears, counts, wraps, loads, holds — clear over load over count', () => {
    const p = part('counter 8');
    p.set({ clr: 1 });
    p.tick();
    expect(p.get('Q')).toBe(0);
    p.set({ clr: 0, inc: 1 });
    for (let n = 1; n <= 3; n++) {
      p.tick();
      expect(p.get('Q')).toBe(n);
    }
    p.set({ load: 1, D: 0xfe });
    p.tick();
    expect(p.get('Q')).toBe(0xfe);
    p.set({ load: 0 });
    p.tick();
    p.tick();
    expect(p.get('Q')).toBe(0x00);
    p.set({ inc: 0 });
    p.tick();
    expect(p.get('Q')).toBe(0x00);
    p.set({ load: 1, D: 0x42, clr: 1 });
    p.tick();
    expect(p.get('Q')).toBe(0);
    p.set({ clr: 0 });
    p.tick();
    expect(p.get('Q')).toBe(0x42);
  });
});
