import { combineLatest, map, type Observable } from 'rxjs';

import type { UiChild, UiKeyboardEvent, UiTextChangeEvent } from 'gesso-core';
import { Dialog } from 'gesso-components';
import { each, type InternalState, type ShellRecentFile } from 'gesso-framework';

import type { VersionsView } from '../app/CircuitContract';
import { INSTRUCTION_GROUPS, written } from '../cpu/Isa';
import { action, field, heading, small } from './controls';
import { MOD, parseRate, shortcutSections } from './Commands';

/**
 * The dialogs. Every one carries a button, and not for decoration: a
 * dialog traps focus as it opens and, with nothing focusable inside,
 * hands the keyboard to nothing, so Escape reaches nobody. gessosheet
 * found that in a browser; its `Shortcuts.tsx` has the story.
 */

/**
 * The width inside a dialog of this width. `Dialog` pads its box by 20
 * on each side and does not hand its width down to percentages, so
 * wrapped text inside one is given its width in pixels, or it runs out
 * past the edge on one line.
 */
const inner = (dialogWidth: number) => dialogWidth - 40;
const STEPS_WIDTH = inner(520);

/** A change about to be thrown away: what will replace it, and what to do if the person agrees. */
export interface Discard {
  readonly what: string;
  readonly then: () => void;
}

/**
 * Asks before a document with unsaved changes is replaced.
 *
 * Opening a file or an example forgets the undo history as well as the
 * document, and the autosave follows it a moment later, so without
 * this one misclick lost work that nothing could bring back.
 */
export function confirmDiscard(pending: Observable<Discard | null>, close: () => void, save: () => void): UiChild {
  return (
    <Dialog
      open={pending.pipe(map(p => p !== null))}
      onClose={close}
      title="Discard your changes?"
      width={420}
      content={
        <column gap={14} width={inner(420)}>
          <text
            width={inner(420)}
            text={pending.pipe(
              map(p =>
                p === null
                  ? ''
                  : `This circuit has changes that are not saved. ${p.what} replaces it, and Undo cannot bring it back; File › Restore an earlier version can.`
              )
            )}
            fontSize={12}
            color="text"
            textWrap="word"
          />
          <row gap={8} x="end" width={inner(420)}>
            {action('Cancel', close)}
            {action('Save first…', () => {
              close();
              save();
            })}
            {action('Discard changes', () => {
              let then: (() => void) | null = null;
              pending.subscribe(p => (then = p?.then ?? null)).unsubscribe();
              close();
              (then as (() => void) | null)?.();
            }, 'danger')}
          </row>
        </column>
      }
    />
  );
}

/** The shortcut sheet, generated from `Commands.ts`. */
export function shortcuts(open: Observable<boolean>, close: () => void): UiChild {
  const line = (label: string, keys: string) => (
    <row gap={24} y="center" paddingTop={2} paddingBottom={2}>
      <text text={label} flex={1} minWidth={0} fontSize={12} color="text" selectable={false} />
      <text text={keys} flexShrink={0} textWrap="none" fontSize={11} fontWeight={600} color="textMuted" selectable={false} />
    </row>
  );
  const sections = shortcutSections();
  // Two columns, so the sheet fits a laptop screen without scrolling.
  const half = Math.ceil(sections.length / 2);
  const column = (list: typeof sections) => (
    <column flex={1} minWidth={0} gap={2}>
      {list.map(section => (
        <column gap={0} marginBottom={10}>
          {heading(section.title)}
          {section.lines.map(([label, keys]) => line(label, keys))}
        </column>
      ))}
    </column>
  );
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Keyboard shortcuts"
      width={760}
      content={
        <column gap={10} minWidth={0}>
          <scrollview maxHeight={520} minWidth={0}>
            <row gap={28} minWidth={0}>
              {column(sections.slice(0, half))}
              {column(sections.slice(half))}
            </row>
          </scrollview>
          <row x="end" width={inner(380)}>{action('Close', close, 'accent')}</row>
        </column>
      }
    />
  );
}

const ISA_WIDTH = inner(900);

