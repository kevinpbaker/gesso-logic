import { BY_MNEMONIC, BY_OPCODE, PORTS, ROM_SIZE, type Instruction, type Mode } from './Isa';

/**
 * The assembler: source text in, a ROM image out.
 *
 *     ; a comment runs to the end of the line
 *     BALL = 0x10           ; a constant
 *     start:  LDA #1        ; a label, and an instruction
 *             STA BALL
 *             LDA 0x40,X    ; indexed
 *             ADD B         ; register B
 *             LDT masks,X   ; a byte from a table in the ROM
 *             JMP start
 *     masks:  .byte 1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80
 *             .org 0xF0     ; carry on at another ROM address
 *
 * Mnemonics and `B`/`X` are case-blind; labels and constants are not.
 * A value is a sum or difference of numbers — `12`, `0x0C`, `0b1100`,
 * `'c'` — and names, and must fit a byte; a negative one is taken as its
 * two's complement. Every error is reported, each with its line, before
 * anything is thrown.
 */

export interface Assembled {
  /** The ROM image: 256 words, unused ones 0 (`HLT`). */
  readonly rom: Uint16Array;
  /** Words written, counting from 0 to the highest address used. */
  readonly size: number;
  /** Labels and constants, by name. */
  readonly symbols: ReadonlyMap<string, number>;
  /** The source line each written ROM address came from, 1-based. */
  readonly lineOf: ReadonlyMap<number, number>;
}

export interface AssemblyProblem {
  readonly line: number;
  readonly message: string;
}

export class AssemblyError extends Error {
  readonly problems: readonly AssemblyProblem[];

  constructor(problems: readonly AssemblyProblem[]) {
    super(problems.map(p => `line ${p.line}: ${p.message}`).join('\n'));
    this.name = 'AssemblyError';
    this.problems = problems;
  }
}

/** A line, after the first pass: where it goes, and what is left to encode. */
type Item =
  | { kind: 'instruction'; line: number; address: number; mnemonic: string; operand: string }
  | { kind: 'byte'; line: number; address: number; expression: string };

const NAME = /^[A-Za-z_.][A-Za-z0-9_.]*$/;
const RESERVED = new Set(['A', 'B', 'X']);

