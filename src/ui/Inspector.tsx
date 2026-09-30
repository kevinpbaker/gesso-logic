import { combineLatest, distinctUntilChanged, map, type Observable } from 'rxjs';

import { percent, type UiChild } from 'gesso-core';
import { each, internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, type TableView } from '../app/CircuitContract';
import { WIDENABLE } from '../app/DocumentEdits';
import type { CanvasHandle, SelectionSummary } from '../canvas/CircuitCanvas';
import type { Kind } from '../sim/Primitives';
import { field, heading, small } from './controls';

/**
 * The right-hand column over the canvas: what is selected and what can
 * be done to it, and under it the truth table when one is open.
 *
 * One column, laid out in flow, so the table sits below the card
 * however tall the card grows. Before this the controls for a
 * selection were rows that came and went inside the readout, moving
 * everything under them, and the truth table was pinned 172 pixels
 * down and drawn over whatever had grown into that space.
 */

const KIND_NAMES: Readonly<Record<Kind, string>> = {
  input: 'Switch',
  button: 'Button',
  clock: 'Clock',
  constant: 'Constant',
  output: 'LED',
  probe: 'Probe',
  hex: 'Hex display',
  seg7: '7-segment display',
  matrix: 'LED matrix',
  split: 'Split',
  join: 'Join',
  not: 'NOT gate',
  and: 'AND gate',
  or: 'OR gate',
  nand: 'NAND gate',
  nor: 'NOR gate',
  xor: 'XOR gate',
  xnor: 'XNOR gate',
  chip: 'Chip',
  rom: 'Program ROM'
};

export function kindName(kind: Kind): string {
  return KIND_NAMES[kind] ?? kind;
}

const same = (a: SelectionSummary, b: SelectionSummary) =>
  a.parts === b.parts &&
  a.wires === b.wires &&
  a.one?.id === b.one?.id &&
  a.one?.width === b.one?.width &&
  a.one?.chip === b.one?.chip &&
  a.one?.label === b.one?.label;

export function inspector(ctx: ComponentContext, canvas: CanvasHandle, inside: Observable<string | null>): UiChild {
  const circuit = ctx.channel(Circuit);
  const selection = canvas.editorChanged.pipe(
    map(() => canvas.selection()),
    distinctUntilChanged(same)
  );

  const chipName = internalState('');
  const widthText = internalState('');
  const valueText = internalState('');
  let current: SelectionSummary = { parts: 0, wires: 0, one: null };
  ctx.effect(selection, s => {
    current = s;
    chipName.value = s.one?.chip ?? '';
    widthText.value = s.one === null ? '' : String(s.one.width);
    valueText.value = '';
  });

  const rename = () => {
    const from = current.one?.chip;
    const to = chipName.value.trim();
    if (from != null && to !== '' && to !== from) circuit.send.renameChip(from, to);
  };
  const applyWidth = () => {
    const width = Number.parseInt(widthText.value, 10);
    const one = current.one;
    if (one !== null && Number.isInteger(width) && width >= 1 && width <= 32 && width !== one.width) circuit.send.setWidth([one.id], width);
  };
  const applyValue = () => {
    const text = valueText.value.trim();
    const value = /^0x/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number.parseInt(text, 10);
    const one = current.one;
    if (one !== null && Number.isInteger(value) && value >= 0) circuit.send.setInput(one.id, value);
  };

  const editor = canvas.editor;
  // A button here takes the keyboard when pressed; give it back to the
  // canvas, or the next R or Delete goes to the button.
  const act = (run: () => void) => () => {
    run();
    canvas.focus();
  };
  const labelled = (label: string, control: UiChild, key: string) => (
    <row key={key} gap={8} y="center">
      <text text={label} width={52} fontSize={12} color="textMuted" />
      {control}
    </row>
  );

  const changed = circuit.view.document.pipe(
    map(d => d.changedChips),
    distinctUntilChanged((a, b) => a.join('\n') === b.join('\n'))
  );
  const body = combineLatest([selection, inside, changed]).pipe(
    map(([s, chip, changedChips]): UiChild[] => {
      if (s.parts === 0 && s.wires === 0) return [];
      const one = s.one;
      const title =
        one === null
          ? s.parts === 0
            ? s.wires === 1
              ? 'Wire'
              : `${s.wires} wires`
            : `${s.parts} part${s.parts === 1 ? '' : 's'}${s.wires > 0 ? ` and ${s.wires} wire${s.wires === 1 ? '' : 's'}` : ''}`
          : one.kind === 'chip'
            ? `Chip · ${one.chip ?? ''}`
            : kindName(one.kind);
      const rows: UiChild[] = [
        <row key="title" gap={6} y="center">
          <text text={title} flex={1} minWidth={0} fontSize={13} fontWeight={600} color="text" textWrap="none" textOverflow="ellipsis" />
          {one === null ? null : <text text={one.label ?? one.id} fontSize={11} color="textMuted" textWrap="none" />}
        </row>
      ];
      if (chip !== null) {
        rows.push(<text key="inside" text={`Inside ${chip}: an edit here changes every ${chip}. Undo takes it back.`} fontSize={11} color="textMuted" textWrap="word" />);
      }
      if (one?.kind === 'chip' && one.chip !== null) {
        rows.push(labelled('Name', <row gap={6}>{field('name', 'Chip name', chipName, 120, rename)}{small('Rename', rename)}</row>, 'name'));
      }
      if (one !== null && WIDENABLE.has(one.kind)) {
        rows.push(labelled('Width', <row gap={6} y="center">{field('width', 'Width in bits', widthText, 44, applyWidth)}<text text="bits · Enter" fontSize={11} color="textMuted" /></row>, 'width'));
        // Inside a chip an input is a pin, driven from outside it.
        if (one.kind === 'input' && one.width > 1 && chip === null) {
          rows.push(labelled('Value', <row gap={6} y="center">{field('value', 'Value, 0x for hex', valueText, 72, applyValue)}<text text="0x for hex" fontSize={11} color="textMuted" /></row>, 'value'));
        }
      }
      const actions: UiChild[] = [];
      if (one?.kind === 'chip') actions.push(small('Look inside', act(() => circuit.send.openChip(one.id)), 'open'));
      // Not `act`: the dialog takes the keyboard, and the canvas has it back when it closes.
      if (one?.kind === 'rom') actions.push(small('Edit program', () => circuit.send.openProgram(one.id), 'program'));
      if (one?.kind === 'chip' && one.chip !== null && changedChips.includes(one.chip)) {
        const name = one.chip;
        actions.push(small('Reset to original', act(() => circuit.send.resetChip(name)), 'reset'));
      }
      if (s.parts > 0) {
        actions.push(small('Rotate  R', act(() => editor.rotateSelection()), 'rotate'));
        actions.push(small('Duplicate', act(() => editor.duplicate()), 'dup'));
      }
      if (s.parts > 1) {
        actions.push(small('Make chip  M', act(() => editor.makeChip()), 'chip'));
      }
      if (s.parts > 0) actions.push(small('Truth table  T', act(() => editor.tabulate()), 'table'));
      actions.push(small('Delete', act(() => editor.deleteSelection()), 'delete'));
      rows.push(
        <row key="actions" gap={4} flexWrap="wrap" marginTop={2}>
          {actions}
        </row>
      );
      return rows;
    })
  );

  return (
    <column position="absolute" right={12} top={12} width={292} gap={10} hitTestable={false} maxHeight={percent(90)}>
      {body.pipe(
        map(rows =>
          rows.length === 0
            ? []
            : [
                <column key="card" gap={8} padding={12} borderRadius={8} backgroundColor="surface" borderColor="border" borderWidth={1} opacity={0.98}>
                  {rows}
                </column>
              ]
        )
      )}
      {truthTable(circuit.view.table, act(() => circuit.send.tabulate([])))}
    </column>
  );
}

