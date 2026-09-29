import { MENU_SEPARATOR, type MenuBarMenu } from 'gesso-components';

import type { ClockRate, SceneName } from '../app/CircuitContract';
import { PROGRAMS } from './Programs';

/**
 * Every command the menus, the toolbar and the shortcut sheet offer,
 * in one table.
 *
 * The menus are drawn from it, the accelerators they show are read
 * from it, and the shortcut sheet is generated from it, so a key that
 * works is a key the sheet names and a key the sheet names is one that
 * works: a help page written by hand is wrong within a month.
 *
 * What a command *does* is `Workbench.tsx`'s `run`; the keys that
 * trigger it are answered by the canvas and `Editor.ts`. This table
 * is what they are called.
 */

export const RATES: readonly ClockRate[] = [1, 2, 10, 100, 1000, 'max'];

export const EXAMPLES: readonly { readonly scene: SceneName; readonly label: string; readonly about: string }[] = [
  { scene: 'counter', label: 'Counter', about: 'A 4-bit counter driving a seven-segment display, clocked at 2 Hz' },
  { scene: 'adder', label: '8-bit adder', about: 'Full adders made into a chip and chained eight wide' },
  { scene: 'bus adder', label: 'Bus adder', about: 'The 8-bit adder again, with buses instead of eight wires' },
  { scene: 'ram', label: '128-byte RAM', about: 'The RAM chip between address and data switches' },
  { scene: 'datapath', label: 'Datapath', about: 'The CPU’s registers and ALU, with a switch for each control line' },
  { scene: 'computer', label: 'Computer', about: 'The whole 8-bit computer running three instructions' },
  { scene: 'diagonal', label: 'Computer drawing a diagonal', about: 'The computer lighting the LED matrix a pixel at a time' },
  { scene: 'bench', label: '10,000-gate stress test', about: 'Phase 0’s random scene, for watching the canvas under load' }
];

export type CommandId =
  | 'new'
  | 'open'
  | 'openRecent'
  | 'save'
  | 'saveAs'
  | 'importChip'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'selectAll'
  | 'deselect'
  | 'rotate'
  | 'makeChip'
  | 'openChip'
  | 'fit'
  | 'zoomIn'
  | 'zoomOut'
  | 'upLevel'
  | 'topLevel'
  | 'analyser'
  | 'truthTable'
  | 'runPause'
  | 'step'
  | `rate:${string}`
  | `example:${SceneName}`
  | `program:${string}`
  | 'shortcuts'
  | 'gettingStarted'
  | 'menuBar';

/** ⌘ on a Mac, Ctrl everywhere else; a worker has a navigator too. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

interface Command {
  readonly label: string;
  /** The keys, written the way they are read. */
  readonly keys?: string;
  /** Kept out of the shortcut sheet: a rate is one of a set, and the sheet lists keys, not items. */
  readonly group?: 'File' | 'Edit' | 'View' | 'Simulate' | 'Help';
}

const FIXED: Readonly<Record<string, Command>> = {
  new: { label: 'New circuit', group: 'File' },
  open: { label: 'Open…', keys: `${MOD}+O`, group: 'File' },
  openRecent: { label: 'Open recent…', group: 'File' },
  save: { label: 'Save', keys: `${MOD}+S`, group: 'File' },
  saveAs: { label: 'Save as…', keys: `${MOD}+Shift+S`, group: 'File' },
  importChip: { label: 'Import a file as a chip…', group: 'File' },
  undo: { label: 'Undo', keys: `${MOD}+Z`, group: 'Edit' },
  redo: { label: 'Redo', keys: `${MOD}+Y`, group: 'Edit' },
  cut: { label: 'Cut', keys: `${MOD}+X`, group: 'Edit' },
  copy: { label: 'Copy', keys: `${MOD}+C`, group: 'Edit' },
  paste: { label: 'Paste', keys: `${MOD}+V`, group: 'Edit' },
  duplicate: { label: 'Duplicate', keys: `${MOD}+D`, group: 'Edit' },
  delete: { label: 'Delete', keys: 'Del', group: 'Edit' },
  selectAll: { label: 'Select all', keys: `${MOD}+A`, group: 'Edit' },
  deselect: { label: 'Select nothing', keys: 'Esc', group: 'Edit' },
  rotate: { label: 'Rotate', keys: 'R', group: 'Edit' },
  makeChip: { label: 'Make a chip of the selection', keys: 'M', group: 'Edit' },
  openChip: { label: 'Look inside the chip', keys: 'Double-click', group: 'View' },
  fit: { label: 'Fit the circuit', keys: '0', group: 'View' },
  zoomIn: { label: 'Zoom in', keys: '=', group: 'View' },
  zoomOut: { label: 'Zoom out', keys: '−', group: 'View' },
  upLevel: { label: 'Up one level', keys: 'U', group: 'View' },
  topLevel: { label: 'Back to the top', group: 'View' },
  analyser: { label: 'Logic analyser', keys: 'W', group: 'View' },
  truthTable: { label: 'Truth table of the selection', keys: 'T', group: 'View' },
  runPause: { label: 'Run', keys: `${MOD}+Enter`, group: 'Simulate' },
  step: { label: 'Step one clock cycle', keys: '.', group: 'Simulate' },
  shortcuts: { label: 'Keyboard shortcuts', keys: '?', group: 'Help' },
  gettingStarted: { label: 'Getting started', group: 'Help' },
  menuBar: { label: 'Go to the menu bar', keys: 'F10', group: 'Help' }
};

export function rateLabel(rate: ClockRate): string {
  return rate === 'max' ? 'As fast as it goes' : rate >= 1000 ? `${rate / 1000} kHz` : `${rate} Hz`;
}