/**
 * Every instruction the CPU runs, generated from `Isa.ts`, the table
 * the emulator executes and the assembler encodes, so it says what the
 * machine does and not what someone remembered it doing.
 */
export function instructionSet(open: Observable<boolean>, close: () => void): UiChild {
  // Inside the scroll view, a little narrower, so its bar never covers the effect column.
  const width = ISA_WIDTH - 16;
  const para = (text: string) => <text text={text} width={width} fontSize={12} color="textMuted" textWrap="word" />;
  // The header row is in the interface's face, and the instructions in the editor's.
  const EFFECT = 210;
  const line = (form: string, opcode: string, flags: string, effect: string, about: string, header = false) => {
    const cell = (text: string, w: number, color: 'text' | 'textMuted', weight = 400) =>
      header ? (
        <text text={text} width={w} flexShrink={0} fontSize={11} color="textMuted" textWrap="none" selectable={false} />
      ) : (
        <text text={text} width={w} flexShrink={0} fontSize={12} fontFamily="monospace" fontWeight={weight} color={color} textWrap="none" />
      );
    return (
      <row gap={12} y="start" paddingTop={2} paddingBottom={2} width={width}>
        {cell(form, 96, 'text', 600)}
        {cell(opcode, 28, 'textMuted')}
        {cell(flags, 48, 'text')}
        <text text={effect} width={EFFECT} flexShrink={0} fontSize={header ? 11 : 12} color={header ? 'textMuted' : 'text'} textWrap="word" />
        <text text={about} width={width - 96 - 28 - 48 - EFFECT - 48} fontSize={header ? 11 : 12} color="textMuted" textWrap="word" />
      </row>
    );
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="The CPU’s instruction set"
      width={900}
      content={
        <column gap={10} width={ISA_WIDTH}>
          <scrollview height={520} width={ISA_WIDTH} overscrollBehavior="contain">
            <column gap={10} width={width}>
              {para(
                'Registers: A, the accumulator; B, the ALU’s second operand; X, the index; L, where RET returns to; and the flags Z (zero), C (carry) and N (negative). Every instruction is one ROM word and takes two clock cycles.'
              )}
              {para(
                'Operands: #k is the byte k itself; a is the data byte at address a; a,X is the byte at a + X; t is a label in the ROM; p is a port, 0–3; t,X is the low byte of the ROM word at t + X. In the flags column, * sets the flag from the result and - leaves it alone.'
              )}
              {INSTRUCTION_GROUPS.map(group => (
                <column gap={0} width={width}>
                  {heading(group.title)}
                  {line('Instruction', 'Op', 'Z C N', 'Effect', 'In words', true)}
                  {group.instructions.map(i =>
                    line(written(i), i.opcode.toString(16).toUpperCase().padStart(2, '0'), `${i.z} ${i.c} ${i.n}`, i.effect, i.about)
                  )}
                </column>
              ))}
              {para('RAM is 0x00–0x3F, the 32 × 16 framebuffer 0x40–0x7F. Port 0 reads the buttons and shows the left score; port 1 reads the frame tick and shows the right score.')}
            </column>
          </scrollview>
          <row x="end" width={ISA_WIDTH}>{action('Close', close, 'accent')}</row>
        </column>
      }
    />
  );
}

