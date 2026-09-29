import { combineLatest, type Observable } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';

import {
  paintPictures,
  percent,
  sizeContainer,
  UiContainerSizeSource,
  type PaintBox,
  type PaintSurface,
  type UiPaint,
  type UiPinchEvent,
  type UiPointerEvent,
  type UiWheelEvent
} from 'gesso-core';
import { each, FrameService, internalState, type ComponentContext, type Inputs } from 'gesso-framework';

import { BENCH_DONE, BENCH_PREFIX, BenchDriver, benchFilter, benchMatrix, isBench, type BenchRun, type Lod, type Motion, type ZoomRaster, type PaintMode, type ZoomPreset } from './spike/Bench';
import { Circuit, signalOf, type Signals, type WireShape, type WireStats } from './spike/CircuitContract';
import { buildScene, CELL, CHUNK, SceneQuery, WORLD_HEIGHT, WORLD_WIDTH } from './spike/Scene';
import { DETAIL_SCALE, paintTiming, ScenePainter } from './spike/ScenePainter';

/**
 * Phase 0, spikes 1 and 2, on one screen.
 *
 * Ten thousand fake gates and twenty thousand wires, pannable and
 * zoomable, with the application worker flipping 10% of all nets sixty
 * times a second and publishing what is on screen. Nothing here is
 * meant to survive; the point is two numbers — a tile size and a wire
 * shape — and whether a frame stays under 16.7 ms while it all moves.
 *
 * Two ways to paint it, because which one is the question:
 *
 *   - **single**: one `Paint` the size of the view. Its inputs are the
 *     camera and the snapshot, so any pan and any new snapshot records
 *     and rasterises every visible gate and wire again.
 *   - **tiles**: screen-sized-ish tiles on a world grid, each two
 *     `Paint` nodes — gates, which change on nothing here, and wires,
 *     whose inputs are the chunk strings its wires read. A pan moves
 *     tiles by `left` / `top` and records nothing but the tiles that
 *     entered; a snapshot records only the wire layers whose chunks
 *     changed.
 *
 * Tiles live on a world grid per zoom octave: the tile's world size is
 * `tile / octave`, so its screen size runs from `tile` to `2 × tile`
 * across an octave and the set of tiles is stable while you zoom
 * within one. Zooming still resizes them, which records them again —
 * see what the bench says about that.
 */

interface Camera {
  /** World coordinates at the view's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** Screen pixels per world unit. */
  readonly zoom: number;
}

