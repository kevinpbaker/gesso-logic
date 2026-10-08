import { BehaviorSubject, combineLatest, Subject, type Observable } from 'rxjs';
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
import { Menu, type MenuItem } from 'gesso-components';
import { internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, type AnalyserView } from '../app/CircuitContract';
import type { TraceWhere } from './CircuitCanvas';

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
 *     that becomes true;
 *   - a pin or wire Alt+clicked on the canvas, at any depth, is a row of
 *     its own: hovering its name says where it is, and its × takes it away;
 *   - hovering a row lights what it traces on the canvas, and a click on
 *     its name takes the canvas there; dragging its name moves the row;
 *   - right-clicking a row shows a bus in hex, decimal, signed or binary,
 *     pauses the circuit when the row becomes its value at the cursor,
 *     moves it, goes to it, or stops tracing it.
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
/** The × that takes a traced pin away: this wide, at the gutter's right. */
const REMOVE = 16;

/** How a bus's value is written: hex, decimal, two's complement, or bits. */
export type Radix = 'hex' | 'dec' | 'signed' | 'bin';
const RADIX_LABELS: Readonly<Record<Radix, string>> = { hex: 'hex', dec: 'decimal', signed: 'signed decimal', bin: 'binary' };

/** A value `width` bits wide, written in a radix. */
export function written(value: number, width: number, radix: Radix): string {
  switch (radix) {
    case 'dec':
      return String(value);
    case 'signed':
      return String(value >= 2 ** (width - 1) ? value - 2 ** width : value);
    case 'bin':
      return value.toString(2).padStart(width, '0');
    default:
      return value.toString(16).toUpperCase();
  }
}

export interface WaveformPanel {
  readonly element: unknown;
  readonly open: Observable<boolean>;
  /** How tall the panel is, over the bottom of the canvas, when open. */
  readonly height: Observable<number>;
  /** Where the hovered row's signal is; null while no row is hovered. */
  readonly hovered: Observable<TraceWhere | null>;
  /** Where a row whose name was clicked has its signal: the canvas goes there. */
  readonly picked: Observable<TraceWhere>;
  toggle(): void;
}

