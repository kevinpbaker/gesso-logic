import { MENU_SEPARATOR } from 'gesso-components';
import { describe, expect, it } from 'vitest';

import { commandKeys, commandLabel, EXAMPLES, MENUS, PART_SECTIONS, rateOf, shortcutSections, type CommandId } from './Commands';
import { PROGRAMS } from './Programs';

/**
 * The command table is what the menus draw and the shortcut sheet is
 * generated from, so these are the checks that keep the two honest.
 */
describe('the command table', () => {
  const entries = MENUS.flatMap(menu => menu.entries).filter((e): e is CommandId => e !== MENU_SEPARATOR);

  it('gives every menu entry a label of its own', () => {
    for (const id of entries) expect(commandLabel(id), id).not.toBe(id);
  });

  it('puts no command in two places', () => {
    expect(new Set(entries).size).toBe(entries.length);
  });

  it('gives every menu a distinct mnemonic', () => {
    const letters = MENUS.map(menu => menu.mnemonic);
    expect(letters.every(l => l !== undefined)).toBe(true);
    expect(new Set(letters).size).toBe(letters.length);
  });

  it('binds no key to two commands', () => {
    const keys = entries.map(commandKeys).filter((k): k is string => k !== undefined);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('offers every example and every test program', () => {
    for (const example of EXAMPLES) expect(entries).toContain(`example:${example.scene}`);
    expect(PROGRAMS.length).toBe(7);
    for (const program of PROGRAMS) {
      expect(entries).toContain(`program:${program.name}`);
      expect(program.about).not.toBe('');
    }
  });

  it('reads a rate back out of its command', () => {
    expect(rateOf('rate:max')).toBe('max');
    expect(rateOf('rate:100')).toBe(100);
    expect(rateOf('undo')).toBeNull();
  });

  it('lists every part key on the shortcut sheet', () => {
    const parts = shortcutSections().find(section => section.title === 'Parts')!;
    expect(parts.lines.length).toBe(PART_SECTIONS.reduce((n, s) => n + s.parts.length, 0));
  });
});
