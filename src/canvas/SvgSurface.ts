import {
  colorToCss,
  normalizeColor,
  type PaintFillRule,
  type PaintLineCap,
  type PaintLineJoin,
  type PaintSurface,
  type PaintTextStyle,
  type UiColorValue,
  type UiTheme
} from 'gesso-core';

/**
 * A `PaintSurface` that writes SVG: the canvas's own painters, drawn to
 * a vector picture rather than to pixels, so an exported circuit is the
 * one on screen — every gate symbol, wire colour and label — at any size.
 *
 * Transforms are applied as points are added, as a canvas does, so one
 * path can hold shapes drawn under different transforms (`turned`, in
 * `Painters.ts`, rotates one gate in a batch of a thousand) and comes
 * out as one `<path>` in picture coordinates. A line's width and dash
 * are taken under the transform in force when it is stroked, also as a
 * canvas does. Text keeps its transform as an attribute, so a turned
 * display's digits turn with it.
 *
 * What a circuit is not drawn with — gradients, blur, images, clipping
 * — draws nothing here.
 */

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

interface State {
  matrix: Matrix;
  fill: string;
  stroke: string;
  width: number;
  cap: PaintLineCap;
  join: PaintLineJoin;
  miter: number;
  dash: readonly number[];
  dashOffset: number;
  alpha: number;
}

