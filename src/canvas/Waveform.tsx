import { combineLatest, type Observable } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';

import {
  percent,
  type PaintBox,
  type PaintSurface,
  type UiKeyboardEvent,
  type UiPaint,
  type UiPointerEvent,
  type UiTextChangeEvent,
  type UiWheelEvent
} from 'gesso-core';
import { internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, type AnalyserView } from '../app/CircuitContract';

/**
 * The logic analyser's panel: a strip of waveforms along the bottom of
 * the canvas, one row a probe or LED.
 *
 * It holds no history. It says which cycles it shows and how many
 * pixel columns it has, and the application worker answers with one
 * entry a column (`Analyser.window`), so scrubbing a history of
 * thousands of cycles costs a few hundred characters a frame. While it
 * follows — until someone scrubs — the window ends at the newest cycle
 * and moves as the circuit runs.
 *
 *   - drag, or the wheel, scrubs through time;
 *   - ctrl-wheel zooms in time about the pointer;
 *   - a click places the cursor, and each row says its value there;
 *   - Live goes back to following the newest cycle;
 *   - the trigger field, `name = value`, pauses the circuit on the cycle
 *     that becomes true.
 *
 * One-bit rows are square waves. A bus is a staircase — its height is its
 * value — with the value in hex where a step is wide enough to read, so a
 * counter's count climbs and falls back as it wraps. A column that
 * changed within it is drawn as a band.
 */

/** The panel's rows and gutter, in pixels. */
const ROW = 30;
const GUTTER = 96;
const HEADER = 30;
const MIN_SPAN = 8;

export interface WaveformPanel {
  readonly element: unknown;
  readonly open: Observable<boolean>;
  /** How tall the panel is, over the bottom of the canvas, when open. */
  readonly height: Observable<number>;
  toggle(): void;
}

