import { BY_MNEMONIC } from './Isa';

/**
 * Assembly source in runs, for the program editor to colour: what each
 * piece of a line is, by the assembler's own rules for reading one. The
 * runs' texts put together are the source exactly, newlines and all —
 * an editable draws its runs only when they spell out its value.
 */

export type TokenKind = 'plain' | 'comment' | 'mnemonic' | 'definition' | 'directive' | 'number' | 'register';

export interface Token {
  readonly text: string;
  readonly kind: TokenKind;
}

const NAME = /^[A-Za-z_.][A-Za-z0-9_.]*/;
/** In an operand: a number or a character, a register, a name. The rest — spaces, `#`, `,`, `+`, `-` — is plain. */
const OPERAND = /'.'|0x[0-9a-fA-F]+|0b[01]+|[0-9]+|[A-Za-z_.][A-Za-z0-9_.]*/g;

export function highlight(source: string): Token[] {
  const tokens: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text === '') return;
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === kind) tokens[tokens.length - 1] = { text: last.text + text, kind };
    else tokens.push({ text, kind });
  };
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    const at = commentAt(line);
    lineTokens(line.slice(0, at), push);
    push(line.slice(at), 'comment');
    if (i < lines.length - 1) push('\n', 'plain');
  });
  return tokens;
}

/** Where a line's comment starts: its first `;` outside a character, or its end. */
function commentAt(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "'") quoted = !quoted;
    else if (line[i] === ';' && !quoted) return i;
  }
  return line.length;
}

function lineTokens(code: string, push: (text: string, kind: TokenKind) => void): void {
  let rest = code;
  const lead = /^\s*/.exec(rest)![0];
  push(lead, 'plain');
  rest = rest.slice(lead.length);
  // `NAME = value`, or `label:` before whatever follows it.
  const constant = /^([^\s=:]+)(\s*=)/.exec(rest);
  if (constant !== null) {
    push(constant[1]!, 'definition');
    push(constant[2]!, 'plain');
    operand(rest.slice(constant[0].length), push);
    return;
  }
  const label = /^([^\s:]+):/.exec(rest);
  if (label !== null) {
    push(label[1]!, 'definition');
    push(':', 'plain');
    rest = rest.slice(label[0].length);
    const gap = /^\s*/.exec(rest)![0];
    push(gap, 'plain');
    rest = rest.slice(gap.length);
  }
  const word = NAME.exec(rest)?.[0] ?? '';
  if (word.startsWith('.')) push(word, 'directive');
  else if (BY_MNEMONIC.has(word.toUpperCase())) push(word, 'mnemonic');
  else push(word, 'plain');
  operand(rest.slice(word.length), push);
}

function operand(text: string, push: (text: string, kind: TokenKind) => void): void {
  let at = 0;
  for (const match of text.matchAll(OPERAND)) {
    push(text.slice(at, match.index), 'plain');
    const piece = match[0];
    const kind: TokenKind = /^['0-9]/.test(piece) ? 'number' : /^[BbXx]$/.test(piece) ? 'register' : 'plain';
    push(piece, kind);
    at = match.index + piece.length;
  }
  push(text.slice(at), 'plain');
}
