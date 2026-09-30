/**
 * The toolbar's glyphs: Heroicons 2.2.0, 24×24 outline, as path data.
 *
 * One set, for the reason gessosheet gives in its own `icons.ts`: a
 * toolbar's icons are read as a group, and a row whose strokes and
 * corners disagree looks assembled rather than designed. Heroicons is
 * MIT licensed — Copyright (c) Tailwind Labs, Inc.
 *
 * Named for what the button means rather than for the picture, so the
 * picture can change without touching a call site.
 */
export interface Glyph {
  readonly path: string;
  readonly viewBox: number;
  readonly style: 'fill' | 'stroke';
  readonly strokeWidth?: number;
}

const outline = (path: string): Glyph => ({ path, viewBox: 24, style: 'stroke', strokeWidth: 1.5 });

export const ICONS = {
  /** `sun`: the button that turns the lights back on. */
  light: outline(
    'M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z'
  ),
  /** `moon`: the button that turns them down. */
  dark: outline(
    'M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z'
  ),
  /** `arrow-uturn-left` */
  undo: outline('M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3'),
  /** `arrow-uturn-right` */
  redo: outline('m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3'),
  /** `play` */
  run: outline(
    'M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z'
  ),
  /** `pause` */
  pause: outline('M15.75 5.25v13.5m-7.5-13.5v13.5'),
  /** `forward` */
  step: outline(
    'M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 0 1 0 1.954l-7.108 4.061A1.125 1.125 0 0 1 3 16.811V8.69ZM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 0 1 0 1.954l-7.108 4.061a1.125 1.125 0 0 1-1.683-.977V8.69Z'
  ),
  /** `magnifying-glass-plus` */
  zoomIn: outline('m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607ZM10.5 7.5v6m3-3h-6'),
  /** `magnifying-glass-minus` */
  zoomOut: outline('m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607ZM13.5 10.5h-6'),
  /** `arrows-pointing-out` */
  fit: outline(
    'M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15'
  ),
  /** `cube` */
  chip: outline('m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9'),
  /** `presentation-chart-line` */
  analyser: outline(
    'M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605'
  ),
  /** `question-mark-circle` */
  help: outline(
    'M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z'
  ),
  /** `document-plus` */
  newFile: outline(
    'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z'
  ),
  /** `folder-open` */
  open: outline(
    'M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776'
  ),
  /** `arrow-down-tray` */
  save: outline('M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3'),
  /** `arrow-up` */
  up: outline('M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18'),
  /** `exclamation-triangle` */
  warning: outline(
    'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z'
  ),
  /** `table-cells`, simplified to its outline and rules: the full glyph is eighty segments. */
  table: outline('M3.375 19.5h17.25M3.375 4.5h17.25M2.25 5.625v12.75M21.75 5.625v12.75M2.25 9.375h19.5M2.25 13.875h19.5M12 9.375v10.125')
} as const satisfies Record<string, Glyph>;
