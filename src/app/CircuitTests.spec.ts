import { describe, expect, it } from 'vitest';

import { CIRCUIT_VERSION, type Circuit } from '../sim/Circuit';
import { readCircuit, writeCircuit } from '../sim/CircuitFile';
import type { DocumentSummary, TestsView } from './CircuitContract';
import { CircuitService } from './CircuitService';
import { runTests, testsFromNow } from './CircuitTests';
import { libraryChips } from './LibraryParts';
import { counterScene } from './Scenes';

const chips = libraryChips();
const adder = chips['full adder']!;

describe('tests for a circuit', () => {
  it('writes a full adder’s table from what it does, and passes it', () => {
    const tests = testsFromNow(adder, chips);
    expect(tests.split('\n').filter(line => /^[01] [01] [01]/.test(line))).toHaveLength(8);
    expect(tests).toContain('a b cin | cout s');
    expect(runTests(adder, chips, tests)).toEqual({ rows: 8, failed: 0, failures: [], error: null });
  });

  it('says which row fails, on which line, and what it showed', () => {
    const tests = ['# carry only', 'a b cin | cout s', '1 1 0 | 1 x', '1 0 0 | 1 1', '0 0 0 | 0 0'].join('\n');
    expect(runTests(adder, chips, tests)).toEqual({
      rows: 3,
      failed: 1,
      failures: [{ line: 4, message: 'cout should be 1, is 0' }],
      error: null
    });
  });

  it('carries buses as numbers, in decimal, hex or binary', () => {
    const add = chips['add/sub 8']!;
    const tests = ['A B sub | S cout', '200 100 0 | 0x2C 1', '0x10 0b11 1 | 13 1', '5 7 1 | 0xFE 0'].join('\n');
    expect(runTests(add, chips, tests)).toEqual({ rows: 3, failed: 0, failures: [], error: null });
  });

  it('runs rows in order, so a clocked circuit is tested by what it remembers', () => {
    const counter = chips['counter 8']!;
    const tests = [
      'D clr load inc clk | Q',
      '0 1 0 0 0 | x',
      '- - - - 1 | x',
      '- 0 - 1 0 | 0',
      '- - - - 1 | 1',
      '- - - - 0 | 1',
      '- - - - 1 | 2',
      '- - 1 0 0 | 2',
      '0x40 - - - 1 | 0x40'
    ].join('\n');
    expect(runTests(counter, chips, tests).failures).toEqual([]);
  });

  it('ticks a circuit with a clock between rows', () => {
    const scene = counterScene();
    const tests = testsFromNow(scene, scene.chips);
    expect(tests).toContain('tick');
    expect(runTests(scene, scene.chips, tests)).toMatchObject({ failed: 0, error: null });
    // And a wrong count is caught a tick later.
    const wrong = tests.replace(/0x3(\s+0\s+0\s*)$/, '0x5$1');
    expect(wrong).not.toBe(tests);
    expect(runTests(scene, scene.chips, wrong).failed).toBeGreaterThan(0);
  });

  it('checks a hex display by the number it shows', () => {
    const shown: Circuit = {
      version: CIRCUIT_VERSION,
      components: [
        { id: 'n', kind: 'input', x: 0, y: 0, width: 8, label: 'n' },
        { id: 'big', kind: 'hex', x: 6, y: 0, width: 8, label: 'value' },
        { id: 'b0', kind: 'input', x: 0, y: 8, label: 'b' },
        { id: 'small', kind: 'hex', x: 6, y: 8, label: 'digit' }
      ],
      wires: [
        { id: 'w1', from: { component: 'n', pin: 'out' }, to: { component: 'big', pin: 'in' } },
        { id: 'w2', from: { component: 'b0', pin: 'out' }, to: { component: 'small', pin: 'b0' } }
      ]
    };
    expect(runTests(shown, undefined, 'n b | value digit\n0x2A 1 | 42 1\n7 0 | 7 0')).toMatchObject({ rows: 2, failed: 0, error: null });
    expect(testsFromNow(shown, undefined)).toContain('n    b | value digit');
  });

  it('says why tests do not read, by line', () => {
    expect(runTests(adder, chips, '').error).toMatch(/no tests/);
    expect(runTests(adder, chips, 'a b carry | s').error).toBe('line 1: no switch or button called “carry”');
    expect(runTests(adder, chips, 'a b cin | s\n0 0 | 0').error).toMatch(/^line 2: a row is 3 inputs/);
    expect(runTests(adder, chips, 'a b cin | s\n0 0 2 | 0').error).toBe('line 2: 2 does not fit cin, 1 bit wide');
    expect(runTests(adder, chips, 'a b cin | s\n0 0 y | 0').error).toBe('line 2: “y” for cin is not a number');
  });

  it('goes in the file with the level it tests, and comes back', () => {
    const tested: Circuit = {
      version: CIRCUIT_VERSION,
      components: [],
      wires: [],
      tests: 'a | b\n',
      chips: { 'full adder': { ...adder, tests: testsFromNow(adder, chips) } }
    };
    const again = readCircuit(writeCircuit(tested));
    expect(again.tests).toBe('a | b\n');
    expect(again.chips!['full adder']!.tests).toBe(tested.chips!['full adder']!.tests);
  });
});

describe('tests in the service', () => {
  it('fills a level’s tests, runs them after each edit while followed, and undoes them like any edit', () => {
    const fired: (() => void)[] = [];
    const service = new CircuitService({ schedule: () => {}, delay: run => (fired.push(run), () => {}) });
    let document!: DocumentSummary;
    let tested!: TestsView;
    service.document.subscribe(d => (document = d));
    service.tested.subscribe(t => (tested = t));
    service.loadScene('counter');

    service.fillTests();
    expect(document.tests).toContain('tick');
    expect(document.testedLevels).toBe(1);
    service.runTests(false, true);
    expect(tested.results).toMatchObject([{ level: 'the top level', failed: 0, error: null }]);

    // Tests that expect another count fail, once edits stop.
    const serial = tested.serial;
    service.setTests(document.tests.replace(/0x3(\s+0\s+0\s*)$/, '0x5$1'));
    fired.splice(0).forEach(run => run());
    expect(tested.serial).toBeGreaterThan(serial);
    expect(tested.results[0]!.failed).toBe(1);

    // Two edits of the tests text are one undo; the fill before them another.
    service.setTests(`${document.tests}\n# more`);
    service.undo();
    expect(document.tests).toContain('tick');
    service.undo();
    expect(document.tests).toBe('');
    expect(document.testedLevels).toBe(0);
  });

  it('runs every level’s tests at once', () => {
    const service = new CircuitService({ schedule: () => {} });
    let tested!: TestsView;
    service.tested.subscribe(t => (tested = t));
    service.loadScene('adder');
    service.setTests('');
    service.runTests(true, false);
    expect(tested).toMatchObject({ all: true, results: [] });
  });
});
