import { BehaviorSubject, combineLatest, type Observable } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';

import {
  percent,
  sizeContainer,
  UiContainerSizeSource,
  type PaintBox,
  type PaintSurface,
  type UiChild,
  type UiPaint,
  type UiPinchEvent,
  type UiPointerEvent,
  type UiWheelEvent
} from 'gesso-core';
import { each, FrameService, internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, type Signals } from '../app/CircuitContract';
import type { Box } from '../app/Layout';
import { signalOf } from '../app/SignalPacking';
import { paintLive, paintOver, paintUnder } from './Painters';
import { CELL, SceneIndex } from './SceneIndex';

/**
 * The circuit, drawn: a pannable, zoomable surface of tiles.
 *
 * Phase 0 decided every choice here by measuring it, and PHASE0.md §1
 * has the numbers:
 *
 *   - **Tiles**, 256 px nominal, on a world grid per zoom octave: a
 *     tile's world size is `256 / octave` units, and the grid's octave
 *     holds across a band, so a zoom replaces the tiles only rarely.
 *     They are placed in screen space, each by its own `left` and
 *     `top`, because the renderer does not cull through a transform and
 *     one big transformed layer would rasterise the whole world every
 *     frame.
 *   - **Three layers a tile** (`Painters.ts`): what changes on an edit
 *     under and over what changes every frame, so a new snapshot
 *     rasterises only the live layer.
 *   - **Levels of detail** (`detailAt`): below 6 px a unit wires go
 *     unlit into the static layer and gates show the value — as symbols
 *     down to 2.5, as blocks below that.
 *   - **Settle zoom**: during a zoom a tile keeps the size it was drawn
 *     at and is scaled by a transform. Once the zoom has been still for
 *     150 ms tiles are redrawn at the new size, a few per frame rather
 *     than all in one, which was Phase 0's remaining p95 spike.
 *
 * Camera units are grid units; `scale` is screen pixels per unit.
 */

export interface Camera {
  /** Grid coordinates at the view's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** Screen pixels per grid unit. */
  readonly scale: number;
}

export type ZoomPreset = 'all' | 'mid' | 'close';

export interface CanvasHandle {
  readonly element: UiChild;
  readonly camera: BehaviorSubject<Camera> & { value: Camera };
  readonly size: UiContainerSizeSource;
  /** Frames the camera: everything, a few hundred gates, or a few dozen. */
  show(preset: ZoomPreset): void;
  /** Whether there is a scene and a size to draw it at. */
  ready(): boolean;
  /** A scale within the canvas's zoom limits. */
  clampScale(scale: number): number;
  /** Tiles mounted now. */
  tileCount(): number;
  /** Tiles made since construction, for telling frames that made tiles from frames that did not. */
  tilesMade(): number;
  /** Share of the view's tiles with nothing drawn on their ground yet, 0..1: the price of queueing new tiles. */
  blank(): number;
  /** Share of on-screen nets with no value yet, 0..1. */
  missed(): number;
  /** The scene's bounds in grid units. */
  bounds(): Box;
}

const TILE = 256;
const MIN_SCALE = 0.25;
const MAX_SCALE = 48;
/** How long the zoom must be still before tiles are redrawn at the new size. */
const SETTLE_MS = 150;
/** The most tiles redrawn at the new size in one frame, once a zoom settles. */
const REFRESH_PER_FRAME = 4;
/**
 * The most new tiles brought into view in one frame; see the queue below.
 * Three, measured against one and two: one tile a frame left up to 60%
 * of a zooming view blank for a frame gain lost in the noise, and three
 * keeps the blank ground under 2% on average.
 */
const NEW_PER_FRAME = 3;

interface Tile {
  readonly key: string;
  readonly tx: number;
  readonly ty: number;
  /** Grid units per side. */
  readonly world: number;
  readonly area: Box;
  /** The chunks this tile's nets are in. */
  readonly chunks: readonly number[];
  /** The scale the tile's bitmaps were last drawn at; see settle zoom above. */
  readonly drawnAt: BehaviorSubject<number>;
  readonly under: UiPaint;
  readonly over: UiPaint;
  readonly drawLive: (surface: PaintSurface, box: PaintBox) => void;
}