export function assemble(source: string): Assembled {
  const problems: AssemblyProblem[] = [];
  const fail = (line: number, message: string) => problems.push({ line, message });
  const labels = new Map<string, number>();
  const constants = new Map<string, { expression: string; line: number }>();
  const items: Item[] = [];
  const definedAt = new Map<string, number>();
  const define = (name: string, line: number): boolean => {
    if (!NAME.test(name) || RESERVED.has(name.toUpperCase())) {
      fail(line, `'${name}' can't be a name${RESERVED.has(name.toUpperCase()) ? ': it is a register' : ''}.`);
      return false;
    }
    const before = definedAt.get(name);
    if (before !== undefined) {
      fail(line, `'${name}' is already defined, on line ${before}.`);
      return false;
    }
    definedAt.set(name, line);
    return true;
  };

  const resolving = new Set<string>();
  const value = (expression: string, line: number): number | null => evaluate(expression, line);
  function lookup(name: string, line: number): number | null {
    const label = labels.get(name);
    if (label !== undefined) return label;
    const constant = constants.get(name);
    if (constant === undefined) {
      fail(line, `'${name}' is not defined.`);
      return null;
    }
    if (resolving.has(name)) {
      fail(line, `'${name}' is defined in terms of itself.`);
      return null;
    }
    resolving.add(name);
    const result = evaluate(constant.expression, constant.line);
    resolving.delete(name);
    return result;
  }
  function evaluate(expression: string, line: number): number | null {
    const text = expression.replace(/\s+/g, '');
    if (text === '') {
      fail(line, 'A value is missing.');
      return null;
    }
    // Terms with their signs: "a+2-b" → +a, +2, -b.
    const terms = text.match(/[+-]?[^+-]+/g);
    if (terms === null || terms.join('') !== text) {
      fail(line, `'${expression}' is not a value.`);
      return null;
    }
    let total = 0;
    for (const term of terms) {
      const sign = term.startsWith('-') ? -1 : 1;
      const body = term.replace(/^[+-]/, '');
      const number = parseNumber(body);
      const v = number ?? (NAME.test(body) ? lookup(body, line) : null);
      if (v === null) {
        if (number === null && !NAME.test(body)) fail(line, `'${body}' is not a number or a name.`);
        return null;
      }
      total += sign * v;
    }
    return total;
  }
  const byte = (expression: string, line: number, what: string): number | null => {
    const v = value(expression, line);
    if (v === null) return null;
    if (v < -128 || v > 255) {
      fail(line, `${what} ${v} doesn't fit in a byte.`);
      return null;
    }
    return v & 0xff;
  };

  // First pass: labels get addresses, constants their expressions, and
  // every line its place in the ROM. `.org` is worked out here, so its
  // value can use only names defined above it.
  let address = 0;
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    let text = stripComment(raw).trim();
    const constant = /^([^\s=:]+)\s*=\s*(.*)$/.exec(text);
    if (constant !== null) {
      if (define(constant[1]!, line)) constants.set(constant[1]!, { expression: constant[2]!.trim(), line });
      return;
    }
    const label = /^([^\s:]+):(.*)$/.exec(text);
    if (label !== null) {
      if (define(label[1]!, line)) labels.set(label[1]!, address);
      text = label[2]!.trim();
    }
    if (text === '') return;
    const [word, ...rest] = text.split(/\s+/);
    const operand = rest.join(' ').trim();
    const directive = word!.toLowerCase();
    if (directive === '.org') {
      const before = problems.length;
      const target = value(operand, line);
      if (target === null) {
        if (problems.length > before) problems[problems.length - 1] = { line, message: `.org needs a value made of numbers and names defined above it: ${problems[problems.length - 1]!.message}` };
      } else if (target < address) fail(line, `.org 0x${hex(target)} would go back, to before 0x${hex(address)}.`);
      else if (target >= ROM_SIZE) fail(line, `.org 0x${hex(target)} is past the end of the ROM.`);
      else address = target;
      return;
    }
    if (directive === '.byte') {
      const values = operand === '' ? [] : splitList(operand);
      if (values.length === 0) fail(line, '.byte needs at least one value.');
      for (const value of values) items.push({ kind: 'byte', line, address: address++, expression: value });
      return;
    }
    if (word!.startsWith('.')) {
      fail(line, `'${word}' is not a directive. There are .byte and .org.`);
      return;
    }
    const mnemonic = word!.toUpperCase();
    if (!BY_MNEMONIC.has(mnemonic)) {
      fail(line, `'${word}' is not an instruction.`);
      return;
    }
    items.push({ kind: 'instruction', line, address: address++, mnemonic, operand });
  });

  const rom = new Uint16Array(ROM_SIZE);
  const lineOf = new Map<number, number>();
  let size = 0;
  for (const item of items) {
    if (item.address >= ROM_SIZE) {
      fail(item.line, `The program is past the end of the ROM, which holds ${ROM_SIZE} words.`);
      break;
    }
    if (lineOf.has(item.address)) {
      fail(item.line, `ROM address 0x${hex(item.address)} is already used, by line ${lineOf.get(item.address)}.`);
      continue;
    }
    lineOf.set(item.address, item.line);
    size = Math.max(size, item.address + 1);
    if (item.kind === 'byte') {
      const v = byte(item.expression, item.line, 'The value');
      if (v !== null) rom[item.address] = v;
      continue;
    }
    const encoded = encode(item.mnemonic, item.operand, item.line);
    if (encoded !== null) rom[item.address] = encoded;
  }

  function encode(mnemonic: string, operand: string, line: number): number | null {
    const forms = BY_MNEMONIC.get(mnemonic)!;
    const pick = (modes: readonly Mode[], written: string): Instruction | null => {
      for (const mode of modes) {
        const form = forms.get(mode);
        if (form !== undefined) return form;
      }
      fail(line, `${mnemonic} has no ${written} form; it takes ${describeForms(mnemonic)}.`);
      return null;
    };
    const indexed = /^(.*),\s*[Xx]$/.exec(operand);
    if (operand === '') {
      const form = pick(['none'], 'operand-less');
      return form === null ? null : form.opcode << 8;
    }
    if (operand.startsWith('#')) {
      const form = pick(['imm'], 'immediate');
      const v = byte(operand.slice(1), line, 'The value');
      return form === null || v === null ? null : (form.opcode << 8) | v;
    }
    if (operand.toUpperCase() === 'B') {
      const form = pick(['b'], 'register B');
      return form === null ? null : form.opcode << 8;
    }
    if (indexed !== null) {
      const form = pick(['absX', 'table'], 'indexed');
      const v = byte(indexed[1]!, line, 'The address');
      return form === null || v === null ? null : (form.opcode << 8) | v;
    }
    const form = pick(['abs', 'target', 'port'], 'address');
    if (form === null) return null;
    const v = byte(operand, line, form.mode === 'port' ? 'The port' : 'The address');
    if (v === null) return null;
    if (form.mode === 'port' && v >= PORTS) {
      fail(line, `There is no port ${v}; ports are 0 to ${PORTS - 1}.`);
      return null;
    }
    return (form.opcode << 8) | v;
  }

  if (problems.length > 0) {
    throw new AssemblyError([...problems].sort((a, b) => a.line - b.line));
  }
  const symbols = new Map<string, number>(labels);
  for (const name of constants.keys()) symbols.set(name, lookup(name, 0)!);
  return { rom, size, symbols, lineOf };
}

