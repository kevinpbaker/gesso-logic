import { PaintTarget, normalizeColor, type PaintContext2D, type UiColor, type UiColorValue, type UiTheme } from 'gesso-core';

import type { Geometry } from '../app/CircuitContract';
import type { Box } from '../app/Layout';
import { paintLive, paintOver, paintUnder } from './Painters';
import { SceneIndex } from './SceneIndex';
import { SvgSurface } from './SvgSurface';

/**
 * The circuit as a picture to keep: for a document, a slide, a page of
 * notes. Drawn by the canvas's own painters, so a picture is what the
 * canvas shows at full detail — gate symbols, wires lit by their values,
 * labels — without the dot grid, on the theme's background, framed on
 * what is drawn with a little room around it.
 *
 * SVG is the circuit in vectors, sharp at any size. PNG is pixels, as
 * many a unit as keep it under a size every browser can make.
 */

/** Pixels a grid unit: a gate is 64 pixels wide, as on the canvas when working close. */
export const PICTURE_SCALE = 16;
/** Room left around what is drawn, in grid units. */
const MARGIN = 2;
/** The most pixels a PNG is made of, and the longest side, both short of what a canvas allows. */
const MAX_PNG_PIXELS = 64_000_000;
const MAX_PNG_SIDE = 16_000;

/** Only these parts, and the wires between them: a selection, on its own. */
export function geometryOf(geometry: Geometry, ids: ReadonlySet<string>): Geometry {
  const components: Record<string, Record<string, Geometry['components'][string][string]>> = {};
  for (const [bucket, entries] of Object.entries(geometry.components)) {
    for (const [id, entry] of Object.entries(entries)) {
      if (ids.has(id)) (components[bucket] ??= {})[id] = entry;
    }
  }
  const wires: Record<string, Record<string, Geometry['wires'][string][string]>> = {};
  for (const [bucket, entries] of Object.entries(geometry.wires)) {
    for (const [id, entry] of Object.entries(entries)) {
      if (ids.has(entry.from.component) && ids.has(entry.to.component)) (wires[bucket] ??= {})[id] = entry;
    }
  }
  return { ...geometry, components, wires };
}

/** What a picture of the scene covers: everything drawn, and the margin. */
export function pictureArea(scene: SceneIndex): Box {
  const b = scene.bounds;
  return { left: Math.floor(b.left - MARGIN), top: Math.floor(b.top - MARGIN), right: Math.ceil(b.right + MARGIN), bottom: Math.ceil(b.bottom + MARGIN) };
}

function paintAll(surface: Parameters<typeof paintLive>[0], scene: SceneIndex, area: Box, scale: number, chunks: Readonly<Record<string, string>>): void {
  surface.scale(scale, scale);
  surface.translate(-area.left, -area.top);
  paintUnder(surface, scene, area, scale);
  paintLive(surface, scene, area, scale, chunks);
  paintOver(surface, scene, area, scale, false);
}

export function pictureSvg(scene: SceneIndex, chunks: Readonly<Record<string, string>>, theme: UiTheme): string {
  const area = pictureArea(scene);
  const surface = new SvgSurface(theme);
  paintAll(surface, scene, area, PICTURE_SCALE, chunks);
  return surface.svg((area.right - area.left) * PICTURE_SCALE, (area.bottom - area.top) * PICTURE_SCALE, 'background');
}

/** The pixels a unit a PNG of the scene is made at: `wanted`, or fewer for a circuit too big for that. */
export function pngScale(scene: SceneIndex, wanted: number): number {
  const area = pictureArea(scene);
  const width = area.right - area.left;
  const height = area.bottom - area.top;
  return Math.max(0.5, Math.min(wanted, MAX_PNG_SIDE / width, MAX_PNG_SIDE / height, Math.sqrt(MAX_PNG_PIXELS / (width * height))));
}

export async function picturePng(scene: SceneIndex, chunks: Readonly<Record<string, string>>, theme: UiTheme, wanted = PICTURE_SCALE * 2): Promise<Uint8Array<ArrayBuffer>> {
  const area = pictureArea(scene);
  const scale = pngScale(scene, wanted);
  const canvas = new OffscreenCanvas(Math.ceil((area.right - area.left) * scale), Math.ceil((area.bottom - area.top) * scale));
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser cannot draw a picture off screen');
  const colors = theme.colors as unknown as Readonly<Record<string, UiColor>>;
  const color = (value: UiColorValue): UiColor | undefined =>
    typeof value === 'string' && Object.hasOwn(colors, value) ? colors[value] : normalizeColor(value);
  const surface = new PaintTarget(context as unknown as PaintContext2D, { color, gradient: () => undefined });
  surface.beginPath();
  surface.fillColor('background');
  surface.rect(0, 0, canvas.width, canvas.height);
  surface.fill();
  // The painters' scale is pixels a unit: at the PNG's, it is drawn at
  // the detail a canvas would show it at that size.
  paintAll(surface, scene, area, scale, chunks);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/** A scene of the geometry, or of only some of its parts. */
export function pictureScene(geometry: Geometry, ids: ReadonlySet<string> | null): SceneIndex {
  return new SceneIndex(ids === null ? geometry : geometryOf(geometry, ids));
}
