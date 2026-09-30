import { describe, expect, it } from 'vitest';

import { gutterOf, spansOf } from './ProgramEditor';

describe('the program editor’s runs', () => {
  const source = 'start: LDA #1   ; one\n        JMP start\nHLT';
  const text = (marked: number) => spansOf(source, marked).map(s => s.text).join('');
  const markedText = (marked: number) =>
    spansOf(source, marked)
      .filter(s => s.backgroundColor !== undefined)
      .map(s => s.text)
      .join('');

  it('spell out the source, whichever line is marked', () => {
    for (const line of [0, 1, 2, 3, 9]) expect(text(line)).toBe(source);
  });

  it('mark one line’s text, and not its newline', () => {
    expect(markedText(0)).toBe('');
    expect(markedText(1)).toBe('start: LDA #1   ; one');
    expect(markedText(2)).toBe('        JMP start');
    expect(markedText(3)).toBe('HLT');
    // A line past the end marks nothing.
    expect(markedText(9)).toBe('');
  });
});

describe('the program editor’s gutter', () => {
  it('numbers every line, and gives each the address it was assembled to', () => {
    // Line 1 a comment, 2 an instruction, 3 blank, 4 a .byte list of two words.
    const lines = [2, 4, 4];
    expect(gutterOf(4, lines).split('\n')).toEqual(['  1   ', '  2 00', '  3   ', '  4 01']);
  });

  it('numbers lines alone while there are none to address', () => {
    expect(gutterOf(3, null)).toBe('  1   \n  2   \n  3   ');
  });
});
