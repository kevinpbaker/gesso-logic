import { assemble, type Assembled } from './Assembler';
import { Emulator } from './Emulator';
import { FRAMEBUFFER } from './Isa';

/**
 * Pong on the reference emulator, a frame at a time: the harness the
 * game is written and debugged against before it runs on gates.
 *
 * The emulator's devices are the computer's (see `Lockstep.ts`): the
 * buttons on `IN 0`, and on `IN 1` the frame tick, bit 9 of the clock
 * edges since reset. `frame` runs until the tick turns and the game has
 * done that frame's work and is waiting again, so its state — read from
 * RAM by the program's own names — is whole.
 */

/** Cycles between turns of the frame tick. */
export const TICK_CYCLES = 512;

export interface PongState {
  readonly ball: { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number };
  readonly left: number;
  readonly right: number;
  readonly scores: readonly [number, number];
}

export class PongHarness {
  readonly program: Assembled;
  readonly emulator: Emulator;
  up = false;
  down = false;
  /** The scores as the `OUT` ports last showed them, and every write to them in order. */
  readonly shown: [number, number] = [0, 0];
  readonly outs: [port: number, value: number][] = [];
  /** Cycles the last frame's work took, from the tick turning to the game waiting again. */
  lastWork = 0;

  constructor(source: string) {
    this.program = assemble(source);
    this.emulator = new Emulator(this.program.rom, {
      read: port => {
        if (port === 0) return (this.up ? 1 : 0) | (this.down ? 2 : 0);
        if (port === 1) return ((this.emulator.cycles + 1) >> 9) & 1;
        return 0;
      },
      write: (port, value) => {
        if (port < 2) {
          this.shown[port] = value;
          this.outs.push([port, value]);
        }
      }
    });
    this.waitAt(); // through the setup, to the first wait
  }

  private symbol(name: string): number {
    const value = this.program.symbols.get(name);
    if (value === undefined) throw new Error(`The program has no '${name}'.`);
    return value;
  }

  /** Runs until the program is at its wait loop, reading the tick. */
  private waitAt(): void {
    const wait = this.symbol('wait');
    for (let i = 0; i < 1_000_000 && this.emulator.state.pc !== wait; i++) this.emulator.step();
    if (this.emulator.state.pc !== wait) throw new Error('The game never came back to its wait loop.');
  }

  /** One frame: to the next turn of the tick, and through the work it sets off. */
  frame(): void {
    const turn = (Math.floor((this.emulator.cycles + 1) / TICK_CYCLES) + 1) * TICK_CYCLES;
    while (this.emulator.cycles + 1 < turn) this.emulator.step();
    const started = this.emulator.cycles;
    // Off the wait loop, and back to it.
    this.emulator.step();
    this.waitAt();
    this.lastWork = this.emulator.cycles - started;
  }

  get state(): PongState {
    const ram = this.emulator.ram;
    const signed = (v: number) => (v > 127 ? v - 256 : v);
    return {
      ball: { x: ram[this.symbol('BX')]!, y: ram[this.symbol('BY')]!, dx: signed(ram[this.symbol('DX')]!), dy: signed(ram[this.symbol('DY')]!) },
      left: ram[this.symbol('PL')]!,
      right: ram[this.symbol('PR')]!,
      scores: [ram[this.symbol('SL')]!, ram[this.symbol('SR')]!]
    };
  }

  /** Whether pixel (x, y) is lit. */
  pixel(x: number, y: number): boolean {
    return ((this.emulator.ram[FRAMEBUFFER + 4 * y + (x >> 3)]! >> (x & 7)) & 1) === 1;
  }

  /** The screen as text, `#` for a lit pixel. */
  screen(): string {
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) {
      let row = '';
      for (let x = 0; x < 32; x++) row += this.pixel(x, y) ? '#' : '.';
      rows.push(row);
    }
    return rows.join('\n');
  }
}
