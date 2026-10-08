import { combineLatest, distinctUntilChanged, filter, map, of, startWith, take } from 'rxjs';

import { darkTheme, lightTheme, percent, type UiNode } from 'gesso-core';
import { MenuBar, Select } from 'gesso-components';
import { createComponent, FocusService, internalState, OpfsStorage, persisted, ShellService, type ComponentContext } from 'gesso-framework';

import { Circuit, type ClockRate, type SceneName } from '../app/CircuitContract';
import { isMainThread } from '../canvas/Bench';
import { circuitCanvas, type CanvasKeys } from '../canvas/CircuitCanvas';
import { fileActions, type FileActions } from '../canvas/Files';
import { waveformPanel } from '../canvas/Waveform';
import { action, heading, rule, small, tool } from './controls';
import { commandKeys, commandLabel, EXAMPLES, MENUS, rateLabel, rateOf, RATES, type CommandId } from './Commands';
import { clockRate, confirmDiscard, gettingStarted, instructionSet, pasteHint, recentFiles, shortcuts, type Discard } from './Dialogs';
import { ICONS } from './icons';
import { inspector } from './Inspector';
import { programEditor } from './ProgramEditor';
import { palette } from './Palette';
import { GAMES, PROGRAMS } from './Programs';
import { ringingParts } from './Problems';
import { tour } from './Tour';

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
  const shell = ctx.inject(ShellService);
  const mainThread = isMainThread();
  const tourOpen = internalState(false);

  // Light or dark: the system's until the toggle is used, and then the
  // choice, remembered in a folder of its own beside the autosave's.
  // Every colour in the app and on the canvas is a theme token, so the
  // theme at the root is the whole of it.
  const appearance = persisted<'system' | 'light' | 'dark'>(new OpfsStorage({ directory: 'gessologic-settings' }), 'appearance', {
    initial: 'system',
    revive: raw => (raw === 'system' || raw === 'light' || raw === 'dark' ? raw : null),
    label: 'appearance'
  });
  const scheme = combineLatest([appearance.value, shell.colorScheme]).pipe(
    map(([chosen, system]) => (chosen === 'system' ? system : chosen)),
    distinctUntilChanged()
  );
  const theme = scheme.pipe(map(value => (value === 'dark' ? darkTheme : lightTheme)));
  let dark = false;
  ctx.effect(scheme, value => (dark = value === 'dark'));

  // ---------------------------------------------------------------------
  // Dialogs, and the guard in front of everything that replaces the document
  // ---------------------------------------------------------------------

  const discard = internalState<Discard | null>(null);
  const showShortcuts = internalState(false);
  const showStart = internalState(false);
  const showIsa = internalState(false);
  const showRecent = internalState(false);
  const showPaste = internalState(false);
  const showRate = internalState(false);
  const rateText = internalState('');

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
  const keys: CanvasKeys = (key, ctrl, shift) => {
    if (ctrl) {
      if (key !== 'Enter') return false;
      run('runPause');
      return true;
    }
    // Shift+D, however the key arrives: some keyboards and remote
    // drivers send `d` with Shift held rather than `D`.
    if (shift && key.toLowerCase() === 'd') {
      run('theme');
      return true;
    }
    if (shift && key.toLowerCase() === 'w') {
      run('trace');
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
  // A pin or wire traced from the canvas opens the analyser on it.
  ctx.effect(canvas.traced, () => {
    if (!analyserOpen) analyser.toggle();
  });

  // Whatever was open when the tab closed, brought back by the
  // application worker from its autosave — or, the first time, Pong,
  // already playing.
  const pong = GAMES.find(g => g.name === 'pong.asm');
  circuit.send.restore(pong === undefined ? undefined : { name: pong.name, source: pong.source, rate: pong.rate });
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

  /**
   * The chip whose inside is shown, or null at the top. It is live, and
   * an edit made there changes the chip's definition, so every instance.
   */
  const inside = document.pipe(
    map(d => d.path.at(-1)?.chip ?? null),
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
      case 'resetChip': {
        const chip = resetTarget();
        if (chip !== null) circuit.send.resetChip(chip);
        return;
      }
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
      case 'trace':
        return editor.traceSelection();
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
      case 'instructionSet':
        return openDialog(showIsa);
      case 'customRate': {
        const current = status.value.clockHz;
        rateText.value = current === 'max' ? '' : rateLabel(current);
        return openDialog(showRate);
      }
      case 'tour':
        tourOpen.value = true;
        return;
      case 'theme':
        appearance.set(dark ? 'light' : 'dark');
        return;
      case 'thread':
        // The same page with `?main` added, or taken away: `main.ts`
        // navigates to it in place, and the autosave brings the circuit
        // back, running, on the other thread.
        shell.openUrl(mainThread ? '?' : '?main');
        return;
      case 'menuBar':
        if (menuBarNode !== null) focusService.focus(menuBarNode);
        return;
      default:
        return;
    }
  }

  /**
   * The chip Reset would put back: the one selected, or else the one
   * whose inside is shown — when it has changed since it was opened.
   */
  function resetTarget(): string | null {
    const d = document.value;
    const one = canvas.selection().one;
    const chip = one?.kind === 'chip' && one.chip !== null ? one.chip : (d.path.at(-1)?.chip ?? null);
    return chip !== null && d.changedChips.includes(chip) ? chip : null;
  }

  function enabled(id: CommandId): boolean {
    const d = document.value;
    const s = canvas.selection();
    switch (id) {
      case 'undo':
        return d.canUndo;
      case 'redo':
        return d.canRedo;
      case 'cut':
      case 'delete':
        return s.parts + s.wires > 0;
      case 'copy':
        return s.parts > 0;
      case 'duplicate':
      case 'rotate':
      case 'makeChip':
        return s.parts > 0;
      case 'resetChip':
        return resetTarget() !== null;
      case 'deselect':
        return s.parts + s.wires > 0;
      case 'openChip':
        return s.one?.kind === 'chip';
      case 'truthTable':
        return s.parts > 0;
      case 'trace':
        return s.parts + s.wires > 0;
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
    if (id === 'customRate') {
      const current = status.value.clockHz;
      return RATES.includes(current) ? '    Another rate…' : `✓  ${rateLabel(current)}…`;
    }
    if (id === 'runPause') return status.value.running ? 'Pause' : 'Run';
    if (id === 'analyser') return analyserOpen ? 'Hide the logic analyser' : 'Show the logic analyser';
    if (id === 'theme') return dark ? 'Light mode' : 'Dark mode';
    if (id === 'thread') return mainThread ? 'Run the simulator in its worker again' : 'Run the simulator on the main thread';
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
              ))
                .map(rate => ({ value: String(rate), label: rateLabel(rate) }))
                .concat({ value: 'custom', label: 'Another rate…' })
            )
          ),
          onChange: (value: string) => {
            // The select is the status's, so choosing this leaves it on
            // the rate running now until the dialog sets another.
            // The dialog opens once the list has closed: `Select` calls
            // this before it releases its own focus trap, and a release
            // pops the innermost trap — which would be the dialog's,
            // leaving the keyboard in a list no longer on screen.
            if (value === 'custom') return queueMicrotask(() => run('customRate'));
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
      {tool({
        label: mainThread ? 'Simulator on the main thread' : 'Simulator in a worker',
        text: mainThread ? 'Main thread' : 'Worker',
        icon: ICONS.chip,
        on: of(mainThread),
        tip: () =>
          mainThread
            ? 'The simulator is sharing the page’s thread. Set the clock to “As fast as it goes” and drag the canvas to feel it. Click to put it back in its worker.'
            : 'The simulator runs in a worker of its own, so the page never waits for it. Click to run it on the main thread instead, and feel the difference.',
        onRun: () => run('thread')
      })}
      {tool({
        label: scheme.pipe(map(value => (value === 'dark' ? 'Light mode' : 'Dark mode'))),
        icon: scheme.pipe(map(value => (value === 'dark' ? ICONS.light : ICONS.dark))),
        tip: () => `${dark ? 'Light mode' : 'Dark mode'}  ·  Shift+D`,
        onRun: () => run('theme')
      })}
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
                  <text text={`Live · edits change every ${d.path.at(-1)!.chip}`} fontSize={11} color="textMuted" marginLeft={6} textWrap="none" selectable={false} />
                  {d.changedChips.includes(d.path.at(-1)!.chip) ? small('Reset', () => (circuit.send.resetChip(d.path.at(-1)!.chip), canvas.focus()), 'reset') : null}
                </row>
              ]
        )
      )}
    </row>
  );

  // The tour opens by itself when a first visit lands on Pong.
  ctx.effect(
    document.pipe(
      map(d => d.welcome),
      distinctUntilChanged()
    ),
    welcome => {
      if (welcome) tourOpen.value = true;
    }
  );
  const tourCard = tour(
    tourOpen,
    {
      document,
      status,
      analyser: analyser.open,
      analyserHeight: analyser.height,
      played: canvas.editorChanged.pipe(
        map(() => editor.playedWithArrows),
        startWith(editor.playedWithArrows),
        distinctUntilChanged()
      )
    },
    {
      openChips: path => {
        circuit.send.closeChip(0);
        for (const id of path) circuit.send.openChip(id);
        canvas.focus();
      },
      toTop: () => {
        circuit.send.closeChip(0);
        canvas.focus();
      },
      showAnalyser: () => {
        if (!analyserOpen) analyser.toggle();
        canvas.focus();
      },
      close: () => {
        tourOpen.value = false;
        canvas.focus();
      }
    }
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
          map(([, chip]) =>
            chip !== null && editor.idle ? `Inside ${chip}: an edit here changes every ${chip} · U goes up a level · Double-click a chip to go deeper` : editor.hint
          )
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
    <column
      theme={theme}
      textStyle={theme.pipe(map(value => value.typography.body))}
      width={percent(100)}
      height={percent(100)}
      backgroundColor="background"
      overscrollBehavior="contain">
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
          {tourCard}
          {inspector(ctx, canvas, inside)}
          {analyser.element as never}
          {toast}
        </stack>
      </row>
      {line('x')}
      {statusBar}
      {confirmDiscard(discard, () => ((discard.value = null), canvas.focus()), () => files.save(false))}
      {shortcuts(showShortcuts, closeDialog(showShortcuts))}
      {instructionSet(showIsa, closeDialog(showIsa))}
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
      {clockRate(
        showRate,
        rateText,
        rate => {
          circuit.send.setClockHz(rate);
          closeDialog(showRate)();
        },
        closeDialog(showRate)
      )}
      {programEditor(ctx, () => canvas.focus())}
    </column>
  );
}
