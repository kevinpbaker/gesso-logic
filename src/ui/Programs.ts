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

const GAME_SOURCES = import.meta.glob<string>('../cpu/games/*.asm', { query: '?raw', import: 'default', eager: true });

/** A game for the computer, and the clock it is played at. */
export interface Game extends Program {
  /** What the menu calls it: `Pong`. */
  readonly title: string;
  readonly rate: number;
}

/**
 * The clock each game is played at, by file name. Pong at 20 kHz: at
 * 30 kHz, what it was first written for, the ball crossed the screen in
 * about a second, which was too quick to enjoy, and 15 kHz, where it
 * went next, was a touch too slow.
 */
const GAME_RATES: Readonly<Record<string, number>> = { 'pong.asm': 20_000 };

export const GAMES: readonly Game[] = Object.entries(GAME_SOURCES)
  .map(([path, source]) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const about = /^;\s*(.+)$/m.exec(source)?.[1]?.trim() ?? '';
    return { name, about, source, title: name.replace(/\.asm$/, '').replace(/^./, c => c.toUpperCase()), rate: GAME_RATES[name] ?? 1000 };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
