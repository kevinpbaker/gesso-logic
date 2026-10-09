import { BehaviorSubject, combineLatest, Subject, type Observable } from 'rxjs';
import { debounceTime, distinctUntilChanged, map } from 'rxjs/operators';

import {
  dropTarget,
  EXTERNAL_FILES,
  percent,
  sizeContainer,
  UiContainerSizeSource,
  type PaintBox,
  type PaintSurface,
  type UiChild,
  type UiPaint,
  type UiPinchEvent,
  type UiKeyboardEvent,
  type UiPasteEvent,
  type UiPointerEvent,
  type UiNode,
  type UiTheme,
  type UiWheelEvent
} from 'gesso-core';
import { each, FocusService, FrameService, internalState, ShellService, type ComponentContext } from 'gesso-framework';

import { Circuit, type Signals } from '../app/CircuitContract';
import { intersects, pinAt, type Box, type Point } from '../app/Layout';
import type { PinRef } from '../sim/Circuit';
import { signalOf } from '../app/SignalPacking';
import { Editor, type Hit } from './Editor';
import type { Kind } from '../sim/Primitives';
import type { FileActions } from './Files';
import { paintLive, paintOver, paintUnder } from './Painters';
import { pictureArea, picturePng, pictureScene, pictureSvg } from './Picture';
import type { MinimapSource } from './Minimap';
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

/** What is selected, for the inspector: counts, and the one part when there is exactly one. */
export interface SelectionSummary {
  readonly parts: number;
  readonly wires: number;
  /** Whether a wire selected was bent by hand. */
  readonly bent: boolean;
  /** The parts selected, by id. */
  readonly partIds: readonly string[];
  readonly one: {
    readonly id: string;
    readonly kind: Kind;
    readonly width: number;
    readonly label: string | null;
    /** A chip's definition name; null for any other kind. */
    readonly chip: string | null;
    /** A switch's or LED's note; null for none. */
    readonly note: string | null;
    /** Its own label, as given; null when it has none and goes by its id. */
    readonly ownLabel: string | null;
  } | null;
}

export interface CanvasHandle {
  readonly element: UiChild;
  readonly camera: BehaviorSubject<Camera> & { value: Camera };
  readonly size: UiContainerSizeSource;
  /** Frames the camera: everything, a few hundred gates, or a few dozen. */
  show(preset: ZoomPreset): void;
  /** Centres the view on these components, zooming out if they do not fit. */
  frame(ids: readonly string[]): void;
  /** Zooms about the middle of the view by a factor: 2 is twice as close. */
  zoomBy(factor: number): void;
  /** Components outlined as a problem — the ones oscillating — until it is set again. */
  readonly highlight: BehaviorSubject<readonly string[]>;
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
  /** The definition name of the chip selected, when the selection is exactly one chip; null otherwise. */
  selectedChip(): string | null;
  /** The one component selected — its id, kind and width — or null for none or several. */
  selectedPart(): { readonly id: string; readonly kind: Kind; readonly width: number } | null;
  selection(): SelectionSummary;
  /** Puts the keyboard on the canvas, so its keys work again after a menu or a dialog. */
  focus(): void;
  /** A component's label, or null; for naming parts in messages. */
  labelOf(id: string): string | null;
  /** A component's kind, or null for one not on this level. */
  kindOf(id: string): Kind | null;
  /** The chip definition a part on this level is an instance of; null for any other part. */
  chipOf(id: string): string | null;
  /** Selection, gestures and the keys that drive them. */
  readonly editor: Editor;
  /** Bumped whenever the editor has something new to show. */
  readonly editorChanged: BehaviorSubject<number>;
  /** Something was just sent to the analyser to trace, for the page to open it. */
  readonly traced: Observable<void>;
  /** A note's words or a named wire's name to edit, by id: just placed, or double-clicked. */
  readonly textToEdit: Observable<string>;
  /** Asks the page to edit a note's words or a named wire's name. */
  editText(id: string): void;
  /** A right-click that was not a pan: where, in page pixels, and what it was on, now selected. */
  readonly contextMenu: Observable<{ readonly at: Point; readonly hit: Hit }>;
  /**
   * Lights what an analyser row traces: its pin and net when it is on
   * this level, the chip it is inside when it is deeper; null for none.
   */
  highlightTrace(where: TraceWhere | null): void;
  /**
   * Centres the view on a traced pin and selects its part, once its
   * level is on the canvas: the caller asks for the level.
   */
  reveal(where: TraceWhere): void;
  /** Puts the view back as it was on a level, once that level is on the canvas: the caller asks for the level. */
  restoreView(path: readonly string[], view: Camera): void;
  /**
   * A picture of the level, or of the parts selected when there are any,
   * with every wire's value: SVG text, or PNG bytes. See `Picture.ts`.
   */
  picture(format: 'svg', theme: UiTheme): Promise<string>;
  picture(format: 'png', theme: UiTheme): Promise<Uint8Array<ArrayBuffer>>;
  /** Whether a wire on this level has been bent by hand; with no id, whether any has. */
  bent(id?: string): boolean;
  /** What the minimap draws from and moves: see `Minimap.tsx`. */
  readonly minimapSource: MinimapSource;
}

