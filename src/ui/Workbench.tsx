import { combineLatest, distinctUntilChanged, filter, map, take } from 'rxjs';

import { percent, type UiNode } from 'gesso-core';
import { MenuBar, Select } from 'gesso-components';
import { createComponent, FocusService, internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, type ClockRate, type SceneName } from '../app/CircuitContract';
import { circuitCanvas, type CanvasKeys } from '../canvas/CircuitCanvas';
import { fileActions, type FileActions } from '../canvas/Files';
import { waveformPanel } from '../canvas/Waveform';
import { action, heading, rule, small, tool } from './controls';
import { commandKeys, commandLabel, EXAMPLES, MENUS, rateLabel, rateOf, RATES, type CommandId } from './Commands';
import { confirmDiscard, gettingStarted, pasteHint, recentFiles, shortcuts, type Discard } from './Dialogs';
import { ICONS } from './icons';
import { inspector } from './Inspector';
import { palette } from './Palette';
import { GAMES, PROGRAMS } from './Programs';
import { ringingParts } from './Problems';

/**
 * The simulator as a person uses it.
 *
 *   ┌ menu bar ──────────────────────────────────── file name ┐
 *   ├ toolbar ────────────────────────────────────────────────┤
 *   │ palette │ canvas                        inspector,      │
 *   │         │   breadcrumb, while in a chip  truth table    │
 *   │         │                  analyser, along the bottom   │
 *   ├ status bar: running, cycle, gates, problems, hint, zoom ┤
 *
 * Every command is in the menu bar, with its key beside it; the toolbar
 * and the palette are the mouse's short cuts to the same commands, and
 * the status bar says what the keys do from wherever the editor is. The
 * frame-cost instrument that used to sit over all of this lives on the
 * measured pages now (`Instruments.tsx`), where it is the point.
 *
 * Nothing that replaces the document does so unasked: New, Open, Open
 * recent, a dropped file and every example go through `guard`, which
 * asks first when there are unsaved changes, because loading forgets
 * the undo history and the autosave follows a moment later.
 */
