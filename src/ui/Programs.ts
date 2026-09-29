/**
 * The CPU's test programs, for the Examples menu to run on the
 * computer.
 *
 * Read here, on the render worker, where Vite bundles them as text,
 * and sent to the application worker as source. The application
 * worker cannot import them itself: `pnpm speed` runs it under plain
 * Node, which has no `?raw`.
 */
const SOURCES = import.meta.glob<string>('../cpu/programs/*.asm', { query: '?raw', import: 'default', eager: true });

export interface Program {
  /** The file's name, `logic.asm`. */
  readonly name: string;
  /** Its first comment line, which says what it exercises. */
  readonly about: string;
  readonly source: string;
}

export const PROGRAMS: readonly Program[] = Object.entries(SOURCES)
  .map(([path, source]) => ({
    name: path.slice(path.lastIndexOf('/') + 1),
    about: /^;\s*(.+)$/m.exec(source)?.[1]?.trim() ?? '',
    source
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
