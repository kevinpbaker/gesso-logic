import { isGate, type GateKind, type Kind } from '../sim/Primitives';

/**
 * Parts and pins in words: what each kind of part is called, and what
 * each built-in part's pins are for, in a line, for the tooltip hovering
 * a pin shows.
 *
 * A chip's pins say what their definition's switches and LEDs say (their
 * `note`), and travel with the document. A built-in part's are the same
 * everywhere, so they live here, on the render worker's side, rather
 * than in every gate's geometry: inside the ALU that would be a few
 * hundred copies of "first input".
 */

const KIND_NAMES: Readonly<Record<Kind, string>> = {
  input: 'Switch',
  button: 'Button',
  clock: 'Clock',
  constant: 'Constant',
  output: 'LED',
  probe: 'Probe',
  hex: 'Hex display',
  seg7: '7-segment display',
  matrix: 'LED matrix',
  split: 'Split',
  join: 'Join',
  not: 'NOT gate',
  and: 'AND gate',
  or: 'OR gate',
  nand: 'NAND gate',
  nor: 'NOR gate',
  xor: 'XOR gate',
  xnor: 'XNOR gate',
  chip: 'Chip',
  rom: 'Program ROM'
};

/** A kind of part as a person calls it: `Switch`, `AND gate`. */
export function kindName(kind: Kind): string {
  return KIND_NAMES[kind] ?? kind;
}

const GATE_OUT: Readonly<Record<GateKind, string>> = {
  not: 'The opposite of a',
  and: '1 when a and b are both 1',
  or: '1 when a or b is 1',
  nand: '0 only when a and b are both 1',
  nor: '1 only when a and b are both 0',
  xor: '1 when a and b differ',
  xnor: '1 when a and b are the same'
};

/** The seven-segment display's segments, lettered as the standard does. */
const SEGMENTS: Readonly<Record<string, string>> = {
  a: 'Lights the top segment',
  b: 'Lights the upper right segment',
  c: 'Lights the lower right segment',
  d: 'Lights the bottom segment',
  e: 'Lights the lower left segment',
  f: 'Lights the upper left segment',
  g: 'Lights the middle segment'
};

const ROM: Readonly<Record<string, string>> = {
  A: 'Address of the instruction to fetch',
  D: 'The 16-bit instruction word at address A',
  T: 'Address of a table byte, which LDT reads',
  Q: 'The low byte of the word at address T'
};

/** A built-in part's pin's note, or null for a chip's, or a pin it has not got. */
export function primitivePinNote(kind: Kind, pin: string, width: number): string | null {
  if (isGate(kind)) {
    if (pin === 'out') return GATE_OUT[kind];
    if (kind === 'not') return pin === 'a' ? 'The input' : null;
    return pin === 'a' ? 'First input' : pin === 'b' ? 'Second input' : null;
  }
  const bit = /^b(\d+)$/.exec(pin);
  switch (kind) {
    case 'input':
      return width > 1 ? 'The value set in the inspector' : 'The switch’s value: click the switch to flip it';
    case 'button':
      return '1 while the button is held down';
    case 'clock':
      return 'Goes 0, 1, 0, 1… at the clock rate';
    case 'constant':
      return 'Always this value';
    case 'output':
      return width > 1 ? 'The value the LEDs show' : 'Lights the LED while 1';
    case 'probe':
      return 'The value the probe shows';
    case 'hex':
      return bit !== null ? `Bit ${bit[1]} of the digit shown` : 'The value shown, in hex';
    case 'seg7':
      return SEGMENTS[pin] ?? null;
    case 'matrix': {
      const row = /^r(\d+)$/.exec(pin);
      return row === null ? null : `Row ${row[1]}: bit x lights the pixel in column x`;
    }
    case 'split':
      return pin === 'in' ? 'The bus to take apart' : bit !== null ? `Bit ${bit[1]} of the bus` : null;
    case 'join':
      return pin === 'out' ? 'The bus the bits make' : bit !== null ? `Bit ${bit[1]} of the bus` : null;
    case 'rom':
      return ROM[pin] ?? null;
    default:
      return null;
  }
}