/**
 * The truth table of the selection: a header naming inputs and outputs,
 * then a row per combination, in monospace so the columns line up.
 */
function truthTable(table: Observable<TableView>, close: () => void): Observable<UiChild[]> {
  const width = (names: readonly string[]) => names.map(n => n.length);
  const lines = table.pipe(
    map(t => {
      if (t.ids.length === 0) return [];
      if (t.error !== null) return [{ key: 'error', text: t.error, head: false }];
      const inWidths = width(t.inputs);
      const outWidths = width(t.outputs);
      const cell = (value: string, w: number) => value.padStart(Math.ceil(w / 2)).padEnd(w);
      const header = `${t.inputs.join(' ')} │ ${t.outputs.join(' ')}`;
      const rows = t.rows.map((outputs, n) => {
        const bits = t.inputs.map((_, i) => String((n >> (t.inputs.length - 1 - i)) & 1));
        const text = `${bits.map((b, i) => cell(b, inWidths[i]!)).join(' ')} │ ${[...outputs].map((o, i) => cell(o, outWidths[i]!)).join(' ')}`;
        return { key: `r${n}`, text, head: false };
      });
      return [{ key: 'head', text: header, head: true }, ...rows];
    })
  );
  const open = table.pipe(
    map(t => t.ids.length > 0),
    distinctUntilChanged()
  );
  const panel = () => (
    <column key="table" gap={2} padding={12} borderRadius={8} backgroundColor="surface" borderColor="border" borderWidth={1} opacity={0.98} minHeight={0} flexShrink={1}>
      <row gap={10} y="center" marginBottom={4}>
        {heading(table.pipe(map(t => `TRUTH TABLE · ${t.ids.length} PART${t.ids.length === 1 ? '' : 'S'}`)))}
        <box flex={1} />
        {small('Close', close)}
      </row>
      <scrollview minHeight={0} flexShrink={1} overscrollBehavior="contain">
        <column gap={2}>
          {each(lines, 'key', line => (
            <text text={line.text} fontSize={12} fontFamily="monospace" fontWeight={line.head ? 600 : 400} color={line.head ? 'text' : 'textMuted'} textWrap="none" />
          ))}
        </column>
      </scrollview>
    </column>
  );
  return open.pipe(map(on => (on ? [panel()] : [])));
}
