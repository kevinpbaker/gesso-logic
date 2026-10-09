import { distinctUntilChanged, map, type Observable } from 'rxjs';

import { percent, type UiChild } from 'gesso-core';
import { tooltip } from 'gesso-components';
import { createComponent, each, type ComponentContext, type Inputs } from 'gesso-framework';

import type { DocumentSummary, MyChipsView } from '../app/CircuitContract';
import type { CanvasHandle } from '../canvas/CircuitCanvas';
import type { Kind } from '../sim/Primitives';
import { HOVER, heading } from './controls';
import { PART_SECTIONS } from './Commands';

/**
 * The parts, down the left: every kind by what it is for, then the
 * standard library, the person's own chips, kept across documents, and
 * the chips this document has made.
 *
 * Each row names its part and the key that picks it up, and is lit
 * while that part is on the pointer, so the palette teaches the keys
 * rather than standing in for them. Its buttons are not tab stops, for
 * the reason `tool` gives: a click here and then a key press should do
 * what the key says, on the canvas.
 */
export const PALETTE_WIDTH = 188;

/** What a lesson of the course lets a person place: only these are shown while it is open. */
export interface PaletteLesson {
  readonly id: string;
  readonly title: string;
  readonly kinds: readonly Kind[];
  readonly chips: readonly string[];
}

/** Parts any lesson may use besides its own: to look at a signal, and to write on the canvas. */
const LESSON_EXTRAS: readonly Kind[] = ['probe', 'note'];

export function palette(
  ctx: ComponentContext,
  canvas: CanvasHandle,
  document: Observable<DocumentSummary>,
  myChips: Observable<MyChipsView>,
  lesson: Observable<PaletteLesson | null>
): UiChild {
  const placing = canvas.editorChanged.pipe(
    map(() => {
      const p = canvas.editor.placing;
      return p === null ? '' : p.chip === null ? `kind:${p.what}` : `chip:${p.chip}`;
    }),
    distinctUntilChanged()
  );
  const pick = (kind: Kind, chip?: string) => {
    canvas.editor.startPlacing(kind, false, chip);
    canvas.focus();
  };

  const row = (key: string, label: string, keys: string, tip: string, lit: string, onClick: () => void) =>
    createComponent(PaletteRow, { key, label, keys, tip, lit, placing, onClick });

  const section = (title: string, children: UiChild) => (
    <column gap={1} width={percent(100)}>
      <box paddingLeft={8} paddingTop={10} paddingBottom={3}>
        {heading(title.toUpperCase())}
      </box>
      {children}
    </column>
  );

  const parts: readonly (readonly [Kind, string, string, string])[] = PART_SECTIONS.flatMap(s => s.parts as readonly (readonly [Kind, string, string, string])[]);
  const partRow = (kind: Kind) => {
    const [, label, keys, tip] = parts.find(([k]) => k === kind)!;
    return row(kind, label, keys, `${tip} — press ${keys}`, `kind:${kind}`, () => pick(kind));
  };
  /**
   * A lesson's palette: the chips it builds on, which are what a person
   * should reach for first, then the parts it allows, and nothing else,
   * so the wrong part is never one click away.
   */
  const forLesson = (l: PaletteLesson) => (
    <column key={`lesson:${l.id}`} padding={6} paddingBottom={16} width={percent(100)}>
      <box paddingLeft={8} paddingRight={8} paddingTop={8}>
        <text text={`Only the parts for ${l.title} are shown. Close the course to see them all.`} fontSize={11} color="textMuted" textWrap="word" />
      </box>
      {l.chips.length === 0
        ? null
        : section(
            'Your chips',
            <column gap={1} width={percent(100)}>
              {l.chips.map(name => row(`lesson-chip:${name}`, name, '', `Your ${name}, from an earlier lesson`, `chip:${name}`, () => pick('chip', name)))}
            </column>
          )}
      {l.kinds.length === 0 ? null : section('Parts', <column gap={1} width={percent(100)}>{l.kinds.filter(k => parts.some(([kind]) => kind === k)).map(partRow)}</column>)}
      {section('Also', <column gap={1} width={percent(100)}>{LESSON_EXTRAS.map(partRow)}</column>)}
    </column>
  );

  /** Every part, as the palette is outside a lesson. */
  const everything = (
    <column key="all" padding={6} paddingBottom={16} width={percent(100)}>
      {PART_SECTIONS.map(s =>
        section(
          s.title,
          <column gap={1} width={percent(100)}>
            {s.parts.map(([kind, label, keys, tip]) => row(kind, label, keys, `${tip} — press ${keys}`, `kind:${kind}`, () => pick(kind)))}
          </column>
        )
      )}
      {section(
        'Library',
        <column gap={1} width={percent(100)}>
          {each(
            document.pipe(
              map(d => d.library.map(part => ({ name: part.name, note: part.note }))),
              distinctUntilChanged((a, b) => a.length === b.length && a.every((p, i) => p.name === b[i]!.name))
            ),
            'name',
            part => row(part.name, part.name, '', part.note, `chip:${part.name}`, () => pick('chip', part.name))
          )}
        </column>
      )}
      {section(
        'My chips',
        <column gap={1} width={percent(100)}>
          {each(
            myChips.pipe(
              map(v => (v.chips.length === 0 ? [{ name: '' }] : v.chips.map(chip => ({ name: chip.name })))),
              distinctUntilChanged((a, b) => a.length === b.length && a.every((p, i) => p.name === b[i]!.name))
            ),
            'name',
            chip =>
              chip.name === '' ? (
                <box paddingLeft={8} paddingRight={8} paddingTop={2}>
                  <text text="Select a chip and choose Add to My chips, to place it in any circuit." fontSize={11} color="textMuted" textWrap="word" />
                </box>
              ) : (
                row(`mine:${chip.name}`, chip.name, '', `Place your ${chip.name}: it comes into this circuit with the chips it is made of`, `chip:mine:${chip.name}`, () =>
                  pick('chip', `mine:${chip.name}`)
                )
              )
          )}
        </column>
      )}
      {section(
        'This circuit’s chips',
        <column gap={1} width={percent(100)}>
          {each(
            document.pipe(
              map(d => (d.chips.length === 0 ? [{ name: '' }] : d.chips.map(chip => ({ name: chip.name })))),
              distinctUntilChanged((a, b) => a.length === b.length && a.every((p, i) => p.name === b[i]!.name))
            ),
            'name',
            chip =>
              chip.name === '' ? (
                <box paddingLeft={8} paddingRight={8} paddingTop={2}>
                  <text text="None yet. Select some parts and press M to make one." fontSize={11} color="textMuted" textWrap="word" />
                </box>
              ) : (
                row(chip.name, chip.name, '', `Place a ${chip.name}; double-click one to look inside`, `chip:${chip.name}`, () =>
                  pick('chip', chip.name)
                )
              )
          )}
        </column>
      )}
    </column>
  );
  let currentLesson: PaletteLesson | null = null;
  ctx.effect(lesson, l => (currentLesson = l));

  return (
    <column width={PALETTE_WIDTH} height={percent(100)} backgroundColor="surface" flexShrink={0}>
      <scrollview flex={1} minHeight={0} width={percent(100)} overscrollBehavior="contain">
        {lesson.pipe(
          map(l => (l === null ? 'all' : `lesson:${l.id}`)),
          distinctUntilChanged(),
          map(() => {
            const l = currentLesson;
            return l === null ? [everything] : [forLesson(l)];
          })
        )}
      </scrollview>
    </column>
  );
}