/** Five steps from an empty canvas to a circuit that does something. */
export function gettingStarted(open: Observable<boolean>, close: () => void, openExample: () => void): UiChild {
  const steps: readonly (readonly [string, string])[] = [
    ['Place parts', 'Click one in the palette on the left, or press its key — A for AND, I for a switch, L for an LED — then click the canvas to drop it.'],
    ['Wire them', 'Drag from a pin to another pin. A bus is drawn the same way, and is as wide as the pins it joins.'],
    ['Run it', `Press Run in the toolbar or ${MOD}+Enter. Click a switch to select it, and click it again to flip it.`],
    ['Make chips', 'Select some parts and press M: they become one chip you can place again from the palette. Double-click a chip to look inside.'],
    ['Watch it', 'Probes and LEDs show up in the logic analyser (W). T shows the truth table of whatever is selected.']
  ];
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Getting started"
      width={520}
      content={
        <column gap={12} width={STEPS_WIDTH}>
          {steps.map(([title, body], i) => (
            <row gap={10} y="start" width={STEPS_WIDTH}>
              <box width={22} height={22} borderRadius={11} backgroundColor="primary" x="center" y="center" flexShrink={0}>
                <text text={String(i + 1)} fontSize={11} fontWeight={700} color="background" selectable={false} />
              </box>
              <column gap={2} width={STEPS_WIDTH - 32}>
                <text text={title} fontSize={13} fontWeight={600} color="text" />
                <text text={body} width={STEPS_WIDTH - 32} fontSize={12} color="textMuted" textWrap="word" />
              </column>
            </row>
          ))}
          <text text="Press ? at any time for every shortcut." width={STEPS_WIDTH} fontSize={12} color="textMuted" />
          <row gap={8} x="end" width={STEPS_WIDTH}>
            {action('Open an example', () => {
              close();
              openExample();
            })}
            {action('Start building', close, 'accent')}
          </row>
        </column>
      }
    />
  );
}

/** The files the shell remembers, to open one again. */
export function recentFiles(
  open: Observable<boolean>,
  recent: Observable<readonly ShellRecentFile[]>,
  choose: (handle: number) => void,
  close: () => void
): UiChild {
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Open recent"
      width={380}
      content={
        <column gap={10} width={inner(380)}>
          <column gap={4} width={inner(380)}>
            {each(
              recent.pipe(map(list => (list.length === 0 ? [{ handle: -1, name: '', used: 0 }] : list.slice(0, 12)))),
              'handle',
              file =>
                file.handle < 0 ? (
                  <text text="No recent files yet. Files you open or save appear here." width={inner(380)} fontSize={12} color="textMuted" textWrap="word" />
                ) : (
                  <row>{small(file.name, () => choose(file.handle))}</row>
                )
            )}
          </column>
          <row x="end" width={inner(380)}>{action('Close', close)}</row>
        </column>
      }
    />
  );
}

/**
 * Paste from a menu cannot paste: the render worker has no clipboard
 * to read, and a browser hands it only to the keyboard shortcut. A
 * menu item that silently did nothing would be worse than this.
 */
export function pasteHint(open: Observable<boolean>, close: () => void): UiChild {
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Paste with the keyboard"
      width={380}
      content={
        <column gap={12} width={inner(380)}>
          <text
            width={inner(380)}
            text={`Your browser only hands the clipboard to the keyboard shortcut. Point where the parts should go and press ${MOD}+V.`}
            fontSize={12}
            color="text"
            textWrap="word"
          />
          <row x="end" width={inner(380)}>{action('Close', close, 'accent')}</row>
        </column>
      }
    />
  );
}

/**
 * A clock rate typed rather than picked, for the rate between two
 * presets — a program written for 440 Hz, or a game that plays best at
 * 12 kHz. What it reads is `parseRate`'s; a rate it cannot read keeps
 * the dialog open and says what it takes.
 */
export function clockRate(open: Observable<boolean>, text: InternalState<string>, apply: (rate: number | 'max') => void, close: () => void): UiChild {
  const problem = map((t: string) => (t.trim() === '' || parseRate(t) !== null ? '' : 'Type a rate above zero, such as 440, 2.5 Hz, 15 kHz or 1.2 MHz.'));
  const set = () => {
    const rate = parseRate(text.value);
    if (rate !== null) apply(rate);
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Clock rate"
      width={380}
      content={
        <column gap={10} width={inner(380)}>
          <text
            width={inner(380)}
            text="How many clock cycles a second: a number in Hz, or with kHz or MHz after it. The simulator runs as close to it as it can."
            fontSize={12}
            color="text"
            textWrap="word"
          />
          {field('rate', 'Clock rate', text, inner(380), set)}
          <text width={inner(380)} text={text.pipe(problem)} fontSize={11} color="danger" textWrap="word" />
          <row gap={8} x="end" width={inner(380)}>
            {action('Cancel', close)}
            {action('Set the clock', set, 'accent')}
          </row>
        </column>
      }
    />
  );
}