export function rateOf(id: CommandId): ClockRate | null {
  if (!id.startsWith('rate:')) return null;
  const text = id.slice(5);
  return text === 'max' ? 'max' : Number(text);
}

export function commandLabel(id: CommandId): string {
  const rate = rateOf(id);
  if (rate !== null) return `Clock: ${rateLabel(rate)}`;
  if (id.startsWith('example:')) return EXAMPLES.find(e => `example:${e.scene}` === id)?.label ?? id;
  if (id.startsWith('program:')) return `Computer running ${id.slice(8)}`;
  return FIXED[id]?.label ?? id;
}

export function commandKeys(id: CommandId): string | undefined {
  return FIXED[id]?.keys;
}

export const MENUS: readonly MenuBarMenu<CommandId>[] = [
  {
    label: 'File',
    mnemonic: 'f',
    entries: ['new', 'open', 'openRecent', MENU_SEPARATOR, 'save', 'saveAs', MENU_SEPARATOR, 'importChip']
  },
  {
    label: 'Edit',
    mnemonic: 'e',
    entries: [
      'undo',
      'redo',
      MENU_SEPARATOR,
      'cut',
      'copy',
      'paste',
      'duplicate',
      'delete',
      MENU_SEPARATOR,
      'selectAll',
      'deselect',
      MENU_SEPARATOR,
      'rotate',
      'makeChip'
    ]
  },
  {
    label: 'View',
    mnemonic: 'v',
    entries: ['fit', 'zoomIn', 'zoomOut', MENU_SEPARATOR, 'openChip', 'upLevel', 'topLevel', MENU_SEPARATOR, 'analyser', 'truthTable']
  },
  {
    label: 'Simulate',
    mnemonic: 's',
    entries: ['runPause', 'step', MENU_SEPARATOR, ...RATES.map((rate): CommandId => `rate:${rate}`)]
  },
  {
    label: 'Examples',
    mnemonic: 'x',
    entries: [
      ...EXAMPLES.filter(e => e.scene !== 'bench').map((e): CommandId => `example:${e.scene}`),
      MENU_SEPARATOR,
      ...PROGRAMS.map((p): CommandId => `program:${p.name}`),
      MENU_SEPARATOR,
      'example:bench'
    ]
  },
  { label: 'Help', mnemonic: 'h', entries: ['gettingStarted', 'shortcuts'] }
];

/** The shortcut sheet: the commands with a key, by menu, then what the pointer and the part keys do. */
export function shortcutSections(): readonly { readonly title: string; readonly lines: readonly (readonly [string, string])[] }[] {
  const groups = ['File', 'Edit', 'View', 'Simulate', 'Help'] as const;
  const fromTable = groups.map(group => ({
    title: group,
    lines: Object.values(FIXED)
      .filter(command => command.group === group && command.keys !== undefined)
      .map(command => [command.label === 'Run' ? 'Run or pause' : command.label, command.keys!] as const)
  }));
  return [
    ...fromTable,
    {
      title: 'On the canvas',
      lines: [
        ['Draw a wire', 'Drag from a pin'],
        ['Select several', 'Drag across empty space'],
        ['Add to the selection', 'Shift+click'],
        ['Flip a switch', 'Click it once selected'],
        ['Press a button', 'Hold it down'],
        ['Probe a wire', 'Drop a probe on it'],
        ['Nudge the selection', 'Arrows, Shift for 4'],
        ['Pan', 'Space+drag, right-drag or wheel'],
        ['Zoom', `${MOD}+wheel or pinch`],
        ['Open a circuit file', 'Drop it on the canvas']
      ]
    },
    { title: 'Parts', lines: PART_KEYS.map(([, label, key]) => [label, key] as const) }
  ];
}

/** Every part a person can place from the palette, by section, with the key that picks it up (see `Editor.ts`). */
export const PART_SECTIONS = [
  {
    title: 'Inputs',
    parts: [
      ['input', 'Switch', 'I', 'A switch you flip: click it, then click again'],
      ['button', 'Button', 'B', 'High only while it is held down'],
      ['clock', 'Clock', 'C', 'Ticks at the simulation clock rate'],
      ['constant', 'Constant', 'K', 'Always 0 or always 1']
    ]
  },
  {
    title: 'Outputs',
    parts: [
      ['output', 'LED', 'L', 'Lights when its input is high'],
      ['probe', 'Probe', 'P', 'Shows a value; drop it on a wire to clip on'],
      ['hex', 'Hex display', 'H', 'A bus’s value in hexadecimal'],
      ['seg7', '7-segment', '7', 'Seven segments, driven one wire each']
    ]
  },
  {
    title: 'Gates',
    parts: [
      ['not', 'NOT', 'N', 'High when its input is low'],
      ['and', 'AND', 'A', 'High when every input is high'],
      ['or', 'OR', 'O', 'High when any input is high'],
      ['xor', 'XOR', 'X', 'High when an odd number of inputs are high'],
      ['nand', 'NAND', 'Shift+A', 'AND, inverted'],
      ['nor', 'NOR', 'Shift+O', 'OR, inverted'],
      ['xnor', 'XNOR', 'Shift+X', 'XOR, inverted']
    ]
  },
  {
    title: 'Wiring',
    parts: [
      ['split', 'Split', 'S', 'A bus into its bits'],
      ['join', 'Join', 'J', 'Bits into a bus']
    ]
  }
] as const;

const PART_KEYS = PART_SECTIONS.flatMap(section => section.parts.map(([kind, label, key]) => [kind, label, key] as const));
