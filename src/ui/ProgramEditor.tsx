import { combineLatest, distinctUntilChanged, map } from 'rxjs';

import type { UiChild, UiKeyboardEvent, UiTextChangeEvent, UiTextSpan, UiThemeColorName } from 'gesso-core';
import { Dialog } from 'gesso-components';
import { internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, type ProgramView } from '../app/CircuitContract';
import { highlight, type TokenKind } from '../cpu/Highlight';
import { action } from './controls';
import { MOD } from './Commands';

/**
 * The program editor: a ROM's source, to change and load.
 *
 * The service owns the answer. The dialog sends what was typed and shows
 * what came back: the problems, each with its line, or the program
 * loaded. What was typed stays until the dialog closes, so a program
 * that doesn't assemble can be fixed where it is.
 */

const WIDTH = 720;
const INNER = WIDTH - 40;
const ROM_WORDS = 256;
/** The problems listed under the field; the first few are the ones to fix, and the rest often follow from them. */
const MAX_PROBLEMS = 6;

/** Theme colours, so the source reads in light and dark alike. */
const TOKEN_COLORS: Readonly<Record<TokenKind, UiThemeColorName>> = {
  plain: 'text',
  comment: 'textMuted',
  mnemonic: 'primary',
  definition: 'secondary',
  directive: 'secondary',
  number: 'controlAccent',
  register: 'controlAccent'
};

function spansOf(source: string): UiTextSpan[] {
  return highlight(source).map(t => ({ text: t.text, color: TOKEN_COLORS[t.kind] }));
}

export function programEditor(ctx: ComponentContext, onClosed: () => void): UiChild {
  const circuit = ctx.channel(Circuit);
  const program = circuit.view.program;
  /** What is in the field, and the program the ROM holds as the dialog knows it: the two differ while there are edits to load. */
  const text = internalState('');
  const loaded = internalState('');
  /** Asking whether to throw edits away, after a close with edits not loaded. */
  const confirming = internalState(false);

  let view: ProgramView = { id: '', label: '', source: '', note: null, words: 0, problems: [], serial: 0 };
  ctx.effect(program, p => {
    const opened = p.id !== '' && p.id !== view.id;
    view = p;
    if (opened) {
      text.value = p.source;
      loaded.value = p.source;
      confirming.value = false;
    } else if (p.id !== '' && p.problems.length === 0) {
      loaded.value = p.source;
    }
  });

  const load = () => {
    if (view.id !== '') circuit.send.setProgram(view.id, text.value);
  };
  const close = (force = false) => {
    if (!force && text.value !== loaded.value) {
      confirming.value = true;
      return;
    }
    confirming.value = false;
    circuit.send.openProgram('');
    onClosed();
  };

  /** Under the field: what the ROM holds, what is waiting to be loaded, or what is wrong. */
  const report = combineLatest([program, text, loaded]).pipe(
    map(([p, t, l]): { tone: 'text' | 'textMuted' | 'danger'; lines: string[] } => {
      if (p.problems.length > 0 && t === p.source) {
        const count = p.problems.length;
        const shown = p.problems.slice(0, MAX_PROBLEMS).map(q => `Line ${q.line}: ${q.message}`);
        if (count > MAX_PROBLEMS) shown.push(`…and ${count - MAX_PROBLEMS} more.`);
        return { tone: 'danger', lines: [`${count} problem${count === 1 ? '' : 's'}, so nothing was loaded:`, ...shown] };
      }
      if (t !== l) return { tone: 'text', lines: [`Edited, not loaded yet. ${MOD}+Enter assembles and loads it, and restarts the computer.`] };
      return { tone: 'textMuted', lines: [`${p.words} of ${ROM_WORDS} words, loaded.${p.note === null ? '' : ` ${p.note}`}`] };
    }),
    distinctUntilChanged((a, b) => a.tone === b.tone && a.lines.join('\n') === b.lines.join('\n'))
  );

  const content = (
    <column gap={10} width={INNER}>
      {/* Not in a scroll view: an editable scrolls its own text to the
          caret, and one in a scroll view is brought into view by its top
          whenever it takes focus, so a click far down jumped back up. */}
      <editabletext
        value={text as never}
        spans={text.pipe(map(spansOf))}
        multiline={true}
        width={INNER}
        height={420}
        padding={8}
        backgroundColor="background"
        borderColor="border"
        borderWidth={1}
        borderRadius={4}
        fontSize={12}
        fontFamily="monospace"
        color="text"
        textWrap="none"
        role="textbox"
        label="Program source"
        onInput={(event: UiTextChangeEvent) => {
          text.value = event.value;
          confirming.value = false;
        }}
        onKeyDown={(event: UiKeyboardEvent) => {
          if (event.key === 'Enter' && (event.modifiers.ctrl || event.modifiers.meta)) {
            load();
            event.preventDefault();
          }
        }}
      />
      <column gap={2} width={INNER}>
        {report.pipe(
          map(r =>
            r.lines.map((line, i) => (
              <text key={`r${i}`} text={line} width={INNER} fontSize={12} fontWeight={i === 0 && r.tone === 'danger' ? 600 : 400} color={r.tone} textWrap="word" />
            ))
          )
        )}
      </column>
      {confirming.pipe(
        map(asking =>
          asking ? (
            <row key="confirm" gap={8} y="center" width={INNER}>
              <text text="Close without loading your edits? They'll be lost." flex={1} minWidth={0} fontSize={12} color="text" textWrap="word" />
              {action('Keep editing', () => (confirming.value = false))}
              {action('Discard edits', () => close(true), 'danger')}
            </row>
          ) : (
            <row key="actions" gap={8} x="end" width={INNER}>
              {action('Close', () => close())}
              {action('Assemble & load', load, 'accent')}
            </row>
          )
        )
      )}
    </column>
  );

  return (
    <Dialog
      open={program.pipe(
        map(p => p.id !== ''),
        distinctUntilChanged()
      )}
      onClose={() => close()}
      title={program.pipe(map(p => `Program · ${p.label}`))}
      width={WIDTH}
      content={content}
    />
  );
}
