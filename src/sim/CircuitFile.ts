import { CIRCUIT_VERSION, type Circuit, type Component, type Rotation, type Wire } from './Circuit';
import { PINS, type Kind } from './Primitives';

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
      ...(c.rate !== undefined ? { rate: c.rate } : {})
    });
  const wire = (w: Wire) =>
    JSON.stringify({
      id: w.id,
      from: { component: w.from.component, pin: w.from.pin },
      to: { component: w.to.component, pin: w.to.pin }
    });
  const list = (items: string[]) => (items.length === 0 ? '[]' : `[\n    ${items.join(',\n    ')}\n  ]`);
  return (
    '{\n' +
    `  "format": "${FILE_FORMAT}",\n` +
    `  "version": ${CIRCUIT_VERSION},\n` +
    `  "components": ${list(circuit.components.map(component))},\n` +
    `  "wires": ${list(circuit.wires.map(wire))}\n` +
    '}\n'
  );
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

  const components: Component[] = [];
  const kinds = new Map<string, Kind>();
  const ids = new Set<string>();
  for (const [n, raw] of arrayAt(data, 'components').entries()) {
    const at = `components[${n}]`;
    if (!isRecord(raw)) throw new CircuitFileError(`${at}: not an object`);
    const id = idAt(raw, at, ids);
    const kind = raw['kind'];
    if (typeof kind !== 'string' || !Object.hasOwn(PINS, kind)) {
      throw new CircuitFileError(`${at}.kind: ${JSON.stringify(kind)} is not a part`);
    }
    const x = integerAt(raw, 'x', at);
    const y = integerAt(raw, 'y', at);
    const rotation = raw['rotation'];
    if (rotation !== undefined && rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
      throw new CircuitFileError(`${at}.rotation: ${JSON.stringify(rotation)} is not 0, 90, 180 or 270`);
    }
    const label = raw['label'];
    if (label !== undefined && typeof label !== 'string') throw new CircuitFileError(`${at}.label: not a string`);
    const value = raw['value'];
    if (value !== undefined && value !== 0 && value !== 1) throw new CircuitFileError(`${at}.value: not 0 or 1`);
    const rate = raw['rate'];
    if (rate !== undefined && !(typeof rate === 'number' && rate > 0 && Number.isFinite(rate))) {
      throw new CircuitFileError(`${at}.rate: not a positive number`);
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
      ...(rate !== undefined ? { rate } : {})
    });
  }

  const wires: Wire[] = [];
  for (const [n, raw] of arrayAt(data, 'wires').entries()) {
    const at = `wires[${n}]`;
    if (!isRecord(raw)) throw new CircuitFileError(`${at}: not an object`);
    const id = idAt(raw, at, ids);
    const end = (side: 'from' | 'to') => {
      const ref = raw[side];
      if (!isRecord(ref) || typeof ref['component'] !== 'string' || typeof ref['pin'] !== 'string') {
        throw new CircuitFileError(`${at}.${side}: not a pin`);
      }
      const kind = kinds.get(ref['component']);
      if (kind === undefined) {
        throw new CircuitFileError(`${at}.${side}: no component ${JSON.stringify(ref['component'])}`);
      }
      const pins = PINS[kind];
      if (!pins.inputs.includes(ref['pin']) && !pins.outputs.includes(ref['pin'])) {
        throw new CircuitFileError(`${at}.${side}: a ${kind} has no pin ${JSON.stringify(ref['pin'])}`);
      }
      return { component: ref['component'], pin: ref['pin'] };
    };
    wires.push({ id, from: end('from'), to: end('to') });
  }
  return { version: CIRCUIT_VERSION, components, wires };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayAt(data: Record<string, unknown>, key: string): unknown[] {
  const value = data[key];
  if (!Array.isArray(value)) throw new CircuitFileError(`${key}: missing or not a list`);
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
