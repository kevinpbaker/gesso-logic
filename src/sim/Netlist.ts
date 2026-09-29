import { pinName, type Circuit, type Component, type PinRef } from './Circuit';
import { GATE_KINDS, isGate, PINS } from './Primitives';

/**
 * A circuit compiled for running: nets as integers, gates as rows of
 * typed arrays.
 *
 * Every pin belongs to exactly one net, including a pin nothing is wired
 * to, which is a net of one. A net has at most one driver — an output
 * pin — and a net with none reads 0, because the logic is two-state and
 * there is no Z. Gates are indexed in document order, so the same
 * document always compiles to the same numbers.
 */
export interface Netlist {
  readonly netCount: number;
  readonly gateCount: number;
  /** Per gate: its kind as an index into `GATE_KINDS` and `TRUTH`, its two input nets and its output net. */
  readonly type: Uint8Array;
  readonly in0: Int32Array;
  readonly in1: Int32Array;
  readonly out: Int32Array;
  /** Fan-out in CSR form: the gates reading net n are `fanGate[fanStart[n] .. fanStart[n + 1])`. */
  readonly fanStart: Int32Array;
  readonly fanGate: Int32Array;
  /** Nets driven by sources, by component id, with the value each starts at. */
  readonly inputs: ReadonlyMap<string, { readonly net: number; readonly value: 0 | 1 }>;
  readonly constants: ReadonlyMap<string, { readonly net: number; readonly value: 0 | 1 }>;
  readonly clocks: readonly number[];
  /** The net each pin is on, keyed `component.pin` by id. */
  readonly pinNet: ReadonlyMap<string, number>;
  /** A name per net for reports: its driver's pin, as `label.pin`, or its first pin when undriven. */
  readonly netNames: readonly string[];
  /** Nets some pin reads that nothing drives. Not an error: they read 0. */
  readonly floating: readonly number[];
}

export class CircuitError extends Error {
  constructor(
    readonly code: 'duplicate-id' | 'unknown-component' | 'unknown-pin' | 'short' | 'version',
    message: string
  ) {
    super(message);
    this.name = 'CircuitError';
  }
}

export function pinKey(ref: PinRef): string {
  return `${ref.component}.${ref.pin}`;
}