/**
 * A part renamed from its right-click menu: the same edit as the
 * inspector's Label field, for when the inspector is out of mind. Blank
 * text takes the name away, and the part goes by its id.
 */
export function renamePart(open: Observable<boolean>, text: InternalState<string>, what: Observable<string>, apply: () => void, close: () => void): UiChild {
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Rename"
      width={380}
      content={
        <column gap={10} width={inner(380)}>
          <text width={inner(380)} text={what} fontSize={12} color="text" textWrap="word" />
          {field('label', 'New name', text, inner(380), apply)}
          <row gap={8} x="end" width={inner(380)}>
            {action('Cancel', close)}
            {action('Rename', apply, 'accent')}
          </row>
        </column>
      }
    />
  );
}

/** A line in Find's list: a command, or a part somewhere in the circuit. */
export interface FindItem {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
}

/**
 * Find: a part at any depth by its name, or a command by its label, in
 * one list. Typing narrows it; the arrows walk it and Enter chooses, or
 * a click does. The list is the caller's, rebuilt as the text changes.
 */
export function findDialog(
  open: Observable<boolean>,
  text: InternalState<string>,
  items: Observable<readonly FindItem[]>,
  active: InternalState<number>,
  choose: (index: number) => void,
  close: () => void
): UiChild {
  const WIDTH = 460;
  let count = 0;
  const rows = combineLatest([items, active]).pipe(
    map(([list, at]) => {
      count = list.length;
      if (list.length === 0) {
        return [<text key="none" text={text.value.trim() === '' ? 'Type a part’s name, or a command.' : 'Nothing by that name.'} fontSize={12} color="textMuted" />];
      }
      return list.map((item, i) => (
        <button
          key={item.key}
          label={item.title}
          onClick={() => choose(i)}
          width={inner(WIDTH)}
          paddingLeft={8}
          paddingRight={8}
          paddingTop={5}
          paddingBottom={5}
          borderRadius={5}
          backgroundColor={i === at ? 'selectionBackground' : 'surface'}
          cursor="pointer">
          <row gap={8} y="center" width={inner(WIDTH) - 16}>
            <text text={item.title} fontSize={13} fontWeight={600} color="text" textWrap="none" textOverflow="ellipsis" minWidth={0} />
            <text text={item.detail} flex={1} minWidth={0} fontSize={11} color="textMuted" textWrap="none" textOverflow="ellipsis" textAlign="end" />
          </row>
        </button>
      ));
    })
  );
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Find"
      width={WIDTH}
      content={
        <column gap={8} width={inner(WIDTH)}>
          <editabletext
            value={text as never}
            width={inner(WIDTH)}
            fontSize={13}
            color="text"
            textWrap="none"
            backgroundColor="background"
            borderColor="border"
            borderWidth={1}
            borderRadius={4}
            padding={6}
            role="textbox"
            label="Find a part or a command"
            onInput={(event: UiTextChangeEvent) => (text.value = event.value)}
            onKeyDown={(event: UiKeyboardEvent) => {
              if (event.key === 'ArrowDown') active.value = Math.min(count - 1, active.value + 1);
              else if (event.key === 'ArrowUp') active.value = Math.max(0, active.value - 1);
              else if (event.key === 'Enter') choose(active.value);
              else return;
              event.preventDefault();
            }}
          />
          <scrollview maxHeight={340} overscrollBehavior="contain">
            <column gap={1} width={inner(WIDTH)}>
              {rows}
            </column>
          </scrollview>
        </column>
      }
    />
  );
}

/**
 * A link that opens the circuit, already copied: what it is, that
 * nothing was uploaded, and a warning where it is long enough for a
 * chat app to cut it.
 */
