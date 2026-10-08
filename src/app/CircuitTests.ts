import { CIRCUIT_VERSION, type Circuit, type Component } from '../sim/Circuit';
import { CircuitError, compile } from '../sim/Netlist';
import { bitPins, isSettable } from '../sim/Primitives';
import { Simulator } from '../sim/Simulator';

/**
 * Tests for a circuit: what it should do, written beside it, and run on
 * demand against what it does now.
 *
 * A level — the top, or a chip's inside — keeps its tests as text. The
 * first line that is not a comment names the columns: the switches and
 * buttons to set, a bar, and the LEDs and probes to check, each by its
 * label (spaces as `_`) or its id; a hex display is checked by the
 * number it shows. Every line after is a row: a value
 * for each switch, then what each LED should show.
 *
 *     # A full adder.
 *     a b cin | sum cout
 *     0 0 0   | 0   0
 *     1 1 0   | 0   1
 *     1 1 1   | 1   1
 *
 * A row sets the switches left to right, letting the circuit settle
 * after each — so in `d clk`, d is steady before clk rises, as it must
 * be in hardware — and compares what the LEDs show. Values
 * are bits, or for a bus a number: `12`, `0x0C`, `0b1100`. `x` or `-`
 * for an output is "anything"; `-` for an input leaves it as it was.
 *
 * Rows run in order on one simulator, from power-on, so a circuit that
 * remembers is tested by what it remembers. `tick` runs a clock cycle
 * between rows, and `tick 8` eight:
 *
 *     en | q
 *     1  | 0
 *     tick
 *     1  | 1
 *     tick 3
 *     -  | 4
 *
 * A level's switches are what a chip's pins are, so the same text tests
 * a chip opened inside the document and the circuit it was made from.
 */

export interface TestFailure {
  /** The line of the tests the failing row is on, 1-based. */
  readonly line: number;
  readonly message: string;
}

export interface TestReport {
  /** The rows checked, and how many failed; a row fails once however many of its outputs are wrong. */
  readonly rows: number;
  readonly failed: number;
  /** The first few failures, in order. */
  readonly failures: readonly TestFailure[];
  /** Why the tests could not run at all — a line that does not read, a circuit that does not compile — or null. */
  readonly error: string | null;
}

/** Failures listed; past the first few, the rest usually follow from them. */
export const MAX_FAILURES = 5;
/** The most clock cycles one run ticks, so a typo of `tick 1000000000` cannot hang the worker. */
export const MAX_TICKS = 1_000_000;

type Step =
  | { readonly kind: 'row'; readonly line: number; readonly inputs: readonly (number | null)[]; readonly outputs: readonly (number | null)[] }
  | { readonly kind: 'tick'; readonly line: number; readonly count: number };

interface Column {
  readonly name: string;
  readonly component: Component;
  readonly width: number;
  /** An output's pins, a bit each, least significant first. */
  readonly pins: readonly string[];
}

/** What a test can check: an LED, a probe, or a hex display, whose value is the number it shows. */
function isChecked(c: Component): boolean {
  return c.kind === 'output' || c.kind === 'probe' || c.kind === 'hex';
}

function columnOf(component: Component, name = columnName(component)): Column {
  // A hex display with no width reads four one-bit pins; with one, a bus.
  const plainHex = component.kind === 'hex' && component.width === undefined;
  const width = plainHex ? 4 : (component.width ?? 1);
  return { name, component, width, pins: plainHex ? ['b0', 'b1', 'b2', 'b3'] : bitPins('in', width) };
}

class TestTextError extends Error {}

/** A part's name in a test's header: its label, spaces as `_`, or its id. */
export function columnName(component: Component): string {
  return (component.label ?? component.id).trim().replace(/\s+/g, '_');
}

function findColumn(level: Circuit, name: string, wanted: (c: Component) => boolean, what: string, line: number): Column {
  const matches = level.components.filter(c => wanted(c) && (columnName(c) === name || c.id === name));
  if (matches.length === 0) throw new TestTextError(`line ${line}: no ${what} called “${name}”`);
  if (matches.length > 1) throw new TestTextError(`line ${line}: more than one ${what} is called “${name}”; use an id`);
  return columnOf(matches[0]!, name);
}