export function compile(circuit: Circuit): Netlist {
  if (circuit.version !== 1) {
    throw new CircuitError('version', `This build reads circuit version 1, not ${String(circuit.version)}.`);
  }

  // Every pin gets an index, in document order: component by component,
  // inputs before outputs.
  const byId = new Map<string, Component>();
  const pinIndex = new Map<string, number>();
  const pins: PinRef[] = [];
  const driving: boolean[] = [];
  for (const component of circuit.components) {
    if (byId.has(component.id)) {
      throw new CircuitError('duplicate-id', `Two components have the id '${component.id}'.`);
    }
    byId.set(component.id, component);
    const spec = PINS[component.kind];
    for (const [pinList, drives] of [
      [spec.inputs, false],
      [spec.outputs, true]
    ] as const) {
      for (const pin of pinList) {
        const ref = { component: component.id, pin };
        pinIndex.set(pinKey(ref), pins.length);
        pins.push(ref);
        driving.push(drives);
      }
    }
  }

  // Wires join pins into nets.
  const parent = pins.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const indexOf = (ref: PinRef, wire: string): number => {
    const component = byId.get(ref.component);
    if (component === undefined) {
      throw new CircuitError('unknown-component', `Wire '${wire}' names a component '${ref.component}' that is not in the circuit.`);
    }
    const index = pinIndex.get(pinKey(ref));
    if (index === undefined) {
      const spec = PINS[component.kind];
      throw new CircuitError(
        'unknown-pin',
        `Wire '${wire}' names pin '${ref.pin}' on ${component.kind} '${component.label ?? component.id}', which has ${[...spec.inputs, ...spec.outputs].join(', ')}.`
      );
    }
    return index;
  };
  for (const wire of circuit.wires) {
    const a = find(indexOf(wire.from, wire.id));
    const b = find(indexOf(wire.to, wire.id));
    if (a !== b) {
      parent[Math.max(a, b)] = Math.min(a, b);
    }
  }

  // Number the nets in order of their first pin, and find each one's
  // driver. Two drivers on one net is a short, and no answer is right,
  // so it is refused rather than resolved.
  const netOfRoot = new Map<number, number>();
  const pinNetIndex = new Int32Array(pins.length);
  const drivers: number[] = [];
  const firstPin: number[] = [];
  for (let i = 0; i < pins.length; i++) {
    const root = find(i);
    let net = netOfRoot.get(root);
    if (net === undefined) {
      net = netOfRoot.size;
      netOfRoot.set(root, net);
      drivers.push(-1);
      firstPin.push(i);
    }
    pinNetIndex[i] = net;
    if (driving[i]) {
      if (drivers[net] !== -1) {
        throw new CircuitError(
          'short',
          `${pinName(circuit, pins[drivers[net]])} and ${pinName(circuit, pins[i])} both drive the same net.`
        );
      }
      drivers[net] = i;
    }
  }
  const netCount = netOfRoot.size;
  const netOf = (component: string, pin: string) => pinNetIndex[pinIndex.get(`${component}.${pin}`)!];

  // Gates, sources and outputs.
  const types: number[] = [];
  const ins0: number[] = [];
  const ins1: number[] = [];
  const outs: number[] = [];
  const inputs = new Map<string, { net: number; value: 0 | 1 }>();
  const constants = new Map<string, { net: number; value: 0 | 1 }>();
  const clocks: number[] = [];
  const read = new Uint8Array(netCount);
  for (const component of circuit.components) {
    const { id, kind } = component;
    if (isGate(kind)) {
      const a = netOf(id, 'a');
      const b = kind === 'not' ? a : netOf(id, 'b');
      types.push(GATE_KINDS.indexOf(kind));
      ins0.push(a);
      ins1.push(b);
      outs.push(netOf(id, 'out'));
      read[a] = 1;
      read[b] = 1;
    } else if (kind === 'input') {
      inputs.set(id, { net: netOf(id, 'out'), value: component.value ?? 0 });
    } else if (kind === 'constant') {
      constants.set(id, { net: netOf(id, 'out'), value: component.value ?? 0 });
    } else if (kind === 'clock') {
      clocks.push(netOf(id, 'out'));
    } else {
      read[netOf(id, 'in')] = 1;
    }
  }
  const gateCount = types.length;
  const in0 = Int32Array.from(ins0);
  const in1 = Int32Array.from(ins1);

  // Fan-out, packed contiguously. A gate whose two inputs share a net is
  // listed once, so a change there wakes it once.
  const fanStart = new Int32Array(netCount + 1);
  for (let g = 0; g < gateCount; g++) {
    fanStart[in0[g] + 1]++;
    if (in1[g] !== in0[g]) {
      fanStart[in1[g] + 1]++;
    }
  }
  for (let n = 0; n < netCount; n++) {
    fanStart[n + 1] += fanStart[n];
  }
  const fill = fanStart.slice(0, netCount);
  const fanGate = new Int32Array(fanStart[netCount]);
  for (let g = 0; g < gateCount; g++) {
    fanGate[fill[in0[g]]++] = g;
    if (in1[g] !== in0[g]) {
      fanGate[fill[in1[g]]++] = g;
    }
  }

  const pinNet = new Map<string, number>();
  pins.forEach((ref, i) => pinNet.set(pinKey(ref), pinNetIndex[i]));
  const netNames = drivers.map((driver, net) => pinName(circuit, pins[driver === -1 ? firstPin[net] : driver]));
  const floating: number[] = [];
  for (let net = 0; net < netCount; net++) {
    if (drivers[net] === -1 && read[net] === 1) {
      floating.push(net);
    }
  }

  return {
    netCount,
    gateCount,
    type: Uint8Array.from(types),
    in0,
    in1,
    out: Int32Array.from(outs),
    fanStart,
    fanGate,
    inputs,
    constants,
    clocks,
    pinNet,
    netNames,
    floating
  };
}
