import { BehaviorSubject, combineLatest, distinctUntilChanged, map, type Observable } from 'rxjs';

import type { UiChild, UiKeyboardEvent, UiNode, UiTextChangeEvent, UiTextSpan, UiThemeColorName } from 'gesso-core';
import { Dialog, Select } from 'gesso-components';
import { createComponent, internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, NO_PROGRAM, type ProgramView } from '../app/CircuitContract';
import { highlight, type Token, type TokenKind } from '../cpu/Highlight';
import { action } from './controls';
import { MOD } from './Commands';
import { GAMES, PROGRAMS } from './Programs';

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
/** The field's text and the gutter's, top to bottom; the same for both, or the gutter drifts from the lines it names. */
const PADDING = 8;
const LINE_HEIGHT = 15;
const FIELD_HEIGHT = 420;
/** Wide enough for `270 1F`: a line number, and the address it assembled to. */
const GUTTER_WIDTH = 64;
/** The problems listed under the field; the first few are the ones to fix, and the rest often follow from them. */
const MAX_PROBLEMS = 6;

/** What the dialog can start from: the games, then the CPU's test programs, by file name. */
const EXAMPLES: readonly { readonly name: string; readonly source: string }[] = [...GAMES, ...PROGRAMS];

/** Something that would throw edits away, waiting for a yes. */
interface Pending {
  readonly question: string;
  readonly confirm: string;
  readonly then: () => void;
}

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

/** The last source highlighted, and its runs: the program counter moves far more often than the text does. */
let cached: { source: string; tokens: Token[] } = { source: '', tokens: [] };
function tokensOf(source: string): Token[] {
  if (cached.source !== source) cached = { source, tokens: highlight(source) };
  return cached.tokens;
}

/**
 * The gutter beside the source: a line number for each line of it, and,
 * when `lines` is given, the ROM address each line was assembled to. A
 * line that made no word has no address, and one that made several —
 * a `.byte` list — has its first.
 */
export function gutterOf(lineCount: number, lines: readonly number[] | null): string {
  const addressOf = new Map<number, number>();
  lines?.forEach((line, address) => {
    if (line > 0 && !addressOf.has(line)) addressOf.set(line, address);
  });
  const rows: string[] = [];
  for (let line = 1; line <= lineCount; line++) {
    const address = addressOf.get(line);
    rows.push(`${String(line).padStart(3)} ${address === undefined ? '  ' : address.toString(16).toUpperCase().padStart(2, '0')}`);
  }
  return rows.join('\n');
}

/** Behind the line the program counter is at. */
const PC_BACKGROUND: UiThemeColorName = 'selectionBackground';

/**
 * The source in coloured runs, with line `marked` (1-based; 0 for none)
 * given a background. Runs that cross into or out of that line are cut
 * at its edges, so only its own text is marked, not the newline.
 */
export function spansOf(source: string, marked: number): UiTextSpan[] {
  const tokens = tokensOf(source);
  let start = marked > 0 ? 0 : -1;
  for (let line = 1; line < marked && start >= 0; line++) {
    const newline = source.indexOf('\n', start);
    start = newline < 0 ? -1 : newline + 1;
  }
  if (start < 0) return tokens.map(t => ({ text: t.text, color: TOKEN_COLORS[t.kind] }));
  const newline = source.indexOf('\n', start);
  const end = newline < 0 ? source.length : newline;
  const spans: UiTextSpan[] = [];
  let at = 0;
  for (const t of tokens) {
    const color = TOKEN_COLORS[t.kind];
    const from = at;
    const to = at + t.text.length;
    at = to;
    // The pieces of this run before, inside and after the marked line.
    const cuts = [from, Math.min(Math.max(start, from), to), Math.min(Math.max(end, from), to), to];
    for (let i = 0; i < 3; i++) {
      if (cuts[i + 1]! <= cuts[i]!) continue;
      const text = t.text.slice(cuts[i]! - from, cuts[i + 1]! - from);
      spans.push(i === 1 ? { text, color, backgroundColor: PC_BACKGROUND } : { text, color });
    }
  }
  return spans;
}

