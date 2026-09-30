import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { highlight } from './Highlight';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every program in the repository, by path. */
function programs(): string[] {
  return ['programs', 'games'].flatMap(dir =>
    readdirSync(join(HERE, dir))
      .filter(name => name.endsWith('.asm'))
      .map(name => join(HERE, dir, name))
  );
}

describe('highlighting', () => {
  it('spells out the source exactly, for every program here', () => {
    const files = programs();
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(highlight(source).map(t => t.text).join(''), file).toBe(source);
    }
  });

  it('tells a line’s pieces apart', () => {
    const kinds = (line: string) => highlight(line).map(t => `${t.kind}:${t.text}`);
    expect(kinds("loop:   LDA 0x40,X    ; a ';' here")).toEqual([
      'definition:loop',
      'plain::   ',
      'mnemonic:LDA',
      'plain: ',
      'number:0x40',
      'plain:,',
      'register:X',
      'plain:    ',
      "comment:; a ';' here"
    ]);
    expect(kinds('WIN = 0x11')).toEqual(['definition:WIN', 'plain: = ', 'number:0x11']);
    expect(kinds("  .byte 1, 'c', masks")).toEqual(['plain:  ', 'directive:.byte', 'plain: ', 'number:1', 'plain:, ', "number:'c'", 'plain:, masks']);
    expect(kinds('        add b')).toEqual(['plain:        ', 'mnemonic:add', 'plain: ', 'register:b']);
    // What isn't an instruction isn't coloured as one.
    expect(kinds('FROB 2')).toEqual(['plain:FROB ', 'number:2']);
  });

  it('keeps empty lines, and a source that is only newlines', () => {
    expect(highlight('\n\nNOP\n').map(t => t.text).join('')).toBe('\n\nNOP\n');
    expect(highlight('')).toEqual([]);
  });
});
