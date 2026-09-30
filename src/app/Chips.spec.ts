import { describe, expect, it } from 'vitest';

import { CIRCUIT_VERSION, type Circuit } from '../sim/Circuit';
import { CircuitBuilder } from '../sim/CircuitBuilder';
import { chipInterface } from '../sim/Chips';
import { CircuitError, compile } from '../sim/Netlist';
import { fullAdder } from '../sim/Parts';
import { Simulator } from '../sim/Simulator';
import { makeChip, renameChip } from './DocumentEdits';
import { ADDER, adderScene } from './Scenes';
import { entriesOf, entryOf } from './CircuitContract';

/** Sets the top level's switches A0..A7 and B0..B7 and reads S0..S7 and COUT back as a number. */
function add(sim: Simulator, a: number, b: number): number {
  for (let i = 0; i < 8; i++) {
    sim.set(`A${i}`, ((a >> i) & 1) as 0 | 1);
    sim.set(`B${i}`, ((b >> i) & 1) as 0 | 1);
  }
  expect(sim.settle().settled).toBe(true);
  let sum = sim.read('COUT', 'in') << 8;
  for (let i = 0; i < 8; i++) sum |= sim.read(`S${i}`, 'in') << i;
  return sum;
}

describe('chips', () => {
  it('flattens an adder of adders, and it adds', () => {
    const sim = new Simulator(compile(adderScene()));
    expect(sim.settle().settled).toBe(true);
    // Carry in is a flip-flop, which powers on either way.
    const cin = sim.read('CIN.slave.q');
    let sum = 0;
    for (let i = 0; i < 8; i++) sum |= sim.read(`S${i}`, 'in') << i;
    expect(sum).toBe((ADDER.a + ADDER.b + cin) & 0xff);
    expect(add(sim, 0xff, 0x01)).toBe(0x100 + cin);
    expect(add(sim, 200, 100)).toBe(300 + cin);
    // A tick toggles it, and the sum follows.
    sim.cycle();
    expect(sim.read('CIN.slave.q')).toBe(1 - cin);
    expect(add(sim, 200, 100)).toBe(300 + (1 - cin));
  });

  it('has the inside of the third full adder live, under its prefix', () => {
    const netlist = compile(adderScene());
    const sim = new Simulator(netlist);
    const inside = (pin: string) => sim.value[netlist.pinNet.get(`add/fa2/${pin}`)!];
    // The third full adder's sum LED is bit 2 of the sum; its carry in,
    // the carry out of the second.
    add(sim, 0b0000_0100, 0);
    expect(inside('s.in')).toBe(1);
    add(sim, 0b0000_0110, 0b0000_0010);
    expect(inside('cin.out')).toBe(1);
    expect(inside('s.in')).toBe(0);
    expect(inside('cout.in')).toBe(1);
  });

  it('makes a chip of a full adder drawn with its own switches and LEDs, with those as its pins', () => {
    const b = new CircuitBuilder();
    const { sum, carry } = fullAdder(b, b.input('a'), b.input('b'), b.input('cin'), 'fa');
    b.output('s', sum);
    b.output('cout', carry);
    const drawn = b.build();
    const made = makeChip(drawn, drawn.components.map(c => c.id), 'full adder', 'fa1');

    expect(made.components).toEqual([expect.objectContaining({ id: 'fa1', kind: 'chip', chip: 'full adder' })]);
    const face = chipInterface(made.chips!['full adder']!);
    expect(face.inputs.map(p => p.name).sort()).toEqual(['a', 'b', 'cin']);
    expect(face.outputs.map(p => p.name).sort()).toEqual(['cout', 's']);
  });

  it('turns a selection’s boundary crossings into pins, and the circuit still does what it did', () => {
    // A full adder with its switches and LEDs outside the selection:
    // the five gates become a chip, and the wires crossing its edge its pins.
    const b = new CircuitBuilder();
    const { sum, carry } = fullAdder(b, b.input('a'), b.input('b'), b.input('cin'), 'fa');
    b.output('s', sum);
    b.output('cout', carry);
    const drawn = b.build();
    const gates = drawn.components.filter(c => c.id.startsWith('fa.')).map(c => c.id);
    const made = makeChip(drawn, gates, 'adder core', 'core');

    const face = chipInterface(made.chips!['adder core']!);
    expect(face.inputs).toHaveLength(3);
    expect(face.outputs).toHaveLength(2);
    expect(made.components.map(c => c.id).sort()).toEqual(['a', 'b', 'cin', 'core', 'cout', 's']);

    const before = new Simulator(compile(drawn));
    const after = new Simulator(compile(made));
    for (let n = 0; n < 8; n++) {
      for (const sim of [before, after]) {
        sim.set('a', (n & 1) as 0 | 1);
        sim.set('b', ((n >> 1) & 1) as 0 | 1);
        sim.set('cin', ((n >> 2) & 1) as 0 | 1);
        sim.settle();
      }
      expect([after.read('s', 'in'), after.read('cout', 'in')]).toEqual([before.read('s', 'in'), before.read('cout', 'in')]);
    }
  });

  it('refuses a chip that contains itself, and one the document does not define', () => {
    const loop: Circuit = {
      version: CIRCUIT_VERSION,
      components: [{ id: 'x', kind: 'chip', chip: 'loop', x: 0, y: 0 }],
      wires: [],
      chips: { loop: { version: CIRCUIT_VERSION, components: [{ id: 'y', kind: 'chip', chip: 'loop', x: 0, y: 0 }], wires: [] } }
    };
    expect(() => compile(loop)).toThrow(CircuitError);
    expect(() => compile(loop)).toThrow(/contains itself/);
    expect(() => compile({ ...loop, chips: {} })).toThrow(/does not define/);
  });
});

