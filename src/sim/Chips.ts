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
  /** Its width in bits: the switch's or LED's. */
  readonly width: number;
  /** What it is for, from the switch's or LED's `note`; null when it has none. */
  readonly note: string | null;
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
      .map(c => ({ name: c.label ?? c.id, component: c.id, width: c.width ?? 1, note: c.note ?? null }));
  return { inputs: pinsOfKind('input'), outputs: pinsOfKind('output') };
}

/** How wide a split or join is when its width is not given. */
export const DEFAULT_BUS_WIDTH = 8;

/**
 * A component's pins and their widths: its kind's, sized by its
 * `width`, or for a chip its definition's. Empty for a chip whose
 * definition is missing.
 */
export function pinsOf(component: Component, chips: Circuit['chips']): PinSpec {
  const width = component.width ?? 1;
  const wide = (pin: string, w: number) => (w > 1 ? { widths: { [pin]: w } } : {});
  switch (component.kind) {
    case 'input':
    case 'constant':
      return { inputs: [], outputs: ['out'], ...wide('out', width) };
    case 'output':
    case 'probe':
      return { inputs: ['in'], outputs: [], ...wide('in', width) };
    case 'hex':
      // With a width, one bus pin; without, the four one-bit pins it always had.
      return component.width === undefined ? PINS.hex : { inputs: ['in'], outputs: [], ...wide('in', width) };
    case 'split': {
      const bits = component.width ?? DEFAULT_BUS_WIDTH;
      return { inputs: ['in'], outputs: Array.from({ length: bits }, (_, i) => `b${i}`), widths: { in: bits } };
    }
    case 'join': {
      const bits = component.width ?? DEFAULT_BUS_WIDTH;
      return { inputs: Array.from({ length: bits }, (_, i) => `b${i}`), outputs: ['out'], widths: { out: bits } };
    }
    case 'chip': {
      const definition = component.chip === undefined ? undefined : chips?.[component.chip];
      if (definition === undefined) {
        return PINS.chip;
      }
      const face = chipInterface(definition);
      const widths: Record<string, number> = {};
      for (const pin of [...face.inputs, ...face.outputs]) {
        if (pin.width > 1) widths[pin.name] = pin.width;
      }
      return { inputs: face.inputs.map(p => p.name), outputs: face.outputs.map(p => p.name), widths };
    }
    default:
      return PINS[component.kind];
  }
}
