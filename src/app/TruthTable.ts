import { CIRCUIT_VERSION, type Circuit, type Component, type Wire } from '../sim/Circuit';
import { compile, CircuitError } from '../sim/Netlist';
import { pinsOf } from '../sim/Chips';
import { isGate, isSettable } from '../sim/Primitives';
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
  const pinsOfPart = (c: (typeof gates)[number]) => pinsOf(c, circuit.chips);
  const netOf = (id: string, pin: string) => netlist.pinNet.get(`${id}.${pin}`) ?? -1;

  // Which selected gate output drives each net.
  const driver = new Map<number, { component: string; pin: string }>();
  for (const g of gates) {
    for (const pin of pinsOfPart(g).outputs) {
      driver.set(netOf(g.id, pin), { component: g.id, pin });
    }
  }

  const inputNets: number[] = [];
  const inputNames: string[] = [];
  const addInput = (net: number, name: string) => {
    if (net >= 0 && !inputNets.includes(net)) {
      inputNets.push(net);
      inputNames.push(name);
    }
  };
  for (const c of chosen) {
    if (isSettable(c.kind)) addInput(netOf(c.id, 'out'), c.label ?? c.id);
  }
  for (const g of gates) {
    for (const pin of pinsOfPart(g).inputs) {
      const net = netOf(g.id, pin);
      if (!driver.has(net)) addInput(net, netlist.netNames[net] ?? `net ${net}`);
    }
  }
  if (inputNets.length > MAX_INPUTS) {
    return { error: `${inputNets.length} inputs; a table is swept for at most ${MAX_INPUTS}` };
  }

  // Nets read by selected gates, by selected displays, and by anything outside.
  const readInside = new Set<number>();
  const shown = new Set<number>();
  const readOutside = new Set<number>();
  // An output shown by a selected LED or probe goes by the LED's name.
  const shownAs = new Map<number, string>();
  for (const c of circuit.components) {
    for (const pin of pinsOf(c, circuit.chips).inputs) {
      const net = netOf(c.id, pin);
      if (!selected.has(c.id)) {
        readOutside.add(net);
        // An LED or probe outside names the output it shows, unless one
        // inside the selection already does.
        if ((c.kind === 'output' || c.kind === 'probe') && !shownAs.has(net)) shownAs.set(net, c.label ?? c.id);
      }
      else if (isGate(c.kind) || c.kind === 'chip') readInside.add(net);
      else {
        shown.add(net);
        if (c.kind === 'output' || c.kind === 'probe') shownAs.set(net, c.label ?? c.id);
      }
    }
  }
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

  // The selected gates alone, a switch on every input.
  const components: Component[] = gates.map(g => ({ id: g.id, kind: g.kind, x: 0, y: 0, ...(g.chip === undefined ? {} : { chip: g.chip }) }));
  const wires: Wire[] = [];
  inputNets.forEach((_, i) => components.push({ id: `in${i}`, kind: 'input', x: 0, y: 0 }));
  for (const g of gates) {
    for (const pin of pinsOfPart(g).inputs) {
      const net = netOf(g.id, pin);
      const source = driver.get(net) ?? { component: `in${inputNets.indexOf(net)}`, pin: 'out' };
      wires.push({ id: `w${wires.length}`, from: source, to: { component: g.id, pin } });
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
    return String(d !== undefined ? sub.read(d.component, d.pin) : sub.read(`in${inputNets.indexOf(net)}`));
  };

  const rows: string[] = [];
  const count = inputNets.length;
  for (let row = 0; row < 1 << count; row++) {
    for (let i = 0; i < count; i++) {
      sub.set(`in${i}`, ((row >> (count - 1 - i)) & 1) as 0 | 1);
    }
    const settled = sub.settle().settled;
    rows.push(outputNets.map(net => (settled ? readNet(net) : '~')).join(''));
  }
  return {
    table: {
      inputs: inputNames,
      outputs: outputNets.map(net => {
        const d = driver.get(net);
        return shownAs.get(net) ?? (d !== undefined ? `${d.component}.${d.pin}` : (netlist.netNames[net] ?? `net ${net}`));
      }),
      rows
    }
  };
}