export function programEditor(ctx: ComponentContext, onClosed: () => void): UiChild {
  const circuit = ctx.channel(Circuit);
  const program = circuit.view.program;
  /** What is in the field, and the program the ROM holds as the dialog knows it: the two differ while there are edits to load. */
  const text = internalState('');
  const loaded = internalState('');
  /** Asking whether to throw edits away: a close, or an example, while there are edits not loaded. */
  const pending = internalState<Pending | null>(null);
  /** The example picker's value, '' between picks, so the same example can be picked twice. */
  const example = internalState('');

  let view: ProgramView = NO_PROGRAM;
  ctx.effect(program, p => {
    const opened = p.id !== '' && p.id !== view.id;
    view = p;
    if (opened) {
      text.value = p.source;
      loaded.value = p.source;
      pending.value = null;
    } else if (p.id !== '' && p.problems.length === 0) {
      loaded.value = p.source;
    }
  });

  const load = () => {
    if (view.id !== '') circuit.send.setProgram(view.id, text.value);
  };
  /** Runs `then` at once, or once the person agrees to lose the edits not loaded. */
  const unlessEdited = (question: string, confirm: string, then: () => void) => {
    if (text.value === loaded.value) {
      pending.value = null;
      then();
    } else {
      pending.value = { question, confirm, then };
    }
  };
  const close = () =>
    unlessEdited("Close without loading your edits? They'll be lost.", 'Discard edits', () => {
      pending.value = null;
      circuit.send.openProgram('');
      onClosed();
    });
  const startFrom = (name: string) => {
    example.value = '';
    const chosen = EXAMPLES.find(e => e.name === name);
    if (chosen === undefined) return;
    unlessEdited(`Replace your edits with ${chosen.name}? They'll be lost.`, 'Replace', () => {
      pending.value = null;
      text.value = chosen.source;
    });
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
      const line = p.pc >= 0 ? (p.lines[p.pc] ?? 0) : 0;
      const at = p.pc < 0 ? '' : ` The program counter is at 0x${p.pc.toString(16).toUpperCase().padStart(2, '0')}${line > 0 ? `, line ${line}` : ''}.`;
      return { tone: 'textMuted', lines: [`${p.words} of ${ROM_WORDS} words, loaded.${at}${p.note === null ? '' : ` ${p.note}`}`] };
    }),
    distinctUntilChanged((a, b) => a.tone === b.tone && a.lines.join('\n') === b.lines.join('\n'))
  );

  /** The line the program counter is at, while the field holds the program the ROM runs; 0 otherwise. */
  const marked: Observable<number> = combineLatest([text, loaded, program]).pipe(
    map(([t, l, p]) => (t === l && p.pc >= 0 ? (p.lines[p.pc] ?? 0) : 0))
  );
  const spans = combineLatest([text, marked.pipe(distinctUntilChanged())]).pipe(
    distinctUntilChanged(([a, m], [b, n]) => a === b && m === n),
    map(([t, m]) => spansOf(t, m))
  );

  /** The field, for the gutter to scroll with. */
  const field = new BehaviorSubject<UiNode | null>(null);
  /** The gutter's rows, the program counter's in the accent colour. */
  const gutter = combineLatest([text, loaded, program, marked.pipe(distinctUntilChanged())]).pipe(
    map(([t, l, p, m]): UiTextSpan[] => {
      const rows = gutterOf(t.split('\n').length, t === l ? p.lines : null).split('\n');
      if (m <= 0 || m > rows.length) return [{ text: rows.join('\n'), color: 'textMuted' }];
      const before = rows.slice(0, m - 1).join('\n');
      const after = rows.slice(m).join('\n');
      return [
        { text: m > 1 ? `${before}\n` : '', color: 'textMuted' },
        { text: rows[m - 1]!, color: 'primary' },
        { text: m < rows.length ? `\n${after}` : '', color: 'textMuted' }
      ].filter(span => span.text !== '');
    })
  );

  const content = (
    <column gap={10} width={INNER}>
      <row gap={8} y="center" width={INNER}>
        <text text="Start from" fontSize={12} color="textMuted" textWrap="none" />
        {createComponent(Select, {
          compact: true,
          labelHidden: true,
          label: 'Start from an example program',
          placeholder: 'An example…',
          width: 260,
          value: example,
          options: EXAMPLES.map(e => ({ value: e.name, label: e.name })),
          onChange: startFrom
        })}
        <text
          text="It replaces what's here; Assemble & load puts it in the ROM."
          flex={1}
          minWidth={0}
          fontSize={11}
          color="textMuted"
          textWrap="none"
          textOverflow="ellipsis"
        />
      </row>
      {/* Not in a scroll view: an editable scrolls its own text to the
          caret, and one in a scroll view is brought into view by its top
          whenever it takes focus, so a click far down jumped back up. */}
      <row width={INNER} height={FIELD_HEIGHT} backgroundColor="background" borderColor="border" borderWidth={1} borderRadius={4} overflow="hidden">
        {/* Follows the field's vertical scroll in the same layout pass, so the two never disagree by a frame. */}
        <box
          overflow="hidden"
          width={GUTTER_WIDTH}
          height={FIELD_HEIGHT - 2}
          scrollWith={field}
          scrollWithAxis="y"
          backgroundColor="surface">
          {/* A pixel more below than the field has: it scrolls one past its text, for the caret. */}
          <column paddingTop={PADDING} paddingBottom={PADDING + 1} paddingX={PADDING}>
            <text spans={gutter} fontSize={12} fontFamily="monospace" lineHeight={LINE_HEIGHT} textWrap="none" selectable={false} />
          </column>
        </box>
        <editabletext
          ref={(node: UiNode | null) => field.next(node)}
          value={text as never}
          spans={spans}
          multiline={true}
          width={INNER - GUTTER_WIDTH - 2}
          height={FIELD_HEIGHT - 2}
          padding={PADDING}
          lineHeight={LINE_HEIGHT}
          fontSize={12}
          fontFamily="monospace"
          color="text"
          textWrap="none"
          role="textbox"
          label="Program source"
          onInput={(event: UiTextChangeEvent) => {
            text.value = event.value;
            pending.value = null;
          }}
          onKeyDown={(event: UiKeyboardEvent) => {
            if (event.key === 'Enter' && (event.modifiers.ctrl || event.modifiers.meta)) {
              load();
              event.preventDefault();
            }
          }}
        />
      </row>
      <column gap={2} width={INNER}>
        {report.pipe(
          map(r =>
            r.lines.map((line, i) => (
              <text key={`r${i}`} text={line} width={INNER} fontSize={12} fontWeight={i === 0 && r.tone === 'danger' ? 600 : 400} color={r.tone} textWrap="word" />
            ))
          )
        )}
      </column>
      {pending.pipe(
        map(asking =>
          asking !== null ? (
            <row key="confirm" gap={8} y="center" width={INNER}>
              <text text={asking.question} flex={1} minWidth={0} fontSize={12} color="text" textWrap="word" />
              {action('Keep editing', () => (pending.value = null))}
              {action(asking.confirm, asking.then, 'danger')}
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