export function waveformPanel(ctx: ComponentContext, canvasWidth: Observable<number>): WaveformPanel {
  const circuit = ctx.channel(Circuit);
  const open = internalState(false);
  /** Cycles shown, the first of them (null follows the newest), and the cursor's cycle. */
  const span = internalState(256);
  const start = internalState<number | null>(null);
  const cursor = internalState<number | null>(null);
  const triggerText = internalState('');
  const view = circuit.view.analyser;
  let columns = 0;

  // Asks for the window whenever what it shows, or how wide it is, moves.
  ctx.effect(
    combineLatest([open, span, start, canvasWidth]).pipe(
      map(([isOpen, s, first, width]) => [isOpen, s, first, Math.max(0, Math.floor(width - 24 - GUTTER))] as const),
      distinctUntilChanged((a, b) => a.every((v, i) => v === b[i]))
    ),
    ([isOpen, s, first, width]) => {
      columns = width;
      circuit.send.setAnalyserView(first, s, isOpen ? width : 0);
    }
  );

  /** The first cycle drawn: the one asked for, or while following, the newest span. */
  const firstShown = (v: AnalyserView) => v.start;
  const cyclesPerPixel = () => span.value / Math.max(1, columns);
  const cycleAt = (x: number, v: AnalyserView) => Math.round(firstShown(v) + (x - GUTTER) * cyclesPerPixel());

  /** The wave area's box: pointer positions are the page's, and the panel is not at its left edge. */
  const waves = ctx.bounds('waves');
  const xOf = (event: { x: number }) => event.x - waves.value.x;

  let drag: { x: number; start: number; moved: boolean } | null = null;
  const pointerDown = (event: UiPointerEvent) => {
    const v = view.value;
    drag = { x: xOf(event), start: firstShown(v), moved: false };
  };
  const pointerMove = (event: UiPointerEvent) => {
    if (drag === null) return;
    const dx = xOf(event) - drag.x;
    if (Math.abs(dx) >= 3) drag.moved = true;
    if (drag.moved) start.value = Math.round(drag.start - dx * cyclesPerPixel());
  };
  const pointerUp = (event: UiPointerEvent) => {
    if (drag !== null && !drag.moved && xOf(event) >= GUTTER) cursor.value = cycleAt(xOf(event), view.value);
    drag = null;
  };
  const wheel = (event: UiWheelEvent) => {
    const v = view.value;
    if (event.modifiers.ctrl || event.modifiers.meta) {
      // About the pointer: the cycle under it stays under it.
      const at = cycleAt(xOf(event), v);
      const next = Math.max(MIN_SPAN, Math.min(8192, Math.round(span.value * Math.exp(event.deltaY * 0.002))));
      const fraction = (xOf(event) - GUTTER) / Math.max(1, columns);
      span.value = next;
      start.value = Math.round(at - fraction * next);
    } else {
      start.value = Math.round(firstShown(v) + (event.deltaX + event.deltaY) * cyclesPerPixel());
    }
  };
  const zoom = (factor: number) => {
    const v = view.value;
    const centre = firstShown(v) + span.value / 2;
    const next = Math.max(MIN_SPAN, Math.min(8192, Math.round(span.value * factor)));
    span.value = next;
    if (start.value !== null) start.value = Math.round(centre - next / 2);
  };
  const applyTrigger = () => {
    const text = triggerText.value.trim();
    if (text === '') {
      circuit.send.setTrigger(null, 0);
      return;
    }
    const match = /^(.+?)\s*=\s*(0x[0-9a-f]+|\d+)$/i.exec(text);
    const trace = match === null ? undefined : view.value.traces.find(t => t.name === match[1]!.trim() || t.id === match[1]!.trim());
    if (match === null || trace === undefined) return;
    const value = /^0x/i.test(match[2]!) ? Number.parseInt(match[2]!.slice(2), 16) : Number.parseInt(match[2]!, 10);
    circuit.send.setTrigger(trace.id, value);
  };

  const paint = combineLatest([view, cursor]).pipe(
    map(([v, c]): UiPaint => ({ draw: (surface, box) => drawWaves(surface, box, v, c), inputs: [v, c] }))
  );
  const height = view.pipe(map(v => HEADER + Math.max(1, v.traces.length) * ROW + 8));
  const range = view.pipe(
    map(v =>
      v.last < v.first
        ? 'nothing recorded yet: run or step the circuit'
        : `cycles ${v.start.toLocaleString('en')}–${(v.start + v.step * v.count - 1).toLocaleString('en')} of ${v.first.toLocaleString('en')}–${v.last.toLocaleString('en')}${v.step > 1 ? ` · ${v.step} a pixel` : ''}`
    )
  );

  const button = (label: string | Observable<string>, onClick: () => void) => (
    <button
      onClick={onClick}
      paddingLeft={8}
      paddingRight={8}
      paddingTop={3}
      paddingBottom={3}
      borderRadius={5}
      backgroundColor="controlBackground"
      borderColor="controlBorder"
      borderWidth={1}
      cursor="pointer">
      <text text={label} fontSize={11} color="controlForeground" />
    </button>
  );

  const element = (
    <column
      position="absolute"
      left={12}
      right={12}
      bottom={12}
      height={height}
      padding={6}
      gap={4}
      borderRadius={8}
      backgroundColor="surface"
      borderColor="border"
      borderWidth={1}
      opacity={open.pipe(map(o => (o ? 0.97 : 0)))}
      pointerEvents={open.pipe(map(o => (o ? 'auto' : 'none')))}>
      <row gap={6} y="center">
        <text text="Analyser" fontSize={12} fontWeight={600} color="text" />
        {/* Takes the slack, so the controls stay put while the range's width changes every cycle. */}
        <text text={range} flex={1} minWidth={0} fontSize={11} color="textMuted" textWrap="none" textOverflow="ellipsis" />
        {button(start.pipe(map(s => (s === null ? 'Live ●' : 'Live'))), () => (start.value = null))}
        {button('−', () => zoom(2))}
        {button('+', () => zoom(0.5))}
        <text text="Trigger" fontSize={11} color="textMuted" />
        <editabletext
          value={triggerText as never}
          width={120}
          fontSize={11}
          color="text"
          textWrap="none"
          backgroundColor="background"
          borderColor="border"
          borderWidth={1}
          padding={3}
          role="textbox"
          label="Trigger, as name = value"
          onInput={(event: UiTextChangeEvent) => (triggerText.value = event.value)}
          onKeyDown={(event: UiKeyboardEvent) => {
            if (event.key === 'Enter') {
              applyTrigger();
              event.preventDefault();
            }
          }}
        />
        <text
          text={view.pipe(map(v => (v.trigger === null ? '' : `armed: ${v.traces.find(t => t.id === v.trigger!.trace)?.name ?? v.trigger.trace} = ${v.trigger.value}`)))}
          fontSize={11}
          color="textMuted"
        />
        {button('Close', () => (open.value = false))}
      </row>
      <box
        width={percent(100)}
        height={view.pipe(map(v => Math.max(1, v.traces.length) * ROW))}
        modifiers={[waves.modifier]}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onWheel={wheel}
        overscrollBehavior="contain">
        <paint width={percent(100)} height={percent(100)} paint={paint} />
      </box>
    </column>
  );

  return { element, open, height, toggle: () => (open.value = !open.value) };
}

