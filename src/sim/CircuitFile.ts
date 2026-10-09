import { CIRCUIT_VERSION, type Circuit, type Component, type PinRef, type Rotation, type TracedPin, type Wire } from './Circuit';
import { pinsOf } from './Chips';
import { MAX_WIDTH, PINS, ROM_WORDS, widthOf, type Kind } from './Primitives';

/** The kinds that may have a width. */
const WIDTHED: ReadonlySet<Kind> = new Set(['input', 'constant', 'output', 'probe', 'hex', 'split', 'join', 'tunnel']);

/**
 * The circuit file: a circuit document as JSON, marked and versioned.
 *
 *   {
 *     "format": "gessologic",
 *     "version": 1,
 *     "components": [
 *       {"id":"a","kind":"input","x":0,"y":0},
 *       …
 *     ],
 *     "wires": [
 *       {"id":"w1","from":{"component":"a","pin":"out"},"to":{"component":"g","pin":"a"}},
 *       …
 *     ]
 *   }
 *
 * One component or wire a line, so a file under version control diffs
 * as the circuit changed: moving a gate is one line. Fields are written
 * in a fixed order and absent ones are left out, so saving the same
 * circuit twice writes the same bytes.
 *
 * Reading is strict about what it keeps and forgiving about what it
 * ignores. Every component and wire is checked — a kind that is not a
 * part, a wire to a pin its component does not have, an id used twice —
 * and a file that fails says where, in the words of the file
 * (`components[12].kind`). A field it does not know is dropped, so a
 * file written by a later version that only added fields still opens. A
 * version newer than this one is refused outright rather than half
 * understood; an older one is migrated, when there is one to migrate.
 */

export const FILE_FORMAT = 'gessologic';

/**
 * What a circuit file is saved and opened as, in the shape a file
 * picker takes. Named `something.gessologic.json`, but offered to the
 * picker as `.json`: a picker's extension is a single suffix.
 */
export const FILE_TYPE = { description: 'gessologic circuit', mediaType: 'application/json', extensions: ['.json'] } as const;
export const DEFAULT_FILE_NAME = 'circuit.gessologic.json';

/** The most corners a wire may be bent to: far past any drawn by hand. */
export const MAX_VIA = 256;

export class CircuitFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitFileError';
  }
}

export function writeCircuit(circuit: Circuit): string {
  const component = (c: Component) =>
    JSON.stringify({
      id: c.id,
      kind: c.kind,
      x: c.x,
      y: c.y,
      ...(c.rotation ? { rotation: c.rotation } : {}),
      ...(c.label !== undefined ? { label: c.label } : {}),
      ...(c.value !== undefined ? { value: c.value } : {}),
      ...(c.width !== undefined ? { width: c.width } : {}),
      ...(c.rate !== undefined ? { rate: c.rate } : {}),
      ...(c.chip !== undefined ? { chip: c.chip } : {}),
      ...(c.rom !== undefined ? { rom: c.rom } : {}),
      ...(c.source !== undefined ? { source: c.source } : {}),
      ...(c.note !== undefined ? { note: c.note } : {})
    });
  const wire = (w: Wire) =>
    JSON.stringify({
      id: w.id,
      from: { component: w.from.component, pin: w.from.pin },
      to: { component: w.to.component, pin: w.to.pin },
      ...(w.via !== undefined && w.via.length > 0 ? { via: w.via.map(p => [p.x, p.y]) } : {})
    });
  const list = (items: string[], indent: string) =>
    items.length === 0 ? '[]' : `[\n${indent}  ${items.join(`,\n${indent}  `)}\n${indent}]`;
  const body = (level: Circuit, indent: string) =>
    `${indent}"components": ${list(level.components.map(component), indent)},\n` +
    `${indent}"wires": ${list(level.wires.map(wire), indent)}` +
    (level.tests === undefined ? '' : `,\n${indent}"tests": ${JSON.stringify(level.tests)}`);
  // Chips by name, sorted, so the same document writes the same bytes;
  // each definition one part a line, like the top level.
  const names = Object.keys(circuit.chips ?? {}).sort();
  const chips =
    names.length === 0
      ? ''
      : `,\n  "chips": {\n${names
          .map(name => `    ${JSON.stringify(name)}: {\n${body(circuit.chips![name]!, '      ')}\n    }`)
          .join(',\n')}\n  }`;
  const traces =
    circuit.traces === undefined || circuit.traces.length === 0
      ? ''
      : `,\n  "traces": ${list(
          circuit.traces.map(t => JSON.stringify({ path: [...t.path], pin: { component: t.pin.component, pin: t.pin.pin } })),
          '  '
        )}`;
  return (
    '{\n' +
    `  "format": "${FILE_FORMAT}",\n` +
    `  "version": ${CIRCUIT_VERSION},\n` +
    `${body(circuit, '  ')}${chips}${traces}\n` +
    '}\n'
  );
}