interface Tile {
  readonly key: string;
  readonly tx: number;
  readonly ty: number;
  /** World units per side. */
  readonly world: number;
  /** The chunks this tile's gates and wires read, found once when it is first shown. */
  readonly chunks: readonly number[];
  readonly drawGates: (surface: PaintSurface, box: PaintBox) => void;
  readonly drawWires: (surface: PaintSurface, box: PaintBox) => void;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const PAN_SPEED = 1500;

interface Readout {
  fps: number;
  frameMs: number;
  worstMs: number;
  recorded: number;
  rasterized: number;
  missed: number;
  ageMs: number;
  tiles: number;
  nodes: number;
}

const IDLE: Readout = { fps: 0, frameMs: 0, worstMs: 0, recorded: 0, rasterized: 0, missed: 0, ageMs: 0, tiles: 0, nodes: 0 };

export function App(_inputs: Inputs<{}>, ctx: ComponentContext) {
  const circuit = ctx.channel(Circuit);
  const signalsView = circuit.view.signals;

  const scene = buildScene();
  const painter = new ScenePainter(scene);
  const query = new SceneQuery(scene);

  const size = new UiContainerSizeSource();
  const camera = internalState<Camera>({ x: 0, y: 0, zoom: 0.14 });
  const mode = internalState<PaintMode>('tiles');
  const tileSize = internalState(256);
  const lod = internalState<Lod>('full');
  const zoomRaster = internalState<ZoomRaster>('resize');
  const shape = internalState<WireShape>('hex');
  const activity = internalState(0.1);
  const readout = internalState<Readout>(IDLE);

  /** The snapshot the painters draw from; kept here so `draw` can read it without being an input. */
  let signals: Signals = signalsView.value;
  ctx.effect(signalsView, next => (signals = next));

  const viewportSize = () => size.current;

  // ---------------------------------------------------------------------
  // The round trip: what is on screen, snapped outward to the spatial
  // index's cells so the command is sent when a cell boundary is
  // crossed, not every frame. The worker adds its own band on top.
  // ---------------------------------------------------------------------
  const worldView = combineLatest([camera, size.changes]).pipe(
    map(([c, s]) => ({
      left: Math.floor(c.x / CELL) * CELL,
      top: Math.floor(c.y / CELL) * CELL,
      right: Math.ceil((c.x + s.width / c.zoom) / CELL) * CELL,
      bottom: Math.ceil((c.y + s.height / c.zoom) / CELL) * CELL
    })),
    distinctUntilChanged((a, b) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom)
  );
  ctx.effect(worldView, v => circuit.send.setViewport(v.left, v.top, v.right, v.bottom));
  ctx.effect(shape, next => circuit.send.setShape(next));
  ctx.effect(activity, next => circuit.send.setActivity(next));

  /**
   * The nets on screen, for counting the ones with no value yet. Found
   * per snapped view rather than per frame, so the count costs a loop
   * over an array and not a spatial query.
   */
  let visibleNets = new Int32Array(0);
  ctx.effect(worldView, v => {
    const nets = new Set<number>();
    query.forEach(v.left, v.top, v.right, v.bottom, g => nets.add(scene.gateNet[g]), w => nets.add(scene.wireNet[w]));
    visibleNets = Int32Array.from(nets);
  });

  // ---------------------------------------------------------------------
  // Tiles
  // ---------------------------------------------------------------------

  const tileCache = new Map<string, Tile>();

  const makeTile = (tx: number, ty: number, world: number, key: string, level: Lod): Tile => {
    const left = tx * world;
    const top = ty * world;
    const chunkSet = new Set<number>();
    query.forEach(
      left,
      top,
      left + world,
      top + world,
      g => chunkSet.add(Math.floor(scene.gateNet[g] / CHUNK)),
      w => chunkSet.add(Math.floor(scene.wireNet[w] / CHUNK))
    );
    const place = (surface: PaintSurface, box: PaintBox) => {
      const scale = box.width / world;
      surface.scale(scale, scale);
      surface.translate(-left, -top);
      return scale;
    };
    return {
      key,
      tx,
      ty,
      world,
      chunks: [...chunkSet].sort((a, b) => a - b),
      // Under `blocks`, below the detail zoom the layers swap roles: the
      // static one carries the wires, the live one the gates.
      drawGates: (surface, box) => {
        const scale = place(surface, box);
        if (level === 'blocks' && scale < DETAIL_SCALE) {
          painter.staticWires(surface, left, top, left + world, top + world, scale);
        } else {
          painter.gates(surface, left, top, left + world, top + world, scale);
        }
      },
      drawWires: (surface, box) => {
        const scale = place(surface, box);
        if (level === 'blocks' && scale < DETAIL_SCALE) {
          painter.liveGates(surface, left, top, left + world, top + world, signals);
        } else {
          painter.wires(surface, left, top, left + world, top + world, scale, signals);
        }
      }
    };
  };

  const tiles: Observable<readonly Tile[]> = combineLatest([camera, size.changes, mode, tileSize, lod]).pipe(
    map(([c, s, m, t, level]) => {
      if (m !== 'tiles' || s.width <= 0) {
        return [];
      }
      const octave = 2 ** Math.floor(Math.log2(c.zoom));
      const world = t / octave;
      const x0 = Math.max(0, Math.floor(c.x / world));
      const y0 = Math.max(0, Math.floor(c.y / world));
      const x1 = Math.min(Math.ceil(WORLD_WIDTH / world) - 1, Math.floor((c.x + s.width / c.zoom) / world));
      const y1 = Math.min(Math.ceil(WORLD_HEIGHT / world) - 1, Math.floor((c.y + s.height / c.zoom) / world));
      const list: Tile[] = [];
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const key = `${level}:${world}:${tx}:${ty}`;
          let tile = tileCache.get(key);
          if (tile === undefined) {
            tile = makeTile(tx, ty, world, key, level);
            tileCache.set(key, tile);
          }
          list.push(tile);
        }
      }
      // The cache holds only what is shown: a tile that scrolled away is
      // rebuilt if it comes back, which is a spatial query and nothing
      // more, and holding it would hold its bindings with it.
      if (tileCache.size > list.length * 4) {
        const keep = new Set(list.map(tile => tile.key));
        for (const key of tileCache.keys()) {
          if (!keep.has(key)) {
            tileCache.delete(key);
          }
        }
      }
      return list;
    }),
    distinctUntilChanged((a, b) => a.length === b.length && a.every((tile, i) => tile === b[i]))
  );
  let tileCount = 0;
  ctx.effect(tiles, list => (tileCount = list.length));

  /**
   * How big a tile's box is, and what scale it is shown at.
   *
   * `resize` sizes the box to the tile's screen size, so the bitmap is
   * always drawn 1:1 — and every frame of a zoom changes the box, which
   * records and rasterises both layers of every tile again.
   * `scale` sizes the box to the top of its octave (twice the nominal
   * tile) and shrinks it with a transform, so within an octave a zoom
   * changes only a paint property and records nothing; the bitmap is
   * downsampled by at most half, which stays sharp.
   */
  //
  // `settle` is what a map does: during a zoom the tiles keep the box
  // they were drawn at and are scaled, and 150 ms after the zoom stops —
  // or as soon as the scale drifts past 1.5× either way — they are
  // resized and drawn 1:1 again. The first bench said pixels cost as
  // much as ops, so the 2× raster `scale` pays for is the wrong trade
  // everywhere but mid-zoom.
  const rasterZoom = internalState(camera.value.zoom);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  ctx.effect(
    camera.pipe(
      map(c => c.zoom),
      distinctUntilChanged()
    ),
    zoom => {
      clearTimeout(settleTimer);
      if (Math.abs(Math.log2(zoom / rasterZoom.value)) > Math.log2(1.5)) {
        rasterZoom.value = zoom;
      } else {
        settleTimer = setTimeout(() => (rasterZoom.value = camera.value.zoom), 150);
      }
    }
  );

  const tileBox = (tile: Tile) =>
    combineLatest([camera, zoomRaster, rasterZoom]).pipe(
      map(([c, raster, drawnAt]) => {
        const shown = tile.world * c.zoom;
        const box =
          raster === 'scale'
            ? tile.world * 2 ** (Math.floor(Math.log2(c.zoom)) + 1)
            : raster === 'settle'
              ? tile.world * drawnAt
              : shown;
        return { box, scale: shown / box };
      })
    );

  const renderTile = (tile: Tile) => {
    const gatesPaint: UiPaint = { draw: tile.drawGates, inputs: [tile.key] };
    const wiresPaint = signalsView.pipe(
      map((s): UiPaint => ({ draw: tile.drawWires, inputs: wireInputs(tile, s) }))
    );
    const box = tileBox(tile);
    return (
      <stack
        position="absolute"
        left={camera.pipe(map(c => (tile.tx * tile.world - c.x) * c.zoom))}
        top={camera.pipe(map(c => (tile.ty * tile.world - c.y) * c.zoom))}
        width={box.pipe(map(b => b.box))}
        height={box.pipe(map(b => b.box))}
        transform={box.pipe(map(b => (b.scale === 1 ? undefined : { scaleX: b.scale, scaleY: b.scale })))}>
        <paint width={percent(100)} height={percent(100)} paint={wiresPaint} />
        <paint width={percent(100)} height={percent(100)} paint={gatesPaint} />
      </stack>
    );
  };

  // ---------------------------------------------------------------------
  // Single
  // ---------------------------------------------------------------------

  const drawSingle = (surface: PaintSurface, box: PaintBox) => {
    const c = camera.value;
    const right = c.x + box.width / c.zoom;
    const bottom = c.y + box.height / c.zoom;
    surface.scale(c.zoom, c.zoom);
    surface.translate(-c.x, -c.y);
    if (lod.value === 'blocks' && c.zoom < DETAIL_SCALE) {
      painter.staticWires(surface, c.x, c.y, right, bottom, c.zoom);
      painter.liveGates(surface, c.x, c.y, right, bottom, signals);
    } else {
      painter.wires(surface, c.x, c.y, right, bottom, c.zoom, signals);
      painter.gates(surface, c.x, c.y, right, bottom, c.zoom);
    }
  };
  const singlePaint = combineLatest([camera, signalsView, mode, lod]).pipe(
    map(([c, s, m, level]): UiPaint | undefined =>
      m === 'single' ? { draw: drawSingle, inputs: [c.x, c.y, c.zoom, s, level] } : undefined
    )
  );

  // ---------------------------------------------------------------------
  // Input: drag or wheel to pan, ctrl-wheel or pinch to zoom
  // ---------------------------------------------------------------------

  const zoomAt = (screenX: number, screenY: number, factor: number) => {
    const c = camera.value;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * factor));
    // The world point under the pointer stays under the pointer.
    const worldX = c.x + screenX / c.zoom;
    const worldY = c.y + screenY / c.zoom;
    camera.value = { x: worldX - screenX / zoom, y: worldY - screenY / zoom, zoom };
  };
  const panBy = (dx: number, dy: number) => {
    const c = camera.value;
    camera.value = { ...c, x: c.x + dx / c.zoom, y: c.y + dy / c.zoom };
  };
  let dragFrom: { x: number; y: number } | null = null;

  const onWheel = (event: UiWheelEvent) => {
    if (event.modifiers.ctrl || event.modifiers.meta) {
      zoomAt(event.x, event.y, Math.exp(-event.deltaY * 0.002));
    } else {
      panBy(event.deltaX, event.deltaY);
    }
  };
  const onPointerDown = (event: UiPointerEvent) => (dragFrom = { x: event.x, y: event.y });
  const onPointerMove = (event: UiPointerEvent) => {
    if (dragFrom !== null && event.buttons !== 0) {
      panBy(dragFrom.x - event.x, dragFrom.y - event.y);
      dragFrom = { x: event.x, y: event.y };
    }
  };
  const onPointerUp = () => (dragFrom = null);
  const onPinchMove = (event: UiPinchEvent) => zoomAt(event.x, event.y, event.scaleDelta);

  const zoomFor = (preset: ZoomPreset): number => {
    const s = viewportSize();
    const fit = Math.min(s.width / WORLD_WIDTH, s.height / WORLD_HEIGHT);
    return preset === 'all' ? fit : preset === 'mid' ? 0.5 : 1.5;
  };
  const showPreset = (preset: ZoomPreset) => {
    const s = viewportSize();
    const zoom = zoomFor(preset);
    // Centred on the world's middle, so pan runs have room both ways.
    camera.value = { zoom, x: WORLD_WIDTH / 2 - s.width / zoom / 2, y: WORLD_HEIGHT / 2 - s.height / zoom / 2 };
  };

  // ---------------------------------------------------------------------
  // Motion, for the sweep buttons and the bench
  // ---------------------------------------------------------------------

  let motion: { kind: Motion; direction: number; base: number; phase: number } | null = null;

  /** One frame of a run's motion. Pan bounces off the world's edge; zoom breathes over two octaves. */
  const step = (kind: Motion, gapMs: number) => {
    if (motion === null || kind === 'still') {
      return;
    }
    const s = viewportSize();
    const c = camera.value;
    if (kind === 'pan') {
      const dx = (PAN_SPEED * gapMs) / 1000 / c.zoom;
      let x = c.x + motion.direction * dx;
      const limit = WORLD_WIDTH - s.width / c.zoom;
      if (x <= -s.width / c.zoom / 4 || x >= limit + s.width / c.zoom / 4) {
        motion.direction = -motion.direction;
        x = c.x;
      }
      camera.value = { ...c, x };
    } else {
      motion.phase += gapMs / 1000;
      const zoom = motion.base * 2 ** (1 + Math.sin(motion.phase * Math.PI));
      const centreX = c.x + s.width / c.zoom / 2;
      const centreY = c.y + s.height / c.zoom / 2;
      camera.value = { zoom, x: centreX - s.width / zoom / 2, y: centreY - s.height / zoom / 2 };
    }
  };

  const startMotion = (kind: Motion) => {
    motion = { kind, direction: 1, base: camera.value.zoom / 2, phase: -0.5 };
  };

  // ---------------------------------------------------------------------
  // Measurement
  // ---------------------------------------------------------------------

  const bench = isBench()
    ? new BenchDriver(benchFilter(benchMatrix()), {
        apply: (run: BenchRun) => {
          mode.value = run.mode;
          tileSize.value = run.tile;
          lod.value = run.lod;
          zoomRaster.value = run.zoomRaster;
          shape.value = run.shape;
          activity.value = run.activity;
          showPreset(run.zoom);
          startMotion(run.motion);
        },
        move: (run, gapMs) => step(run.motion, gapMs),
        report: line => console.log(BENCH_PREFIX + line),
        done: () => console.log(BENCH_DONE)
      })
    : null;

  let lastAt = 0;
  let lastTick = -1;
  let smoothed = 0;
  let worst = 0;
  let lastRecorded = paintPictures.stats.recorded;
  let lastRasterized = paintPictures.stats.rasterized;

  ctx.effect(ctx.inject(FrameService).frames, frame => {
    const gap = lastAt > 0 ? frame.at - lastAt : 0;
    lastAt = frame.at;
    if (gap > 0) {
      smoothed += (gap - smoothed) / 30;
      worst = Math.max(worst * 0.995, gap);
    }

    let missing = 0;
    const current = signals;
    for (let i = 0; i < visibleNets.length; i++) {
      if (signalOf(current, visibleNets[i]) === -1) {
        missing++;
      }
    }
    const missed = visibleNets.length === 0 ? 0 : missing / visibleNets.length;
    let ageMs = -1;
    if (current.tick !== lastTick) {
      lastTick = current.tick;
      ageMs = performance.timeOrigin + performance.now() - current.sentAt;
    }
    const recorded = paintPictures.stats.recorded;
    const rasterized = paintPictures.stats.rasterized;

    if (bench === null && motion !== null) {
      step(motion.kind, gap);
    }
    const wire: WireStats = circuit.view.stats.value;
    bench?.frame(frame.at, {
      gapMs: gap,
      durationMs: frame.durationMs,
      phases: frame.phases,
      nodes: frame.nodes,
      renderer: frame.renderer,
      recorded,
      rasterized,
      recordMs: paintTiming.recordMs,
      missed,
      ageMs,
      tiles: tileCount,
      publishes: wire.publishes,
      patches: wire.patches,
      bytes: wire.bytes,
      nets: wire.lastNets,
      chunks: wire.lastChunks,
      buildMs: wire.buildMs,
      diffMs: wire.diffMs
    });

    readout.value = {
      fps: smoothed > 0 ? 1000 / smoothed : 0,
      frameMs: frame.durationMs,
      worstMs: worst,
      recorded: recorded - lastRecorded,
      rasterized: rasterized - lastRasterized,
      missed,
      ageMs: ageMs >= 0 ? ageMs : readout.value.ageMs,
      tiles: tileCount,
      nodes: frame.nodes
    };
    lastRecorded = recorded;
    lastRasterized = rasterized;
    paintTiming.recordMs = 0;
  });

  // The first size report is the moment the camera can be framed.
  let framed = false;
  ctx.effect(size.changes, s => {
    if (!framed && s.width > 0) {
      framed = true;
      showPreset('all');
    }
  });

  // `contain` on the root: the app fills the page, so no wheel over it
  // should reach the browser. Without it the shell cancels only wheels
  // a scroll container can use, and the canvas is not one, so a
  // ctrl-wheel — and a trackpad pinch, which Chrome sends as one —
  // zoomed the page as well as the circuit. PHASE0.md §5.
  return (
    <stack width={percent(100)} height={percent(100)} backgroundColor="background" overscrollBehavior="contain">
      <box
        width={percent(100)}
        height={percent(100)}
        overflow="hidden"
        containerSize={size}
        modifiers={[sizeContainer({ source: size })]}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPinchMove={onPinchMove}>
        <paint position="absolute" left={0} top={0} width={percent(100)} height={percent(100)} paint={singlePaint} />
        {each(tiles, 'key', renderTile)}
      </box>
      {Hud({
        readout,
        stats: circuit.view.stats,
        mode,
        tileSize,
        lod,
        zoomRaster,
        shape,
        activity,
        camera,
        onPreset: showPreset,
        onMotion: startMotion
      })}
    </stack>
  );
}

