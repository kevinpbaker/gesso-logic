/**
 * The circuit document: what a person draws and a file holds.
 *
 * Components with positions, and wires between their pins. Nothing here
 * is computed — no nets, no values — so the document is plain data that
 * can be saved, sent across the worker barrier and diffed as it is.
 * `compile` in `Netlist.ts` turns it into something that can run.
 *
 * A wire joins two pins. Pins joined by any chain of wires are one net,
 * so a wire from one output to three inputs is three wires, and a wire
 * that happens to cross another joins nothing. Junctions in the middle
 * of a wire are the editor's business (Phase 4); the document only ever
 * says which pins are joined.
 */

import type { Kind } from './Primitives';

export const CIRCUIT_VERSION = 1;

export type Rotation = 0 | 90 | 180 | 270;

export interface Circuit {
  readonly version: typeof CIRCUIT_VERSION;
  readonly components: readonly Component[];
  readonly wires: readonly Wire[];
  /**
   * The chips this circuit uses, by name, each a circuit in its own
   * right: its switches are the chip's inputs and its LEDs its outputs
   * (see `Chips.ts`). One table for the whole document — a chip inside a
   * chip names its definition here too, and a definition's own `chips`
   * is ignored — so each definition exists once however deep it is used.
   */
  readonly chips?: Readonly<Record<string, Circuit>>;
}

export interface Component {
  /** Unique within the circuit. Referred to by wires, and by everything that names a pin. */
  readonly id: string;
  readonly kind: Kind;
  /** Grid position of the component's origin. */
  readonly x: number;
  readonly y: number;
  /** What the component is called on screen and in reports; its id when absent. */
  readonly label?: string;
  /**
   * Quarter turns clockwise, in degrees. Absent is 0. Rotation is where
   * the pins are, which is layout's business (`src/app/Layout.ts`); the
   * netlist does not care which way a gate faces.
   */
  readonly rotation?: Rotation;
  /**
   * The value a `constant` drives, or an `input` starts at. Ignored by
   * every other kind.
   */
  readonly value?: 0 | 1;
  /**
   * A `clock`'s rate in cycles a second; absent is as fast as it will go.
   * One rate drives every clock — the simulator has one clock domain —
   * so a document's clocks agree, and the rate travels with the circuit
   * when it is saved or pasted.
   */
  readonly rate?: number;
  /** A `chip`'s definition, by its name in the document's `chips`. */
  readonly chip?: string;
}

export interface PinRef {
  readonly component: string;
  readonly pin: string;
}

export interface Wire {
  readonly id: string;
  readonly from: PinRef;
  readonly to: PinRef;
}

/** A pin as people read it: `label.pin`. */
export function pinName(circuit: Circuit, ref: PinRef): string {
  const component = circuit.components.find(c => c.id === ref.component);
  return `${component?.label ?? ref.component}.${ref.pin}`;
}
