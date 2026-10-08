/**
 * The logic analyser's history as a VCD file — Value Change Dump, IEEE
 * 1364's waveform format — which GTKWave, Surfer, PulseView and every
 * HDL simulator's viewer open.
 *
 * One time unit a clock cycle: the simulator has no time but cycles, so
 * a cycle is written as a nanosecond, and the header says so. Each trace
 * is a `wire` of its width in one scope, named as the analyser names it
 * with anything a VCD name cannot hold turned into `_`. Only changes are
 * written, as the format intends, so a quiet trace over sixty thousand
 * cycles is a line. A cycle before a trace was recorded — one traced
 * mid-run — is `x`, unknown, which is what it was to the analyser.
 */

export interface VcdTrace {
  readonly name: string;
  readonly width: number;
}

export interface VcdSource {
  readonly traces: readonly VcdTrace[];
  /** The oldest cycle held and the newest; `last` is `first - 1` when none is. */
  readonly first: number;
  readonly last: number;
  /** A trace's value at the end of a cycle, by its index; null where it was not recorded. */
  valueAt(trace: number, cycle: number): number | null;
}

/** The short code a VCD names a signal by in its changes: printable ASCII, base 94. */
function code(index: number): string {
  let out = '';
  let n = index;
  do {
    out += String.fromCharCode(33 + (n % 94));
    n = Math.floor(n / 94) - 1;
  } while (n >= 0);
  return out;
}

/** A name a VCD reader takes: no whitespace, and no characters that end or nest a scope. */
export function vcdName(name: string): string {
  const cleaned = name.trim().replace(/\s*›\s*/g, '.').replace(/[^\x21-\x7e]+/g, '_').replace(/[$]/g, '_');
  return cleaned === '' ? 'signal' : cleaned;
}

function valueText(value: number | null, width: number, id: string): string {
  if (width === 1) return `${value === null ? 'x' : value & 1}${id}`;
  return `b${value === null ? 'x' : value.toString(2)} ${id}`;
}

export function writeVcd(source: VcdSource, options: { readonly date?: string; readonly scope?: string } = {}): string {
  const lines: string[] = [];
  if (options.date !== undefined) lines.push(`$date ${options.date} $end`);
  lines.push('$version gessologic $end');
  lines.push('$comment one time unit is one clock cycle $end');
  lines.push('$timescale 1ns $end');
  lines.push(`$scope module ${vcdName(options.scope ?? 'circuit')} $end`);
  const ids = source.traces.map((_, i) => code(i));
  // Two traces may share a name — the same pin in two chips is told
  // apart in the panel by its place — and a reader wants them distinct.
  const seen = new Map<string, number>();
  source.traces.forEach((trace, i) => {
    const base = vcdName(trace.name);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const name = count === 0 ? base : `${base}_${count + 1}`;
    lines.push(`$var wire ${trace.width} ${ids[i]} ${name}${trace.width > 1 ? ` [${trace.width - 1}:0]` : ''} $end`);
  });
  lines.push('$upscope $end');
  lines.push('$enddefinitions $end');
  if (source.last < source.first || source.traces.length === 0) return `${lines.join('\n')}\n`;

  const previous: (number | null | undefined)[] = source.traces.map(() => undefined);
  for (let cycle = source.first; cycle <= source.last; cycle++) {
    const changes: string[] = [];
    source.traces.forEach((trace, i) => {
      const value = source.valueAt(i, cycle);
      if (previous[i] !== undefined && value === previous[i]) return;
      previous[i] = value;
      changes.push(valueText(value, trace.width, ids[i]!));
    });
    if (changes.length === 0) continue;
    lines.push(`#${cycle}`);
    if (cycle === source.first) lines.push('$dumpvars', ...changes, '$end');
    else lines.push(...changes);
  }
  // The end of the last cycle, so a viewer draws it as wide as the others.
  lines.push(`#${source.last + 1}`);
  return `${lines.join('\n')}\n`;
}
