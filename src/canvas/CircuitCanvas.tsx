import { BehaviorSubject, combineLatest, type Observable } from 'rxjs';
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
  type UiWheelEvent
} from 'gesso-core';
import { each, FrameService, internalState, ShellService, type ComponentContext } from 'gesso-framework';

import { Circuit, type Signals } from '../app/CircuitContract';
import { intersects, type Box } from '../app/Layout';
import { signalOf } from '../app/SignalPacking';
import { Editor } from './Editor';
import type { Kind } from '../sim/Primitives';
import type { FileActions } from './Files';
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
  /** The definition name of the chip selected, when the selection is exactly one chip; null otherwise. */
  selectedChip(): string | null;
  /** The one component selected — its id, kind and width — or null for none or several. */
  selectedPart(): { readonly id: string; readonly kind: Kind; readonly width: number } | null;
  /** Selection, gestures and the keys that drive them. */
  readonly editor: Editor;
  /** Bumped whenever the editor has something new to show. */
  readonly editorChanged: BehaviorSubject<number>;
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

export function circuitCanvas(ctx: ComponentContext, files: FileActions | null = null): CanvasHandle {
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
  ctx.effect(circuit.view.geometry, geometry => {
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
          : cells(previousOctave, c, s)
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
    const under = tile.version.pipe(map((v): UiPaint => ({ draw: tile.drawUnder, inputs: [tile.key, v] })));
    const over = tile.version.pipe(map((v): UiPaint => ({ draw: tile.drawOver, inputs: [tile.key, v] })));
    const live = combineLatest([circuit.view.signals, tile.version, netVersion]).pipe(
      map(([s, v, nets]): UiPaint => ({
        draw: tile.drawLive,
        inputs: [tile.key, v, nets, ...tile.chunks.map(chunk => s.chunks[chunk])]
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
  // ---------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------

  const editorChanged = new BehaviorSubject(0);
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
      return (document.chips.find(chip => chip.name === name) ?? document.library.find(part => part.name === name))?.shape;
    }
  });
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
  const drawOverlay = (surface: PaintSurface) => {
    const c = camera.value;
    surface.scale(c.scale, c.scale);
    surface.translate(-c.x, -c.y);
    editor.drawOverlay(surface);
  };
  const overlay = combineLatest([camera, editorChanged]).pipe(
    map(([c, version]): UiPaint => ({ draw: drawOverlay, inputs: [c.x, c.y, c.scale, version] }))
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
      framedFor = document.opened;
      const next = document.path.length;
      if (next > depth) {
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
  // And where it is left is remembered, once the view comes to rest.
  ctx.effect(camera.pipe(debounceTime(400)), c => circuit.send.rememberCamera(c.x, c.y, c.scale));

  const element = (
    <box
      width={percent(100)}
      height={percent(100)}
      overflow="hidden"
      backgroundColor="background"
      containerSize={size}
      modifiers={[
        sizeContainer({ source: size }),
        dropTarget({
          accepts: EXTERNAL_FILES,
          onDrop: payload => files?.openDropped(payload.data as readonly { name: string; bytes?: ArrayBuffer }[]),
          over: { borderColor: 'primary', borderWidth: 2 }
        })
      ]}
      onWheel={(event: UiWheelEvent) => {
        if (event.modifiers.ctrl || event.modifiers.meta) {
          zoomAt(event.x, event.y, Math.exp(-event.deltaY * 0.002));
        } else {
          panBy(event.deltaX, event.deltaY);
        }
      }}
      focusable
      onPointerDown={(event: UiPointerEvent) => editor.pointerDown({ x: event.x, y: event.y }, event.buttons, event.modifiers.shift)}
      onPointerMove={(event: UiPointerEvent) => editor.pointerMove({ x: event.x, y: event.y }, event.buttons)}
      onPointerUp={(event: UiPointerEvent) => editor.pointerUp({ x: event.x, y: event.y })}
      onKeyDown={(event: UiKeyboardEvent) => {
        const ctrl = event.modifiers.ctrl || event.modifiers.meta;
        const key = event.key.toLowerCase();
        if (files !== null && ctrl && (key === 's' || key === 'o')) {
          if (key === 's') files.save(event.modifiers.shift);
          else files.open();
          event.preventDefault();
          return;
        }
        if (editor.keyDown(event.key, event.modifiers.ctrl || event.modifiers.meta, event.modifiers.shift)) {
          event.preventDefault();
        }
      }}
      onKeyUp={(event: UiKeyboardEvent) => editor.keyUp(event.key)}
      onPaste={(event: UiPasteEvent) => editor.paste(event.text)}
      onPinchMove={(event: UiPinchEvent) => zoomAt(event.x, event.y, event.scaleDelta)}>
      {each(visibleTiles, 'key', renderTile)}
      <paint position="absolute" left={0} top={0} width={percent(100)} height={percent(100)} paint={overlay} />
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
    bounds: () => scene.bounds,
    selectedPart: () => {
      if (editor.selection.size !== 1) return null;
      const id = [...editor.selection][0]!;
      const c = scene.indexOf.get(id);
      return c === undefined ? null : { id, kind: scene.kindOf(c), width: scene.widths[c]! };
    },
    selectedChip: () => {
      if (editor.selection.size !== 1) return null;
      const c = scene.indexOf.get([...editor.selection][0]!);
      return c === undefined ? null : scene.chipNames[c] ?? null;
    },
    editor,
    editorChanged
  };
}
