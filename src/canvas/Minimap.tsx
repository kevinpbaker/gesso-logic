import { combineLatest, distinctUntilChanged, map, type Observable } from 'rxjs';

import type { PaintSurface, UiChild, UiPaint, UiPointerEvent } from 'gesso-core';
import type { ComponentContext } from 'gesso-framework';

import type { Box } from '../app/Layout';
import type { Camera } from './CircuitCanvas';
import type { SceneIndex } from './SceneIndex';

/**
 * The whole level in a corner, and where the view is in it: for a
 * circuit bigger than the screen, so that a person deep in one corner of
 * the computer knows which, and can get to another with a click.
 *
 * Shown only while the level does not fit the view — a circuit seen
 * whole needs no map of itself — and not at all when turned off.
 * Clicking it centres the view there, and dragging moves the view with
 * the pointer, at the zoom it was.
 *
 * Two paints: the level, drawn again when it changes, and the view's
 * rectangle over it, drawn again when the camera moves. Parts are
 * blocks and wires lines, all in one colour, which is what a map at a
 * pixel a gate can say.
 */

/** The most room the map takes, in pixels; it keeps the level's shape inside that. */
const MAX_WIDTH = 200;
const MAX_HEIGHT = 140;
/** Room around the level inside the map, in grid units. */
const PAD = 4;

export interface MinimapSource {
  /** The scene as it is now. */
  scene(): SceneIndex;
  /** Bumped when the scene changes. */
  readonly revision: Observable<number>;
  readonly camera: Observable<Camera> & { value: Camera };
  /** Moves the view. */
  setCamera(camera: Camera): void;
  /** The canvas's size in pixels. */
  readonly size: Observable<{ readonly width: number; readonly height: number }>;
}

/** How the level fits the map: the world area it shows, pixels a unit, and the map's size. */
interface Fit {
  readonly area: Box;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

function fitOf(bounds: Box): Fit {
  const area = { left: bounds.left - PAD, top: bounds.top - PAD, right: bounds.right + PAD, bottom: bounds.bottom + PAD };
  const scale = Math.min(MAX_WIDTH / (area.right - area.left), MAX_HEIGHT / (area.bottom - area.top));
  return { area, scale, width: Math.round((area.right - area.left) * scale), height: Math.round((area.bottom - area.top) * scale) };
}

export function minimap(ctx: ComponentContext, source: MinimapSource, on: Observable<boolean>, bottom: Observable<number>): UiChild {
  const fit = source.revision.pipe(
    map(() => fitOf(source.scene().bounds)),
    distinctUntilChanged((a, b) => a.width === b.width && a.height === b.height && a.scale === b.scale && a.area.left === b.area.left && a.area.top === b.area.top)
  );
  let current: Fit = fitOf(source.scene().bounds);
  ctx.effect(fit, f => (current = f));

  // Shown while it is on and the level does not fit the view.
  const shown = combineLatest([on, source.camera, source.size, source.revision]).pipe(
    map(([wanted, c, s]) => {
      const scene = source.scene();
      if (!wanted || scene.componentCount === 0 || s.width <= 0) return false;
      const b = scene.bounds;
      return b.left < c.x || b.top < c.y || b.right > c.x + s.width / c.scale || b.bottom > c.y + s.height / c.scale;
    }),
    distinctUntilChanged()
  );

  const drawLevel = (surface: PaintSurface) => {
    const scene = source.scene();
    const f = current;
    surface.scale(f.scale, f.scale);
    surface.translate(-f.area.left, -f.area.top);
    // Wires first, faint; parts over them.
    surface.beginPath();
    const p = scene.wirePoints;
    for (let w = 0; w < scene.wireCount; w++) {
      const start = scene.wireStart[w]!;
      const end = scene.wireStart[w + 1]!;
      surface.moveTo(p[start]!, p[start + 1]!);
      for (let i = start + 2; i < end; i += 2) surface.lineTo(p[i]!, p[i + 1]!);
    }
    surface.lineWidth(1 / f.scale);
    surface.strokeColor('border');
    surface.stroke();
    surface.beginPath();
    for (let c = 0; c < scene.componentCount; c++) surface.rect(scene.x[c]!, scene.y[c]!, scene.width(c), scene.height(c));
    surface.fillColor('textMuted');
    surface.fill();
  };
  const level = source.revision.pipe(map((r): UiPaint => ({ draw: drawLevel, inputs: [r] })));

  const drawView = (surface: PaintSurface) => {
    const f = current;
    const c = source.camera.value;
    const s = sizeNow;
    const left = Math.max(0, (c.x - f.area.left) * f.scale);
    const top = Math.max(0, (c.y - f.area.top) * f.scale);
    const right = Math.min(f.width, (c.x + s.width / c.scale - f.area.left) * f.scale);
    const bottom = Math.min(f.height, (c.y + s.height / c.scale - f.area.top) * f.scale);
    if (right <= left || bottom <= top) return;
    surface.beginPath();
    surface.rect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);
    surface.save();
    surface.alpha(0.15);
    surface.fillColor('primary');
    surface.fill();
    surface.restore();
    surface.lineWidth(1.5);
    surface.strokeColor('primary');
    surface.stroke();
  };
  let sizeNow = { width: 0, height: 0 };
  ctx.effect(source.size, s => (sizeNow = s));
  const view = combineLatest([source.camera, source.size, fit]).pipe(map(([c, s, f]): UiPaint => ({ draw: drawView, inputs: [c.x, c.y, c.scale, s.width, s.height, f.scale, f.area.left, f.area.top] })));

  // A press centres the view on the point; a drag keeps it under the pointer.
  const box = ctx.bounds('minimap');
  let dragging = false;
  const centreAt = (event: UiPointerEvent) => {
    const f = current;
    const c = source.camera.value;
    const s = sizeNow;
    // Inside the border, a pixel in from the box.
    const x = f.area.left + (event.x - box.value.x - 1) / f.scale;
    const y = f.area.top + (event.y - box.value.y - 1) / f.scale;
    source.setCamera({ scale: c.scale, x: x - s.width / c.scale / 2, y: y - s.height / c.scale / 2 });
  };

  return (
    <box
      position="absolute"
      right={12}
      bottom={bottom}
      width={fit.pipe(map(f => f.width + 2))}
      height={fit.pipe(map(f => f.height + 2))}
      opacity={shown.pipe(map(s => (s ? 0.95 : 0)))}
      pointerEvents={shown.pipe(map(s => (s ? 'auto' : 'none')))}
      backgroundColor="surface"
      borderColor="border"
      borderWidth={1}
      borderRadius={4}
      overflow="hidden"
      cursor="pointer"
      label="Map of the level: click or drag to move the view"
      modifiers={[box.modifier]}
      onPointerDown={(event: UiPointerEvent) => {
        event.stopPropagation();
        dragging = true;
        centreAt(event);
      }}
      onPointerMove={(event: UiPointerEvent) => {
        event.stopPropagation();
        if (dragging && (event.buttons & 1) !== 0) centreAt(event);
        else dragging = false;
      }}
      onPointerUp={(event: UiPointerEvent) => {
        event.stopPropagation();
        dragging = false;
      }}
      onWheel={(event: { stopPropagation(): void }) => event.stopPropagation()}>
      <paint position="absolute" left={1} top={1} width={fit.pipe(map(f => f.width))} height={fit.pipe(map(f => f.height))} paint={level} />
      <paint position="absolute" left={1} top={1} width={fit.pipe(map(f => f.width))} height={fit.pipe(map(f => f.height))} paint={view} />
    </box>
  );
}