/** The waves: names in the gutter, a row a trace, and the cursor with each row's value at it. */
function drawWaves(surface: PaintSurface, box: PaintBox, v: AnalyserView, cursor: number | null): void {
  const width = box.width - GUTTER;
  if (width <= 0 || v.count === 0) {
    surface.fillColor('textMuted');
    surface.text(v.traces.length === 0 ? 'Nothing to trace: add a probe or an LED.' : '', 8, 18, { fontSize: 12 });
    return;
  }
  const column = width / v.count;
  const at = (i: number) => GUTTER + i * column;

  v.traces.forEach((trace, row) => {
    const top = row * ROW + 4;
    const bottom = top + ROW - 10;
    surface.fillColor('text');
    surface.text(trace.name, 6, top + 15, { fontSize: 11, fontWeight: 600 });
    const entries = trace.width === 1 ? [...(v.data[trace.id] ?? '')] : (v.data[trace.id] ?? '').split(',');
    const max = 2 ** trace.width - 1;

    // Bands where a column changed within itself.
    surface.beginPath();
    entries.forEach((entry, i) => {
      if (entry === '*') surface.rect(at(i), top, Math.max(1, column), bottom - top);
    });
    surface.fillColor('placeholder');
    surface.fill();

    // The trace: a step per column, joined where it holds still.
    surface.beginPath();
    let drawing = false;
    entries.forEach((entry, i) => {
      if (entry === '*' || entry === '.' || entry === '') {
        drawing = false;
        return;
      }
      const value = trace.width === 1 ? Number(entry) : Number.parseInt(entry, 16);
      const y = bottom - (value / Math.max(1, max)) * (bottom - top);
      if (!drawing) surface.moveTo(at(i), y);
      else surface.lineTo(at(i), y);
      surface.lineTo(at(i + 1), y);
      drawing = true;
    });
    surface.strokeColor('primary');
    surface.lineWidth(1.5);
    surface.stroke();

    // A bus's value where a run of it is wide enough to read.
    if (trace.width > 1) {
      surface.fillColor('text');
      let runStart = 0;
      for (let i = 1; i <= entries.length; i++) {
        if (i < entries.length && entries[i] === entries[runStart]) continue;
        const entry = entries[runStart]!;
        const runWidth = (i - runStart) * column;
        if (entry !== '*' && entry !== '.' && runWidth >= 8 * entry.length + 6) {
          surface.text(entry, at(runStart) + 3, top + 11, { fontSize: 10, fontFamily: 'monospace' });
        }
        runStart = i;
      }
    }

    // The row's rule.
    surface.beginPath();
    surface.moveTo(GUTTER, bottom + 4);
    surface.lineTo(box.width, bottom + 4);
    surface.strokeColor('border');
    surface.lineWidth(1);
    surface.stroke();
  });

  // The cursor, and each row's value at it.
  if (cursor !== null) {
    const i = Math.floor((cursor - v.start) / v.step);
    if (i >= 0 && i < v.count) {
      const x = at(i) + column / 2;
      surface.beginPath();
      surface.moveTo(x, 0);
      surface.lineTo(x, box.height);
      surface.strokeColor('text');
      surface.lineWidth(1);
      surface.stroke();
      surface.fillColor('text');
      surface.text(`cycle ${cursor.toLocaleString('en')}`, x + 4, box.height - 4, { fontSize: 10 });
      v.traces.forEach((trace, row) => {
        const entries = trace.width === 1 ? [...(v.data[trace.id] ?? '')] : (v.data[trace.id] ?? '').split(',');
        const entry = entries[i] ?? '.';
        const text = entry === '.' ? '' : entry === '*' ? '~' : trace.width === 1 ? entry : `0x${entry}`;
        surface.text(text, 6, row * ROW + 26, { fontSize: 10, fontFamily: 'monospace' });
      });
    }
  }
}
