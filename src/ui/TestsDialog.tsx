import { combineLatest, distinctUntilChanged, map, type Observable } from 'rxjs';

import type { UiChild, UiKeyboardEvent, UiTextChangeEvent } from 'gesso-core';
import { Dialog } from 'gesso-components';
import { internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, type TestsView } from '../app/CircuitContract';
import { action } from './controls';

/**
 * A level's tests: what it should do, as text beside it, run again
 * whenever the circuit or the tests change while this is open.
 *
 * The text is the document's — kept in the level, saved with the file,
 * undone with everything else — so what is typed goes to the service
 * once typing pauses, and whatever the document then says (an undo, a
 * fill, another level opened) comes back into the field.
 */

const WIDTH = 720;
const INNER = WIDTH - 40;
const FIELD_HEIGHT = 340;
/** How long typing pauses before the tests are taken into the document. */
const TYPING_MS = 400;

/** An example to start from, before anything is written. */
const EXAMPLE = [
  '# Name the switches, a |, then the LEDs or displays, by label (spaces as _) or id.',
  '# Each row sets the switches and checks the LEDs. x checks nothing;',
  '# - keeps a switch as it was. tick runs a clock cycle, tick 4 four.',
  '#',
  '#   a b | y',
  '#   0 0 | 0',
  '#   1 1 | 1',
  ''
].join('\n');

/** How a run went, in a line or a few: what passed, or the failures, or why it did not run. */
export function testSummary(view: TestsView): { tone: 'primary' | 'danger' | 'textMuted'; lines: string[] } {
  const result = view.results[0];
  if (view.serial === 0 || result === undefined) return { tone: 'textMuted', lines: ['Not run yet.'] };
  if (result.error !== null) return { tone: 'danger', lines: [`Can't run these tests: ${result.error}.`] };
  if (result.rows === 0) return { tone: 'textMuted', lines: ['No rows to check yet.'] };
  if (result.failed === 0) return { tone: 'primary', lines: [`✓ All ${result.rows} row${result.rows === 1 ? '' : 's'} pass.`] };
  const more = result.failed - result.failures.length;
  return {
    tone: 'danger',
    lines: [
      `✗ ${result.failed} of ${result.rows} row${result.rows === 1 ? '' : 's'} fail${result.failed === 1 ? 's' : ''}:`,
      ...result.failures.map(f => `Line ${f.line}: ${f.message}`),
      ...(more > 0 ? [`…and ${more} more.`] : [])
    ]
  };
}

/** Every level's run, as a notice: all passing, or where the failures are. */
export function allTestsSummary(view: TestsView): { text: string; error: boolean } {
  const ran = view.results;
  if (ran.length === 0) return { text: 'No level has tests yet. Simulate › Tests for this level… writes some.', error: false };
  const rows = ran.reduce((n, r) => n + r.rows, 0);
  const broken = ran.filter(r => r.error !== null || r.failed > 0);
  if (broken.length === 0) return { text: `✓ Every test passes: ${rows} row${rows === 1 ? '' : 's'} in ${ran.length} level${ran.length === 1 ? '' : 's'}.`, error: false };
  const names = broken.map(r => (r.error !== null ? `${r.level} (can't run)` : `${r.level} (${r.failed} of ${r.rows})`));
  return { text: `✗ Tests fail in ${names.join(', ')}. Open that level's tests to see which rows.`, error: true };
}