export function circuitCanvas(ctx: ComponentContext): CanvasHandle {
  const circuit = ctx.channel(Circuit);
  const size = new UiContainerSizeSource();
  const camera = internalState<Camera>({ x: 0, y: 0, scale: 1 }) as unknown as CanvasHandle['camera'];

  // ---------------------------------------------------------------------
  // The scene, rebuilt when geometry changes
  // ---------------------------------------------------------------------

  let scene = new SceneIndex(circuit.view.geometry.value);
  const revision = internalState(0);
  ctx.effect(circuit.view.geometry, geometry => {
    scene = new SceneIndex(geometry);
    revision.value++;
  });

  let chunks: Readonly<Record<string, string>> = circuit.view.signals.value.chunks;
  ctx.effect(circuit.view.signals, (signals: Signals) => (chunks = signals.chunks));

  // ---------------------------------------------------------------------
  // The round trip: what is on screen, snapped outward to index cells so
  // the command goes when a cell boundary is crossed, not every frame.
  // ---------------------------------------------------------------------

  const worldView = combineLatest([camera, size.changes, revision]).pipe(
    map(([c, s]) => ({
      left: Math.floor(c.x / CELL) * CELL,
      top: Math.floor(c.y / CELL) * CELL,
      right: Math.ceil((c.x + s.width / c.scale) / CELL) * CELL,
      bottom: Math.ceil((c.y + s.height / c.scale) / CELL) * CELL
    })),
    distinctUntilChanged((a, b) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom)
  );
  let visibleNets: number[] = [];
  ctx.effect(worldView, v => {
    circuit.send.setViewport(v.left, v.top, v.right, v.bottom);
    visibleNets = scene.netsIn(v);
  });

  // ---------------------------------------------------------------------
  // Tiles
  // ---------------------------------------------------------------------

  const tiles = new Map<string, Tile>();

  /**
   * The octave the tile grid is cut at: the camera's, with a little
   * hysteresis so a zoom resting just below a power of two does not flip
   * it back and forth.
   *
   * Little, and only below, because tile size costs twice. Every live
   * layer is redrawn every frame the circuit runs, and a tile hanging
   * off the edge of the view is redrawn in full. Holding a coarser grid
   * across a wider band left mid zoom on 12 tiles of 512 px, and its
   * frame went from 16 ms to 48 in software rendering.
   */
  const gridOctave = internalState(2 ** Math.floor(Math.log2(camera.value.scale)));
  ctx.effect(camera, c => {
    const ratio = c.scale / gridOctave.value;
    if (ratio < 0.9 || ratio >= 1.9) {
      gridOctave.value = 2 ** Math.floor(Math.log2(c.scale));
    }
  });

  /**
   * New tiles, brought in a few a frame instead of all at once.
   *
   * A tile's layers are rasterised on the frame it first appears, and a
   * frame that brings in many tiles pays for all of them. Phase 3 met
   * this twice. A new grid (a zoom crossing an octave) made every tile in
   * one frame: 103 ms with the GPU, 216 ms without. And in software
   * rendering, the frames after a pan or zoom brought in a column of
   * tiles averaged 21–27 ms against 17–18 otherwise.
   *
   * So a tile becomes visible only when the frame loop promotes it, at
   * most `NEW_PER_FRAME` a frame, nearest the middle of the view first.
   * Until then its ground shows the old grid's tile if a grid change is
   * under way, and the background if not: at the edge of a pan, a sliver
   * a frame or two late, which is the price map viewers pay for the
   * same reason. Two cases skip the queue, because there is nothing on
   * screen to protect: a view with no tile shown at all (the first
   * frame, a jump), and an edit, whose tiles are all new at once.
   */
  let previousOctave: number | null = null;
  let lastOctave = gridOctave.value;
  let lastRevision = -1;
  let ready = new Set<string>();
  let pending: { key: string; tx: number; ty: number; world: number }[] = [];
  /** Of the tiles the view wants, how many have nothing on their ground, and out of how many. */
  let blankCells = 0;
  let wantedCells = 0;
  const promoted = internalState(0);
  ctx.effect(gridOctave, octave => {
    if (octave === lastOctave) return;
    if (previousOctave === null) {
      previousOctave = lastOctave;
    }
    lastOctave = octave;
  });

  /** When the camera's scale last changed, for telling a zoom in progress from a view at rest. */
  let scaleChangedAt = 0;
  let tilesMade = 0;
  const makeTile = (key: string, tx: number, ty: number, world: number, scale: number): Tile => {
    tilesMade++;
    const area: Box = { left: tx * world, top: ty * world, right: (tx + 1) * world, bottom: (ty + 1) * world };
    const nets = scene.netsIn(area);
    const place = (surface: PaintSurface, box: PaintBox) => {
      const s = box.width / world;
      surface.scale(s, s);
      surface.translate(-area.left, -area.top);
      return s;
    };
    const owner = scene;
    return {
      key,
      tx,
      ty,
      world,
      area,
      chunks: [...new Set(nets.map(net => Math.floor(net / 256)))],
      drawnAt: new BehaviorSubject(scale),
      under: { draw: (surface, box) => paintUnder(surface, owner, area, place(surface, box)), inputs: [key] },
      over: { draw: (surface, box) => paintOver(surface, owner, area, place(surface, box)), inputs: [key] },
      drawLive: (surface, box) => paintLive(surface, owner, area, place(surface, box), chunks)
    };
  };

  /** The grid cells an octave cuts the view into, clipped to the scene. */
  const cells = (octave: number, c: Camera, s: { width: number; height: number }, rev: number) => {
    const world = TILE / octave;
    const b = scene.bounds;
    const x0 = Math.max(Math.floor(b.left / world), Math.floor(c.x / world));
    const y0 = Math.max(Math.floor(b.top / world), Math.floor(c.y / world));
    const x1 = Math.min(Math.floor(b.right / world), Math.floor((c.x + s.width / c.scale) / world));
    const y1 = Math.min(Math.floor(b.bottom / world), Math.floor((c.y + s.height / c.scale) / world));
    const out: { key: string; tx: number; ty: number; world: number }[] = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        out.push({ key: `${rev}:${world}:${tx}:${ty}`, tx, ty, world });
      }
    }
    return out;
  };
  const made = (cell: { key: string; tx: number; ty: number; world: number }, scale: number): Tile => {
    let tile = tiles.get(cell.key);
    if (tile === undefined) {
      // A tile made while a zoom is under way is drawn at half the
      // resolution: a quarter of the pixels to rasterise on the frame it
      // arrives, which Phase 3's trace found was what made a zoom's
      // frames late in software rendering. It is on screen only while
      // the view moves, scaled up and slightly soft, and settle zoom
      // redraws it sharp once the zoom stops.
      const zooming = performance.now() - scaleChangedAt < SETTLE_MS;
      tile = makeTile(cell.key, cell.tx, cell.ty, cell.world, zooming ? scale / 2 : scale);
      tiles.set(cell.key, tile);
    }
    return tile;
  };

  const visibleTiles: Observable<readonly Tile[]> = combineLatest([camera, size.changes, revision, gridOctave, promoted]).pipe(
    map(([c, s, rev, octave]) => {
      if (s.width <= 0) {
        return [];
      }
      const current = cells(octave, c, s, rev);
      if (rev !== lastRevision) {
        // An edit, or the scene arriving: every tile is new, and the old
        // ones describe a circuit that no longer exists.
        lastRevision = rev;
        previousOctave = null;
        ready = new Set(current.map(cell => cell.key));
      } else {
        // Forget what has left the view, so a tile coming back is queued
        // again: its layers were dropped with it and are drawn afresh.
        ready = new Set(current.filter(cell => ready.has(cell.key)).map(cell => cell.key));
      }
      pending = current.filter(cell => !ready.has(cell.key));
      // The old grid's tiles stay only over ground whose new tile is not
      // ready: drawing both grids everywhere for a whole change doubled
      // the tiles composited on every frame of a zoom.
      const covers = (tile: Tile, cell: { tx: number; ty: number; world: number }) =>
        cell.tx * cell.world < tile.area.right &&
        (cell.tx + 1) * cell.world > tile.area.left &&
        cell.ty * cell.world < tile.area.bottom &&
        (cell.ty + 1) * cell.world > tile.area.top;
      const old =
        previousOctave === null
          ? []
          : cells(previousOctave, c, s, rev)
              .flatMap(cell => tiles.get(cell.key) ?? [])
              .filter(tile => pending.some(cell => covers(tile, cell)));
      let list = [...old, ...current.filter(cell => ready.has(cell.key)).map(cell => made(cell, c.scale))];
      wantedCells = current.length;
      blankCells = pending.filter(cell => !old.some(tile => covers(tile, cell))).length;
      if (list.length === 0 && current.length > 0) {
        // Nothing on screen at all: a jump, or the first frame. Queueing
        // would show an empty canvas filling in; there is nothing to keep
        // smooth, so everything comes in now.
        ready = new Set(current.map(cell => cell.key));
        pending = [];
        blankCells = 0;
        list = current.map(cell => made(cell, c.scale));
      }
      // Only what is shown is kept: a tile that scrolled away is rebuilt
      // if it comes back, which is an index walk and nothing more.
      if (tiles.size > list.length * 4) {
        const keep = new Set(list.map(tile => tile.key));
        for (const key of tiles.keys()) {
          if (!keep.has(key)) tiles.delete(key);
        }
      }
      return list;
    }),
    distinctUntilChanged((a, b) => a.length === b.length && a.every((tile, i) => tile === b[i]))
  );
  let shown: readonly Tile[] = [];
  ctx.effect(visibleTiles, list => (shown = list));

  const renderTile = (tile: Tile) => {
    const live = circuit.view.signals.pipe(
      map((s): UiPaint => ({ draw: tile.drawLive, inputs: [tile.key, ...tile.chunks.map(chunk => s.chunks[chunk])] }))
    );
    const box = combineLatest([camera, tile.drawnAt]).pipe(
      map(([c, drawnAt]) => ({ side: tile.world * drawnAt, scale: c.scale / drawnAt }))
    );
    return (
      <stack
        position="absolute"
        // Whole pixels. A bitmap drawn at a fractional position is
        // resampled on every draw, and in software rendering that alone
        // made a full redraw 3.5× dearer: 8.6 ms against 2.5 in the
        // engine's measurement. The half pixel this moves a tile is not
        // visible; the resampling was.
        left={camera.pipe(map(c => Math.round((tile.area.left - c.x) * c.scale)))}
        top={camera.pipe(map(c => Math.round((tile.area.top - c.y) * c.scale)))}
        width={box.pipe(map(b => b.side))}
        height={box.pipe(map(b => b.side))}
        transform={box.pipe(map(b => (b.scale === 1 ? undefined : { scaleX: b.scale, scaleY: b.scale })))}>
        <paint width={percent(100)} height={percent(100)} paint={tile.under} />
        <paint width={percent(100)} height={percent(100)} paint={live} />
        <paint width={percent(100)} height={percent(100)} paint={tile.over} />
      </stack>
    );
  };

  // Settle zoom: once the scale has been still for a moment, redraw
  // shown tiles at it, a few a frame, the middle of the view first.
  ctx.effect(
    camera.pipe(
      map(c => c.scale),
      distinctUntilChanged()
    ),
    () => (scaleChangedAt = performance.now())
  );
  ctx.effect(ctx.inject(FrameService).frames, () => {
    const c = camera.value;
    const s = size.current;
    const cx = c.x + s.width / c.scale / 2;
    const cy = c.y + s.height / c.scale / 2;
    const distanceTo = (area: { left: number; right: number; top: number; bottom: number }) =>
      Math.hypot((area.left + area.right) / 2 - cx, (area.top + area.bottom) / 2 - cy);

    // Tiles waiting to come in take this frame's budget, before any
    // settle-zoom redraw: both are a tile's layers rasterised, and a
    // frame should pay for a few of them, not for both queues at once.
    if (pending.length > 0) {
      const byDistance = pending
        .map(cell => ({
          cell,
          d: distanceTo({
            left: cell.tx * cell.world,
            right: (cell.tx + 1) * cell.world,
            top: cell.ty * cell.world,
            bottom: (cell.ty + 1) * cell.world
          })
        }))
        .sort((a, b) => a.d - b.d);
      for (const { cell } of byDistance.slice(0, NEW_PER_FRAME)) {
        ready.add(cell.key);
      }
      promoted.value++;
      return;
    }
    if (previousOctave !== null) {
      // The new grid covers the view; the old one goes.
      previousOctave = null;
      promoted.value++;
      return;
    }

    if (performance.now() - scaleChangedAt < SETTLE_MS) {
      return;
    }
    const stale = shown.filter(tile => tile.drawnAt.value !== c.scale);
    if (stale.length === 0) {
      return;
    }
    stale.sort((a, b) => distanceTo(a.area) - distanceTo(b.area));
    for (const tile of stale.slice(0, REFRESH_PER_FRAME)) {
      tile.drawnAt.next(c.scale);
    }
  });

  // ---------------------------------------------------------------------
  // Input: drag or wheel to pan, ctrl-wheel or pinch to zoom
  // ---------------------------------------------------------------------

  const zoomAt = (sx: number, sy: number, factor: number) => {
    const c = camera.value;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * factor));
    const wx = c.x + sx / c.scale;
    const wy = c.y + sy / c.scale;
    camera.value = { x: wx - sx / scale, y: wy - sy / scale, scale };
  };
  const panBy = (dx: number, dy: number) => {
    const c = camera.value;
    camera.value = { ...c, x: c.x + dx / c.scale, y: c.y + dy / c.scale };
  };
  let dragFrom: { x: number; y: number } | null = null;

  const show = (preset: ZoomPreset) => {
    const s = size.current;
    const b = scene.bounds;
    // Nothing to frame until the scene has arrived: fitting an empty
    // scene gave a scale of a hundred pixels a unit, which the bench
    // then zoomed around.
    if (scene.componentCount === 0 || s.width <= 0) {
      return;
    }
    const fit = Math.min(s.width / (b.right - b.left + 8), s.height / (b.bottom - b.top + 8));
    const scale = preset === 'all' ? fit : preset === 'mid' ? 4 : 12;
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    camera.value = { scale, x: cx - s.width / scale / 2, y: cy - s.height / scale / 2 };
  };

  // Frame the scene the first time there is both a size and a scene.
  let framed = false;
  ctx.effect(combineLatest([size.changes, revision]), ([s]) => {
    if (!framed && s.width > 0 && scene.componentCount > 0) {
      framed = true;
      show('all');
    }
  });

  const element = (
    <box
      width={percent(100)}
      height={percent(100)}
      overflow="hidden"
      backgroundColor="background"
      containerSize={size}
      modifiers={[sizeContainer({ source: size })]}
      onWheel={(event: UiWheelEvent) => {
        if (event.modifiers.ctrl || event.modifiers.meta) {
          zoomAt(event.x, event.y, Math.exp(-event.deltaY * 0.002));
        } else {
          panBy(event.deltaX, event.deltaY);
        }
      }}
      onPointerDown={(event: UiPointerEvent) => (dragFrom = { x: event.x, y: event.y })}
      onPointerMove={(event: UiPointerEvent) => {
        if (dragFrom !== null && event.buttons !== 0) {
          panBy(dragFrom.x - event.x, dragFrom.y - event.y);
          dragFrom = { x: event.x, y: event.y };
        }
      }}
      onPointerUp={() => (dragFrom = null)}
      onPinchMove={(event: UiPinchEvent) => zoomAt(event.x, event.y, event.scaleDelta)}>
      {each(visibleTiles, 'key', renderTile)}
    </box>
  );

  return {
    element,
    camera,
    size,
    show,
    ready: () => scene.componentCount > 0 && size.current.width > 0,
    clampScale: (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)),
    tileCount: () => shown.length,
    tilesMade: () => tilesMade,
    blank: () => (wantedCells === 0 ? 0 : blankCells / wantedCells),
    missed: () => {
      if (visibleNets.length === 0) return 0;
      let missing = 0;
      for (const net of visibleNets) {
        if (signalOf(chunks, net) === -1) missing++;
      }
      return missing / visibleNets.length;
    },
    bounds: () => scene.bounds
  };
}
