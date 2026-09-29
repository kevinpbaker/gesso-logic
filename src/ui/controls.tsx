import { map, of, type Observable } from 'rxjs';

import { interactive, type UiChild, type UiKeyboardEvent, type UiModifier, type UiTextChangeEvent } from 'gesso-core';
import { Icon, tooltip } from 'gesso-components';
import { createComponent, type ComponentContext, type Inputs, type InternalState } from 'gesso-framework';

import type { Glyph } from './icons';

/**
 * The few controls every panel here is built from, so that a button
 * in the palette, the toolbar and a dialog answer the pointer the same
 * way and say what they do the same way.
 */

/** Hover and press, for anything a person can click. Shared, so every call site attaches the same modifier. */
export const HOVER: UiModifier = interactive({
  hover: true,
  press: true,
  hovered: { backgroundColor: 'controlBackgroundHovered' },
  pressed: { backgroundColor: 'controlBackgroundPressed' }
});

/** A glyph at the size and colour the toolbar draws them. One colour always: see gessosheet's `Toolbar.tsx`. */
export function glyph(icon: Glyph, size = 16): UiChild {
  return createComponent(Icon, {
    path: icon.path,
    viewBox: icon.viewBox,
    size,
    color: 'controlForeground',
    style: icon.style,
    strokeWidth: icon.strokeWidth ?? 1.5
  });
}

export interface ToolOptions {
  /** What a screen reader calls it, and the first line of its tooltip. */
  readonly label: string | Observable<string>;
  /** The tooltip, when it has more to say than the label: the shortcut, most often. */
  readonly tip?: string | (() => string);
  readonly icon?: Glyph | Observable<Glyph>;
  /** Words drawn beside the icon, or instead of one. */
  readonly text?: string | Observable<string>;
  readonly onRun: () => void;
  readonly enabled?: Observable<boolean>;
  /** Drawn lit: a panel that is open, a part on the pointer. */
  readonly on?: Observable<boolean>;
  readonly key?: string;
}

/**
 * A toolbar button: an icon, words, or both, with a tooltip under it.
 *
 * Not a tab stop. The canvas keeps the keyboard, so a click here and
 * then a key press does what the key says rather than pressing this
 * again; every one of these commands is also in the menu bar, which is
 * the keyboard's way to them.
 */
export function tool(options: ToolOptions, placement: 'bottom' | 'right' | 'top' = 'bottom'): UiChild {
  return createComponent(Tool, { options, placement });
}

/**
 * A component of its own, rather than a function called by its parent,
 * because `tooltip()` registers an overlay entry and its cleanup on the
 * context it is given, and that has to happen while a component body
 * runs. A button made inside a reactive list — a breadcrumb, a
 * palette section — is made after its parent's body has returned.
 */
function Tool(inputs: Inputs<{ options: ToolOptions; placement: 'bottom' | 'right' | 'top' }>, ctx: ComponentContext): UiChild {
  const options = inputs.options.value;
  const placement = inputs.placement.value;
  const enabled = options.enabled ?? of(true);
  const on = options.on ?? of(false);
  const label = typeof options.label === 'string' ? of(options.label) : options.label;
  let current = '';
  label.subscribe(text => (current = text));
  const tip = options.tip ?? (() => current);
  const icon = options.icon === undefined ? null : 'path' in options.icon ? of(options.icon) : options.icon;
  return (
    <button
      key={options.key}
      focusable={false}
      label={label}
      onClick={() => {
        if (enabledNow(enabled)) options.onRun();
      }}
      modifiers={[HOVER, tooltip(ctx, { text: tip, placement })]}
      paddingLeft={options.text === undefined ? 6 : 8}
      paddingRight={options.text === undefined ? 6 : 10}
      paddingTop={5}
      paddingBottom={5}
      borderRadius={6}
      backgroundColor={on.pipe(map(is => (is ? 'selectionBackground' : 'controlBackground')))}
      borderColor={on.pipe(map(is => (is ? 'primary' : 'transparent')))}
      borderWidth={1}
      cursor={enabled.pipe(map(is => (is ? 'pointer' : 'default')))}
      opacity={enabled.pipe(map(is => (is ? 1 : 0.4)))}>
      <row gap={6} y="center">
        {icon === null ? null : icon.pipe(map(g => glyph(g)))}
        {options.text === undefined ? null : (
          <text text={options.text} fontSize={12} color="controlForeground" textWrap="none" selectable={false} />
        )}
      </row>
    </button>
  );
}

function enabledNow(enabled: Observable<boolean>): boolean {
  let value = true;
  enabled.subscribe(v => (value = v)).unsubscribe();
  return value;
}

/** A thin vertical rule between groups of toolbar buttons. */
export function rule(): UiChild {
  return <box width={1} height={20} marginLeft={4} marginRight={4} backgroundColor="border" />;
}

/**
 * A button for a dialog or a panel: a tab stop, with words. `tone`
 * `accent` is the one to press, `danger` the one that loses something.
 */
export function action(label: string, onClick: () => void, tone: 'neutral' | 'accent' | 'danger' = 'neutral'): UiChild {
  const filled = tone !== 'neutral';
  return (
    <button
      label={label}
      onClick={onClick}
      modifiers={filled ? [] : [HOVER]}
      paddingLeft={12}
      paddingRight={12}
      paddingTop={6}
      paddingBottom={6}
      borderRadius={6}
      backgroundColor={tone === 'accent' ? 'primary' : tone === 'danger' ? 'danger' : 'controlBackground'}
      borderColor={filled ? 'transparent' : 'controlBorder'}
      borderWidth={1}
      cursor="pointer">
      <text text={label} fontSize={12} fontWeight={filled ? 600 : 400} color={filled ? 'background' : 'controlForeground'} selectable={false} />
    </button>
  );
}

/** A small button that sits inside a panel's row. */
export function small(label: string | Observable<string>, onClick: () => void, key?: string): UiChild {
  return (
    <button
      key={key}
      label={label}
      onClick={onClick}
      modifiers={[HOVER]}
      paddingLeft={8}
      paddingRight={8}
      paddingTop={4}
      paddingBottom={4}
      borderRadius={5}
      backgroundColor="controlBackground"
      borderColor="controlBorder"
      borderWidth={1}
      cursor="pointer">
      <text text={label} fontSize={11} color="controlForeground" textWrap="none" selectable={false} />
    </button>
  );
}

/** A one-line field that applies itself on Enter. */
export function field(key: string, label: string, text: InternalState<string>, width: number, apply: () => void): UiChild {
  return (
    <editabletext
      key={key}
      value={text as never}
      width={width}
      fontSize={12}
      color="text"
      textWrap="none"
      backgroundColor="background"
      borderColor="border"
      borderWidth={1}
      borderRadius={4}
      padding={4}
      role="textbox"
      label={label}
      onInput={(event: UiTextChangeEvent) => (text.value = event.value)}
      onKeyDown={(event: UiKeyboardEvent) => {
        if (event.key === 'Enter') {
          apply();
          event.preventDefault();
        }
      }}
    />
  );
}

/** A panel's small heading. */
export function heading(text: string | Observable<string>): UiChild {
  return <text text={text} fontSize={11} fontWeight={600} color="textMuted" selectable={false} />;
}