describe('opening a chip', () => {
  it('shows the inside of the third full adder live, with a way back out', async () => {
    const { CircuitService } = await import('./CircuitService');
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: import('./CircuitContract').DocumentSummary;
    let geometry!: import('./CircuitContract').Geometry;
    service.document.subscribe(d => (summary = d));
    service.geometry.subscribe(g => (geometry = g));
    service.load(adderScene());
    expect(summary.chips.map(c => c.name)).toEqual(['adder 8', 'full adder']);
    expect(entryOf(geometry.components, 'add')).toMatchObject({ kind: 'chip', chip: 'adder 8' });

    service.openChip('add');
    service.openChip('fa2');
    expect(summary.path).toEqual([
      { id: 'add', chip: 'adder 8' },
      { id: 'fa2', chip: 'full adder' }
    ]);
    // The full adder's own parts, on the nets the whole document runs on.
    const netlist = compile(adderScene());
    expect(entriesOf(geometry.components).map(([id]) => id).sort()).toEqual(['a', 'b', 'cin', 'cout', 'fa.both', 'fa.carry', 'fa.half', 'fa.passed', 'fa.sum', 's']);
    expect(entryOf(geometry.components, 's')!.nets['in']).toBe(netlist.pinNet.get('add/fa2/s.in'));

    service.closeChip(0);
    expect(summary.path).toEqual([]);
    expect(entryOf(geometry.components, 'add')).toBeDefined();
  });
});

describe('editing inside a chip', () => {
  it('changes the definition, and so every instance of it; and undoes as one step', async () => {
    const { CircuitService } = await import('./CircuitService');
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: import('./CircuitContract').DocumentSummary;
    let geometry!: import('./CircuitContract').Geometry;
    service.document.subscribe(d => (summary = d));
    service.geometry.subscribe(g => (geometry = g));
    service.load(adderScene());
    const gates = summary.gates;

    service.openChip('add');
    service.openChip('fa2');
    service.place('not', 30, 30, 'spare');
    expect(entryOf(geometry.components, 'spare')).toMatchObject({ kind: 'not' });
    // One NOT in the full adder's definition is one in each of the eight.
    expect(summary.gates).toBe(gates + 8);
    expect(summary.path.map(p => p.id)).toEqual(['add', 'fa2']);

    // A move inside is still a move.
    service.moveBy(['spare'], 2, 0);
    expect(entryOf(geometry.components, 'spare')).toMatchObject({ x: 32 });

    service.undo();
    service.undo();
    expect(summary.gates).toBe(gates);
    expect(entryOf(geometry.components, 'spare')).toBeUndefined();
  });
});

describe('renaming a chip', () => {
  it('renames the definition and every instance of it, at every depth', () => {
    const before = adderScene();
    const after = renameChip(before, 'full adder', 'FA');
    expect(Object.keys(after.chips!).sort()).toEqual(['FA', 'adder 8']);
    expect(after.chips!['adder 8']!.components.filter(c => c.kind === 'chip').every(c => c.chip === 'FA')).toBe(true);
    const sim = new Simulator(compile(after));
    expect(add(sim, 200, 50)).toBe(250 + sim.read('CIN.slave.q'));
    // A taken name, a blank one, or no such chip changes nothing.
    expect(renameChip(before, 'full adder', 'adder 8')).toBe(before);
    expect(renameChip(before, 'full adder', '  ')).toBe(before);
    expect(renameChip(before, 'nothing', 'x')).toBe(before);
  });
});

describe('copying chips between documents', () => {
  it('carries the definitions, and renames one that clashes with a different chip of the same name', async () => {
    const { CircuitService } = await import('./CircuitService');
    const { relabel } = await import('./DocumentEdits');
    const from = new CircuitService({ schedule: () => {}, now: () => 0 });
    let text = '';
    from.clipboard.subscribe(c => (text = c.text));
    from.load(adderScene());
    from.copy(['add']);
    const clipped = JSON.parse(text);
    expect(Object.keys(clipped.chips).sort()).toEqual(['adder 8', 'full adder']);

    // A document with a chip of its own called "full adder": a NOT.
    const to = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: import('./CircuitContract').DocumentSummary;
    to.document.subscribe(d => (summary = d));
    const b = new CircuitBuilder();
    b.output('y', b.not(b.input('x'), 'n'));
    const notChip = b.build();
    to.load({ version: CIRCUIT_VERSION, components: [{ id: 'mine', kind: 'chip', chip: 'full adder', x: 0, y: 0 }], wires: [], chips: { 'full adder': notChip } });

    let n = 0;
    to.insert(relabel(clipped, 0, 20, prefix => `${prefix}${++n}`));
    expect(summary.chips.map(c => c.name)).toEqual(['adder 8', 'full adder', 'full adder 2']);
    expect(summary.error).toBeNull();
    // Theirs is still a NOT, and the pasted adder its own full adders: one gate, and forty.
    expect(summary.gates).toBe(1 + 40);
  });
});