export function workbench(ctx: ComponentContext) {
  const circuit = ctx.channel(Circuit);
  const document = circuit.view.document;
  const status = circuit.view.status;
  const focusService = ctx.inject(FocusService);

  // ---------------------------------------------------------------------
  // Dialogs, and the guard in front of everything that replaces the document
  // ---------------------------------------------------------------------

  const discard = internalState<Discard | null>(null);
  const showShortcuts = internalState(false);
  const showStart = internalState(false);
  const showRecent = internalState(false);
  const showPaste = internalState(false);

  const guard = (what: string, then: () => void) => {
    const d = document.value;
    if (d.dirty && d.components > 0) discard.value = { what, then };
    else then();
  };

  const rawFiles = fileActions(ctx);
  const files: FileActions = {
    ...rawFiles,
    openDropped: list => guard(`Opening ${list[0]?.name ?? 'that file'}`, () => rawFiles.openDropped(list))
  };

  // ---------------------------------------------------------------------
  // Notices: what a file operation said, and what an example is
  // ---------------------------------------------------------------------

  const notice = internalState<{ text: string; error: boolean; serial: number } | null>(null);
  let noticeSerial = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  const notify = (text: string, error = false) => {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    const serial = ++noticeSerial;
    notice.value = { text, error, serial };
    noticeTimer = setTimeout(() => {
      if (notice.value?.serial === serial) notice.value = null;
    }, error ? 8000 : 4000);
  };
  ctx.onUnmount(() => {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
  });
  ctx.effect(
    document.pipe(
      map(d => d.message),
      distinctUntilChanged()
    ),
    message => {
      if (message !== null) notify(message, /^Couldn't/.test(message));
    }
  );

  // ---------------------------------------------------------------------
  // The canvas, and the keys the application answers before the editor
  // ---------------------------------------------------------------------

  let menuBarNode: UiNode | null = null;
  const keys: CanvasKeys = (key, ctrl) => {
    if (ctrl) {
      if (key !== 'Enter') return false;
      run('runPause');
      return true;
    }
    const bound: Readonly<Record<string, CommandId>> = {
      '?': 'shortcuts',
      '.': 'step',
      '0': 'fit',
      '=': 'zoomIn',
      '+': 'zoomIn',
      '-': 'zoomOut',
      _: 'zoomOut',
      u: 'upLevel',
      w: 'analyser',
      F10: 'menuBar',
      F1: 'shortcuts'
    };
    const id = bound[key];
    if (id === undefined) return false;
    run(id);
    return true;
  };
  const canvas = circuitCanvas(ctx, files, keys);
  const editor = canvas.editor;
  const analyser = waveformPanel(ctx, canvas.size.changes.pipe(map(s => s.width)));
  let analyserOpen = false;
  ctx.effect(analyser.open, open => (analyserOpen = open));

  // Whatever was open when the tab closed, brought back by the
  // application worker from its autosave.
  circuit.send.restore();
  files.refreshRecent();
  // The keyboard starts on the canvas, once it is on screen, so the part
  // keys work before anything has been clicked.
  ctx.effect(
    canvas.size.changes.pipe(
      filter(s => s.width > 0),
      take(1)
    ),
    () => canvas.focus()
  );

  /** The level shown is inside a chip: live, and read-only. */
  const inside = document.pipe(
    map(d => d.path.length > 0),
    distinctUntilChanged()
  );

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  /** Set by a command that puts the keyboard somewhere, so the menu bar closing does not take it back to the canvas. */
  let focusClaimed = false;
  const openDialog = (state: { value: boolean }) => {
    focusClaimed = true;
    state.value = true;
  };
  const closeDialog = (state: { value: boolean }) => () => {
    state.value = false;
    canvas.focus();
  };

  const loadExample = (label: string, then: () => void, running: boolean) =>
    guard(`Opening the example “${label}”`, () => {
      then();
      if (running) circuit.send.run();
      notify(running ? `${label}: running. Pause it from the toolbar or with ${commandKeys('runPause')}.` : `${label}: loaded.`);
    });

  function run(id: CommandId): void {
    const rate = rateOf(id);
    if (rate !== null) {
      circuit.send.setClockHz(rate);
      return;
    }
    if (id.startsWith('example:')) {
      const scene = id.slice(8) as SceneName;
      const example = EXAMPLES.find(e => e.scene === scene)!;
      loadExample(example.label, () => circuit.send.loadScene(scene), scene !== 'bench');
      return;
    }
    if (id.startsWith('game:')) {
      const game = GAMES.find(g => g.name === id.slice(5));
      if (game !== undefined) {
        loadExample(game.title, () => circuit.send.loadProgram(game.name, game.source, game.rate), true);
        notify(`${game.title} on the gate-level computer at ${game.rate / 1000} kHz: ↑ and ↓ move your paddle.`);
        canvas.focus();
      }
      return;
    }
    if (id.startsWith('program:')) {
      const program = PROGRAMS.find(p => p.name === id.slice(8));
      if (program !== undefined) loadExample(`computer running ${program.name}`, () => circuit.send.loadProgram(program.name, program.source), true);
      return;
    }
    const d = document.value;
    switch (id) {
      case 'new':
        return guard('A new circuit', () => circuit.send.loadScene('empty'));
      case 'open':
        return guard('Opening a file', () => files.open());
      case 'openRecent':
        files.refreshRecent();
        return openDialog(showRecent);
      case 'save':
        return files.save(false);
      case 'saveAs':
        return files.save(true);
      case 'importChip':
        return files.insertChip();
      case 'undo':
        return circuit.send.undo();
      case 'redo':
        return circuit.send.redo();
      case 'cut':
        return editor.cut();
      case 'copy':
        return editor.copy();
      case 'paste':
        return openDialog(showPaste);
      case 'duplicate':
        return editor.duplicate();
      case 'delete':
        return editor.deleteSelection();
      case 'selectAll':
        return editor.selectAll();
      case 'deselect':
        return editor.cancel();
      case 'rotate':
        return editor.rotateSelection();
      case 'makeChip':
        return editor.makeChip();
      case 'openChip': {
        const one = canvas.selection().one;
        if (one?.kind === 'chip') circuit.send.openChip(one.id);
        return;
      }
      case 'fit':
        return canvas.show('all');
      case 'zoomIn':
        return canvas.zoomBy(Math.SQRT2);
      case 'zoomOut':
        return canvas.zoomBy(Math.SQRT1_2);
      case 'upLevel':
        if (d.path.length > 0) circuit.send.closeChip(d.path.length - 1);
        return;
      case 'topLevel':
        if (d.path.length > 0) circuit.send.closeChip(0);
        return;
      case 'analyser':
        return analyser.toggle();
      case 'truthTable':
        return editor.tabulate();
      case 'runPause':
        return status.value.running ? circuit.send.pause() : circuit.send.run();
      case 'step':
        return circuit.send.step();
      case 'shortcuts':
        return openDialog(showShortcuts);
      case 'gettingStarted':
        return openDialog(showStart);
      case 'menuBar':
        if (menuBarNode !== null) focusService.focus(menuBarNode);
        return;
      default:
        return;
    }
  }

  function enabled(id: CommandId): boolean {
    const d = document.value;
    const editable = d.path.length === 0;
    const s = canvas.selection();
    switch (id) {
      case 'undo':
        return d.canUndo;
      case 'redo':
        return d.canRedo;
      case 'cut':
      case 'delete':
        return editable && s.parts + s.wires > 0;
      case 'copy':
        return s.parts > 0;
      case 'duplicate':
      case 'rotate':
        return editable && s.parts > 0;
      case 'makeChip':
        return editable && s.parts > 0;
      case 'paste':
        return editable;
      case 'deselect':
        return s.parts + s.wires > 0;
      case 'openChip':
        return s.one?.kind === 'chip';
      case 'truthTable':
        return s.parts > 0;
      case 'upLevel':
      case 'topLevel':
        return d.path.length > 0;
      case 'step':
        return !status.value.running;
      default:
        return true;
    }
  }

  function labelOf(id: CommandId): string {
    const rate = rateOf(id);
    if (rate !== null) return `${status.value.clockHz === rate ? '✓' : '  '}  ${rateLabel(rate)}`;
    if (id === 'runPause') return status.value.running ? 'Pause' : 'Run';
    if (id === 'analyser') return analyserOpen ? 'Hide the logic analyser' : 'Show the logic analyser';
    return commandLabel(id);
  }

  // ---------------------------------------------------------------------
  // The menu bar and the toolbar
  // ---------------------------------------------------------------------

  const title = document.pipe(map(d => d.name ?? 'Untitled circuit'));
  const menuBar = (
    <row width={percent(100)} height={34} y="center" gap={4} paddingLeft={10} paddingRight={12} backgroundColor="surface">
      <row gap={6} y="center" marginRight={6}>
        <box width={14} height={14} borderRadius={3} backgroundColor="primary" />
        <text text="gessologic" fontSize={13} fontWeight={700} color="text" selectable={false} />
      </row>
      {createComponent(MenuBar<CommandId>, {
        menus: MENUS,
        labelOf,
        enabled,
        acceleratorOf: (id: CommandId) => commandKeys(id),
        onChoose: (id: CommandId) => run(id),
        onDismiss: () => {
          if (!focusClaimed) canvas.focus();
          focusClaimed = false;
        },
        barRef: (node: UiNode | null) => (menuBarNode = node),
        label: 'Menu'
      })}
      <box flex={1} />
      <row gap={8} y="center">
        <text text={title} fontSize={12} fontWeight={600} color="text" textWrap="none" />
        <box
          paddingLeft={7}
          paddingRight={7}
          paddingTop={2}
          paddingBottom={2}
          borderRadius={9}
          borderWidth={1}
          borderColor={document.pipe(map(d => (d.dirty ? 'primary' : 'border')))}>
          <text
            text={document.pipe(map(d => (d.dirty ? 'Unsaved changes' : d.name === null ? 'Autosaved' : 'Saved')))}
            fontSize={10}
            color={document.pipe(map(d => (d.dirty ? 'primary' : 'textMuted')))}
            textWrap="none"
            selectable={false}
          />
        </box>
      </row>
    </row>
  );

  const running = status.pipe(
    map(s => s.running),
    distinctUntilChanged()
  );
  const can = (id: CommandId) =>
    combineLatest([document, status, canvas.editorChanged]).pipe(
      map(() => enabled(id)),
      distinctUntilChanged()
    );
  const tip = (id: CommandId, what?: string) => () => {
    const keys = commandKeys(id);
    return `${what ?? labelOf(id)}${keys === undefined ? '' : `  ·  ${keys}`}`;
  };
  const clockValue = status.pipe(
    map(s => String(s.clockHz)),
    distinctUntilChanged()
  );
  const toolbar = (
    <row width={percent(100)} y="center" gap={2} paddingLeft={8} paddingRight={8} paddingTop={4} paddingBottom={4} backgroundColor="surface">
      {tool({ label: 'New circuit', icon: ICONS.newFile, tip: tip('new'), onRun: () => run('new') })}
      {tool({ label: 'Open', icon: ICONS.open, tip: tip('open', 'Open a file'), onRun: () => run('open') })}
      {tool({ label: 'Save', icon: ICONS.save, tip: tip('save'), onRun: () => run('save') })}
      {rule()}
      {tool({ label: 'Undo', icon: ICONS.undo, tip: tip('undo'), onRun: () => run('undo'), enabled: can('undo') })}
      {tool({ label: 'Redo', icon: ICONS.redo, tip: tip('redo'), onRun: () => run('redo'), enabled: can('redo') })}
      {rule()}
      {tool({
        label: running.pipe(map(on => (on ? 'Pause' : 'Run'))),
        text: running.pipe(map(on => (on ? 'Pause' : 'Run'))),
        icon: running.pipe(map(on => (on ? ICONS.pause : ICONS.run))),
        tip: tip('runPause', 'Run or pause the clock'),
        on: running,
        onRun: () => run('runPause')
      })}
      {tool({ label: 'Step', icon: ICONS.step, tip: tip('step'), onRun: () => run('step'), enabled: can('step') })}
      <row gap={6} y="center" marginLeft={6}>
        <text text="Clock" fontSize={11} color="textMuted" selectable={false} />
        {createComponent(Select, {
          compact: true,
          labelHidden: true,
          label: 'Clock rate',
          width: 150,
          value: clockValue,
          // A document's clock may run at a rate that is not a preset —
          // the computer examples run at 60 Hz — and a select that
          // cannot show its value shows nothing, so that rate joins the list.
          options: status.pipe(
            map(s => s.clockHz),
            distinctUntilChanged(),
            map(current =>
              (RATES.includes(current) ? RATES : [...RATES.filter(r => r !== 'max'), current, 'max' as const].sort((a, b) =>
                a === 'max' ? 1 : b === 'max' ? -1 : a - b
              )).map(rate => ({ value: String(rate), label: rateLabel(rate) }))
            )
          ),
          onChange: (value: string) => {
            const rate: ClockRate = value === 'max' ? 'max' : Number(value);
            circuit.send.setClockHz(rate);
            canvas.focus();
          }
        })}
      </row>
      {rule()}
      {tool({ label: 'Fit the circuit', icon: ICONS.fit, tip: tip('fit'), onRun: () => run('fit') })}
      {tool({ label: 'Zoom out', icon: ICONS.zoomOut, tip: tip('zoomOut'), onRun: () => run('zoomOut') })}
      {tool({ label: 'Zoom in', icon: ICONS.zoomIn, tip: tip('zoomIn'), onRun: () => run('zoomIn') })}
      {rule()}
      {tool({ label: 'Make a chip', text: 'Make chip', icon: ICONS.chip, tip: tip('makeChip'), onRun: () => run('makeChip'), enabled: can('makeChip') })}
      {tool({
        label: 'Truth table',
        text: 'Truth table',
        icon: ICONS.table,
        tip: tip('truthTable'),
        onRun: () => run('truthTable'),
        enabled: can('truthTable'),
        on: circuit.view.table.pipe(map(t => t.ids.length > 0))
      })}
      {tool({ label: 'Logic analyser', text: 'Analyser', icon: ICONS.analyser, tip: tip('analyser'), onRun: () => run('analyser'), on: analyser.open })}
      <box flex={1} />
      {tool({ label: 'Keyboard shortcuts', icon: ICONS.help, tip: tip('shortcuts'), onRun: () => run('shortcuts') })}
    </row>
  );

  // ---------------------------------------------------------------------
  // Over the canvas: where you are, what to do when it is empty, notices
  // ---------------------------------------------------------------------

  const breadcrumb = (
    <row position="absolute" left={12} top={12} hitTestable={false}>
      {document.pipe(
        map(d =>
          d.path.length === 0
            ? []
            : [
                <row
                  key={`crumbs:${d.path.map(l => l.id).join('/')}`}
                  gap={4}
                  y="center"
                  padding={6}
                  paddingLeft={8}
                  borderRadius={8}
                  backgroundColor="surface"
                  borderColor="border"
                  borderWidth={1}
                  opacity={0.97}
                 >
                  {tool({ label: 'Up one level', icon: ICONS.up, tip: tip('upLevel'), onRun: () => run('upLevel') })}
                  {small('Top', () => (circuit.send.closeChip(0), canvas.focus()), 'top')}
                  {d.path.map((level, i) => [
                    <text key={`sep${i}`} text="›" fontSize={13} color="textMuted" selectable={false} />,
                    i === d.path.length - 1 ? (
                      <row key={`here${i}`} gap={4} y="center" paddingLeft={4} paddingRight={4}>
                        <text text={level.chip} fontSize={12} fontWeight={600} color="text" textWrap="none" />
                        <text text={level.id} fontSize={11} color="textMuted" textWrap="none" />
                      </row>
                    ) : (
                      small(`${level.chip} · ${level.id}`, () => (circuit.send.closeChip(i + 1), canvas.focus()), `crumb${i}`)
                    )
                  ])}
                  <text text="Live · read-only" fontSize={11} color="textMuted" marginLeft={6} selectable={false} />
                </row>
              ]
        )
      )}
    </row>
  );

  const emptyState = combineLatest([document, canvas.editorChanged]).pipe(
    map(([d]) => d.components === 0 && d.path.length === 0 && editor.placing === null),
    distinctUntilChanged(),
    map(empty =>
      !empty
        ? []
        : [
            <column key="empty" position="absolute" left={0} right={0} top={0} bottom={0} x="center" y="center" hitTestable={false}>
              <column
                gap={12}
                padding={20}
                width={380}
                borderRadius={10}
                backgroundColor="surface"
                borderColor="border"
                borderWidth={1}
               >
                <text text="An empty circuit" fontSize={16} fontWeight={700} color="text" />
                <text
                  text="Pick a part from the palette on the left, or press its key — A for an AND gate, I for a switch, L for an LED — then click here to drop it. Drag from pin to pin to wire."
                  fontSize={12}
                  color="textMuted"
                  textWrap="word"
                />
                {heading('OR START FROM AN EXAMPLE')}
                <row gap={6} flexWrap="wrap">
                  {small('Counter', () => run('example:counter'))}
                  {small('8-bit adder', () => run('example:adder'))}
                  {small('Computer drawing a diagonal', () => run('example:diagonal'))}
                </row>
                <row gap={8} marginTop={4}>
                  {action('Getting started', () => run('gettingStarted'), 'accent')}
                  {action('Open a file…', () => run('open'))}
                </row>
              </column>
            </column>
          ]
    )
  );

  const toast = (
    <row position="absolute" left={0} right={0} bottom={16} x="center" hitTestable={false}>
      {notice.pipe(
        map(n =>
          n === null
            ? []
            : [
                <row
                  key={`notice${n.serial}`}
                  gap={10}
                  y="center"
                  paddingLeft={14}
                  paddingRight={8}
                  paddingTop={8}
                  paddingBottom={8}
                  maxWidth={560}
                  borderRadius={8}
                  backgroundColor="surface"
                  borderColor={n.error ? 'danger' : 'border'}
                  borderWidth={n.error ? 2 : 1}
                 
                  role={n.error ? 'alert' : 'status'}
                  live={n.error ? 'assertive' : 'polite'}>
                  <text text={n.text} fontSize={12} color={n.error ? 'danger' : 'text'} textWrap="word" flexShrink={1} minWidth={0} />
                  {small('Dismiss', () => ((notice.value = null), canvas.focus()))}
                </row>
              ]
        )
      )}
    </row>
  );

  // ---------------------------------------------------------------------
  // The status bar, and the parts that will not settle
  // ---------------------------------------------------------------------

  /** The ringing nets, as the parts on this level that drive them. */
  const problemParts = combineLatest([document, status]).pipe(
    map(([d, s]) => ringingParts(d, s)),
    distinctUntilChanged((a, b) => a.join() === b.join())
  );
  ctx.effect(problemParts, ids => canvas.highlight.next(ids));

  const problem = combineLatest([document, status, problemParts]).pipe(
    map(([d, s, ids]) => {
      if (d.error !== null) return { text: d.error, ids: [] as string[], kind: 'error' as const };
      if (s.ringing.length === 0) return null;
      if (ids.length === 0) return { text: `Oscillates inside: ${s.ringing.slice(0, 2).join(', ')}`, ids, kind: 'ringing' as const };
      const names = ids.map(id => canvas.labelOf(id) ?? id);
      const shown = names.slice(0, 3).join(', ');
      return {
        text: `Won’t settle: ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`,
        ids,
        kind: 'ringing' as const
      };
    })
  );

  const statusBar = (
    <row width={percent(100)} height={28} y="center" gap={14} paddingLeft={12} paddingRight={12} backgroundColor="surface">
      <row gap={6} y="center">
        <box width={8} height={8} borderRadius={4} backgroundColor={running.pipe(map(on => (on ? 'primary' : 'border')))} />
        <text
          text={status.pipe(map(s => (s.running ? `Running · ${s.achievedHz.toLocaleString('en')} Hz` : 'Paused')))}
          fontSize={11}
          fontWeight={600}
          color="text"
          textWrap="none"
        />
      </row>
      <text text={status.pipe(map(s => `Cycle ${s.cycles.toLocaleString('en')}`))} fontSize={11} color="textMuted" textWrap="none" />
      <text
        text={document.pipe(map(d => `${d.gates.toLocaleString('en')} gates · ${d.components.toLocaleString('en')} parts · ${d.wires.toLocaleString('en')} wires`))}
        fontSize={11}
        color="textMuted"
        textWrap="none"
      />
      {problem.pipe(
        map(p =>
          p === null
            ? []
            : [
                <button
                  key={`problem:${p.kind}`}
                  focusable={false}
                  label={p.text}
                  onClick={() => {
                    if (p.ids.length > 0) {
                      canvas.frame(p.ids);
                      editor.selectOnly(p.ids);
                    }
                  }}
                  paddingLeft={8}
                  paddingRight={8}
                  paddingTop={2}
                  paddingBottom={2}
                  borderRadius={4}
                  backgroundColor="danger"
                  cursor={p.ids.length > 0 ? 'pointer' : 'default'}
                  flexShrink={1}
                  minWidth={0}>
                  <text
                    text={p.ids.length > 0 ? `⚠ ${p.text} — show` : `⚠ ${p.text}`}
                    fontSize={11}
                    fontWeight={600}
                    color="background"
                    textWrap="none"
                    textOverflow="ellipsis"
                    selectable={false}
                  />
                </button>
              ]
        )
      )}
      <text
        text={combineLatest([canvas.editorChanged, inside]).pipe(
          map(([, readOnly]) => (readOnly ? 'Inside a chip: live and read-only · U goes up a level · Double-click a chip to go deeper' : editor.hint))
        )}
        flex={1}
        minWidth={0}
        textAlign="right"
        fontSize={11}
        color="textMuted"
        textWrap="none"
        textOverflow="ellipsis"
      />
      <text text={canvas.camera.pipe(map(c => `${Math.round((c.scale / 16) * 100)}%`))} fontSize={11} color="textMuted" textWrap="none" />
    </row>
  );

  const line = (direction: 'x' | 'y') =>
    direction === 'x' ? <box width={percent(100)} height={1} backgroundColor="border" /> : <box width={1} height={percent(100)} backgroundColor="border" />;

  return (
    <column width={percent(100)} height={percent(100)} backgroundColor="background" overscrollBehavior="contain">
      {menuBar}
      {line('x')}
      {toolbar}
      {line('x')}
      <row flex={1} minHeight={0} width={percent(100)}>
        {palette(ctx, canvas, document)}
        {line('y')}
        <stack position="relative" flex={1} minWidth={0} height={percent(100)}>
          {canvas.element}
          {emptyState}
          {breadcrumb}
          {inspector(ctx, canvas, inside)}
          {analyser.element as never}
          {toast}
        </stack>
      </row>
      {line('x')}
      {statusBar}
      {confirmDiscard(discard, () => ((discard.value = null), canvas.focus()), () => files.save(false))}
      {shortcuts(showShortcuts, closeDialog(showShortcuts))}
      {gettingStarted(showStart, closeDialog(showStart), () => run('example:counter'))}
      {recentFiles(
        showRecent,
        files.recent,
        handle => {
          showRecent.value = false;
          guard('Opening that file', () => files.openRecent(handle));
        },
        closeDialog(showRecent)
      )}
      {pasteHint(showPaste, closeDialog(showPaste))}
    </column>
  );
}