function parseNumber(text: string): number | null {
  if (/^[0-9]+$/.test(text)) return Number(text);
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^0b[01]+$/i.test(text)) return Number.parseInt(text.slice(2), 2);
  if (/^'.'$/.test(text)) return text.charCodeAt(1);
  return null;
}

/** A comment starts at a `;` that is not inside a character literal. */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "'") quoted = !quoted;
    else if (line[i] === ';' && !quoted) return line.slice(0, i);
  }
  return line;
}

/** A comma-separated list, respecting `','` as a character. */
function splitList(text: string): string[] {
  return text.match(/'.'|[^,]+/g)?.map(s => s.trim()).filter(s => s !== '') ?? [];
}

const FORM_TEXT: Record<Mode, string> = {
  none: 'no operand',
  imm: '#value',
  abs: 'an address',
  absX: 'address,X',
  b: 'B',
  target: 'a label',
  port: 'a port',
  table: 'table,X'
};

function describeForms(mnemonic: string): string {
  const texts = [...BY_MNEMONIC.get(mnemonic)!.keys()].map(mode => FORM_TEXT[mode]);
  return texts.length === 1 ? texts[0]! : `${texts.slice(0, -1).join(', ')} or ${texts[texts.length - 1]}`;
}

/** One ROM word as source text: `LDA 0x40,X`. A word that is no instruction is shown as `.byte`. */
export function disassemble(word: number): string {
  const instruction = BY_OPCODE.get(word >> 8);
  const k = word & 0xff;
  if (instruction === undefined) return `.word 0x${word.toString(16).toUpperCase().padStart(4, '0')}`;
  const v = `0x${hex(k)}`;
  const operand: Record<Mode, string> = {
    none: '',
    imm: `#${v}`,
    abs: v,
    absX: `${v},X`,
    b: 'B',
    target: v,
    port: String(k),
    table: `${v},X`
  };
  return `${instruction.mnemonic} ${operand[instruction.mode]}`.trim();
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * A ROM image as text: every word of the ROM in four hex digits, sixteen
 * to a line, from address 0. What `pnpm asm` writes, and what the ROM
 * primitive of Phase 16 reads.
 */
export function romImage(rom: ArrayLike<number>): string {
  const lines: string[] = [];
  for (let at = 0; at < rom.length; at += 16) {
    lines.push(Array.from({ length: Math.min(16, rom.length - at) }, (_, i) => rom[at + i]!.toString(16).toUpperCase().padStart(4, '0')).join(' '));
  }
  return `${lines.join('\n')}\n`;
}

/** Reads a ROM image back: any whitespace between words, `#` comments allowed. */
export function readRomImage(text: string): Uint16Array {
  const words = text
    .replace(/#.*$/gm, '')
    .split(/\s+/)
    .filter(w => w !== '');
  if (words.length > ROM_SIZE) throw new Error(`A ROM image holds ${ROM_SIZE} words, not ${words.length}.`);
  const rom = new Uint16Array(ROM_SIZE);
  words.forEach((word, i) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(word)) throw new Error(`Word ${i} of the ROM image, '${word}', is not four hex digits.`);
    rom[i] = Number.parseInt(word, 16);
  });
  return rom;
}