export function testsDialog(ctx: ComponentContext, open: Observable<boolean>, onClose: () => void): UiChild {
  const circuit = ctx.channel(Circuit);
  const document = circuit.view.document;
  const text = internalState('');
  /** What the field was last given to the document, or taken from it: a change to the document's text that is not this came from elsewhere. */
  let synced = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // The example is only an example: left as it is, there are no tests.
    const value = text.value === EXAMPLE ? '' : text.value;
    if (value !== synced) {
      synced = value;
      circuit.send.setTests(value);
    }
  };
  ctx.onUnmount(() => {
    if (timer !== null) clearTimeout(timer);
  });
  const confirming = internalState(false);

  let isOpen = false;
  ctx.effect(open.pipe(distinctUntilChanged()), now => {
    isOpen = now;
    if (now) {
      synced = document.value.tests;
      text.value = synced === '' ? EXAMPLE : synced;
      confirming.value = false;
      circuit.send.runTests(false, true);
    } else {
      flush();
      circuit.send.stopTests();
    }
  });
  ctx.effect(
    document.pipe(
      map(d => d.tests),
      distinctUntilChanged()
    ),
    tests => {
      if (!isOpen || tests === synced) return;
      // From elsewhere: an undo, a fill, another level opened.
      if (timer !== null) clearTimeout(timer);
      timer = null;
      synced = tests;
      text.value = tests === '' ? EXAMPLE : tests;
    }
  );

  const fill = () => {
    flush();
    confirming.value = false;
    circuit.send.fillTests();
  };
  const report = combineLatest([circuit.view.tested, document.pipe(map(d => d.tests.trim() === ''))]).pipe(
    map(([tested, none]) =>
      none
        ? { tone: 'textMuted' as const, lines: ['No tests yet: write some here, or fill them in from what the circuit does now.'] }
        : testSummary(tested)
    ),
    distinctUntilChanged((a, b) => a.tone === b.tone && a.lines.join('\n') === b.lines.join('\n'))
  );
  const level = document.pipe(map(d => d.path.at(-1)?.chip ?? 'the top level'));

  const content = (
    <column gap={10} width={INNER}>
      <text
        text={level.pipe(map(name => `What ${name} should do. Saved with the circuit, and run again after every change while this is open.`))}
        width={INNER}
        fontSize={12}
        color="textMuted"
        textWrap="word"
      />
      <editabletext
        value={text as never}
        multiline={true}
        width={INNER}
        height={FIELD_HEIGHT}
        padding={8}
        lineHeight={15}
        fontSize={12}
        fontFamily="monospace"
        color="text"
        textWrap="none"
        backgroundColor="background"
        borderColor="border"
        borderWidth={1}
        borderRadius={4}
        role="textbox"
        label="Tests"
        onInput={(event: UiTextChangeEvent) => {
          text.value = event.value;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(flush, TYPING_MS);
        }}
        onKeyDown={(event: UiKeyboardEvent) => {
          if (event.key === 'Enter' && (event.modifiers.ctrl || event.modifiers.meta)) {
            flush();
            circuit.send.runTests(false, true);
            event.preventDefault();
          }
        }}
      />
      <column gap={2} width={INNER}>
        {report.pipe(
          map(r =>
            r.lines.map((line, i) => (
              <text key={`r${i}`} text={line} width={INNER} fontSize={12} fontWeight={i === 0 ? 600 : 400} color={r.tone} textWrap="word" />
            ))
          )
        )}
      </column>
      {combineLatest([confirming, text]).pipe(
        map(([asking, t]) =>
          asking ? (
            <row key="confirm" gap={8} y="center" width={INNER}>
              <text text="Replace these tests with ones written from what it does now?" flex={1} minWidth={0} fontSize={12} color="text" textWrap="word" />
              {action('Keep them', () => (confirming.value = false))}
              {action('Replace', fill, 'danger')}
            </row>
          ) : (
            <row key="actions" gap={8} y="center" width={INNER}>
              {action('Fill in from what it does now', () => {
                if (t.trim() === '' || t === EXAMPLE) fill();
                else confirming.value = true;
              })}
              <box flex={1} />
              {action('Close', onClose)}
            </row>
          )
        )
      )}
    </column>
  );

  return (
    <Dialog open={open} onClose={onClose} title={level.pipe(map(name => `Tests · ${name}`))} width={WIDTH} content={content} />
  );
}
