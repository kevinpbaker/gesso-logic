import { interval, type Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { paintPictures, percent } from 'gesso-core';
import { FrameService, internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, type ClockRate } from '../app/CircuitContract';
import { BENCH_DONE, BENCH_PREFIX, BenchDriver, benchFilter, benchMatrix, isBench, type Motion } from '../canvas/Bench';
import { circuitCanvas } from '../canvas/CircuitCanvas';
import { paintTiming } from '../canvas/Painters';
import { GAMES } from './Programs';

/**
 * The measured pages: `/proof` and `?bench`.
 *
 * Phase 3's instrument, kept apart from the interface a person uses so
 * that neither has to be the other. Frame cost, what the simulator is
 * doing, and the controls the proof and the bench press to put the
 * canvas under load: `Mid`, `Full speed`, `100 Hz` and the live `Clock`
 * and `Cycles` readouts are what `scripts/proof.ts` finds by name, so
 * they keep their names. Neither page touches files: each loads its own
 * scene, and an autosave written from one would replace a person's
 * work.
 *
 * `overscrollBehavior="contain"` on the root: the app fills the page, so
 * no wheel over it reaches the browser — without it a ctrl-wheel, or a
 * trackpad pinch, zoomed the page as well as the circuit (PHASE0.md §5).
 */

const PAN_SPEED = 1500;
const RATES: readonly ClockRate[] = [1, 2, 10, 100, 1000, 'max'];

interface Readout {
  fps: number;
  frameMs: number;
  worstMs: number;
  recorded: number;
  tiles: number;
  missed: number;
}

export function instrumentedApp(ctx: ComponentContext, proof: boolean) {
  const circuit = ctx.channel(Circuit);
  const canvas = circuitCanvas(ctx, null);
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

  // Both pages measure Phase 0's ten thousand gates.
  circuit.send.loadScene('bench');
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
    if (canvas.ready())
      bench?.frame(frame.at, {
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
        </row>
        <row gap={6} y="center">
          {button(status.pipe(map(s => (s.running ? 'Pause' : 'Run'))), () => (status.value.running ? circuit.send.pause() : circuit.send.run()))}
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
          {proof
            ? button('Pong', () => {
                // The game on the gate-level computer, measured like the bench.
                const pong = GAMES.find(g => g.name === 'pong.asm')!;
                circuit.send.loadProgram(pong.name, pong.source, pong.rate);
                circuit.send.run();
                canvas.show('all');
                canvas.focus();
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
      </column>
    </stack>
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

function button(label: string | Observable<string>, onClick: () => void) {
  return (
    <button
      onClick={onClick}
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
