import { CIRCUIT_VERSION, type Circuit, type Component, type PinRef, type Wire } from '../sim/Circuit';
import { compile, CircuitError } from '../sim/Netlist';
import { pinsOf } from '../sim/Chips';
import { bitPins, isGate, isSettable, widthOf } from '../sim/Primitives';
import { Simulator } from '../sim/Simulator';

/**
 * The truth table of a selection: every combination of its inputs, and
 * what its outputs settle to for each.
 *
 * Worked out on nets, not wires, against the whole circuit's netlist, so
 * what counts as "entering" the selection is exact however the wires
 * happen to be drawn:
 *
 *   - **inputs** — switches and buttons in the selection, and every net
 *     a selected gate reads that no selected gate drives, in order of
 *     first appearance;
 *   - **outputs** — nets a selected gate drives that something outside
 *     the selection reads, or that an LED, probe or display in the
 *     selection shows. A selection that feeds nothing, like a whole
 *     circuit with no LEDs, falls back to the nets its gates drive and
 *     no selected gate reads.
 *
 * The selected gates are copied into a circuit of their own, with a
 * switch on each input and nothing else, and swept. A row that does not
 * settle — a selection with a loop in it that rings — says so. A
 * selection with a loop that holds state, like a latch, shows what it
 * settles to from the row before, which for a latch is the honest
 * answer: it depends.
 */
export const MAX_INPUTS = 8;

export interface TruthTable {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** One string per row, a character an output: '0', '1', or '~' where the row rang. Row n sets input i to bit (count - 1 - i) of n, so the first input is the most significant, as tables are written. */
  readonly rows: readonly string[];
}

export type TruthTableResult = { readonly table: TruthTable } | { readonly error: string };

