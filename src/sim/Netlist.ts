import type { Circuit, Component, PinRef } from './Circuit';
import { chipInterface, pinsOf } from './Chips';
import { bitPins, GATE_KINDS, isGate, isSettable, ROM_WORDS, widthOf, type GateKind, type PinSpec } from './Primitives';

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
/** A ROM as the simulator runs it: see `MemoryKind` in `Primitives.ts`. */
export interface RomPart {
  readonly words: Uint16Array;
  readonly address: Int32Array;
  readonly data: Int32Array;
  readonly table: Int32Array;
  readonly tableData: Int32Array;
}

export interface Netlist {
  /** How many net numbers there are: with stable numbering, some may be unused (see `compile`). */
  readonly netCount: number;
  /** How many nets there are. */
  readonly liveNetCount: number;
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
  /** Each ROM: its words, and the nets of its two ports, least significant bit first. */
  readonly roms: readonly RomPart[];
  /** The net each pin is on, keyed `component.pin` by id. */
  readonly pinNet: ReadonlyMap<string, number>;
  /**
   * The net a pin is on, by component id and pin name (`in[3]` for a bus
   * bit), or undefined for no such pin. What `pinNet` answers, without
   * the thirty thousand string keys it is built from: `pinNet` is made
   * the first time something asks for it, and an edit to a running
   * circuit need never ask.
   */
  readonly netOfPin: (component: string, pin: string) => number | undefined;
  /**
   * For a netlist numbered against a previous one: the previous netlist,
   * and for each net here the net there whose value it carries on — its
   * own number when it kept it, the net it split from when it is new, -1
   * when it has no past. Lets a simulator adopt the running state by
   * copying values rather than by looking every pin up.
   */
  readonly numberedAgainst: Netlist | null;
  /**
   * With `numberedAgainst`: every component, by full id, one of whose
   * pins is on a net numbered differently from before, or that is new.
   * Everything else reads the same nets it did. Null otherwise.
   */
  readonly changedComponents: ReadonlySet<string> | null;
  /** With `changedComponents`: the nets those moved pins are on now. */
  readonly changedNets: readonly number[] | null;
  readonly carriedFrom: Int32Array | null;
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

export type CircuitErrorCode =
  | 'duplicate-id'
  | 'unknown-component'
  | 'unknown-pin'
  | 'short'
  | 'version'
  | 'unknown-chip'
  | 'recursive-chip'
  | 'width';

// A plain field rather than a parameter property, so Node can run this
// file with its types stripped (`pnpm speed`).
export class CircuitError extends Error {
  readonly code: CircuitErrorCode;

