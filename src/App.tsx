import { combineLatest, interval, type Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { paintPictures, percent } from 'gesso-core';
import { each, FrameService, internalState, type ComponentContext, type Inputs } from 'gesso-framework';

import { Circuit, type ClockRate, type TableView } from './app/CircuitContract';
import type { Kind } from './sim/Primitives';
import { BENCH_DONE, BENCH_PREFIX, BenchDriver, benchFilter, benchMatrix, isBench, isProof, type Motion } from './canvas/Bench';
import { circuitCanvas } from './canvas/CircuitCanvas';
import { fileActions } from './canvas/Files';
import { paintTiming } from './canvas/Painters';

/**
 * The screen: the circuit canvas, and a readout over it.
 *
 * The readout is Phase 3's instrument rather than its interface — frame
 * cost, what the simulator is doing, and the handful of controls needed
 * to watch the canvas under load. Phase 7 turns the frame numbers into
 * the proof surface; Phases 4 and 5 bring the controls a person uses.
 *
 * `overscrollBehavior="contain"` on the root: the app fills the page, so
 * no wheel over it reaches the browser — without it a ctrl-wheel, or a
 * trackpad pinch, zoomed the page as well as the circuit (PHASE0.md §5).
 */

const PAN_SPEED = 1500;
const RATES: readonly ClockRate[] = [1, 2, 10, 100, 1000, 'max'];

/** The palette: every part, with the key that picks it up (see `Editor.ts`). */
const PALETTE: readonly (readonly [Kind, string, string])[] = [
  ['input', 'Switch', 'I'],
  ['button', 'Button', 'B'],
  ['clock', 'Clock', 'C'],
  ['constant', 'Const', 'K'],
  ['output', 'LED', 'L'],
  ['probe', 'Probe', 'P'],
  ['hex', 'Hex', 'H'],
  ['seg7', '7-seg', '7'],
  ['not', 'NOT', 'N'],
  ['and', 'AND', 'A'],
  ['or', 'OR', 'O'],
  ['xor', 'XOR', 'X'],
  ['nand', 'NAND', '⇧A'],
  ['nor', 'NOR', '⇧O'],
  ['xnor', 'XNOR', '⇧X']
];

interface Readout {
  fps: number;
  frameMs: number;
  worstMs: number;
  recorded: number;
  tiles: number;
  missed: number;
}

export function App(_inputs: Inputs<{}>, ctx: ComponentContext) {
  const circuit = ctx.channel(Circuit);
  // Neither measured page touches files: each loads its own scene, and
  // an autosave written from one would replace a person's work.
  const proof = isProof();
  const files = isBench() || proof ? null : fileActions(ctx);
  const canvas = circuitCanvas(ctx, files);
  const showRecent = internalState(false);
  const readout = internalState<Readout>({ fps: 0, frameMs: 0, worstMs: 0, recorded: 0, tiles: 0, missed: 0 });

  // ---------------------------------------------------------------------
  // Motion, for the sweep buttons and the bench
  // ---------------------------------------------------------------------

  let motion: { kind: Motion; direction: number; base: number; phase: number } | null = null;
  const startMotion = (kind: Motion) => {
    motion = kind === 'still' ? null : { kind, direction: 1, base: canvas.camera.value.scale / 2, phase: -0.5 };
  };
  /** One frame of motion: a pan that bounces off the scene's edges, a zoom that breathes over two octaves. */
  const step = (gapMs: number) => {
    if (motion === null) return;
    const s = canvas.size.current;
    const c = canvas.camera.value;
    if (motion.kind === 'pan') {
      const b = canvas.bounds();
      let x = c.x + (motion.direction * PAN_SPEED * gapMs) / 1000 / c.scale;
      const span = s.width / c.scale;
      if (x < b.left - span / 4 || x + span > b.right + span / 4) {
        motion.direction = -motion.direction;
        x = c.x;
      }
      canvas.camera.value = { ...c, x };
    } else {
      motion.phase += gapMs / 1000;
      const scale = canvas.clampScale(motion.base * 2 ** (1 + Math.sin(motion.phase * Math.PI)));
      const cx = c.x + s.width / c.scale / 2;
      const cy = c.y + s.height / c.scale / 2;
      canvas.camera.value = { scale, x: cx - s.width / scale / 2, y: cy - s.height / scale / 2 };
    }
  };

  // ---------------------------------------------------------------------
  // Measurement
  // ---------------------------------------------------------------------

  let snapshots = 0;
  ctx.effect(circuit.view.signals, () => snapshots++);

  // The bench measures Phase 0's ten thousand gates; everyone else starts
  // with an empty canvas.
  if (isBench() || proof) {
    circuit.send.loadScene('bench');
  } else {
    // Whatever was open when the tab closed, brought back by the
    // application worker from its autosave.
    circuit.send.restore();
    files?.refreshRecent();
  }
  const bench = isBench()
    ? new BenchDriver(benchFilter(benchMatrix()), {
        apply: run => {
          canvas.show(run.zoom);
          startMotion(run.motion);
          if (run.running) {
            circuit.send.setClockHz('max');
            circuit.send.run();
          } else {
            circuit.send.pause();
          }
        },
        move: (_run, gapMs) => step(gapMs),
        report: line => console.log(BENCH_PREFIX + line),
        done: () => {
          circuit.send.pause();
          console.log(BENCH_DONE);
        }
      })
    : null;

  // Gesso draws only when something changes, and the bench advances on
  // frames. With the circuit paused and the camera still nothing
  // changes, so under the bench a timer keeps a hidden binding moving and
  // the frames coming. What such a frame costs is what an idle frame
  // costs, which is the number a paused run is there to report.
  const pulse = internalState(0);
  if (bench !== null) {
    ctx.effect(interval(1000 / 60), () => pulse.value++);
  }

  let lastAt = 0;
  let smoothed = 0;
  let worst = 0;
  let lastRecorded = paintPictures.stats.recorded;
  ctx.effect(ctx.inject(FrameService).frames, frame => {
    const gap = lastAt > 0 ? frame.at - lastAt : 0;
    lastAt = frame.at;
    if (gap > 0) {
      smoothed += (gap - smoothed) / 30;
      worst = Math.max(worst * 0.995, gap);
    }
    if (bench === null) {
      step(gap);
    }
    const recorded = paintPictures.stats.recorded;
    const missed = canvas.missed();
    const status = circuit.view.status.value;
    // The bench starts once the scene has arrived: a run begun before
    // then framed an empty scene and measured the wrong thing.
    if (canvas.ready()) bench?.frame(frame.at, {
      gapMs: gap,
      durationMs: frame.durationMs,
      phases: frame.phases,
      nodes: frame.nodes,
      renderer: frame.renderer,
      recorded,
      recordMs: paintTiming.recordMs,
      missed,
      tiles: canvas.tileCount(),
      tilesMade: canvas.tilesMade(),
      blank: canvas.blank(),
      snapshots,
      cycles: status.cycles,
      achievedHz: status.achievedHz
    });
    readout.value = {
      fps: smoothed > 0 ? 1000 / smoothed : 0,
      frameMs: frame.durationMs,
      worstMs: worst,
      recorded: recorded - lastRecorded,
      tiles: canvas.tileCount(),
      missed
    };
    lastRecorded = recorded;
    paintTiming.recordMs = 0;
  });

  const status = circuit.view.status;
  const document = circuit.view.document;
  const problem = combineLatest([document, status]).pipe(
    map(([d, s]) => d.error ?? (s.ringing.length > 0 ? `oscillates: ${s.ringing.slice(0, 3).join(', ')}` : '—'))
  );
  return (
    <stack width={percent(100)} height={percent(100)} backgroundColor="background" overscrollBehavior="contain">
      {canvas.element}
      {bench === null ? null : <text text={pulse.pipe(map(String))} opacity={0} position="absolute" left={0} top={0} fontSize={1} />}
      <column
        position="absolute"
        left={12}
        top={12}
        gap={6}
        padding={10}
        borderRadius={8}
        backgroundColor="surface"
        borderColor="border"
        borderWidth={1}
        opacity={0.94}>
        <row gap={14} y="center">
          {stat('FPS', readout.pipe(map(r => (r.fps === 0 ? '—' : r.fps.toFixed(0)))))}
          {stat('Frame', readout.pipe(map(r => `${r.frameMs.toFixed(1)} ms`)))}
          {stat('Worst gap', readout.pipe(map(r => `${r.worstMs.toFixed(0)} ms`)))}
          {stat('Recorded', readout.pipe(map(r => String(r.recorded))))}
          {stat('Tiles', readout.pipe(map(r => String(r.tiles))))}
          {stat('Missed', readout.pipe(map(r => `${(100 * r.missed).toFixed(0)}%`)))}
        </row>
        <row gap={14} y="center">
          {stat('Gates', document.pipe(map(d => d.gates.toLocaleString('en'))))}
          {stat('Zoom', canvas.camera.pipe(map(c => `${c.scale.toFixed(2)} px/u`)))}
          {stat('Clock', status.pipe(map(s => (s.running ? `${s.achievedHz.toLocaleString('en')} Hz` : 'paused'))), proof)}
          {stat('Cycles', status.pipe(map(s => s.cycles.toLocaleString('en'))), proof)}
          {stat('Problem', problem)}
        </row>
        <row gap={6} y="center">
          {button(status.pipe(map(s => (s.running ? 'Pause' : 'Run'))), () =>
            status.value.running ? circuit.send.pause() : circuit.send.run()
          )}
          {button('Step', () => circuit.send.step())}
          {proof
            ? button('Full speed', () => {
                circuit.send.setClockHz('max');
                circuit.send.run();
              })
            : null}
          {proof
            ? button('100 Hz', () => {
                circuit.send.setClockHz(100);
                circuit.send.run();
              })
            : null}
          {button(status.pipe(map(s => `Clock: ${s.clockHz === 'max' ? 'max' : `${s.clockHz} Hz`}`)), () => {
            const at = RATES.indexOf(status.value.clockHz);
            circuit.send.setClockHz(RATES[(at + 1) % RATES.length]!);
          })}
          {button('All', () => canvas.show('all'))}
          {button('Mid', () => canvas.show('mid'))}
          {button('Close', () => canvas.show('close'))}
          {button('Pan', () => startMotion('pan'))}
          {button('Zoom', () => startMotion('zoom'))}
          {button('Stop', () => startMotion('still'))}
        </row>
        <row gap={6} y="center">
          {PALETTE.map(([kind, label, key]) => button(`${label} ${key}`, () => canvas.editor.startPlacing(kind)))}
        </row>
        {files === null ? null : (
          <row gap={6} y="center">
            {button('New', () => circuit.send.loadScene('empty'))}
            {button('Open… ⌃O', () => files.open())}
            {button('Save ⌃S', () => files.save(false))}
            {button('Save as… ⌃⇧S', () => files.save(true))}
            {button('Recent', () => {
              showRecent.value = !showRecent.value;
              if (showRecent.value) files.refreshRecent();
            })}
            <text
              text={document.pipe(map(d => `${d.name ?? 'Untitled'}${d.dirty ? ' •' : ''}`))}
              fontSize={13}
              fontWeight={600}
              color="text"
            />
            <text text={document.pipe(map(d => d.message ?? ''))} fontSize={12} color="textMuted" />
          </row>
        )}
        {files === null ? null : (
          // Empty, and so no height at all, until Recent is pressed.
          <row gap={6} y="center">
            {each(
              combineLatest([files.recent, showRecent]).pipe(
                map(([list, on]) => (!on ? [] : list.length === 0 ? [{ handle: -1, name: '', used: 0 }] : list.slice(0, 8)))
              ),
              'handle',
              file =>
                file.handle < 0 ? (
                  <text text="No recent files" fontSize={12} color="textMuted" />
                ) : (
                  button(file.name, () => {
                    showRecent.value = false;
                    files.openRecent(file.handle);
                  })
                )
            )}
          </row>
        )}
        <row gap={6} y="center">
          {button('Undo', () => circuit.send.undo(), document.pipe(map(d => d.canUndo)))}
          {button('Redo', () => circuit.send.redo(), document.pipe(map(d => d.canRedo)))}
          {button('Counter', () => circuit.send.loadScene('counter'))}
          {button('Bench scene', () => circuit.send.loadScene('bench'))}
          {button('Truth table T', () => circuit.send.tabulate([...canvas.editor.selection]))}
          <text text={canvas.editorChanged.pipe(map(() => canvas.editor.status))} fontSize={12} color="textMuted" />
        </row>
      </column>
      {truthTablePanel(circuit.view.table, () => circuit.send.tabulate([]))}
    </stack>
  );
}

/**
 * The truth table of the selection, over the canvas's right-hand side:
 * a header naming inputs and outputs, then a row per combination, in
 * monospace so the columns line up without a grid. Hidden while no
 * table is open.
 */
function truthTablePanel(table: Observable<TableView>, close: () => void) {
  const width = (names: readonly string[]) => names.map(n => n.length);
  const lines = table.pipe(
    map(t => {
      if (t.ids.length === 0) return [];
      if (t.error !== null) return [{ key: 'error', text: t.error, head: false }];
      const inWidths = width(t.inputs);
      const outWidths = width(t.outputs);
      const cell = (value: string, w: number) => value.padStart(Math.ceil(w / 2)).padEnd(w);
      const header = `${t.inputs.join(' ')} │ ${t.outputs.join(' ')}`;
      const rows = t.rows.map((outputs, n) => {
        const bits = t.inputs.map((_, i) => String((n >> (t.inputs.length - 1 - i)) & 1));
        const text = `${bits.map((b, i) => cell(b, inWidths[i]!)).join(' ')} │ ${[...outputs]
          .map((o, i) => cell(o, outWidths[i]!))
          .join(' ')}`;
        return { key: `r${n}`, text, head: false };
      });
      return [{ key: 'head', text: header, head: true }, ...rows];
    })
  );
  return (
    <column
      position="absolute"
      right={12}
      top={172}
      gap={2}
      padding={10}
      borderRadius={8}
      backgroundColor="surface"
      borderColor="border"
      borderWidth={1}
      opacity={table.pipe(map(t => (t.ids.length === 0 ? 0 : 0.96)))}
      pointerEvents={table.pipe(map(t => (t.ids.length === 0 ? 'none' : 'auto')))}
      maxHeight={percent(70)}
      overflow="auto">
      <row gap={10} y="center">
        <text text={table.pipe(map(t => `Truth table · ${t.ids.length} parts`))} fontSize={12} fontWeight={600} color="text" />
        {button('Close', close)}
      </row>
      {each(lines, 'key', line => (
        <text
          text={line.text}
          fontSize={12}
          fontFamily="monospace"
          fontWeight={line.head ? 600 : 400}
          color={line.head ? 'text' : 'textMuted'}
        />
      ))}
    </column>
  );
}

/**
 * A readout. `live` puts it in the accessibility tree as a live region,
 * which is how `pnpm proof` reads the clock off the page — only on
 * `/proof`, because a screen reader told the cycle count sixty times a
 * second is no use to anybody.
 */
function stat(label: string, value: Observable<string>, live = false) {
  return (
    <row gap={5} y="center">
      {/* A live readout carries its own label, so the tree reads "Clock 552 Hz". */}
      {live ? null : <text text={label} fontSize={11} color="textMuted" />}
      <text
        text={live ? value.pipe(map(v => `${label} ${v}`)) : value}
        fontSize={13}
        fontWeight={600}
        color="text"
        {...(live ? { live: 'polite' as const } : {})}
      />
    </row>
  );
}

function button(label: string | Observable<string>, onClick: () => void, enabled?: Observable<boolean>) {
  return (
    <button
      onClick={onClick}
      opacity={enabled === undefined ? 1 : enabled.pipe(map(on => (on ? 1 : 0.4)))}
      paddingLeft={10}
      paddingRight={10}
      paddingTop={5}
      paddingBottom={5}
      borderRadius={6}
      backgroundColor="controlBackground"
      borderColor="controlBorder"
      borderWidth={1}
      cursor="pointer">
      <text text={label} fontSize={12} color="controlForeground" />
    </button>
  );
}