/** The pins traced, as a file lists them: checked for shape, not for being in the document. */
function tracesFrom(raw: unknown): TracedPin[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new CircuitFileError('traces: not a list');
  return raw.map((t: unknown, n) => {
    const here = `traces[${n}]`;
    const path = isRecord(t) ? t['path'] : undefined;
    const pin = isRecord(t) ? t['pin'] : undefined;
    if (!Array.isArray(path) || !path.every(id => typeof id === 'string')) throw new CircuitFileError(`${here}.path: not a list of ids`);
    if (!isRecord(pin) || typeof pin['component'] !== 'string' || typeof pin['pin'] !== 'string') {
      throw new CircuitFileError(`${here}.pin: not a component and a pin`);
    }
    return { path: path as string[], pin: { component: pin['component'], pin: pin['pin'] } };
  });
}

export function readCircuit(text: string): Circuit {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new CircuitFileError(`not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return circuitFrom(data);
}

/** A circuit from parsed JSON, checked as `readCircuit` checks a file. */
export function circuitFrom(data: unknown): Circuit {
  if (!isRecord(data) || data['format'] !== FILE_FORMAT) {
    throw new CircuitFileError('not a gessologic circuit file');
  }
  const version = data['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new CircuitFileError('version: missing or not a whole number');
  }
  if (version > CIRCUIT_VERSION) {
    throw new CircuitFileError(`version ${version}: made by a newer gessologic, which this one cannot read`);
  }

  // The chips first, by name, so a component can name one and a wire
  // can be checked against its pins, whichever order the file lists them.
  const rawChips = data['chips'];
  if (rawChips !== undefined && !isRecord(rawChips)) {
    throw new CircuitFileError('chips: not an object');
  }
  const names = new Set(Object.keys(rawChips ?? {}));
  const chips: Record<string, Circuit> = {};
  for (const name of [...names].sort()) {
    chips[name] = levelFrom((rawChips as Record<string, unknown>)[name], `chips[${JSON.stringify(name)}]`, names);
  }
  const top = levelFrom(data, '', names);
  const traces = tracesFrom(data['traces']);
  const circuit: Circuit = { ...top, ...(names.size === 0 ? {} : { chips }), ...(traces.length === 0 ? {} : { traces }) };
  for (const [at, level] of [['', top] as const, ...Object.entries(chips).map(([name, level]) => [`chips[${JSON.stringify(name)}].`, level] as const)]) {
    checkWires(level, at, circuit.chips);
  }
  return circuit;
}

/**
 * One level: the top, or a chip's definition. Everything but the pins a
 * wire names on a chip, which wait until every definition is read.
 */
function levelFrom(data: unknown, prefix: string, chipNames: ReadonlySet<string>): Circuit {
  if (!isRecord(data)) throw new CircuitFileError(`${prefix || 'circuit'}: not an object`);
  const at = (path: string) => (prefix === '' ? path : `${prefix}.${path}`);
  const components: Component[] = [];
  const kinds = new Map<string, Kind>();
  const ids = new Set<string>();
  for (const [n, raw] of arrayAt(data, 'components', at('components')).entries()) {
    const here = at(`components[${n}]`);
    if (!isRecord(raw)) throw new CircuitFileError(`${here}: not an object`);
    const id = idAt(raw, here, ids);
    const kind = raw['kind'];
    if (typeof kind !== 'string' || !Object.hasOwn(PINS, kind)) {
      throw new CircuitFileError(`${here}.kind: ${JSON.stringify(kind)} is not a part`);
    }
    const x = integerAt(raw, 'x', here);
    const y = integerAt(raw, 'y', here);
    const rotation = raw['rotation'];
    if (rotation !== undefined && rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
      throw new CircuitFileError(`${here}.rotation: ${JSON.stringify(rotation)} is not 0, 90, 180 or 270`);
    }
    const label = raw['label'];
    if (label !== undefined && typeof label !== 'string') throw new CircuitFileError(`${here}.label: not a string`);
    const width = raw['width'];
    if (width !== undefined) {
      if (!WIDTHED.has(kind as Kind)) throw new CircuitFileError(`${here}.width: a ${kind} has no width`);
      const least = kind === 'split' || kind === 'join' ? 2 : 1;
      if (typeof width !== 'number' || !Number.isInteger(width) || width < least || width > MAX_WIDTH) {
        throw new CircuitFileError(`${here}.width: not a whole number from ${least} to ${MAX_WIDTH}`);
      }
    }
    const value = raw['value'];
    const bits = typeof width === 'number' ? width : 1;
    if (value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** bits)) {
      throw new CircuitFileError(`${here}.value: not a whole number that fits in ${bits} bit${bits === 1 ? '' : 's'}`);
    }
    const rate = raw['rate'];
    if (rate !== undefined && !(typeof rate === 'number' && rate > 0 && Number.isFinite(rate))) {
      throw new CircuitFileError(`${here}.rate: not a positive number`);
    }
    const chip = raw['chip'];
    if (kind === 'chip' && (typeof chip !== 'string' || !chipNames.has(chip))) {
      throw new CircuitFileError(`${here}.chip: ${JSON.stringify(chip)} is not a chip this file defines`);
    }
    const rom = raw['rom'];
    if (rom !== undefined) {
      if (kind !== 'rom') throw new CircuitFileError(`${here}.rom: a ${kind} has no words`);
      if (!Array.isArray(rom) || rom.length > ROM_WORDS || !rom.every(w => Number.isInteger(w) && w >= 0 && w <= 0xffff)) {
        throw new CircuitFileError(`${here}.rom: not a list of at most ${ROM_WORDS} words from 0 to 0xFFFF`);
      }
    }
    const source = raw['source'];
    if (source !== undefined) {
      if (kind !== 'rom') throw new CircuitFileError(`${here}.source: a ${kind} has no program`);
      if (typeof source !== 'string') throw new CircuitFileError(`${here}.source: not text`);
    }
    const note = raw['note'];
    if (note !== undefined) {
      if (kind !== 'input' && kind !== 'output') throw new CircuitFileError(`${here}.note: a ${kind} is not a pin and has no note`);
      if (typeof note !== 'string') throw new CircuitFileError(`${here}.note: not text`);
    }
    kinds.set(id, kind as Kind);
    components.push({
      id,
      kind: kind as Kind,
      x,
      y,
      ...(rotation ? { rotation: rotation as Rotation } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(rate !== undefined ? { rate } : {}),
      ...(kind === 'chip' ? { chip: chip as string } : {}),
      ...(rom !== undefined ? { rom: rom as number[] } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(note !== undefined ? { note } : {})
    });
  }

  const wires: Wire[] = [];
  for (const [n, raw] of arrayAt(data, 'wires', at('wires')).entries()) {
    const here = at(`wires[${n}]`);
    if (!isRecord(raw)) throw new CircuitFileError(`${here}: not an object`);
    const id = idAt(raw, here, ids);
    const end = (side: 'from' | 'to') => {
      const ref = raw[side];
      if (!isRecord(ref) || typeof ref['component'] !== 'string' || typeof ref['pin'] !== 'string') {
        throw new CircuitFileError(`${here}.${side}: not a pin`);
      }
      if (!kinds.has(ref['component'])) {
        throw new CircuitFileError(`${here}.${side}: no component ${JSON.stringify(ref['component'])}`);
      }
      return { component: ref['component'], pin: ref['pin'] };
    };
    const rawVia = raw['via'];
    let via: { x: number; y: number }[] | undefined;
    if (rawVia !== undefined) {
      const point = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v));
      if (!Array.isArray(rawVia) || rawVia.length > MAX_VIA || !rawVia.every(point)) {
        throw new CircuitFileError(`${here}.via: not a list of at most ${MAX_VIA} [x, y] points`);
      }
      via = (rawVia as [number, number][]).map(([x, y]) => ({ x, y }));
    }
    wires.push({ id, from: end('from'), to: end('to'), ...(via === undefined || via.length === 0 ? {} : { via }) });
  }
  const tests = data['tests'];
  if (tests !== undefined && typeof tests !== 'string') throw new CircuitFileError(`${at('tests')}: not text`);
  return { version: CIRCUIT_VERSION, components, wires, ...(tests === undefined ? {} : { tests }) };
}

/** Every wire's pins exist on their components, a chip's by its definition. */
function checkWires(level: Circuit, prefix: string, chips: Circuit['chips']): void {
  const byId = new Map(level.components.map(c => [c.id, c]));
  level.wires.forEach((wire, n) => {
    for (const side of ['from', 'to'] as const) {
      const ref = wire[side];
      const component = byId.get(ref.component)!;
      const pins = pinsOf(component, chips);
      if (!pins.inputs.includes(ref.pin) && !pins.outputs.includes(ref.pin)) {
        const what = component.kind === 'chip' ? `chip ${JSON.stringify(component.chip)}` : `a ${component.kind}`;
        throw new CircuitFileError(`${prefix}wires[${n}].${side}: ${what} has no pin ${JSON.stringify(ref.pin)}`);
      }
    }
    const width = (ref: PinRef) => widthOf(pinsOf(byId.get(ref.component)!, chips), ref.pin);
    if (width(wire.from) !== width(wire.to)) {
      throw new CircuitFileError(`${prefix}wires[${n}]: joins a ${width(wire.from)}-bit pin to a ${width(wire.to)}-bit one`);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayAt(data: Record<string, unknown>, key: string, path: string = key): unknown[] {
  const value = data[key];
  if (!Array.isArray(value)) throw new CircuitFileError(`${path}: missing or not a list`);
  return value;
}

/** An id, unique across components and wires alike: the editor hands both out from one namespace. */
function idAt(raw: Record<string, unknown>, at: string, ids: Set<string>): string {
  const id = raw['id'];
  if (typeof id !== 'string' || id === '') throw new CircuitFileError(`${at}.id: missing or not a string`);
  if (ids.has(id)) throw new CircuitFileError(`${at}.id: ${JSON.stringify(id)} is used twice`);
  ids.add(id);
  return id;
}

function integerAt(raw: Record<string, unknown>, key: string, at: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CircuitFileError(`${at}.${key}: not a whole number`);
  }
  return value;
}
