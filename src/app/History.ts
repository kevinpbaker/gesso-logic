/**
 * What the circuit was, for scrubbing back through time: every net's
 * value at the end of a cycle, now and then, and every input a person
 * gave it in between.
 *
 * A cycle's end is the whole of a circuit's state (see
 * `Simulator.restore`), and the simulator is deterministic, so any cycle
 * since the oldest keyframe can be had again exactly: restore the
 * keyframe at or before it, and run on to it, giving each input on the
 * cycle it was given. Keeping every cycle's values would be a
 * keyframe's bytes a cycle; a keyframe every `KEYFRAME_EVERY` cycles is
 * that divided by 256, and running on to a cycle is at most 255 cycles,
 * a few milliseconds even for the CPU.
 *
 * The keyframes are held within a budget of bytes; past it the oldest
 * go, so a huge circuit or a fast run keeps a shorter past rather than
 * more memory.
 */

/** Cycles between keyframes: the most a replay runs. */
export const KEYFRAME_EVERY = 256;
/** The bytes keyframes may take. */
export const HISTORY_BUDGET = 16 * 1024 * 1024;

export interface Keyframe {
  /** The cycle whose end it holds. */
  readonly cycle: number;
  readonly values: Uint8Array;
}

/** A switch set or a button pressed: given while the simulator had run `cycle` cycles, so before the next. */
export interface GivenInput {
  readonly cycle: number;
  readonly id: string;
  readonly value: number;
}

export class History {
  private keyframes: Keyframe[] = [];
  private inputs: GivenInput[] = [];
  /** The newest cycle recorded; -1 for none. */
  private newest = -1;
  private nextKeyframe = 0;

  private readonly budget: number;
  private readonly every: number;

  constructor(budget = HISTORY_BUDGET, every = KEYFRAME_EVERY) {
    this.budget = budget;
    this.every = every;
  }

  /** The oldest cycle that can be had again, and the newest; `first` is -1 when there is none. */
  get first(): number {
    return this.keyframes[0]?.cycle ?? -1;
  }

  get last(): number {
    return this.newest;
  }

  get bytes(): number {
    return this.keyframes.reduce((sum, k) => sum + k.values.byteLength, 0);
  }

  clear(): void {
    this.keyframes = [];
    this.inputs = [];
    this.newest = -1;
    this.nextKeyframe = 0;
  }

  /**
   * The end of a cycle: `cycle` cycles run, `values` every net's value.
   * A cycle that does not follow the last starts afresh, as the
   * analyser does: what came before says nothing about it.
   */
  record(cycle: number, values: Uint8Array): void {
    if (this.newest >= 0 && cycle !== this.newest + 1) this.clear();
    if (this.keyframes.length === 0 || cycle >= this.nextKeyframe) {
      this.keyframes.push({ cycle, values: values.slice() });
      this.nextKeyframe = cycle + this.every;
      while (this.keyframes.length > 1 && this.bytes > this.budget) this.keyframes.shift();
      const oldest = this.keyframes[0]!.cycle;
      if (this.inputs.length > 0 && this.inputs[0]!.cycle < oldest) this.inputs = this.inputs.filter(i => i.cycle >= oldest);
    }
    this.newest = cycle;
  }

  /**
   * Forgets every cycle after `cycle`, and every input given from it on:
   * the circuit has gone back to it, and what follows will be recorded
   * afresh. A keyframe after it goes; the next is due as if the keyframe
   * before it had been the last.
   */
  truncate(cycle: number): void {
    if (cycle >= this.newest) return;
    this.keyframes = this.keyframes.filter(k => k.cycle <= cycle);
    this.inputs = this.inputs.filter(i => i.cycle < cycle);
    if (this.keyframes.length === 0) {
      this.clear();
      return;
    }
    this.newest = cycle;
    this.nextKeyframe = this.keyframes[this.keyframes.length - 1]!.cycle + this.every;
  }

  /** An input given with `cycle` cycles run: replayed before the cycle after. Nothing is kept before the first keyframe. */
  input(cycle: number, id: string, value: number): void {
    if (this.keyframes.length === 0) return;
    this.inputs.push({ cycle, id, value });
  }

  /**
   * How to have `cycle` again: the keyframe to restore, and the inputs
   * to give on the way, in order. Null for a cycle not held.
   */
  plan(cycle: number): { readonly from: Keyframe; readonly inputs: readonly GivenInput[] } | null {
    if (this.keyframes.length === 0 || cycle < this.first || cycle > this.newest) return null;
    let from = this.keyframes[0]!;
    for (const k of this.keyframes) {
      if (k.cycle > cycle) break;
      from = k;
    }
    return { from, inputs: this.inputs.filter(i => i.cycle >= from.cycle && i.cycle < cycle) };
  }
}