/** Where a traced pin is: the chips that open its level, from the top, and the pin there. */
export interface TraceWhere {
  readonly path: readonly string[];
  readonly pin: PinRef;
}

const TILE = 256;
const MIN_SCALE = 0.25;
const MAX_SCALE = 48;
/**
 * How far a ctrl-wheel pixel zooms, in natural-log units. A trackpad
 * pinch arrives as small ctrl-wheel deltas of 100·ln(scale), so at
 * 0.01 the circuit follows the fingers; at 0.002 it lagged five times
 * behind them.
 */
const WHEEL_ZOOM_RATE = 0.01;
/** The most one wheel event zooms: a √2 step, as the zoom buttons take, so a mouse wheel's notch is not a lurch. */
const WHEEL_ZOOM_STEP = Math.LN2 / 2;
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
/**
 * The most new tiles brought in in one frame for ground nothing covers —
 * the edges a pinch zooming out uncovers. Blank ground is the glitch the
 * queue is there to avoid making worse, so it goes first, and more of it.
 */
const BLANK_PER_FRAME = 8;

interface Tile {
  readonly key: string;
  readonly tx: number;
  readonly ty: number;
  /** Grid units per side. */
  readonly world: number;
  readonly area: Box;
  /** The chunks this tile's nets are in. Recomputed on every edit: a recompile renumbers nets. */
  chunks: readonly number[];
  /** The scale the tile's bitmaps were last drawn at; see settle zoom above. */
  readonly drawnAt: BehaviorSubject<number>;
  /** Bumped when an edit touches this tile's ground, which redraws its static layers. */
  readonly version: BehaviorSubject<number>;
  readonly drawUnder: (surface: PaintSurface, box: PaintBox) => void;
  readonly drawOver: (surface: PaintSurface, box: PaintBox) => void;
  readonly drawLive: (surface: PaintSurface, box: PaintBox) => void;
}

/**
 * A key the application answers before the editor sees it — the view
 * and simulation shortcuts, help — returning whether it did.
 */
export type CanvasKeys = (key: string, ctrl: boolean, shift: boolean, alt: boolean) => boolean;

