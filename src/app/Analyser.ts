/**
 * The logic analyser's memory: the value of every traced signal at the
 * end of each of the last `capacity` clock cycles.
 *
 * A trace is a probe or an LED on the top level, named by its label; a
 * wide one is a bus, and its value is a number. After every cycle the
 * service hands over the simulator's net values and this keeps what the
 * traces show, a word a trace a cycle in a ring.
 *
 * The panel does not get the ring. It asks for a window — a first cycle,
 * a span and how many pixel columns it has — as the canvas asks for the
 * nets in its viewport, and gets one entry a column. A column covering
 * more than one cycle says what it showed if it held still, and `*` if
 * it changed within it, so a trace that toggles every cycle draws as a
 * band at any zoom instead of a thousand lines in one pixel. The window
 * a panel scrubbing at 60 fps asks for is a few hundred characters a
 * trace, whatever the history holds.
 */

export interface Trace {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  /** The nets it reads, least significant bit first. */
  readonly nets: readonly number[];
}

export interface AnalyserWindow {
  /** The first cycle the window covers. */
  readonly start: number;
  /** Cycles a column. */
  readonly step: number;
  /** Columns. */
  readonly count: number;
  /**
   * A string a trace, a column an entry. A one-bit trace's is a
   * character a column: `0`, `1`, `*` where it changed within the
   * column, `.` where nothing was recorded. A bus's is its entries joined
   * by commas: a value in hex, `*` or `.`.
   */
  readonly data: Readonly<Record<string, string>>;
}

export interface Trigger {
  readonly trace: string;
  readonly value: number;
}

/**
 * Cycles held. At a thousand cycles a second that is a minute of
 * history; at full speed on a small circuit — hundreds of thousands a
 * second — a fraction of one, which is what scrubbing back can reach.
 * Five traces of it are a megabyte and a bit.
 */
export const DEFAULT_CAPACITY = 65536;

export class Analyser {
  private traces: readonly Trace[] = [];
  private values: Uint32Array[] = [];
  /** The cycle held in slot `(start + i) % capacity`, for the i-th oldest of `size`. */
  private oldest = 0;
  private size = 0;
  private startSlot = 0;
  private trigger: Trigger | null = null;

  constructor(readonly capacity = DEFAULT_CAPACITY) {}

  /**
   * Says what to trace. The same traces on the same nets keep their
   * history; anything else starts afresh, because an old cycle's values
   * say nothing about a net that is now something else.
   */
  configure(traces: readonly Trace[]): void {
    // Matched by id and nets, not by order: a moved LED is drawn in a new
    // place in the list, and is the same trace.
    const key = (t: Trace) => `${t.id}|${t.width}|${t.nets.join(',')}`;
    const was = new Map(this.traces.map((t, i) => [key(t), this.values[i]!]));
    const same = traces.length === this.traces.length && traces.every(t => was.has(key(t)));
    this.traces = traces;
    if (same) {
      this.values = traces.map(t => was.get(key(t))!);
    } else {
      this.values = traces.map(() => new Uint32Array(this.capacity));
      this.clear();
    }
    if (this.trigger !== null && !traces.some(t => t.id === this.trigger!.trace)) {
      this.trigger = null;
    }
  }

  clear(): void {
    this.size = 0;
    this.startSlot = 0;
    this.oldest = 0;
  }

  get traced(): readonly Trace[] {
    return this.traces;
  }

  /** The oldest cycle held, and the newest; `last` is `first - 1` when nothing is. */
  get first(): number {
    return this.oldest;
  }

  get last(): number {
    return this.oldest + this.size - 1;
  }

  setTrigger(trigger: Trigger | null): void {
    this.trigger = trigger !== null && this.traces.some(t => t.id === trigger.trace) ? trigger : null;
  }

  get armed(): Trigger | null {
    return this.trigger;
  }

  /**
   * Keeps the values at the end of `cycle`. A cycle that does not follow
   * the last one — a new simulator, a run that skipped — starts afresh.
   * Returns true when the trigger's trace has just become its value, on
   * this cycle and not the one before.
   */
  record(cycle: number, nets: Uint8Array): boolean {
    if (this.traces.length === 0) return false;
    if (this.size > 0 && cycle !== this.last + 1) {
      this.clear();
    }
    if (this.size === 0) {
      this.oldest = cycle;
    }
    let slot: number;
    if (this.size < this.capacity) {
      slot = (this.startSlot + this.size) % this.capacity;
      this.size++;
    } else {
      slot = this.startSlot;
      this.startSlot = (this.startSlot + 1) % this.capacity;
      this.oldest++;
    }
    let fired = false;
    this.traces.forEach((trace, i) => {
      let value = 0;
      trace.nets.forEach((net, bit) => {
        if (net >= 0 && nets[net] === 1) value |= 1 << bit;
      });
      value >>>= 0;
      const column = this.values[i]!;
      if (this.trigger?.trace === trace.id && value === this.trigger.value) {
        const before = this.size > 1 ? column[(slot + this.capacity - 1) % this.capacity] : undefined;
        if (before !== value) fired = true;
      }
      column[slot] = value;
    });
    return fired;
  }

  /** A trace's value at the end of a cycle, or null when that cycle is not held. */
  valueAt(trace: string, cycle: number): number | null {
    const i = this.traces.findIndex(t => t.id === trace);
    if (i < 0 || cycle < this.first || cycle > this.last) return null;
    return this.values[i]![(this.startSlot + (cycle - this.oldest)) % this.capacity]!;
  }

  /** The window a panel of `columns` pixels asks for: `span` cycles from `start`. */
  window(start: number, span: number, columns: number): AnalyserWindow {
    const width = Math.max(1, Math.floor(span));
    const step = Math.max(1, Math.ceil(width / Math.max(1, columns)));
    const count = Math.ceil(width / step);
    const data: Record<string, string> = {};
    this.traces.forEach((trace, i) => {
      const column = this.values[i]!;
      const entries: string[] = [];
      for (let c = 0; c < count; c++) {
        const from = Math.max(start + c * step, this.first);
        const to = Math.min(start + (c + 1) * step - 1, this.last);
        if (from > to) {
          entries.push('.');
          continue;
        }
        const first = column[(this.startSlot + (from - this.oldest)) % this.capacity]!;
        let changed = false;
        for (let cycle = from + 1; cycle <= to && !changed; cycle++) {
          changed = column[(this.startSlot + (cycle - this.oldest)) % this.capacity] !== first;
        }
        entries.push(changed ? '*' : trace.width === 1 ? String(first) : first.toString(16).toUpperCase());
      }
      data[trace.id] = trace.width === 1 ? entries.join('') : entries.join(',');
    });
    return { start, step, count, data };
  }
}
