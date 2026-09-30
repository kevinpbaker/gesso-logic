import { describe, expect, it } from 'vitest';

import { CircuitBuilder } from '../sim/CircuitBuilder';
import type { DocumentSummary, ProgramView } from './CircuitContract';
import { CircuitService } from './CircuitService';
import { computerScene } from './Scenes';

/** A ROM whose `D` is on LEDs, read at address 0, beside a clock that counts cycles. */
function romBench(words: number[], source?: string) {
  const b = new CircuitBuilder();
  const rom = b.rom('rom', words, source);
  b.connect(b.input('A', 0, 8), { component: rom, pin: 'A' });
  b.connect(b.input('T', 0, 8), { component: rom, pin: 'T' });
  b.output('D', { component: rom, pin: 'D' }, 16);
  b.output('Q', { component: rom, pin: 'Q' }, 8);
  b.output('tick', b.clock());
  return b.build();
}

function bench(words: number[], source?: string) {
  const service = new CircuitService({ schedule: () => {}, now: () => 0 });
  let program!: ProgramView;
  let summary!: DocumentSummary;
  service.program.subscribe(p => (program = p));
  service.document.subscribe(d => (summary = d));
  service.load(romBench(words, source));
  const read = () => {
    let v = 0;
    for (let i = 0; i < 16; i++) v |= service['simulator']!.read('D', `in[${i}]`) << i;
    return v;
  };
  return { service, read, program: () => program, summary: () => summary };
}

describe('the program editor', () => {
  it('opens on the program a ROM kept', () => {
    const { service, program } = bench([0x1001], '; one\nLDA #1\n');
    service.openProgram('rom');
    expect(program()).toMatchObject({ id: 'rom', label: 'rom', source: '; one\nLDA #1\n', note: null, words: 1, problems: [] });
    service.openProgram('');
    expect(program().id).toBe('');
  });

  it('opens on a listing of the words for a ROM with no program, or one that does not match them', () => {
    const { service, program } = bench([0x1001, 0x0005]);
    service.openProgram('rom');
    expect(program().source).toContain('LDA #0x01');
    expect(program().source).toContain('.word 0x0005');
    expect(program().note).toMatch(/kept no program/);

    const mismatched = bench([0x1002], 'LDA #1\n');
    mismatched.service.openProgram('rom');
    expect(mismatched.program().source).toContain('LDA #0x02');
    expect(mismatched.program().note).toMatch(/doesn't assemble to its words/);
  });

  it('loads a program that assembles, as one edit undo takes back', () => {
    const { service, read, program, summary } = bench([0x1001], 'LDA #1\n');
    service.openProgram('rom');
    expect(read()).toBe(0x1001);

    service.setProgram('rom', 'LDA #0x42\nHLT\n');
    // The ROM's words changed and nothing else did: still a recompile.
    expect(read()).toBe(0x1042);
    expect(program()).toMatchObject({ source: 'LDA #0x42\nHLT\n', words: 2, problems: [] });
    expect(summary().message).toBe('Loaded 2 words into rom, and restarted');
    expect(service['circuit'].components.find(c => c.id === 'rom')).toMatchObject({ rom: [0x1042, 0], source: 'LDA #0x42\nHLT\n' });

    service.undo();
    expect(read()).toBe(0x1001);
    expect(service['circuit'].components.find(c => c.id === 'rom')?.source).toBe('LDA #1\n');
  });

  it('says what is wrong, line by line, and changes nothing', () => {
    const { service, read, program, summary } = bench([0x1001], 'LDA #1\n');
    service.openProgram('rom');
    const revision = summary().revision;
    service.setProgram('rom', 'LDA #1\nFROB 2\nLDA #300\n');
    expect(program().problems).toEqual([
      { line: 2, message: "'FROB' is not an instruction." },
      { line: 3, message: "The value 300 doesn't fit in a byte." }
    ]);
    // The dialog keeps what was typed, to be fixed.
    expect(program().source).toBe('LDA #1\nFROB 2\nLDA #300\n');
    expect(summary().revision).toBe(revision);
    expect(read()).toBe(0x1001);

    const serial = program().serial;
    service.setProgram('rom', 'LDA #1\nFROB 2\nLDA #300\n');
    expect(program().serial).toBe(serial + 1);
  });

  it('starts the circuit again from power-on for a new program, and not for another edit', () => {
    const { service } = bench([0x1001], 'LDA #1\n');
    for (let n = 0; n < 5; n++) service.step();
    service.place('input', 40, 0, 'extra');
    expect(service['simulator']!.cycles).toBe(5);

    service.setProgram('rom', 'LDA #2\n');
    expect(service['simulator']!.cycles).toBe(0);
    for (let n = 0; n < 3; n++) service.step();
    service.undo();
    expect(service['simulator']!.cycles).toBe(0);
  });

  it('keeps a running circuit at its clock rate across a restart', () => {
    const queue: (() => void)[] = [];
    let time = 0;
    const service = new CircuitService({ schedule: run => queue.push(run), now: () => time, budgetMs: 8, publishIntervalMs: 16 });
    service.load(romBench([0x1001], 'LDA #1\n'));
    service.setClockHz(100);
    service.run();
    const slices = (n: number) => {
      for (let i = 0; i < n; i++) {
        time += 100;
        queue.shift()?.();
      }
    };
    slices(10);
    expect(service['simulator']!.cycles).toBe(100);
    service.setProgram('rom', 'LDA #2\n');
    slices(1);
    // A tenth of a second at 100 Hz: 10 cycles, not the 110 the old count was due.
    expect(service['simulator']!.cycles).toBe(10);
  });

  it('closes when its ROM goes', () => {
    const { service, program } = bench([0x1001], 'LDA #1\n');
    service.openProgram('rom');
    service.remove(['rom']);
    expect(program().id).toBe('');
  });

  it('is given the source the computer was made from', () => {
    const source = '; tiny\nLDA #1\nHLT\n';
    expect(computerScene(source).components.find(c => c.kind === 'rom')?.source).toBe(source);
    expect(computerScene([0x1001]).components.find(c => c.kind === 'rom')?.source).toBeUndefined();
  });

  it('leaves a ROM that already holds the program alone', () => {
    const { service, summary } = bench([0x1001], 'LDA #1\n');
    const revision = summary().revision;
    service.setProgram('rom', 'LDA #1\n');
    expect(summary().revision).toBe(revision);
    expect(summary().message).toBe('rom already holds that program');
  });
});