/** A number as short as it can be written without losing what a picture can show. */
function n(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class SvgSurface implements PaintSurface {
  private state: State = {
    matrix: IDENTITY,
    fill: '#000',
    stroke: '#000',
    width: 1,
    cap: 'butt',
    join: 'miter',
    miter: 10,
    dash: [],
    dashOffset: 0,
    alpha: 1
  };
  private readonly stack: State[] = [];
  private d: string[] = [];
  /** The current point, in picture coordinates; null when the path has none. */
  private at: { x: number; y: number } | null = null;
  private readonly body: string[] = [];

  constructor(private readonly theme: UiTheme) {}

  /** The picture: `width` × `height` pixels, of the area from (0, 0) to `viewWidth` × `viewHeight` as drawn. */
  svg(width: number, height: number, background: UiColorValue | null): string {
    const fill = background === null ? null : this.css(background);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">\n` +
      (fill === null ? '' : `<rect width="100%" height="100%" fill="${fill}"/>\n`) +
      `${this.body.join('\n')}\n</svg>\n`
    );
  }

  private css(color: UiColorValue): string {
    const colors = this.theme.colors as unknown as Readonly<Record<string, unknown>>;
    const resolved = typeof color === 'string' && Object.hasOwn(colors, color) ? (colors[color] as Parameters<typeof colorToCss>[0]) : normalizeColor(color);
    return resolved === undefined ? '#000' : colorToCss(resolved);
  }

  private point(x: number, y: number): { x: number; y: number } {
    const m = this.state.matrix;
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
  }

  /** How much the transform scales a length; the painters only ever scale evenly. */
  private get unit(): number {
    const m = this.state.matrix;
    return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  }

  save(): void {
    this.stack.push({ ...this.state });
  }

  restore(): void {
    this.state = this.stack.pop() ?? this.state;
  }

  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y);
  }

  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0);
  }

  rotate(angle: number): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.transform(c, s, -s, c, 0, 0);
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.state.matrix = multiply(this.state.matrix, [a, b, c, d, e, f]);
  }

  beginPath(): void {
    this.d = [];
    this.at = null;
  }

  moveTo(x: number, y: number): void {
    const p = this.point(x, y);
    this.d.push(`M${n(p.x)} ${n(p.y)}`);
    this.at = p;
  }

  lineTo(x: number, y: number): void {
    const p = this.point(x, y);
    this.d.push(`${this.at === null ? 'M' : 'L'}${n(p.x)} ${n(p.y)}`);
    this.at = p;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (this.at === null) this.moveTo(cx, cy);
    const c = this.point(cx, cy);
    const p = this.point(x, y);
    this.d.push(`Q${n(c.x)} ${n(c.y)} ${n(p.x)} ${n(p.y)}`);
    this.at = p;
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (this.at === null) this.moveTo(c1x, c1y);
    const a = this.point(c1x, c1y);
    const b = this.point(c2x, c2y);
    const p = this.point(x, y);
    this.d.push(`C${n(a.x)} ${n(a.y)} ${n(b.x)} ${n(b.y)} ${n(p.x)} ${n(p.y)}`);
    this.at = p;
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    // The sweep as a canvas takes it: clockwise from start to end, or
    // counterclockwise, a whole turn at most.
    let sweep = counterclockwise ? startAngle - endAngle : endAngle - startAngle;
    if (sweep >= Math.PI * 2) sweep = Math.PI * 2;
    else sweep = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const on = (angle: number) => this.point(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
    const start = on(startAngle);
    this.d.push(`${this.at === null ? 'M' : 'L'}${n(start.x)} ${n(start.y)}`);
    const r = radius * this.unit;
    const m = this.state.matrix;
    // A transform that mirrors turns clockwise into counterclockwise.
    const mirrored = m[0] * m[3] - m[1] * m[2] < 0;
    const sweepFlag = (counterclockwise ? 0 : 1) ^ (mirrored ? 1 : 0);
    const direction = counterclockwise ? -1 : 1;
    // In halves, so a whole circle — whose ends meet, which SVG draws as
    // nothing — is two arcs.
    const pieces = sweep > Math.PI ? 2 : 1;
    let end = start;
    for (let i = 1; i <= pieces; i++) {
      end = on(startAngle + (direction * sweep * i) / pieces);
      this.d.push(`A${n(r)} ${n(r)} 0 0 ${sweepFlag} ${n(end.x)} ${n(end.y)}`);
    }
    this.at = end;
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.moveTo(x, y);
    this.lineTo(x + width, y);
    this.lineTo(x + width, y + height);
    this.lineTo(x, y + height);
    this.closePath();
  }

  roundRect(x: number, y: number, width: number, height: number, radius: number): void {
    const r = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2));
    if (r === 0) {
      this.rect(x, y, width, height);
      return;
    }
    this.moveTo(x + r, y);
    this.lineTo(x + width - r, y);
    this.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    this.lineTo(x + width, y + height - r);
    this.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    this.lineTo(x + r, y + height);
    this.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    this.lineTo(x, y + r);
    this.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    this.closePath();
  }

  closePath(): void {
    if (this.d.length > 0) this.d.push('Z');
  }

  path(_d: string): void {
    // Not used by the circuit's painters.
  }

  fillColor(color: UiColorValue): void {
    this.state.fill = this.css(color);
  }

  fillGradient(): void {
    // Not used by the circuit's painters.
  }

  strokeColor(color: UiColorValue): void {
    this.state.stroke = this.css(color);
  }

  lineWidth(width: number): void {
    this.state.width = width;
  }

  lineCap(cap: PaintLineCap): void {
    this.state.cap = cap;
  }

  lineJoin(join: PaintLineJoin): void {
    this.state.join = join;
  }

  miterLimit(limit: number): void {
    this.state.miter = limit;
  }

  lineDash(segments: readonly number[], offset = 0): void {
    this.state.dash = [...segments];
    this.state.dashOffset = offset;
  }

  alpha(value: number): void {
    this.state.alpha *= value;
  }

  blur(): void {
    // Not used by the circuit's painters.
  }

  private opacity(): string {
    return this.state.alpha === 1 ? '' : ` opacity="${n(this.state.alpha)}"`;
  }

  fill(rule: PaintFillRule = 'nonzero'): void {
    if (this.d.length === 0) return;
    this.body.push(`<path d="${this.d.join('')}" fill="${this.state.fill}"${rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${this.opacity()}/>`);
  }

  stroke(): void {
    if (this.d.length === 0) return;
    const unit = this.unit;
    const s = this.state;
    const dash = s.dash.length === 0 ? '' : ` stroke-dasharray="${s.dash.map(v => n(v * unit)).join(' ')}"${s.dashOffset === 0 ? '' : ` stroke-dashoffset="${n(s.dashOffset * unit)}"`}`;
    this.body.push(
      `<path d="${this.d.join('')}" fill="none" stroke="${s.stroke}" stroke-width="${n(s.width * unit)}"` +
        `${s.cap === 'butt' ? '' : ` stroke-linecap="${s.cap}"`}${s.join === 'miter' ? '' : ` stroke-linejoin="${s.join}"`}${dash}${this.opacity()}/>`
    );
  }

  clip(): void {
    // Not used by the circuit's painters.
  }

  text(value: string, x: number, y: number, style: PaintTextStyle = {}): void {
    const m = this.state.matrix;
    const anchor = style.align === 'center' ? 'middle' : style.align === 'right' ? 'end' : 'start';
    const family = style.fontFamily === 'monospace' ? 'ui-monospace, Menlo, Consolas, monospace' : (style.fontFamily ?? 'system-ui, -apple-system, Segoe UI, sans-serif');
    this.body.push(
      `<text transform="matrix(${m.map(n).join(' ')})" x="${n(x)}" y="${n(y)}" font-size="${n(style.fontSize ?? 12)}" font-family="${escape(family)}"` +
        `${style.fontWeight === undefined ? '' : ` font-weight="${style.fontWeight}"`}${anchor === 'start' ? '' : ` text-anchor="${anchor}"`} fill="${this.state.fill}"${this.opacity()}>${escape(value)}</text>`
    );
  }

  image(): void {
    // Not used by the circuit's painters.
  }
}
