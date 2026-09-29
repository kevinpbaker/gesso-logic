import type { Circuit, Component } from './Circuit';
import { PINS, type PinSpec } from './Primitives';

/**
 * Chips: circuits used as parts.
 *
 * A chip's definition is an ordinary circuit, and its interface is read
 * off it: every switch (`input`) is an input pin and every LED
 * (`output`) an output pin, named by the part's label, or its id when it
 * has none, and ordered top to bottom as they are drawn — which is the
 * order the pins take down the sides of the chip's body. So a full adder
 * drawn with switches a, b and cin and LEDs s and cout is a chip with
 * those five pins as it stands, and a chip file is a circuit file.
 *
 * Inside a chip in use, those switches and LEDs are not sources and
 * sinks but the points the instance's pins join; `compile` flattens the
 * hierarchy that way, and nothing else ever does. The renderer draws
 * one level at a time.
 */

export interface ChipPin {
  /** The pin's name on the chip. */
  readonly name: string;
  /** The switch or LED inside that it is. */
  readonly component: string;
}

export interface ChipInterface {
  readonly inputs: readonly ChipPin[];
  readonly outputs: readonly ChipPin[];
}

export function chipInterface(definition: Circuit): ChipInterface {
  const pinsOfKind = (kind: 'input' | 'output'): ChipPin[] =>
    definition.components
      .filter(c => c.kind === kind)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map(c => ({ name: c.label ?? c.id, component: c.id }));
  return { inputs: pinsOfKind('input'), outputs: pinsOfKind('output') };
}

/** A component's pins: its kind's, or for a chip its definition's. Empty for a chip whose definition is missing. */
export function pinsOf(component: Component, chips: Circuit['chips']): PinSpec {
  if (component.kind !== 'chip') {
    return PINS[component.kind];
  }
  const definition = component.chip === undefined ? undefined : chips?.[component.chip];
  if (definition === undefined) {
    return PINS.chip;
  }
  const face = chipInterface(definition);
  return { inputs: face.inputs.map(p => p.name), outputs: face.outputs.map(p => p.name) };
}