describe('inserting a chip from a file', () => {
  it('adds the file as a chip named after it, reusing an identical one and numbering a clash', async () => {
    const { CircuitService } = await import('./CircuitService');
    const { writeCircuit } = await import('../sim/CircuitFile');
    const { fullAdderChip } = await import('./Scenes');
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: import('./CircuitContract').DocumentSummary;
    service.document.subscribe(d => (summary = d));
    service.loadScene('empty');

    service.importChip(writeCircuit(fullAdderChip()), 'full adder.gessologic.json');
    expect(summary.chips.map(c => c.name)).toEqual(['full adder']);
    expect(summary.message).toBe('Added chip "full adder": place it from the palette');
    service.place('chip', 0, 0, 'fa', undefined, 'full adder');
    service.place('input', -6, 0, 'x');
    service.connect({ component: 'x', pin: 'out' }, { component: 'fa', pin: 'a' });
    expect(summary.error).toBeNull();
    expect(summary.gates).toBe(5);

    // The same file again is the same chip.
    service.importChip(writeCircuit(fullAdderChip()), 'full adder.json');
    expect(summary.chips.map(c => c.name)).toEqual(['full adder']);

    // A different circuit under the same name is another chip.
    const b = new CircuitBuilder();
    b.output('y', b.not(b.input('x'), 'n'));
    service.importChip(writeCircuit(b.build()), 'full adder.json');
    expect(summary.chips.map(c => c.name)).toEqual(['full adder', 'full adder 2']);

    service.importChip('{"format":"other"}', 'bad.json');
    expect(summary.message).toBe("Couldn't insert bad.json: not a gessologic circuit file");
  });
});

describe('resetting a chip', () => {
  it('puts back a chip edited inside, with the chips that hold it marked too, and undoes as one step', async () => {
    const { CircuitService } = await import('./CircuitService');
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: import('./CircuitContract').DocumentSummary;
    service.document.subscribe(d => (summary = d));
    service.load(adderScene());
    const gates = summary.gates;
    expect(summary.changedChips).toEqual([]);

    service.openChip('add');
    service.openChip('fa2');
    service.place('not', 30, 30, 'spare');
    // The full adder changed, and so did the adder made of them.
    expect([...summary.changedChips].sort()).toEqual(['adder 8', 'full adder']);

    // Reset from the outside chip reaches the one inside it.
    service.resetChip('adder 8');
    expect(summary.gates).toBe(gates);
    expect(summary.changedChips).toEqual([]);
    expect(summary.message).toBe('Reset adder 8 to how it was opened');

    service.undo();
    expect(summary.gates).toBe(gates + 8);
    expect(summary.changedChips).toContain('full adder');
  });

  it('has nothing to put back for a chip unchanged, or one made here', async () => {
    const { CircuitService } = await import('./CircuitService');
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: import('./CircuitContract').DocumentSummary;
    let geometry!: import('./CircuitContract').Geometry;
    service.document.subscribe(d => (summary = d));
    service.geometry.subscribe(g => (geometry = g));
    service.load(adderScene());
    service.resetChip('full adder');
    expect(summary.canUndo).toBe(false);

    service.place('not', 0, 60, 'n1');
    service.place('not', 0, 70, 'n2');
    service.makeChip(['n1', 'n2'], 'pair');
    service.openChip(entriesOf(geometry.components).find(([, c]) => c.chip === 'pair')![0]);
    service.place('not', 30, 30, 'n3');
    expect(summary.changedChips).not.toContain('pair');
  });

  it('puts a library part back as the library has it, and follows a rename', async () => {
    const { CircuitService } = await import('./CircuitService');
    const service = new CircuitService({ schedule: () => {}, now: () => 0 });
    let summary!: import('./CircuitContract').DocumentSummary;
    service.document.subscribe(d => (summary = d));
    service.loadScene('empty');
    service.place('chip', 0, 0, 'fa', undefined, 'full adder');
    const gates = summary.gates;
    expect(summary.changedChips).toEqual([]);

    service.openChip('fa');
    service.place('not', 30, 30, 'spare');
    expect(summary.changedChips).toContain('full adder');
    service.closeChip(0);
    service.renameChip('full adder', 'adder bit');
    expect(summary.changedChips).toContain('adder bit');

    service.resetChip('adder bit');
    expect(summary.gates).toBe(gates);
    expect(summary.changedChips).toEqual([]);
  });
});