  constructor(code: CircuitErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CircuitError';
  }
}

export function pinKey(ref: PinRef): string {
  return `${ref.component}.${ref.pin}`;
}

/** A component as the walk placed it: its full id, and where its pins start in the flat list. */
interface Placed {
  readonly component: Component;
  readonly id: string;
  readonly base: number;
  readonly spec: PinSpec;
  /** Each pin's offset from `base`: a bus pin's bits follow it. */
  readonly offsets: ReadonlyMap<string, number>;
  /** How many pins it has, from `base` on. */
  readonly count: number;
  /** A chip's definition, whose interface its pins are. */
  readonly definition?: Circuit;
}

/** What the next compile against a netlist reads from it: each placed component, and each pin's net. */
const internals = new WeakMap<Netlist, { placedById: ReadonlyMap<string, Placed>; pinNetIndex: Int32Array }>();

const offsetCache = new WeakMap<PinSpec, ReadonlyMap<string, number>>();

/** Where each of a spec's pins starts, in the order the walk adds them: inputs, then outputs, a bit each. */
function offsetsOf(spec: PinSpec): ReadonlyMap<string, number> {
  const cached = offsetCache.get(spec);
  if (cached !== undefined) return cached;
  const offsets = new Map<string, number>();
  let at = 0;
  for (const pin of [...spec.inputs, ...spec.outputs]) {
    offsets.set(pin, at);
    at += widthOf(spec, pin);
  }
  offsetCache.set(spec, offsets);
  return offsets;
}

const GATE_INDEX = Object.fromEntries(GATE_KINDS.map((kind, i) => [kind, i])) as Record<GateKind, number>;

/**
 * Compiles a circuit. With `previous`, the netlist of the same document a
 * moment ago, nets are numbered stably: a net keeps the number it had,
 * found through any of its pins that existed then, and only a net with
 * no past, or one split from a net whose number the other side kept, gets
 * a new one. So an edit renumbers only what it touched, and whatever
 * reads nets by number — the render worker's geometry and signals — sees
 * only that change. When the numbers have grown sparse, more than twice
 * the nets there are, they are packed again from zero, as without
 * `previous`.
 */
export function compile(circuit: Circuit, previous?: Netlist): Netlist {
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
  //
  // Wires are resolved to pin indices as the walk meets them, by each
  // component's first pin and each pin's offset from it, and a pin's key
  // is built once, for `pinNet`: looking every wire's ends up by string
  // was most of what a compile of ten thousand gates cost.
  const pinComponent: string[] = [];
  const pinName: string[] = [];
  const driving: number[] = [];
  /** Every part that does something, at every depth: its full id, and where its pins are. */
  const parts: Placed[] = [];
  /** Wires, and the joins at chips' edges, as pairs of pin indices. */
  const linkFrom: number[] = [];
  const linkTo: number[] = [];
  const chips = circuit.chips ?? {};
  /** Every component at every depth, in the walk's order, and by full id: for `netOfPin` and messages. */
  const everyPlaced: Placed[] = [];
  const placedById = new Map<string, Placed>();
  const addPins = (id: string, spec: PinSpec, pins: readonly string[], drives: number) => {
    for (const pin of pins) {
      const width = widthOf(spec, pin);
      for (let i = 0; i < width; i++) {
        pinComponent.push(id);
        pinName.push(width === 1 ? pin : `${pin}[${i}]`);
        driving.push(drives);
      }
    }
  };
  const place = (component: Component, id: string, spec: PinSpec, drives: boolean, definition?: Circuit): Placed => {
    const base = pinComponent.length;
    addPins(id, spec, spec.inputs, 0);
    addPins(id, spec, spec.outputs, drives ? 1 : 0);
    const placed: Placed = { component, id, base, spec, offsets: offsetsOf(spec), count: pinComponent.length - base, definition };
    placedById.set(id, placed);
    everyPlaced.push(placed);
    return placed;
  };
  const walk = (level: Circuit, prefix: string, inside: readonly string[]): Map<string, Placed> => {
    /** Each component on this level, by its id here. */
    const here = new Map<string, Placed>();
    for (const component of level.components) {
      if (here.has(component.id)) {
        throw new CircuitError('duplicate-id', `Two components have the id '${prefix}${component.id}'.`);
      }
      const id = prefix + component.id;
      if (component.kind === 'chip') {
        const name = component.chip ?? '';
        const definition = chips[name];
        if (definition === undefined) {
          throw new CircuitError('unknown-chip', `Chip '${id}' uses '${name}', which the document does not define.`);
        }
        if (inside.includes(name)) {
          throw new CircuitError('recursive-chip', `Chip '${name}' contains itself, by way of ${[...inside, name].join(' › ')}.`);
        }
        const outer = place(component, id, pinsOf(component, chips), false, definition);
        here.set(component.id, outer);
        const within = walk(definition, `${id}/`, [...inside, name]);
        const face = chipInterface(definition);
        for (const [pins, inner] of [
          [face.inputs, 'out'],
          [face.outputs, 'in']
        ] as const) {
          for (const pin of pins) {
            const edge = within.get(pin.component)!;
            const from = outer.base + outer.offsets.get(pin.name)!;
            const to = edge.base + edge.offsets.get(inner)!;
            for (let i = 0; i < pin.width; i++) {
              linkFrom.push(from + i);
              linkTo.push(to + i);
            }
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
      const placed = place(component, id, spec, !edge && !bus);
      here.set(component.id, placed);
      // A named wire is joined to its namesakes below; a note is words.
      if (component.kind === 'tunnel' || component.kind === 'note') continue;
      if (bus) {
        const busPin = component.kind === 'split' ? 'in' : 'out';
        const ones = component.kind === 'split' ? spec.outputs : spec.inputs;
        const busAt = placed.base + placed.offsets.get(busPin)!;
        ones.forEach((one, i) => {
          linkFrom.push(busAt + i);
          linkTo.push(placed.base + placed.offsets.get(one)!);
        });
      } else if (!edge) {
        parts.push(placed);
      }
    }
    // Named wires of one name on this level are one net, bit for bit.
    const named = new Map<string, Placed>();
    for (const component of level.components) {
      if (component.kind !== 'tunnel') continue;
      const name = (component.label ?? '').trim();
      if (name === '') continue;
      const placed = here.get(component.id)!;
      const first = named.get(name);
      if (first === undefined) {
        named.set(name, placed);
        continue;
      }
      const width = widthOf(placed.spec, 'io');
      if (width !== widthOf(first.spec, 'io')) {
        throw new CircuitError(
          'width',
          `Two wires named '${name}' are ${widthOf(first.spec, 'io')} and ${width} bits wide: a name joins wires of one width.`
        );
      }
      for (let i = 0; i < width; i++) {
        linkFrom.push(first.base + first.offsets.get('io')! + i);
        linkTo.push(placed.base + placed.offsets.get('io')! + i);
      }
    }
    for (const wire of level.wires) {
      // A wire is as wide as its pins, which must agree; a bus wire is a
      // link per bit.
      const end = (ref: PinRef): { at: number; width: number } => {
        const placed = here.get(ref.component);
        if (placed === undefined) {
          throw new CircuitError('unknown-component', `Wire '${prefix}${wire.id}' names a component '${prefix}${ref.component}' that is not in the circuit.`);
        }
        const offset = placed.offsets.get(ref.pin);
        if (offset === undefined) {
          const known = [...placed.spec.inputs, ...placed.spec.outputs];
          throw new CircuitError(
            'unknown-pin',
            `Wire '${prefix}${wire.id}' names pin '${ref.pin}' on ${placed.component.kind} '${placed.component.label ?? placed.id}', which has ${known.join(', ')}.`
          );
        }
        return { at: placed.base + offset, width: widthOf(placed.spec, ref.pin) };
      };
      const from = end(wire.from);
      const to = end(wire.to);
      if (from.width !== to.width) {
        throw new CircuitError(
          'width',
          `Wire '${prefix}${wire.id}' joins ${wire.from.component}.${wire.from.pin}, ${from.width} bits wide, to ${wire.to.component}.${wire.to.pin}, ${to.width}.`
        );
      }
      for (let i = 0; i < from.width; i++) {
        linkFrom.push(from.at + i);
        linkTo.push(to.at + i);
      }
    }
    return here;
  };
  walk(circuit, '', []);
  const pinCount = pinComponent.length;

  /**
   * A pin as people read it: its component's label, or id, and the pin —
   * inside a chip, after the instance's path.
   */
  const nameOf = (index: number): string => {
    const id = pinComponent[index]!;
    const component = placedById.get(id)?.component;
    const slash = id.lastIndexOf('/');
    return `${id.slice(0, slash + 1)}${component?.label ?? id.slice(slash + 1)}.${pinName[index]}`;
  };

  // Wires join pins into nets.
  const parent = new Int32Array(pinCount);
  for (let i = 0; i < pinCount; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let l = 0; l < linkFrom.length; l++) {
    const a = find(linkFrom[l]!);
    const b = find(linkTo[l]!);
    if (a !== b) {
      parent[Math.max(a, b)] = Math.min(a, b);
    }
  }

  // Number the nets, and find each one's driver. Two drivers on one net
  // is a short, and no answer is right, so it is refused rather than
  // resolved. A root is always a net's lowest pin.
  const netOfRoot = new Int32Array(pinCount).fill(-1);
  const pinNetIndex = new Int32Array(pinCount);
  let netTotal = 0;
  let carried: number[] | null = null;
  /** The old net of each pin, for telling afterwards which pins moved; -1 for a pin that is new. */
  const oldNet = previous === undefined ? null : new Int32Array(pinCount).fill(-1);
  if (previous !== undefined) {
    // A component that is the same document object as before, placed the
    // same way — for a chip, from the same definition — has its pins in
    // the same order, and their old nets are a copy. Anything else is
    // looked up pin by pin.
    const before = internals.get(previous);
    for (const placed of everyPlaced) {
      const was = before?.placedById.get(placed.id);
      if (was !== undefined && was.component === placed.component && was.count === placed.count && was.definition === placed.definition) {
        oldNet!.set(before!.pinNetIndex.subarray(was.base, was.base + was.count), placed.base);
      } else {
        for (let i = placed.base; i < placed.base + placed.count; i++) {
          oldNet![i] = previous.netOfPin(pinComponent[i]!, pinName[i]!) ?? -1;
        }
      }
    }
  }
  if (previous !== undefined) {
    // First, every net that can keep a number it had does: the first of
    // its pins, in order, whose old net no one here has claimed yet.
    const claimed = new Uint8Array(previous.netCount);
    const origin: number[] = [];
    /** For a net whose old number another took: the old net its value comes from, by root. */
    const pending = new Map<number, number>();
    let highest = -1;
    for (let i = 0; i < pinCount; i++) {
      const root = find(i);
      const old = oldNet![i]!;
      if (old === -1) continue;
      if (netOfRoot[root] === -1 && claimed[old] === 0) {
        claimed[old] = 1;
        netOfRoot[root] = old;
        origin[old] = old;
        if (old > highest) highest = old;
      } else if (netOfRoot[root] === -1 && !pending.has(root)) {
        // Remember where a net whose old number is taken came from, for
        // its value; it is numbered below.
        pending.set(root, old);
      }
    }
    // Then the rest, above everything kept.
    let next = Math.max(highest + 1, 0);
    let live = 0;
    for (let i = 0; i < pinCount; i++) {
      const root = find(i);
      if (i === root) live++;
      if (netOfRoot[root] === -1) {
        netOfRoot[root] = next;
        origin[next] = pending.get(root) ?? -1;
        next++;
      }
    }
    if (next <= 2 * live) {
      netTotal = next;
      carried = origin;
    } else {
      netOfRoot.fill(-1);
    }
  }
  if (carried === null) {
    for (let i = 0; i < pinCount; i++) {
      const root = find(i);
      if (netOfRoot[root] === -1) netOfRoot[root] = netTotal++;
    }
  }
  const drivers: number[] = new Array(netTotal).fill(-1);
  const firstPin: number[] = new Array(netTotal).fill(-1);
  for (let i = 0; i < pinCount; i++) {
    const net = netOfRoot[find(i)]!;
    pinNetIndex[i] = net;
    if (firstPin[net] === -1) firstPin[net] = i;
    if (driving[i]) {
      if (drivers[net] !== -1) {
        throw new CircuitError('short', `${nameOf(drivers[net]!)} and ${nameOf(i)} both drive the same net.`);
      }
      drivers[net] = i;
    }
  }
  const netCount = drivers.length;
  const netOf = (placed: Placed, pin: string) => pinNetIndex[placed.base + placed.offsets.get(pin)!]!;

  // Gates, sources and outputs.
  const types: number[] = [];
  const ins0: number[] = [];
  const ins1: number[] = [];
  const outs: number[] = [];
  const inputs = new Map<string, Source>();
  const constants = new Map<string, Source>();
  const clocks: number[] = [];
  const roms: RomPart[] = [];
  const read = new Uint8Array(netCount);
  const bitsOf = (placed: Placed, pin: string, width: number) => {
    const at = placed.base + placed.offsets.get(pin)!;
    return Array.from({ length: width }, (_, i) => pinNetIndex[at + i]!);
  };
  for (const placed of parts) {
    const { component, id } = placed;
    const kind = component.kind;
    if (isGate(kind)) {
      const a = netOf(placed, 'a');
      const b = kind === 'not' ? a : netOf(placed, 'b');
      types.push(GATE_INDEX[kind]);
      ins0.push(a);
      ins1.push(b);
      outs.push(netOf(placed, 'out'));
      read[a] = 1;
      read[b] = 1;
    } else if (isSettable(kind) || kind === 'constant') {
      const nets = bitsOf(placed, 'out', kind === 'button' ? 1 : (component.width ?? 1));
      (kind === 'constant' ? constants : inputs).set(id, { net: nets[0]!, nets, value: component.value ?? 0 });
    } else if (kind === 'clock') {
      clocks.push(netOf(placed, 'out'));
    } else if (kind === 'rom') {
      const words = new Uint16Array(ROM_WORDS);
      words.set((component.rom ?? []).slice(0, ROM_WORDS));
      const port = (pin: string, width: number) => Int32Array.from(bitsOf(placed, pin, width));
      const rom: RomPart = { words, address: port('A', 8), data: port('D', 16), table: port('T', 8), tableData: port('Q', 8) };
      for (const net of [...rom.address, ...rom.table]) read[net] = 1;
      roms.push(rom);
    } else {
      for (const pin of placed.spec.inputs) {
        for (const net of bitsOf(placed, pin, widthOf(placed.spec, pin))) read[net] = 1;
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

  let pinNet: Map<string, number> | null = null;
  const netOfPin = (component: string, pin: string): number | undefined => {
    const placed = placedById.get(component);
    if (placed === undefined) return undefined;
    const bracket = pin.indexOf('[');
    const offset = placed.offsets.get(bracket < 0 ? pin : pin.slice(0, bracket));
    if (offset === undefined) return undefined;
    const bit = bracket < 0 ? 0 : Number(pin.slice(bracket + 1, -1));
    return pinNetIndex[placed.base + offset + bit];
  };
  const floating: number[] = [];
  for (let net = 0; net < netCount; net++) {
    if (drivers[net] === -1 && firstPin[net] !== -1 && read[net] === 1) {
      floating.push(net);
    }
  }

  let moved: { components: Set<string>; nets: number[] } | null = null;
  if (carried !== null && oldNet !== null) {
    moved = { components: new Set(), nets: [] };
    for (let i = 0; i < pinCount; i++) {
      if (oldNet[i] !== pinNetIndex[i]) {
        moved.components.add(pinComponent[i]!);
        moved.nets.push(pinNetIndex[i]!);
      }
    }
  }
  let netNames: string[] | null = null;
  const netlist: Netlist = {
    netCount,
    liveNetCount: firstPin.reduce((n, pin) => (pin === -1 ? n : n + 1), 0),
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
    roms,
    get pinNet(): ReadonlyMap<string, number> {
      if (pinNet === null) {
        pinNet = new Map();
        for (let i = 0; i < pinCount; i++) pinNet.set(`${pinComponent[i]}.${pinName[i]}`, pinNetIndex[i]!);
      }
      return pinNet;
    },
    netOfPin,
    get netNames(): readonly string[] {
      // A number no net holds — one left behind by a merge — is named ''.
      netNames ??= drivers.map((driver, net) => (driver === -1 && firstPin[net] === -1 ? '' : nameOf(driver === -1 ? firstPin[net]! : driver)));
      return netNames;
    },
    floating,
    numberedAgainst: carried === null ? null : (previous ?? null),
    changedComponents: moved?.components ?? null,
    changedNets: moved?.nets ?? null,
    carriedFrom: carried === null ? null : Int32Array.from({ length: netCount }, (_, net) => carried![net] ?? -1)
  };
  internals.set(netlist, { placedById, pinNetIndex });
  return netlist;
}