export function truthTable(circuit: Circuit, ids: readonly string[]): TruthTableResult {
  let netlist;
  try {
    netlist = compile(circuit);
  } catch (e) {
    return { error: e instanceof CircuitError ? e.message : String(e) };
  }
  const selected = new Set(ids);
  const chosen = circuit.components.filter(c => selected.has(c.id));
  // The parts that compute: gates, and chips, whose pins come from their
  // definitions and whose insides the swept copy flattens as any circuit.
  const gates = chosen.filter(c => isGate(c.kind) || c.kind === 'chip');
  const pinsOfPart = (c: Component) => pinsOf(c, circuit.chips);
  const netOf = (id: string, pin: string) => netlist.pinNet.get(`${id}.${pin}`) ?? -1;
  /** A pin's nets, a bit each, least significant first. */
  const netsOf = (c: Component, pin: string) => bitPins(pin, widthOf(pinsOfPart(c), pin)).map(bit => netOf(c.id, bit));

  // Which selected part's output drives each net, and which bit of it.
  const driver = new Map<number, { component: string; pin: string; bit: number; width: number }>();
  for (const g of gates) {
    for (const pin of pinsOfPart(g).outputs) {
      const nets = netsOf(g, pin);
      nets.forEach((net, bit) => driver.set(net, { component: g.id, pin, bit, width: nets.length }));
    }
  }
  const bitOf = (d: { pin: string; bit: number; width: number }) => (d.width === 1 ? d.pin : `${d.pin}[${d.bit}]`);

  // The inputs, as the switches of the swept copy: one per outside bus
  // (a one-bit wire is a bus of one), whose bits are the table's columns.
  const groups: { id: string; nets: number[]; names: string[] }[] = [];
  const groupOf = (nets: number[], names: string[]) => {
    const key = nets.join(',');
    const found = groups.find(g => g.nets.join(',') === key);
    if (found !== undefined) return found;
    const group = { id: `in${groups.length}`, nets, names };
    groups.push(group);
    return group;
  };
  for (const c of chosen) {
    if (isSettable(c.kind)) {
      const nets = netsOf(c, 'out');
      const name = c.label ?? c.id;
      groupOf(nets, nets.length === 1 ? [name] : nets.map((_, i) => `${name}[${i}]`));
    }
  }
  const sources = new Map<string, PinRef>();
  for (const g of gates) {
    for (const pin of pinsOfPart(g).inputs) {
      const nets = netsOf(g, pin);
      const driven = nets.map(net => driver.get(net));
      if (driven.every(d => d === undefined)) {
        const group = groupOf(nets, nets.map(net => netlist.netNames[net] ?? `net ${net}`));
        sources.set(`${g.id}.${pin}`, { component: group.id, pin: 'out' });
        continue;
      }
      // Driven from inside: by one selected pin, bit for bit, or it is not
      // something a wire in the copy can say.
      const first = driven[0];
      const whole =
        first !== undefined &&
        first.width === nets.length &&
        driven.every((d, i) => d !== undefined && d.component === first.component && d.pin === first.pin && d.bit === i);
      if (!whole) {
        return { error: `${g.label ?? g.id}.${pin} is a bus driven partly from inside the selection and partly from outside it` };
      }
      sources.set(`${g.id}.${pin}`, { component: first.component, pin: first.pin });
    }
  }
  const inputBits = groups.reduce((n, g) => n + g.nets.length, 0);
  if (inputBits > MAX_INPUTS) {
    return { error: `${inputBits} inputs; a table is swept for at most ${MAX_INPUTS}` };
  }

  // Nets read by selected gates, by selected displays, and by anything outside.
  const readInside = new Set<number>();
  const shown = new Set<number>();
  const readOutside = new Set<number>();
  // An output shown by an LED or probe goes by the LED's name.
  const shownAs = new Map<number, string>();
  for (const c of circuit.components) {
    for (const pin of pinsOf(c, circuit.chips).inputs) {
      const nets = netsOf(c, pin);
      nets.forEach((net, i) => {
        const name = nets.length === 1 ? (c.label ?? c.id) : `${c.label ?? c.id}[${i}]`;
        if (!selected.has(c.id)) {
          readOutside.add(net);
          // An LED or probe outside names the output it shows, unless one
          // inside the selection already does.
          if ((c.kind === 'output' || c.kind === 'probe') && !shownAs.has(net)) shownAs.set(net, name);
        } else if (isGate(c.kind) || c.kind === 'chip') readInside.add(net);
        else {
          shown.add(net);
          if (c.kind === 'output' || c.kind === 'probe') shownAs.set(net, name);
        }
      });
    }
  }
  const inputNets = groups.flatMap(g => g.nets);
  let outputNets = [
    ...[...driver.keys()].filter(net => readOutside.has(net) || shown.has(net)),
    ...inputNets.filter(net => shown.has(net))
  ];
  if (outputNets.length === 0) {
    outputNets = [...driver.keys()].filter(net => !readInside.has(net));
  }
  if (outputNets.length === 0) {
    return { error: 'nothing in the selection drives an output' };
  }

  // The selected parts alone, a switch on every input.
  const components: Component[] = gates.map(g => ({ id: g.id, kind: g.kind, x: 0, y: 0, ...(g.chip === undefined ? {} : { chip: g.chip }) }));
  for (const group of groups) {
    components.push({ id: group.id, kind: 'input', x: 0, y: 0, ...(group.nets.length > 1 ? { width: group.nets.length } : {}) });
  }
  const wires: Wire[] = [];
  for (const g of gates) {
    for (const pin of pinsOfPart(g).inputs) {
      wires.push({ id: `w${wires.length}`, from: sources.get(`${g.id}.${pin}`)!, to: { component: g.id, pin } });
    }
  }
  // A switch that drives an output directly — a selection of one switch
  // and the LED it lights — is still a table.
  const sub = new Simulator(
    compile({ version: CIRCUIT_VERSION, components, wires, ...(circuit.chips === undefined ? {} : { chips: circuit.chips }) })
  );
  sub.settle();
  const readNet = (net: number): string => {
    const d = driver.get(net);
    if (d !== undefined) return String(sub.read(d.component, bitOf(d)));
    const group = groups.find(g => g.nets.includes(net))!;
    const bit = group.nets.indexOf(net);
    return String(sub.read(group.id, group.nets.length === 1 ? 'out' : `out[${bit}]`));
  };

  const rows: string[] = [];
  const count = inputNets.length;
  for (let row = 0; row < 1 << count; row++) {
    // Column i is bit (count - 1 - i) of the row: the first column most significant.
    let column = 0;
    for (const group of groups) {
      let value = 0;
      group.nets.forEach((_, bit) => {
        value |= ((row >> (count - 1 - (column + bit))) & 1) << bit;
      });
      column += group.nets.length;
      sub.set(group.id, value);
    }
    const settled = sub.settle().settled;
    rows.push(outputNets.map(net => (settled ? readNet(net) : '~')).join(''));
  }
  const inputNames = groups.flatMap(g => g.names);
  return {
    table: {
      inputs: inputNames,
      outputs: outputNets.map(net => {
        const d = driver.get(net);
        return shownAs.get(net) ?? (d !== undefined ? `${d.component}.${bitOf(d)}` : (netlist.netNames[net] ?? `net ${net}`));
      }),
      rows
    }
  };
}