export function shareLink(open: Observable<boolean>, link: Observable<string>, copy: () => void, close: () => void): UiChild {
  const WIDTH = 460;
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Share a link"
      width={WIDTH}
      content={
        <column gap={10} width={inner(WIDTH)}>
          <text
            width={inner(WIDTH)}
            text="The link is copied. Anyone who opens it gets their own copy of this circuit, with what you traced in the analyser. Nothing was uploaded: the circuit is in the link itself."
            fontSize={12}
            color="text"
            textWrap="word"
          />
          <text
            width={inner(WIDTH)}
            text={link}
            fontSize={11}
            fontFamily="monospace"
            color="textMuted"
            textWrap="none"
            textOverflow="ellipsis"
            selectable
          />
          <text
            width={inner(WIDTH)}
            text={link.pipe(
              map(l =>
                l.length > LONG_LINK
                  ? `It is ${l.length.toLocaleString('en')} characters long, and some chat and email apps cut links that long. If it does not open, save the circuit and send the file instead.`
                  : `${l.length.toLocaleString('en')} characters.`
              )
            )}
            fontSize={11}
            color={link.pipe(map(l => (l.length > LONG_LINK ? 'danger' : 'textMuted')))}
            textWrap="word"
          />
          <row gap={8} x="end" width={inner(WIDTH)}>
            {action('Copy again', copy)}
            {action('Done', close, 'accent')}
          </row>
        </column>
      }
    />
  );
}

/** Past this many characters a link may be cut by a chat or email app. */
const LONG_LINK = 8_000;

const VERSION_REASONS: Readonly<Record<VersionsView['entries'][number]['reason'], string>> = {
  opened: 'Before your changes',
  editing: 'While you were editing',
  replaced: 'Before another circuit was opened',
  restored: 'Before an earlier version was restored'
};

/** When a version was kept, as a person says it: today's by the time, this year's by the day. */
export function versionTime(at: number, now = Date.now()): string {
  const when = new Date(at);
  const today = new Date(now);
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(when.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const day = when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(when.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
  return `${day} ${time}`;
}

/**
 * The earlier versions kept of the document, newest first, each with a
 * Restore. Restoring keeps what is open first, so it is undone the same
 * way, and nothing here asks before it acts.
 */
export function versionHistory(open: Observable<boolean>, versions: Observable<VersionsView>, restore: (id: number) => void, close: () => void): UiChild {
  const WIDTH = 520;
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Restore an earlier version"
      width={WIDTH}
      content={
        <column gap={10} width={inner(WIDTH)}>
          <text
            text="Copies of the circuit kept in this browser: before your first change, every few minutes while you edit, and before it is replaced. Restoring one keeps what is open now in this list too."
            width={inner(WIDTH)}
            fontSize={12}
            color="textMuted"
            textWrap="word"
          />
          <scrollview maxHeight={360} overscrollBehavior="contain">
            <column gap={2} width={inner(WIDTH)}>
              {each(
                versions.pipe(map(v => (v.entries.length === 0 ? [{ id: -1, at: 0, reason: 'opened' as const, name: null, parts: 0 }] : v.entries))),
                'id',
                entry =>
                  entry.id < 0 ? (
                    <text text="Nothing kept yet. A copy is kept before your first change to a circuit." width={inner(WIDTH)} fontSize={12} color="textMuted" textWrap="word" />
                  ) : (
                    <row gap={10} y="center" width={inner(WIDTH)} paddingTop={4} paddingBottom={4}>
                      <column gap={1} flex={1} minWidth={0}>
                        <text
                          text={`${versionTime(entry.at)} · ${entry.name ?? 'Untitled circuit'}`}
                          fontSize={12}
                          fontWeight={600}
                          color="text"
                          textWrap="none"
                          textOverflow="ellipsis"
                        />
                        <text
                          text={`${VERSION_REASONS[entry.reason]} · ${entry.parts} part${entry.parts === 1 ? '' : 's'}`}
                          fontSize={11}
                          color="textMuted"
                          textWrap="none"
                          textOverflow="ellipsis"
                        />
                      </column>
                      {small('Restore', () => restore(entry.id))}
                    </row>
                  )
              )}
            </column>
          </scrollview>
          <row x="end" width={inner(WIDTH)}>{action('Close', close)}</row>
        </column>
      }
    />
  );
}
