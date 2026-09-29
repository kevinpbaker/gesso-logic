import { pinName, type Circuit, type Component, type PinRef } from './Circuit';
import { chipInterface, pinsOf } from './Chips';
import { bitPins, GATE_KINDS, isGate, isSettable, widthOf, type PinSpec } from './Primitives';

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
  readonly inputs: ReadonlyMap<string, Source>;
  readonly constants: ReadonlyMap<string, Source>;
  readonly clocks: readonly number[];
  /** The net each pin is on, keyed `component.pin` by id. */
  readonly pinNet: ReadonlyMap<string, number>;
  /** A name per net for reports: its driver's pin, as `label.pin`, or its first pin when undriven. */
  readonly netNames: readonly string[];
  /** Nets some pin reads that nothing drives. Not an error: they read 0. */
  readonly floating: readonly number[];
}

/**
 * A switch or constant: the nets it drives, least significant bit first,
 * and the value it starts at. `net` is the first, which is all there is
 * for one a bit wide.
 */
export interface Source {
  readonly net: number;
  readonly nets: readonly number[];
  readonly value: number;
}

export class CircuitError extends Error {
  constructor(
    readonly code:
      | 'duplicate-id'
      | 'unknown-component'
      | 'unknown-pin'
      | 'short'
      | 'version'
      | 'unknown-chip'
      | 'recursive-chip'
      | 'width',
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
  // inputs before outputs, and a chip's insides after its own pins.
  //
  // The hierarchy is flattened here and nowhere else. A chip instance
  // `fa3` has its own pins, which outside wires reach, and its
  // definition's parts under the prefix `fa3/`. The definition's
  // switches and LEDs are its interface: inside an instance they are not
  // sources or sinks, only points its pins join — `fa3.a` to
  // `fa3/a.out`, `fa3/s.in` to `fa3.s` — so a net runs straight through
  // the chip's edge as if the switch were a length of wire.
  const pinIndex = new Map<string, number>();
  const pins: PinRef[] = [];
  const driving: boolean[] = [];
  /** Every part that does something, at every depth, under its full id. */
  const parts: Component[] = [];
  /** Wires, and the joins at chips' edges, as pairs of pin keys. */
  const links: { readonly from: PinRef; readonly to: PinRef; readonly id: string }[] = [];
  const chips = circuit.chips ?? {};
  /** Every component at every depth, by full id, for messages that name one. */
  const named = new Map<string, Component>();
  const addPin = (component: string, pin: string, drives: boolean) => {
    const ref = { component, pin };
    pinIndex.set(pinKey(ref), pins.length);
    pins.push(ref);
    driving.push(drives);
  };
  const walk = (level: Circuit, prefix: string, inside: readonly string[]) => {
    const ids = new Set<string>();
    /** Each component's pins on this level, for the widths of the wires between them. */
    const specs = new Map<string, PinSpec>();
    for (const component of level.components) {
      if (ids.has(component.id)) {
        throw new CircuitError('duplicate-id', `Two components have the id '${prefix}${component.id}'.`);
      }
      ids.add(component.id);
      const id = prefix + component.id;
      named.set(id, component);
      if (component.kind === 'chip') {
        const name = component.chip ?? '';
        const definition = chips[name];
        if (definition === undefined) {
          throw new CircuitError('unknown-chip', `Chip '${id}' uses '${name}', which the document does not define.`);
        }
        if (inside.includes(name)) {
          throw new CircuitError('recursive-chip', `Chip '${name}' contains itself, by way of ${[...inside, name].join(' › ')}.`);
        }
        const face = chipInterface(definition);
        specs.set(component.id, pinsOf(component, chips));
        for (const pin of [...face.inputs, ...face.outputs]) {
          for (const bit of bitPins(pin.name, pin.width)) addPin(id, bit, false);
        }
        walk(definition, `${id}/`, [...inside, name]);
        for (const [pins, inner] of [
          [face.inputs, 'out'],
          [face.outputs, 'in']
        ] as const) {
          for (const pin of pins) {
            const outer = bitPins(pin.name, pin.width);
            const edge = bitPins(inner, pin.width);
            outer.forEach((bit, i) => {
              links.push({ from: { component: id, pin: bit }, to: { component: `${id}/${pin.component}`, pin: edge[i]! }, id: `${id}.${pin.name}` });
            });
          }
        }
        continue;
      }
      // A chip's switches and LEDs are its edge, not parts: their pins
      // exist for wires to reach, and drive and read nothing.
      const edge = inside.length > 0 && (component.kind === 'input' || component.kind === 'output');
      // A split or join is wiring: its pins drive nothing, and its bus
      // pin's bits are joined to its one-bit pins.
      const bus = component.kind === 'split' || component.kind === 'join';
      const spec = pinsOf(component, chips);
      specs.set(component.id, spec);
      for (const pin of spec.inputs) {
        for (const bit of bitPins(pin, widthOf(spec, pin))) addPin(id, bit, false);
      }
      for (const pin of spec.outputs) {
        for (const bit of bitPins(pin, widthOf(spec, pin))) addPin(id, bit, !edge && !bus);
      }
      if (bus) {
        const busPin = component.kind === 'split' ? 'in' : 'out';
        const ones = component.kind === 'split' ? spec.outputs : spec.inputs;
        bitPins(busPin, widthOf(spec, busPin)).forEach((bit, i) => {
          links.push({ from: { component: id, pin: bit }, to: { component: id, pin: ones[i]! }, id: `${id}.${ones[i]}` });
        });
      } else if (!edge) {
        parts.push({ ...component, id });
      }
    }
    for (const wire of level.wires) {
      // A wire is as wide as its pins, which must agree; a bus wire is a
      // link per bit.
      const fromSpec = specs.get(wire.from.component);
      const toSpec = specs.get(wire.to.component);
      const fromWidth = fromSpec === undefined ? 1 : widthOf(fromSpec, wire.from.pin);
      const toWidth = toSpec === undefined ? 1 : widthOf(toSpec, wire.to.pin);
      if (fromSpec !== undefined && toSpec !== undefined && fromWidth !== toWidth) {
        throw new CircuitError(
          'width',
          `Wire '${prefix}${wire.id}' joins ${wire.from.component}.${wire.from.pin}, ${fromWidth} bits wide, to ${wire.to.component}.${wire.to.pin}, ${toWidth}.`
        );
      }
      const fromBits = bitPins(wire.from.pin, fromWidth);
      const toBits = bitPins(wire.to.pin, toWidth);
      fromBits.forEach((bit, i) => {
        links.push({
          from: { component: prefix + wire.from.component, pin: bit },
          to: { component: prefix + wire.to.component, pin: toBits[i]! },
          id: prefix + wire.id
        });
      });
    }
  };
  walk(circuit, '', []);

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
    const index = pinIndex.get(pinKey(ref));
    if (index === undefined) {
      const component = named.get(ref.component);
      if (component === undefined) {
        throw new CircuitError('unknown-component', `Wire '${wire}' names a component '${ref.component}' that is not in the circuit.`);
      }
      const known = pins.filter(p => p.component === ref.component).map(p => p.pin);
      throw new CircuitError(
        'unknown-pin',
        `Wire '${wire}' names pin '${ref.pin}' on ${component.kind} '${component.label ?? ref.component}', which has ${known.join(', ')}.`
      );
    }
    return index;
  };
  for (const link of links) {
    const a = find(indexOf(link.from, link.id));
    const b = find(indexOf(link.to, link.id));
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
  const inputs = new Map<string, Source>();
  const constants = new Map<string, Source>();
  const bitsOf = (id: string, pin: string, width: number) => bitPins(pin, width).map(bit => netOf(id, bit));
  const clocks: number[] = [];
  const read = new Uint8Array(netCount);
  for (const component of parts) {
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
    } else if (isSettable(kind) || kind === 'constant') {
      const nets = bitsOf(id, 'out', kind === 'button' ? 1 : (component.width ?? 1));
      (kind === 'constant' ? constants : inputs).set(id, { net: nets[0]!, nets, value: component.value ?? 0 });
    } else if (kind === 'clock') {
      clocks.push(netOf(id, 'out'));
    } else {
      const spec = pinsOf(component, chips);
      for (const pin of spec.inputs) {
        for (const net of bitsOf(id, pin, widthOf(spec, pin))) read[net] = 1;
      }
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