/**
 * A tile's wire layer is redrawn when, and only when, a chunk it reads
 * changed. For the `record` shape there are no chunks to compare, so
 * the whole snapshot is the input, which is exactly the cost that shape
 * carries on this side of the barrier.
 */
function wireInputs(tile: Tile, s: Signals): readonly unknown[] {
  if (s.shape === 'record') {
    return [s.nets];
  }
  const inputs: unknown[] = [s.shape];
  for (const chunk of tile.chunks) {
    inputs.push(s.chunks[chunk]);
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------

interface HudInputs {
  readout: Observable<Readout>;
  stats: Observable<WireStats>;
  mode: ReturnType<typeof internalState<PaintMode>>;
  tileSize: ReturnType<typeof internalState<number>>;
  lod: ReturnType<typeof internalState<Lod>>;
  zoomRaster: ReturnType<typeof internalState<ZoomRaster>>;
  shape: ReturnType<typeof internalState<WireShape>>;
  activity: ReturnType<typeof internalState<number>>;
  camera: Observable<Camera>;
  onPreset: (preset: ZoomPreset) => void;
  onMotion: (motion: Motion) => void;
}

function Hud(inputs: HudInputs) {
  const { readout, stats } = inputs;
  return (
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
        {stat('Nodes', readout.pipe(map(r => String(r.nodes))))}
      </row>
      <row gap={14} y="center">
        {stat('Zoom', inputs.camera.pipe(map(c => c.zoom.toFixed(2))))}
        {stat('Missed', readout.pipe(map(r => `${(100 * r.missed).toFixed(0)}%`)))}
        {stat('Age', readout.pipe(map(r => `${r.ageMs.toFixed(0)} ms`)))}
        {stat('Nets', stats.pipe(map(s => String(s.lastNets))))}
        {stat('Patches', stats.pipe(map(s => String(s.lastPatches))))}
        {stat('Bytes', stats.pipe(map(s => `${(s.lastBytes / 1024).toFixed(1)} KiB`)))}
      </row>
      <row gap={6} y="center">
        {cycle('Paint', inputs.mode, ['tiles', 'single'] as PaintMode[], v => v)}
        {cycle('Tile', inputs.tileSize, [128, 256, 512], v => `${v} px`)}
        {cycle('LOD', inputs.lod, ['full', 'blocks'] as Lod[], v => v)}
        {cycle('Zoom raster', inputs.zoomRaster, ['resize', 'scale', 'settle'] as ZoomRaster[], v => v)}
        {cycle('Wire', inputs.shape, ['hex', 'base64', 'record'] as WireShape[], v => v)}
        {cycle('Activity', inputs.activity, [0, 0.01, 0.1, 0.5], v => `${v * 100}%`)}
      </row>
      <row gap={6} y="center">
        {button('All', () => inputs.onPreset('all'))}
        {button('Mid', () => inputs.onPreset('mid'))}
        {button('Close', () => inputs.onPreset('close'))}
        {button('Pan', () => inputs.onMotion('pan'))}
        {button('Zoom', () => inputs.onMotion('zoom'))}
        {button('Stop', () => inputs.onMotion('still'))}
      </row>
    </column>
  );
}

function stat(label: string, value: Observable<string>) {
  return (
    <row gap={5} y="center">
      <text text={label} fontSize={11} color="textMuted" />
      <text text={value} fontSize={13} fontWeight={600} color="text" />
    </row>
  );
}

function button(label: string, onClick: () => void) {
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

function cycle<T>(label: string, cell: ReturnType<typeof internalState<T>>, values: readonly T[], format: (value: T) => string) {
  const next = () => {
    const at = values.indexOf(cell.value);
    cell.value = values[(at + 1) % values.length];
  };
  return (
    <row gap={4} y="center">
      <text text={label} fontSize={11} color="textMuted" />
      <button
        onClick={next}
        paddingLeft={10}
        paddingRight={10}
        paddingTop={5}
        paddingBottom={5}
        borderRadius={6}
        backgroundColor="controlBackground"
        borderColor="controlBorder"
        borderWidth={1}
        cursor="pointer">
        <text text={cell.pipe(map(format))} fontSize={12} color="controlForeground" />
      </button>
    </row>
  );
}