function parseValue(text: string, width: number, column: string, line: number, blank: 'keep' | 'any'): number | null {
  if (text === '-' || (blank === 'any' && (text === 'x' || text === 'X'))) return null;
  const value = /^0x[0-9a-f]+$/i.test(text)
    ? parseInt(text.slice(2), 16)
    : /^0b[01]+$/i.test(text)
      ? parseInt(text.slice(2), 2)
      : /^\d+$/.test(text)
        ? parseInt(text, 10)
        : NaN;
  if (Number.isNaN(value)) throw new TestTextError(`line ${line}: “${text}” for ${column} is not a number`);
  if (value >= 2 ** width) throw new TestTextError(`line ${line}: ${text} does not fit ${column}, ${width} bit${width === 1 ? '' : 's'} wide`);
  return value;
}

function parse(level: Circuit, text: string): { inputs: Column[]; outputs: Column[]; steps: Step[] } {
  const lines = text.split('\n');
  let inputs: Column[] | null = null;
  let outputs: Column[] = [];
  const steps: Step[] = [];
  lines.forEach((raw, i) => {
    const line = i + 1;
    const content = raw.replace(/#.*$/, '').trim();
    if (content === '') return;
    if (inputs === null) {
      const bar = content.split('|');
      if (bar.length !== 2) throw new TestTextError(`line ${line}: the first line names the inputs, a |, and the outputs`);
      inputs = bar[0]!.trim().split(/\s+/).filter(Boolean).map(name => findColumn(level, name, c => isSettable(c.kind), 'switch or button', line));
      outputs = bar[1]!.trim().split(/\s+/).filter(Boolean).map(name => findColumn(level, name, isChecked, 'LED, probe or hex display', line));
      if (outputs.length === 0) throw new TestTextError(`line ${line}: no outputs to check after the |`);
      return;
    }
    const tick = /^tick(?:\s+(\d+))?$/i.exec(content);
    if (tick !== null) {
      steps.push({ kind: 'tick', line, count: tick[1] === undefined ? 1 : parseInt(tick[1], 10) });
      return;
    }
    const bar = content.split('|');
    const left = bar.length === 2 ? bar[0]!.trim().split(/\s+/).filter(Boolean) : [];
    const right = bar.length === 2 ? bar[1]!.trim().split(/\s+/).filter(Boolean) : [];
    const ins = inputs as Column[];
    if (bar.length !== 2 || left.length !== ins.length || right.length !== outputs.length) {
      throw new TestTextError(`line ${line}: a row is ${ins.length} input${ins.length === 1 ? '' : 's'}, a |, and ${outputs.length} output${outputs.length === 1 ? '' : 's'}, or tick`);
    }
    steps.push({
      kind: 'row',
      line,
      inputs: left.map((v, n) => parseValue(v, ins[n]!.width, ins[n]!.name, line, 'keep')),
      outputs: right.map((v, n) => parseValue(v, outputs[n]!.width, outputs[n]!.name, line, 'any'))
    });
  });
  if (inputs === null) throw new TestTextError('there are no tests: the first line names the inputs, a |, and the outputs');
  return { inputs, outputs, steps };
}

function show(value: number, width: number): string {
  return width === 1 ? String(value) : `0x${value.toString(16).toUpperCase()}`;
}

/** A level with the document's chips, as a circuit of its own. */
function standalone(level: Circuit, chips: Circuit['chips']): Circuit {
  return { version: CIRCUIT_VERSION, components: level.components, wires: level.wires, ...(chips === undefined ? {} : { chips }) };
}

function readOutput(simulator: Simulator, column: Column): number {
  let value = 0;
  column.pins.forEach((pin, bit) => (value |= simulator.read(column.component.id, pin) << bit));
  return value >>> 0;
}

/** Runs a level's tests against it, from power-on. */
export function runTests(level: Circuit, chips: Circuit['chips'], text: string): TestReport {
  let parsed;
  try {
    parsed = parse(level, text);
  } catch (error) {
    if (error instanceof TestTextError) return { rows: 0, failed: 0, failures: [], error: error.message };
    throw error;
  }
  let simulator: Simulator;
  try {
    simulator = new Simulator(compile(standalone(level, chips)));
  } catch (error) {
    if (error instanceof CircuitError) return { rows: 0, failed: 0, failures: [], error: `the circuit does not compile: ${error.message}` };
    throw error;
  }
  simulator.settle();
  const failures: TestFailure[] = [];
  let rows = 0;
  let failed = 0;
  let ticks = 0;
  for (const step of parsed.steps) {
    if (step.kind === 'tick') {
      ticks += step.count;
      if (ticks > MAX_TICKS) return { rows, failed, failures, error: `line ${step.line}: more than ${MAX_TICKS.toLocaleString('en')} ticks in all` };
      for (let i = 0; i < step.count; i++) {
        if (!simulator.cycle().settled) {
          return { rows, failed: failed + 1, failures: [...failures, { line: step.line, message: 'the circuit did not settle on this tick' }].slice(0, MAX_FAILURES), error: null };
        }
      }
      continue;
    }
    // Left to right, each settled before the next, as data is steady
    // before the edge it is clocked in on: `d clk` sets d, then raises clk.
    let settled = simulator.settle().settled;
    step.inputs.forEach((value, n) => {
      if (value === null || !settled) return;
      simulator.set(parsed.inputs[n]!.component.id, value);
      settled = simulator.settle().settled;
    });
    rows++;
    if (!settled) {
      failed++;
      if (failures.length < MAX_FAILURES) failures.push({ line: step.line, message: 'the circuit did not settle' });
      continue;
    }
    const wrong: string[] = [];
    step.outputs.forEach((expected, n) => {
      if (expected === null) return;
      const column = parsed.outputs[n]!;
      const got = readOutput(simulator, column);
      if (got !== expected) wrong.push(`${column.name} should be ${show(expected, column.width)}, is ${show(got, column.width)}`);
    });
    if (wrong.length > 0) {
      failed++;
      if (failures.length < MAX_FAILURES) failures.push({ line: step.line, message: wrong.join('; ') });
    }
  }
  return { rows, failed, failures, error: null };
}

/** The most input bits a filled-in table sweeps: 256 rows. */
export const MAX_SWEPT_BITS = 8;

/**
 * Tests written from what the level does now, to keep it doing that: a
 * row for every combination of its switches when there are few enough,
 * or, for one with a clock, its first few cycles from power-on. A
 * starting point, to be read and corrected where what it does now is
 * not what it should.
 */
export function testsFromNow(level: Circuit, chips: Circuit['chips']): string {
  const inputs = level.components.filter(c => isSettable(c.kind)).sort((a, b) => a.y - b.y || a.x - b.x);
  const outputs = level.components.filter(isChecked).sort((a, b) => a.y - b.y || a.x - b.x);
  if (outputs.length === 0) return '# This level has no LEDs, probes or hex displays to check. Add one, then fill these in again.\n';
  let simulator: Simulator;
  try {
    simulator = new Simulator(compile(standalone(level, chips)));
  } catch (error) {
    if (error instanceof CircuitError) return `# The circuit does not compile yet: ${error.message}\n`;
    throw error;
  }
  const columns = (list: Component[]) => list.map(c => columnOf(c));
  const ins = columns(inputs);
  const outs = columns(outputs);
  // Each column as wide as its name or its widest value, so the rows line up.
  const valueText = (value: number, width: number) => (width === 1 ? String(value) : `0x${value.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0')}`);
  const pad = (column: { name: string; width: number }) => Math.max(column.name.length, valueText(0, column.width).length);
  const row = (values: readonly string[], list: readonly { name: string; width: number }[]) => values.map((v, i) => v.padEnd(pad(list[i]!))).join(' ');
  const lines: string[] = [];
  const write = (inValues: readonly string[]) => {
    simulator.settle();
    lines.push(`${row(inValues, ins)} | ${row(outs.map(c => valueText(readOutput(simulator, c), c.width)), outs)}`.trimEnd());
  };
  const header = `${row(ins.map(c => c.name), ins)} | ${row(outs.map(c => c.name), outs)}`.trimEnd();
  const clocked = level.components.some(c => c.kind === 'clock');
  const bits = ins.reduce((sum, c) => sum + c.width, 0);
  simulator.settle();
  if (clocked || bits > MAX_SWEPT_BITS) {
    // Its switches as they start, and the first cycles from power-on.
    const start = ins.map(c => valueText(c.component.value ?? 0, c.width));
    const lead = clocked
      ? '# What it does now, cycle by cycle from power-on. Correct any line that is not what it should do.'
      : `# ${bits} input bits are too many to list every combination: here is where it starts. Add the rows that matter.`;
    lines.push(lead, header);
    ins.forEach(c => simulator.set(c.component.id, c.component.value ?? 0));
    write(start);
    for (let cycle = 0; clocked && cycle < 4; cycle++) {
      lines.push('tick');
      simulator.cycle();
      write(ins.map(() => '-'));
    }
    return `${lines.join('\n')}\n`;
  }
  lines.push('# What it does now, for every combination of its inputs. Correct any row that is not what it should do.', header);
  for (let n = 0; n < 1 << bits; n++) {
    // The first input's bits are the most significant, as a table is written.
    let shift = bits;
    const values = ins.map(c => {
      shift -= c.width;
      const value = (n >> shift) & ((1 << c.width) - 1);
      simulator.set(c.component.id, value);
      return valueText(value, c.width);
    });
    write(values);
  }
  return `${lines.join('\n')}\n`;
}