export function waveformPanel(ctx: ComponentContext, canvasWidth: Observable<number>): WaveformPanel {
  const circuit = ctx.channel(Circuit);
  const open = internalState(false);
  /** Cycles shown, the first of them (null follows the newest), and the cursor's cycle. */
  const span = internalState(256);
  const start = internalState<number | null>(null);
  const cursor = internalState<number | null>(null);
  /** The row whose name the pointer is over, to say where its pin is, and the row it is over at all. */
  const named = internalState<number | null>(null);
  const overRow = internalState<number | null>(null);
  const picked = new Subject<TraceWhere>();
  const triggerText = internalState('');
  /** The rows' order, by trace id — a trace not in it goes after, as published — and how each bus is written. */
  const order = internalState<readonly string[]>([]);
  const radix = internalState<Readonly<Record<string, Radix>>>({});
  /** The view as published, its traces in the rows' order: what is drawn, and what a row number means. */
  const view = new BehaviorSubject<AnalyserView>(circuit.view.analyser.value);
  ctx.effect(combineLatest([circuit.view.analyser, order]), ([v, ids]) => {
    const rank = (id: string, i: number) => {
      const at = ids.indexOf(id);
      return at < 0 ? ids.length + i : at;
    };
    const ranked = v.traces.map((t, i) => ({ t, r: rank(t.id, i) })).sort((a, b) => a.r - b.r);
    view.next({ ...v, traces: ranked.map(x => x.t) });
  });
  /** Moves a row to another place in the list. */
  const moveRow = (from: number, to: number) => {
    const ids = view.value.traces.map(t => t.id);
    if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return;
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id!);
    order.value = ids;
  };
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
  const rowOf = (event: { y: number }) => Math.floor((event.y - waves.value.y) / ROW);

  // A press on the waves scrubs; on a row's name, drags the row.
  let drag: { x: number; y: number; start: number; row: number; moved: boolean } | null = null;
  const pointerDown = (event: UiPointerEvent) => {
    // A right press asks for the row's menu, and never reports its release.
    if ((event.buttons & 1) === 0) return;
    const v = view.value;
    drag = { x: xOf(event), y: event.y, start: firstShown(v), row: xOf(event) < GUTTER ? rowOf(event) : -1, moved: false };
  };
  const pointerMove = (event: UiPointerEvent) => {
    const row = xOf(event) < GUTTER ? rowOf(event) : null;
    if (named.value !== row) named.value = row;
    if (overRow.value !== rowOf(event)) overRow.value = rowOf(event);
    if (drag === null) return;
    if (drag.row >= 0) {
      if (Math.abs(event.y - drag.y) >= 4) drag.moved = true;
      const to = Math.max(0, Math.min(view.value.traces.length - 1, rowOf(event)));
      if (drag.moved && to !== drag.row) {
        moveRow(drag.row, to);
        drag.row = to;
      }
      return;
    }
    const dx = xOf(event) - drag.x;
    if (Math.abs(dx) >= 3) drag.moved = true;
    if (drag.moved) start.value = Math.round(drag.start - dx * cyclesPerPixel());
  };
  const pointerUp = (event: UiPointerEvent) => {
    const x = xOf(event);
    if (drag !== null && !drag.moved && x >= GUTTER) cursor.value = cycleAt(x, view.value);
    // A traced pin's ×.
    const trace = view.value.traces[rowOf(event)];
    const removing = trace?.watched === true && x >= GUTTER - REMOVE && x < GUTTER;
    if (drag !== null && !drag.moved && removing) circuit.send.unwatch(trace.id);
    // Its name: the canvas goes to it.
    else if (drag !== null && !drag.moved && x < GUTTER && trace !== undefined) picked.next({ path: trace.path, pin: trace.pin });
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

  // A row's menu: right-click.
  const menuOpen = internalState(false);
  const menuAt = internalState({ x: 0, y: 0 });
  const menuItems = internalState<readonly MenuItem[]>([]);
  let menuRow = -1;
  /** A row's value at the cursor's column, or null where there is none or it changed within the column. */
  const valueAtCursor = (v: AnalyserView, row: number): number | null => {
    const trace = v.traces[row];
    if (trace === undefined || cursor.value === null) return null;
    const i = Math.floor((cursor.value - v.start) / v.step);
    const entries = trace.width === 1 ? [...(v.data[trace.id] ?? '')] : (v.data[trace.id] ?? '').split(',');
    const entry = entries[i];
    return entry === undefined || entry === '.' || entry === '*' || entry === '' ? null : Number.parseInt(entry, 16);
  };
  const contextMenu = (event: UiPointerEvent) => {
    const v = view.value;
    const row = rowOf(event);
    const trace = v.traces[row];
    if (trace === undefined) return;
    menuRow = row;
    const shownAs = radix.value[trace.id] ?? 'hex';
    const at = valueAtCursor(v, row);
    const items: MenuItem[] = [];
    if (trace.width > 1) {
      for (const r of ['hex', 'dec', 'signed', 'bin'] as const) items.push({ value: `radix:${r}`, label: `${r === shownAs ? '✓ ' : ''}Show in ${RADIX_LABELS[r]}` });
    }
    items.push({
      value: 'trigger',
      label: at === null ? 'Pause when it becomes… (place the cursor first)' : `Pause when it becomes ${written(at, trace.width, shownAs)}`,
      disabled: at === null
    });
    if (v.trigger !== null) items.push({ value: 'untrigger', label: 'Stop pausing on the trigger' });
    items.push({ value: 'up', label: 'Move up', disabled: row === 0 });
    items.push({ value: 'down', label: 'Move down', disabled: row === v.traces.length - 1 });
    items.push({ value: 'goto', label: 'Go to it on the canvas' });
    if (trace.watched) items.push({ value: 'remove', label: 'Stop tracing it' });
    menuItems.value = items;
    menuAt.value = { x: event.x, y: event.y };
    menuOpen.value = true;
  };
  const chooseFromMenu = (choice: string) => {
    const v = view.value;
    const trace = v.traces[menuRow];
    if (trace === undefined) return;
    if (choice.startsWith('radix:')) {
      radix.value = { ...radix.value, [trace.id]: choice.slice(6) as Radix };
    } else if (choice === 'trigger') {
      const at = valueAtCursor(v, menuRow);
      if (at === null) return;
      circuit.send.setTrigger(trace.id, at);
      triggerText.value = `${trace.name} = ${trace.width > 1 ? `0x${at.toString(16).toUpperCase()}` : at}`;
    } else if (choice === 'untrigger') {
      circuit.send.setTrigger(null, 0);
      triggerText.value = '';
    } else if (choice === 'up' || choice === 'down') {
      moveRow(menuRow, menuRow + (choice === 'up' ? -1 : 1));
    } else if (choice === 'goto') {
      picked.next({ path: trace.path, pin: trace.pin });
    } else if (choice === 'remove') {
      circuit.send.unwatch(trace.id);
    }
  };

  const paint = combineLatest([view, cursor, named, radix]).pipe(
    map(([v, c, row, r]): UiPaint => ({ draw: (surface, box) => drawWaves(surface, box, v, c, row, r), inputs: [v, c, row, r] }))
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
        onContextMenu={contextMenu}
        onPointerLeave={() => {
          named.value = null;
          overRow.value = null;
        }}
        onWheel={wheel}
        overscrollBehavior="contain">
        <paint width={percent(100)} height={percent(100)} paint={paint} />
      </box>
      <Menu
        open={menuOpen}
        at={menuAt}
        label="Analyser row"
        items={menuItems}
        onSelect={chooseFromMenu}
        onOpenChange={(isOpen: boolean) => (menuOpen.value = isOpen)}
      />
    </column>
  );

  const hovered = combineLatest([overRow, view, open]).pipe(
    map(([row, v, isOpen]) => {
      const trace = row === null || !isOpen ? undefined : v.traces[row];
      return trace === undefined ? null : { path: trace.path, pin: trace.pin };
    }),
    distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b))
  );

  return { element, open, height, hovered, picked, toggle: () => (open.value = !open.value) };
}