export function circuitCanvas(ctx: ComponentContext, files: FileActions | null = null, keys: CanvasKeys | null = null): CanvasHandle {
  const circuit = ctx.channel(Circuit);
  const size = new UiContainerSizeSource();
  const camera = internalState<Camera>({ x: 0, y: 0, scale: 1 }) as unknown as CanvasHandle['camera'];

  // ---------------------------------------------------------------------
  // The scene, rebuilt when geometry changes
  // ---------------------------------------------------------------------

  let scene = new SceneIndex(circuit.view.geometry.value);
  const revision = internalState(0);
  /**
   * Bumped on every edit, because a recompile renumbers nets and every
   * tile's live layer reads them. Static layers do not, and are redrawn
   * only where the edit happened: see `SceneIndex.changed`.
   */
  const netVersion = internalState(0);

  /**
   * Every chunk's value as last published, not only the snapshot's. A
   * snapshot holds the chunks in and around the view; a chunk that left
   * it was dropped, and coming back — a pinch zooming out faster than
   * the band around the view — its wires were drawn unknown, grey, for
   * the frame or two before the next snapshot. They keep their last
   * value now, a frame stale at worst, which on a running circuit is
   * what the next frame would have said anyway. Kept across documents
   * too: a new one is published around the view the moment it opens and
   * whenever the view moves, which replaces any value from the last one
   * before it can be seen. Clearing it there lost a snapshot that came
   * before the new geometry, and a paused circuit sends no other.
   */
  let chunks: Readonly<Record<string, string>> = circuit.view.signals.value.chunks;
  const known = new BehaviorSubject(chunks);
  ctx.effect(circuit.view.signals, (signals: Signals) => {
    chunks = { ...chunks, ...signals.chunks };
    known.next(chunks);
  });

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
  let viewport: Box | null = null;
  ctx.effect(worldView, v => {
    viewport = v;
    circuit.send.setViewport(v.left, v.top, v.right, v.bottom);
    visibleNets = scene.netsIn(v);
  });

  /**
   * Every value a picture of `drawn` needs. What is off screen was never
   * published, so the application worker is asked for the whole of it
   * as though it were the view, until it answers or a second passes, and
   * then for the view again.
   */
  const valuesFor = async (drawn: SceneIndex): Promise<Readonly<Record<string, string>>> => {
    const area = pictureArea(drawn);
    const missing = () => drawn.netsIn(area).some(net => signalOf(chunks, net) === -1);
    if (!missing()) return chunks;
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, 1000);
      const subscription = circuit.view.signals.subscribe(() => {
        if (!missing()) done();
      });
      function done(): void {
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve();
      }
      circuit.send.setViewport(area.left, area.top, area.right, area.bottom);
    });
    const v = viewport;
    if (v !== null) circuit.send.setViewport(v.left, v.top, v.right, v.bottom);
    return chunks;
  };

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
  let ready = new Set<string>();
  let pending: { key: string; tx: number; ty: number; world: number }[] = [];
  /** Of the tiles the view wants, how many have nothing on their ground, and out of how many. */
  let blankCells = 0;
  let wantedCells = 0;
  const promoted = internalState(0);
  /** Whether a tile is over a cell's ground, so can stand in for it. */
  const covers = (tile: Tile, cell: { tx: number; ty: number; world: number }) =>
    cell.tx * cell.world < tile.area.right &&
    (cell.tx + 1) * cell.world > tile.area.left &&
    cell.ty * cell.world < tile.area.bottom &&
    (cell.ty + 1) * cell.world > tile.area.top;

  /** When the camera's scale last changed, for telling a zoom in progress from a view at rest. */
  let scaleChangedAt = 0;
  let tilesMade = 0;
  const chunksIn = (area: Box) => [...new Set(scene.netsIn(area).map(net => Math.floor(net / 256)))];
  const makeTile = (key: string, tx: number, ty: number, world: number, scale: number): Tile => {
    tilesMade++;
    const area: Box = { left: tx * world, top: ty * world, right: (tx + 1) * world, bottom: (ty + 1) * world };
    const place = (surface: PaintSurface, box: PaintBox) => {
      const s = box.width / world;
      surface.scale(s, s);
      surface.translate(-area.left, -area.top);
      return s;
    };
    // The painters read `scene` when they run, not when the tile was
    // made: a tile outlives edits, and draws the circuit as it is now.
    return {
      key,
      tx,
      ty,
      world,
      area,
      chunks: chunksIn(area),
      drawnAt: new BehaviorSubject(scale),
      version: new BehaviorSubject(0),
      drawUnder: (surface, box) => paintUnder(surface, scene, area, place(surface, box)),
      drawOver: (surface, box) => paintOver(surface, scene, area, place(surface, box)),
      drawLive: (surface, box) => paintLive(surface, scene, area, place(surface, box), chunks)
    };
  };

  // Placed after the tile machinery it uses: the view emits its current
  // value the moment this subscribes.
  let levelKey = `${circuit.view.geometry.value.opened}|${circuit.view.geometry.value.level}`;
  ctx.effect(circuit.view.geometry, geometry => {
    // Another level or document: the selection was the last one's. Here,
    // before anything hears of the new level, so what is selected on
    // arriving — a jump from the analyser — is not forgotten after.
    const key = `${geometry.opened}|${geometry.level}`;
    if (key !== levelKey) {
      levelKey = key;
      editor.forget();
    }
    scene = new SceneIndex(geometry, scene);
    const changed = scene.changed;
    for (const tile of tiles.values()) {
      tile.chunks = chunksIn(tile.area);
      if (changed.some(area => intersects(area, tile.area))) {
        tile.version.next(tile.version.value + 1);
      }
    }
    netVersion.value++;
    revision.value++;
  });

  /** The grid cells an octave cuts the view into, clipped to the scene. */
  // The whole view, not the scene's bounds: a gate can be placed anywhere,
  // and ground with nothing on it costs nothing, because an empty layer
  // makes no bitmap.
  const cells = (octave: number, c: Camera, s: { width: number; height: number }) => {
    const world = TILE / octave;
    const x0 = Math.floor(c.x / world);
    const y0 = Math.floor(c.y / world);
    const x1 = Math.floor((c.x + s.width / c.scale) / world);
    const y1 = Math.floor((c.y + s.height / c.scale) / world);
    const out: { key: string; tx: number; ty: number; world: number }[] = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        out.push({ key: `${world}:${tx}:${ty}`, tx, ty, world });
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
    map(([c, s, _rev, octave]) => {
      if (s.width <= 0) {
        return [];
      }
      const current = cells(octave, c, s);
      // Forget what has left the view, so a tile coming back is queued
      // again: its layers were dropped with it and are drawn afresh.
      ready = new Set(current.filter(cell => ready.has(cell.key)).map(cell => cell.key));
      pending = current.filter(cell => !ready.has(cell.key));
      // What was on screen stays over ground whose new tile is not ready,
      // and only there: drawing both grids everywhere for a whole change
      // doubled the tiles composited on every frame of a zoom. Whatever
      // grid it was cut on — remembering only the one grid before lost
      // a pinch's middle grid when it crossed two before the queue
      // caught up, and its ground went blank.
      const world = TILE / octave;
      const old = shown.filter(tile => tile.world !== world && pending.some(cell => covers(tile, cell)));
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
    const under = tile.version.pipe(map((v): UiPaint => ({ draw: tile.drawUnder, inputs: [tile.key, v] })));
    const over = tile.version.pipe(map((v): UiPaint => ({ draw: tile.drawOver, inputs: [tile.key, v] })));
    const live = combineLatest([known, tile.version, netVersion]).pipe(
      map(([k, v, nets]): UiPaint => ({
        draw: tile.drawLive,
        inputs: [tile.key, v, nets, ...tile.chunks.map(chunk => k[chunk])]
      }))
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
        <paint width={percent(100)} height={percent(100)} paint={under} />
        <paint width={percent(100)} height={percent(100)} paint={live} />
        <paint width={percent(100)} height={percent(100)} paint={over} />
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
    // Ground nothing covers comes first, more of it a frame.
    if (pending.length > 0) {
      const blank = pending.filter(cell => !shown.some(tile => covers(tile, cell)));
      const queue = blank.length > 0 ? blank : pending;
      const byDistance = queue
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
      for (const { cell } of byDistance.slice(0, blank.length > 0 ? BLANK_PER_FRAME : NEW_PER_FRAME)) {
        ready.add(cell.key);
      }
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
  // ---------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------

  const editorChanged = new BehaviorSubject(0);
  const traced = new Subject<void>();
  const textToEdit = new Subject<string>();
  // A right press pans when dragged, and asks for a menu when not: the
  // menu opens once the press has held still a moment, or at once when
  // it is let go — whichever is first — and not at all once it moves.
  const contextMenu = new Subject<{ readonly at: Point; readonly hit: Hit }>();
  let asking: { readonly page: Point; readonly screen: Point; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  const askMenu = () => {
    const ask = asking;
    if (ask === null) return;
    clearTimeout(ask.timer);
    asking = null;
    contextMenu.next({ at: ask.page, hit: editor.contextAt(ask.screen) });
  };
  const pointerMoved = (event: UiPointerEvent) => {
    const ask = asking;
    if (ask !== null) {
      const moved = Math.hypot(event.x - ask.page.x, event.y - ask.page.y) >= 4;
      if ((event.buttons & 2) === 0) askMenu();
      else if (moved) {
        clearTimeout(ask.timer);
        asking = null;
      }
    }
    editor.pointerMove(local(event), event.buttons);
  };
  const shell = ctx.inject(ShellService);
  const editor = new Editor({
    scene: () => scene,
    toWorld: p => {
      const c = camera.value;
      return { x: c.x + p.x / c.scale, y: c.y + p.y / c.scale };
    },
    scale: () => camera.value.scale,
    send: circuit.send,
    panBy,
    value: net => (net < 0 ? -1 : signalOf(chunks, net)),
    changed: () => editorChanged.next(editorChanged.value + 1),
    chipShape: name => {
      const document = circuit.view.document.value;
      // One of the person's own chips, by `mine:` and its name: see `MINE`.
      if (name.startsWith('mine:')) return circuit.view.myChips.value.chips.find(chip => chip.name === name.slice(5))?.shape;
      return (document.chips.find(chip => chip.name === name) ?? document.library.find(part => part.name === name))?.shape;
    },
    pinNote: (chip, pin) => circuit.view.document.value.chips.find(c => c.name === chip)?.notes[pin] ?? null,
    viewSize: () => size.current,
    traced: () => traced.next(),
    editText: id => textToEdit.next(id)
  });
  // A view moving under a still pointer changes what is under it.
  ctx.effect(camera, () => editor.viewMoved());
  // What the application worker made of a copy, onto the clipboard.
  let clipped = 0;
  ctx.effect(circuit.view.clipboard, clip => {
    if (clip.serial !== 0 && clip.serial !== clipped) {
      clipped = clip.serial;
      shell.copyText(clip.text);
    }
  });
  // Geometry arriving can move what the overlay outlines.
  ctx.effect(revision, () => editorChanged.next(editorChanged.value + 1));

  /**
   * The editor's overlay: one `Paint` over every tile, in screen space.
   * Its inputs are the camera and the editor's change count, so it is
   * redrawn when either moves, and with nothing selected and no gesture
   * under way it records nothing and costs nothing.
   */
  const highlight = new BehaviorSubject<readonly string[]>([]);
  const drawOverlay = (surface: PaintSurface) => {
    const c = camera.value;
    surface.scale(c.scale, c.scale);
    surface.translate(-c.x, -c.y);
    // Parts that will not settle, ringed in the danger colour under the
    // selection, so a click on the status bar's problem shows where.
    const flagged = highlight.value;
    if (flagged.length > 0) {
      const px = 1 / c.scale;
      surface.beginPath();
      for (const id of flagged) {
        const i = scene.indexOf.get(id);
        if (i !== undefined) surface.rect(scene.x[i]! - 6 * px, scene.y[i]! - 6 * px, scene.width(i) + 12 * px, scene.height(i) + 12 * px);
      }
      surface.strokeColor('danger');
      surface.lineWidth(3 * px);
      surface.lineDash([6 * px, 4 * px]);
      surface.stroke();
      surface.lineDash([]);
    }
    editor.drawOverlay(surface);
  };
  // The value in the tooltip, as the signals change: the overlay is drawn
  // again when it does, and only then, so it is live while the pointer
  // holds still and costs nothing while it shows no value.
  const hoverValue = combineLatest([circuit.view.signals, editorChanged]).pipe(
    map(() => editor.hoverCard()?.value ?? ''),
    distinctUntilChanged()
  );
  const overlay = combineLatest([camera, editorChanged, highlight, hoverValue]).pipe(
    map(([c, version, flagged, value]): UiPaint => ({ draw: drawOverlay, inputs: [c.x, c.y, c.scale, version, flagged.join(','), value] }))
  );

  const show = (preset: ZoomPreset) => {
    const s = size.current;
    const b = scene.bounds;
    if (s.width <= 0) {
      return;
    }
    // An empty document has nothing to fit. It opens at a working zoom —
    // a gate 64 pixels wide — with the origin near the top-left corner,
    // rather than at the hundred pixels a unit that fitting nothing gave.
    if (scene.componentCount === 0) {
      camera.value = { scale: 16, x: -4, y: -4 };
      return;
    }
    const fit = Math.min(s.width / (b.right - b.left + 8), s.height / (b.bottom - b.top + 8));
    const scale = preset === 'all' ? fit : preset === 'mid' ? 4 : 12;
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    camera.value = { scale, x: cx - s.width / scale / 2, y: cy - s.height / scale / 2 };
  };

  const frame = (ids: readonly string[]) => {
    const s = size.current;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const id of ids) {
      const i = scene.indexOf.get(id);
      if (i === undefined) continue;
      left = Math.min(left, scene.x[i]!);
      top = Math.min(top, scene.y[i]!);
      right = Math.max(right, scene.x[i]! + scene.width(i));
      bottom = Math.max(bottom, scene.y[i]! + scene.height(i));
    }
    if (s.width <= 0 || left === Infinity) return;
    // Close enough to read the parts, and never closer than it is now
    // unless they would not otherwise fit.
    const fit = Math.min(s.width / (right - left + 16), s.height / (bottom - top + 16));
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(fit, Math.max(camera.value.scale, 8))));
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    camera.value = { scale, x: cx - s.width / scale / 2, y: cy - s.height / scale / 2 };
  };
  const zoomBy = (factor: number) => {
    const s = size.current;
    zoomAt(s.width / 2, s.height / 2, factor);
  };

  // Frame the view when a document is opened, once there is a size to
  // frame it in: not on an edit, however much it changes.
  let framedFor = -1;
  // The view at each level of chips opened, so stepping back out of a
  // chip returns to where it was opened from rather than to a fit.
  const levelCameras: { x: number; y: number; scale: number }[] = [];
  let depth = 0;
  ctx.effect(combineLatest([size.changes, circuit.view.document, revision]), ([s, document]) => {
    // Wait for the opened document's geometry: the summary and the
    // geometry are separate keys, and the summary can arrive first.
    const geometry = circuit.view.geometry.value;
    const waiting =
      (document.components > 0 && scene.componentCount === 0) ||
      geometry.opened !== document.opened ||
      geometry.level !== document.path.map(level => level.id).join('/');
    if (s.width > 0 && document.opened !== framedFor && !waiting) {
      // The view being left is only worth coming back to if something
      // was framed before: a page that opens deep inside a chip — a hot
      // reload, say — has a camera that belongs to no level.
      const framedBefore = framedFor !== -1;
      framedFor = document.opened;
      const next = document.path.length;
      if (next > depth && framedBefore) {
        levelCameras[depth] = { ...camera.value };
      }
      const back = next < depth ? levelCameras[next] : undefined;
      depth = next;
      levelCameras.length = depth;
      // A document brought back by a reload opens where it was left.
      if (back !== undefined) {
        camera.value = back;
      } else if (document.camera !== null) {
        camera.value = { ...document.camera };
      } else {
        show('all');
      }
    }
  });
  // What the analyser's hovered row traces, lit as the level changes under it.
  let hoveredTrace: TraceWhere | null = null;
  const lightTrace = () => {
    const where = hoveredTrace;
    const here = circuit.view.document.value.path.map(level => level.id);
    const inside = where !== null && where.path.length >= here.length && here.every((id, i) => id === where.path[i]);
    editor.setHighlight(
      !inside ? null : where.path.length === here.length ? { kind: 'pin', pin: where.pin } : { kind: 'chip', id: where.path[here.length]! }
    );
  };
  ctx.effect(revision, lightTrace);

  // A jump from the analyser: once its level is on the canvas and framed,
  // the view centres on the pin, close enough to read, and its part is selected.
  // Or, going back, the view as it was there.
  let revealing: (TraceWhere & { readonly view?: Camera }) | null = null;
  const tryReveal = () => {
    const where = revealing;
    if (where === null) return;
    const document = circuit.view.document.value;
    const geometry = circuit.view.geometry.value;
    if (framedFor !== document.opened || geometry.opened !== document.opened || geometry.level !== where.path.join('/')) return;
    revealing = null;
    if (where.view !== undefined) {
      camera.value = { ...where.view };
      return;
    }
    const c = scene.indexOf.get(where.pin.component);
    if (c === undefined) return;
    // No pin named: the part's middle, for a part found by name.
    const at =
      where.pin.pin === ''
        ? { x: scene.x[c]! + scene.width(c) / 2, y: scene.y[c]! + scene.height(c) / 2 }
        : pinAt(scene.shapeOf(c), scene.x[c]!, scene.y[c]!, where.pin.pin, scene.rotationOf(c));
    const s = size.current;
    const scale = Math.max(camera.value.scale, 12);
    camera.value = { scale, x: at.x - s.width / scale / 2, y: at.y - s.height / scale / 2 };
    editor.selectOnly([where.pin.component]);
  };
  ctx.effect(combineLatest([circuit.view.document, revision]), tryReveal);

  // And where it is left is remembered, once the view comes to rest.
  ctx.effect(camera.pipe(debounceTime(400)), c => circuit.send.rememberCamera(c.x, c.y, c.scale));

  const focusService = ctx.inject(FocusService);
  let node: UiNode | null = null;
  /**
   * Where the canvas is on the page. Pointer events arrive in page
   * coordinates, and the canvas stopped being the whole page when the
   * menu bar and the palette arrived, so every position is taken
   * relative to this before the editor or the camera sees it.
   */
  const box = ctx.bounds('canvas');
  const local = (event: { x: number; y: number }) => ({ x: event.x - box.value.x, y: event.y - box.value.y });
  const element = (
    <box
      ref={(n: UiNode | null) => (node = n)}
      label="Circuit"
      width={percent(100)}
      height={percent(100)}
      overflow="hidden"
      backgroundColor="background"
      containerSize={size}
      modifiers={[
        sizeContainer({ source: size }),
        box.modifier,
        dropTarget({
          accepts: EXTERNAL_FILES,
          onDrop: payload => files?.openDropped(payload.data as readonly { name: string; bytes?: ArrayBuffer }[]),
          over: { borderColor: 'primary', borderWidth: 2 }
        })
      ]}
      onWheel={(event: UiWheelEvent) => {
        if (event.modifiers.ctrl || event.modifiers.meta) {
          const at = local(event);
          const step = Math.min(WHEEL_ZOOM_STEP, Math.max(-WHEEL_ZOOM_STEP, -event.deltaY * WHEEL_ZOOM_RATE));
          zoomAt(at.x, at.y, Math.exp(step));
        } else {
          panBy(event.deltaX, event.deltaY);
        }
      }}
      focusable
      onPointerDown={(event: UiPointerEvent) => editor.pointerDown(local(event), event.buttons, event.modifiers.shift, event.modifiers.alt)}
      onPointerMove={pointerMoved}
      onContextMenu={(event: UiPointerEvent) => {
        if (asking !== null) clearTimeout(asking.timer);
        asking = { page: { x: event.x, y: event.y }, screen: local(event), timer: setTimeout(askMenu, 250) };
      }}
      onPointerUp={(event: UiPointerEvent) => editor.pointerUp(local(event))}
      onPointerLeave={() => editor.pointerLeave()}
      onKeyDown={(event: UiKeyboardEvent) => {
        const ctrl = event.modifiers.ctrl || event.modifiers.meta;
        const key = event.key.toLowerCase();
        if (files !== null && ctrl && (key === 's' || key === 'o')) {
          if (key === 's') files.save(event.modifiers.shift);
          else files.open();
          event.preventDefault();
          return;
        }
        if (keys?.(event.key, ctrl, event.modifiers.shift, event.modifiers.alt)) {
          event.preventDefault();
          return;
        }
        if (editor.keyDown(event.key, event.modifiers.ctrl || event.modifiers.meta, event.modifiers.shift)) {
          event.preventDefault();
        }
      }}
      onKeyUp={(event: UiKeyboardEvent) => editor.keyUp(event.key)}
      onPaste={(event: UiPasteEvent) => editor.paste(event.text)}
      onPinchMove={(event: UiPinchEvent) => {
        const at = local(event);
        zoomAt(at.x, at.y, event.scaleDelta);
      }}>
      {each(visibleTiles, 'key', renderTile)}
      <paint position="absolute" left={0} top={0} width={percent(100)} height={percent(100)} paint={overlay} />
    </box>
  );

  return {
    element,
    camera,
    size,
    show,
    frame,
    zoomBy,
    highlight,
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
    bounds: () => scene.bounds,
    selectedPart: () => {
      if (editor.selection.size !== 1) return null;
      const id = [...editor.selection][0]!;
      const c = scene.indexOf.get(id);
      return c === undefined ? null : { id, kind: scene.kindOf(c), width: scene.widths[c]! };
    },
    selection: () => {
      let parts = 0;
      let wires = 0;
      let bent = false;
      const partIds: string[] = [];
      // An id in neither is one just handed out, not yet come back.
      for (const id of editor.selection) {
        if (scene.indexOf.has(id)) {
          parts++;
          partIds.push(id);
        } else {
          const w = scene.wireIds.indexOf(id);
          if (w < 0) continue;
          wires++;
          if (scene.wireEnds[w]!.via !== null) bent = true;
        }
      }
      const only = parts === 1 && wires === 0 ? scene.indexOf.get([...editor.selection][0]!) : undefined;
      return {
        parts,
        wires,
        bent,
        partIds,
        one:
          only === undefined
            ? null
            : {
                id: scene.ids[only]!,
                kind: scene.kindOf(only),
                width: scene.widths[only]!,
                label: scene.labels[only] ?? null,
                chip: scene.chipNames[only] ?? null,
                note: scene.entries[only]!.note,
                ownLabel: scene.entries[only]!.label
              }
      };
    },
    focus: () => {
      if (node !== null) focusService.focus(node);
    },
    chipOf: (id: string) => {
      const c = scene.indexOf.get(id);
      return c === undefined ? null : (scene.chipNames[c] ?? null);
    },
    labelOf: (id: string) => {
      const c = scene.indexOf.get(id);
      return c === undefined ? null : scene.labels[c] ?? null;
    },
    kindOf: (id: string) => {
      const c = scene.indexOf.get(id);
      return c === undefined ? null : scene.kindOf(c);
    },
    selectedChip: () => {
      if (editor.selection.size !== 1) return null;
      const c = scene.indexOf.get([...editor.selection][0]!);
      return c === undefined ? null : scene.chipNames[c] ?? null;
    },
    editor,
    editorChanged,
    traced,
    textToEdit,
    editText: (id: string) => textToEdit.next(id),
    contextMenu,
    highlightTrace: where => {
      hoveredTrace = where;
      lightTrace();
    },
    reveal: where => {
      revealing = where;
      tryReveal();
    },
    restoreView: (path, view) => {
      revealing = { path, pin: { component: '', pin: '' }, view };
      tryReveal();
    },
    bent: (id?: string) => {
      if (id === undefined) return scene.wireEnds.some(w => w.via !== null);
      const w = scene.wireIds.indexOf(id);
      return w >= 0 && scene.wireEnds[w]!.via !== null;
    },
    minimapSource: {
      scene: () => scene,
      revision,
      camera,
      setCamera: (next: Camera) => (camera.value = next),
      size: size.changes
    },
    picture: (async (format: 'svg' | 'png', theme: UiTheme) => {
      const ids = new Set([...editor.selection].filter(id => scene.indexOf.has(id)));
      const drawn = pictureScene(circuit.view.geometry.value, ids.size === 0 ? null : ids);
      const values = await valuesFor(drawn);
      return format === 'svg' ? pictureSvg(drawn, values, theme) : picturePng(drawn, values, theme);
    }) as CanvasHandle['picture']
  };
}
