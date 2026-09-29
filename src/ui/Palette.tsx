import { distinctUntilChanged, map, type Observable } from 'rxjs';

import { percent, type UiChild } from 'gesso-core';
import { tooltip } from 'gesso-components';
import { createComponent, each, type ComponentContext, type Inputs } from 'gesso-framework';

import type { DocumentSummary } from '../app/CircuitContract';
import type { CanvasHandle } from '../canvas/CircuitCanvas';
import type { Kind } from '../sim/Primitives';
import { HOVER, heading } from './controls';
import { PART_SECTIONS } from './Commands';

/**
 * The parts, down the left: every kind by what it is for, then the
 * standard library, then the chips this document has made.
 *
 * Each row names its part and the key that picks it up, and is lit
 * while that part is on the pointer, so the palette teaches the keys
 * rather than standing in for them. Its buttons are not tab stops, for
 * the reason `tool` gives: a click here and then a key press should do
 * what the key says, on the canvas.
 */
export const PALETTE_WIDTH = 188;

export function palette(ctx: ComponentContext, canvas: CanvasHandle, document: Observable<DocumentSummary>): UiChild {
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

  return (
    <column width={PALETTE_WIDTH} height={percent(100)} backgroundColor="surface" flexShrink={0}>
      <scrollview flex={1} minHeight={0} width={percent(100)} overscrollBehavior="contain">
        <column padding={6} paddingBottom={16} width={percent(100)}>
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
  const onClick = inputs.onClick.value;
  const on = inputs.placing.pipe(map(p => p === lit));
  return (
    <button
      focusable={false}
      label={label}
      onClick={() => onClick()}
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
          <box paddingLeft={5} paddingRight={5} paddingTop={1} paddingBottom={1} borderRadius={3} borderWidth={1} borderColor="border">
            <text text={keys} fontSize={10} color="textMuted" textWrap="none" selectable={false} />
          </box>
        )}
      </row>
    </button>
  );
}
