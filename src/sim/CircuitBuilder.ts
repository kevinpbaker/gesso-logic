import { CIRCUIT_VERSION, type Circuit, type Component, type PinRef, type Wire } from './Circuit';
import type { GateKind, Kind } from './Primitives';

/**
 * Writes a circuit document from code.
 *
 * The specs build their latches and counters with it, and Phase 14's
 * generators — the RAM, the register file — will write through it too,
 * which is the point of the roadmap's "one file format, no HDL": code
 * that builds a circuit produces the same document the editor opens.
 *
 * Components are placed on a grid in creation order, so a built circuit
 * opens somewhere readable; a generator that cares places them itself.
 */
export interface GateHandle {
  readonly id: string;
  readonly a: PinRef;
  readonly b: PinRef;
  readonly out: PinRef;
}

const GRID = 4;
const ROW = 16;

export class CircuitBuilder {
  private readonly components: Component[] = [];
  private readonly wires: Wire[] = [];
  /** Each component's index in `components`, by id. */
  private readonly index = new Map<string, number>();

  /** A gate with nothing wired to it yet, for circuits with feedback. */
  gate(kind: GateKind, label?: string): GateHandle {
    const id = this.add(kind, label);
    return { id, a: { component: id, pin: 'a' }, b: { component: id, pin: 'b' }, out: { component: id, pin: 'out' } };
  }

  /** Joins two pins. Direction does not matter to the netlist; `from` is the driver by convention. */
  connect(from: PinRef, to: PinRef): void {
    this.wires.push({ id: `w${this.wires.length}`, from, to });
  }

  not(a: PinRef, label?: string): PinRef {
    const gate = this.gate('not', label);
    this.connect(a, gate.a);
    return gate.out;
  }
  and(a: PinRef, b: PinRef, label?: string): PinRef {
    return this.binary('and', a, b, label);
  }
  or(a: PinRef, b: PinRef, label?: string): PinRef {
    return this.binary('or', a, b, label);
  }
  nand(a: PinRef, b: PinRef, label?: string): PinRef {
    return this.binary('nand', a, b, label);
  }
  nor(a: PinRef, b: PinRef, label?: string): PinRef {
    return this.binary('nor', a, b, label);
  }
  xor(a: PinRef, b: PinRef, label?: string): PinRef {
    return this.binary('xor', a, b, label);
  }
  xnor(a: PinRef, b: PinRef, label?: string): PinRef {
    return this.binary('xnor', a, b, label);
  }

  /** A switch; with `width`, a bus of switches set to `value`. */
  input(label: string, value = 0, width = 1): PinRef {
    return { component: this.add('input', label, { value, ...(width > 1 ? { width } : {}) }), pin: 'out' };
  }
  /** A split taking a `width`-bit bus on `in` and giving its bits on `b0`… */
  split(label: string, width: number): string {
    return this.add('split', label, { width });
  }
  /** A join taking bits on `b0`… and giving a `width`-bit bus on `out`. */
  join(label: string, width: number): string {
    return this.add('join', label, { width });
  }
  /** A constant; with `width`, a bus holding `value`. */
  constant(value: number, label?: string, width = 1): PinRef {
    return { component: this.add('constant', label, { value, ...(width > 1 ? { width } : {}) }), pin: 'out' };
  }
  clock(label = 'clk'): PinRef {
    return { component: this.add('clock', label), pin: 'out' };
  }
  /** An instance of a chip, by its name in the document's `chips`, which the caller supplies with `build`. */
  chip(label: string, name: string): string {
    return this.add('chip', label, { chip: name });
  }
  button(label: string): PinRef {
    return { component: this.add('button', label), pin: 'out' };
  }
  /** A probe, a hex or a seven-segment display, fed pin by pin. */
  display(kind: 'probe' | 'hex' | 'seg7', label: string, from: Readonly<Record<string, PinRef>>, width?: number): string {
    const id = this.add(kind, label, width === undefined ? {} : { width });
    for (const [pin, source] of Object.entries(from)) {
      this.connect(source, { component: id, pin });
    }
    return id;
  }
  output(label: string, from: PinRef, width = 1): string {
    const id = this.add('output', label, width > 1 ? { width } : {});
    this.connect(from, { component: id, pin: 'in' });
    return id;
  }

  /** Moves a component, for a generator that lays its circuit out itself. */
  position(id: string, x: number, y: number): void {
    const at = this.index.get(id);
    if (at === undefined) {
      throw new Error(`No component '${id}' to position.`);
    }
    this.components[at] = { ...this.components[at]!, x, y };
  }

  build(): Circuit {
    return { version: CIRCUIT_VERSION, components: [...this.components], wires: [...this.wires] };
  }

  private binary(kind: GateKind, a: PinRef, b: PinRef, label?: string): PinRef {
    const gate = this.gate(kind, label);
    this.connect(a, gate.a);
    this.connect(b, gate.b);
    return gate.out;
  }

  /**
   * Adds a component. Its id is its label when that is free — so a spec
   * can read `sim.read('q')` — and a generated one otherwise.
   */
  private add(kind: Kind, label?: string, extra: Partial<Component> = {}): string {
    let id = label ?? `${kind}${this.components.length}`;
    if (this.index.has(id)) {
      id = `${id}#${this.components.length}`;
    }
    const n = this.components.length;
    this.index.set(id, n);
    this.components.push({ id, kind, x: (n % ROW) * GRID, y: Math.floor(n / ROW) * GRID, ...(label ? { label } : {}), ...extra });
    return id;
  }
}