/**
 * A name cut to `chars`, with an ellipsis where it was cut: at the
 * front for a traced pin, whose name ends in the pin — `…path.ADDR` —
 * and at the end for a probe's or LED's label.
 */
function fit(name: string, chars: number, front: boolean): string {
  if (name.length <= chars) return name;
  return front ? `…${name.slice(name.length - chars + 1)}` : `${name.slice(0, chars - 1)}…`;
}

/**
 * The waves: names in the gutter, a row a trace, and the cursor with
 * each row's value at it; a traced pin's row has a × to take it away,
 * and the row whose name is hovered says where its pin is.
 */
function drawWaves(
  surface: PaintSurface,
  box: PaintBox,
  v: AnalyserView,
  cursor: number | null,
  named: number | null,
  radix: Readonly<Record<string, Radix>>
): void {
  const width = box.width - GUTTER;
  if (width <= 0 || v.count === 0) {
    surface.fillColor('textMuted');
    surface.text(v.traces.length === 0 ? 'Nothing to trace: add a probe or an LED, or Alt+click a pin or wire.' : '', 8, 18, { fontSize: 12 });
    return;
  }
  const column = width / v.count;
  const at = (i: number) => GUTTER + i * column;

  v.traces.forEach((trace, row) => {
    const top = row * ROW + 4;
    const bottom = top + ROW - 10;
    surface.fillColor('text');
    // 11px bold runs near 6.6 pixels a character.
    surface.text(fit(trace.name, Math.floor((GUTTER - 10 - (trace.watched ? REMOVE : 0)) / 6.6), trace.watched), 6, top + 15, { fontSize: 11, fontWeight: 600 });
    if (trace.watched) {
      surface.fillColor('textMuted');
      surface.text('×', GUTTER - REMOVE / 2 - 2, top + 15, { fontSize: 13, align: 'center' });
    }
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
        const text = entry === '*' || entry === '.' || entry === '' ? '' : written(Number.parseInt(entry, 16), trace.width, radix[trace.id] ?? 'hex');
        if (text !== '' && runWidth >= 6.5 * text.length + 6) {
          surface.text(text, at(runStart) + 3, top + 11, { fontSize: 10, fontFamily: 'monospace' });
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
        const shownAs = radix[trace.id] ?? 'hex';
        const text =
          entry === '.' ? '' : entry === '*' ? '~' : trace.width === 1 ? entry : shownAs === 'hex' ? `0x${entry}` : written(Number.parseInt(entry, 16), trace.width, shownAs);
        surface.text(text, 6, row * ROW + 26, { fontSize: 10, fontFamily: 'monospace' });
      });
    }
  }

  // Where the hovered row's pin is, over the start of its waves.
  const hovered = named === null ? undefined : v.traces[named];
  // Shown for a traced pin, and for a name the gutter had to cut.
  if (hovered !== undefined && (hovered.title !== hovered.name || hovered.name.length > Math.floor((GUTTER - 10) / 6.6))) {
    const text = hovered.title;
    const top = named! * ROW + 4;
    const pill = text.length * 6.2 + 12;
    surface.beginPath();
    surface.roundRect(GUTTER + 4, top + 1, pill, 18, 4);
    surface.fillColor('surface');
    surface.fill();
    surface.strokeColor('border');
    surface.lineWidth(1);
    surface.stroke();
    surface.fillColor('text');
    surface.text(text, GUTTER + 10, top + 14, { fontSize: 11 });
  }
}