interface PaletteRowProps {
  key: string;
  label: string;
  keys: string;
  tip: string;
  /** What `placing` says while this row's part is on the pointer. */
  lit: string;
  /** What is on the pointer; bound, so the row reads it as a cell. */
  placing: string;
  onClick: () => void;
}

/** One row. A component, so its tooltip is registered in a body of its own: see `Tool` in `controls.tsx`. */
function PaletteRow(inputs: Inputs<PaletteRowProps>, ctx: ComponentContext): UiChild {
  const label = inputs.label.value;
  const keys = inputs.keys.value;
  const tip = inputs.tip.value;
  const lit = inputs.lit.value;
  const on = inputs.placing.pipe(map(p => p === lit));
  return (
    <button
      focusable={false}
      label={label}
      // Read when clicked: each render of the palette hands over a new
      // function, and this row is not rebuilt for it.
      onClick={() => inputs.onClick.value()}
      modifiers={[HOVER, tooltip(ctx, { text: tip, placement: 'right' })]}
      width={percent(100)}
      paddingLeft={8}
      paddingRight={8}
      paddingTop={4}
      paddingBottom={4}
      borderRadius={5}
      borderWidth={1}
      borderColor={on.pipe(map(is => (is ? 'primary' : 'transparent')))}
      backgroundColor={on.pipe(map(is => (is ? 'selectionBackground' : 'surface')))}
      cursor="pointer">
      <row gap={6} y="center" width={percent(100)}>
        <text text={label} flex={1} minWidth={0} fontSize={12} color="text" textWrap="none" textOverflow="ellipsis" selectable={false} />
        {keys === '' ? null : (
          // A 10px line keeps its bottom ~3px for descenders that a key
          // never has, so the capitals sit high: a pixel more padding on
          // top evens the ink out. The minimum width makes the one-letter
          // keys one size, a column rather than a ragged edge.
          <box
            minWidth={18}
            x="center"
            y="center"
            paddingLeft={5}
            paddingRight={5}
            paddingTop={2}
            paddingBottom={1}
            borderRadius={3}
            borderWidth={1}
            borderColor="border">
            <text text={keys} fontSize={10} lineHeight={12} color="textMuted" textWrap="none" selectable={false} />
          </box>
        )}
      </row>
    </button>
  );
}
