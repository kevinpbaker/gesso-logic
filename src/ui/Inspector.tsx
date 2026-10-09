import { combineLatest, distinctUntilChanged, map, type Observable } from 'rxjs';

import { percent, type UiChild } from 'gesso-core';
import { each, internalState, type ComponentContext } from 'gesso-framework';

import { Circuit, type TableView } from '../app/CircuitContract';
import { headings } from '../app/TruthTable';
import { WIDENABLE, type Arrangement } from '../app/DocumentEdits';
import type { CanvasHandle, SelectionSummary } from '../canvas/CircuitCanvas';
import { kindName } from '../app/Describe';
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

/** The selection card's width, and the narrowest the truth table under it is. */
const CARD_WIDTH = 292;

const same = (a: SelectionSummary, b: SelectionSummary) =>
  a.parts === b.parts &&
  a.wires === b.wires &&
  a.bent === b.bent &&
  a.one?.id === b.one?.id &&
  a.one?.width === b.one?.width &&
  a.one?.chip === b.one?.chip &&
  a.one?.label === b.one?.label &&
  a.one?.note === b.one?.note &&
  a.one?.ownLabel === b.one?.ownLabel;

export function inspector(ctx: ComponentContext, canvas: CanvasHandle, inside: Observable<string | null>): UiChild {
  const circuit = ctx.channel(Circuit);
  const selection = canvas.editorChanged.pipe(
    map(() => canvas.selection()),
    distinctUntilChanged(same)
  );

  const chipName = internalState('');
  const widthText = internalState('');
  const valueText = internalState('');
  const noteText = internalState('');
  const labelText = internalState('');
  let current: SelectionSummary = { parts: 0, wires: 0, bent: false, partIds: [], one: null };
  ctx.effect(selection, s => {
    current = s;
    chipName.value = s.one?.chip ?? '';
    widthText.value = s.one === null ? '' : String(s.one.width);
    valueText.value = '';
    noteText.value = s.one?.note ?? '';
    labelText.value = s.one?.ownLabel ?? '';
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
  const applyLabel = () => {
    const one = current.one;
    if (one !== null && labelText.value.trim() !== (one.ownLabel ?? '')) circuit.send.setLabel(one.id, labelText.value);
  };
  const applyNote = () => {
    const one = current.one;
    if (one !== null && noteText.value.trim() !== (one.note ?? '')) circuit.send.setNote(one.id, noteText.value);
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
      // Inside a chip a switch's or LED's label is the chip's pin name.
      if (one?.kind === 'note') {
        rows.push(<row key="words">{small('Edit the words…', () => canvas.editText(one.id), 'words')}</row>);
      } else if (one?.kind === 'tunnel') {
        rows.push(
          labelled('Name', <row gap={6} y="center">{field('label', 'Name: every named wire of this name on this level is joined', labelText, 120, applyLabel)}<text text="Enter" fontSize={11} color="textMuted" /></row>, 'label')
        );
        rows.push(<text key="tag" text="Joined to every named wire called this on this level." fontSize={11} color="textMuted" textWrap="word" />);
      } else if (one !== null) {
        const pin = chip !== null && (one.kind === 'input' || one.kind === 'output');
        rows.push(
          labelled(
            'Label',
            <row gap={6} y="center">
              {field('label', pin ? 'Label, which is the pin’s name' : 'Label', labelText, 120, applyLabel)}
              <text text={pin ? 'pin name' : 'Enter'} fontSize={11} color="textMuted" />
            </row>,
            'label'
          )
        );
      }
      if (one?.kind === 'chip' && one.chip !== null) {
        rows.push(labelled('Chip', <row gap={6}>{field('name', 'Chip name', chipName, 120, rename)}{small('Rename', rename)}</row>, 'name'));
      }
      if (one !== null && WIDENABLE.has(one.kind)) {
        rows.push(labelled('Width', <row gap={6} y="center">{field('width', 'Width in bits', widthText, 44, applyWidth)}<text text="bits · Enter" fontSize={11} color="textMuted" /></row>, 'width'));
        // Inside a chip an input is a pin, driven from outside it.
        if (one.kind === 'input' && one.width > 1 && chip === null) {
          rows.push(labelled('Value', <row gap={6} y="center">{field('value', 'Value, 0x for hex', valueText, 72, applyValue)}<text text="0x for hex" fontSize={11} color="textMuted" /></row>, 'value'));
        }
      }
      // A switch or LED is a pin of any chip made of this circuit; its
      // note is what hovering the pin says.
      if (one !== null && (one.kind === 'input' || one.kind === 'output')) {
        rows.push(labelled('Pin note', field('note', 'What this pin is for, shown when its pin is hovered', noteText, 200, applyNote), 'note'));
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
        // The selection when clicked: these rows outlive a change to another of the same size.
        const line = (how: Arrangement) => act(() => circuit.send.arrange(canvas.selection().partIds, how));
        rows.push(
          labelled(
            'Align',
            <row gap={3} flexWrap="wrap">
              {small('Left', line('left'), 'a-left')}
              {small('Centre', line('centre'), 'a-centre')}
              {small('Right', line('right'), 'a-right')}
              {small('Top', line('top'), 'a-top')}
              {small('Middle', line('middle'), 'a-middle')}
              {small('Bottom', line('bottom'), 'a-bottom')}
            </row>,
            'align'
          )
        );
        if (s.parts > 2) {
          rows.push(
            labelled('Space', <row gap={3}>{small('Evenly across', line('across'), 's-across')}{small('Evenly down', line('down'), 's-down')}</row>, 'space')
          );
        }
      }
      if (s.bent) actions.push(small('Straighten', act(() => circuit.send.straighten([...editor.selection])), 'straighten'));
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
    <column position="absolute" right={12} top={12} gap={10} x="end" hitTestable={false} maxHeight={percent(90)}>
      {body.pipe(
        map(rows =>
          rows.length === 0
            ? []
            : [
                <column key="card" width={CARD_WIDTH} gap={8} padding={12} borderRadius={8} backgroundColor="surface" borderColor="border" borderWidth={1} opacity={0.98}>
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
 * then a row per combination, in monospace so the columns line up, and
 * under them the key to any name too long to head its column.
 *
 * The panel is as wide as the table, from the card's width up to
 * TABLE_MAX_WIDTH, and scrolls sideways past that. The width is worked
 * out from the longest line, a monospace character being CHAR_WIDTH
 * pixels at 12px, since a flex column stretches to its limit rather
 * than hugging text that does not wrap.
 */
const TABLE_MAX_WIDTH = 560;
const CHAR_WIDTH = 7.25;
/** Padding and border, both sides. */
const TABLE_CHROME = 26;

function truthTable(table: Observable<TableView>, close: () => void): Observable<UiChild[]> {
  const lines = table.pipe(
    map(t => {
      if (t.ids.length === 0) return [];
      if (t.error !== null) return [{ key: 'error', text: t.error, head: false }];
      const named = headings(t.inputs, t.outputs);
      const inWidths = named.inputs.map(n => n.length);
      const outWidths = named.outputs.map(n => n.length);
      const cell = (value: string, w: number) => value.padStart(Math.ceil(w / 2)).padEnd(w);
      const header = `${named.inputs.join(' ')} │ ${named.outputs.join(' ')}`;
      const rows = t.rows.map((outputs, n) => {
        const bits = t.inputs.map((_, i) => String((n >> (t.inputs.length - 1 - i)) & 1));
        const text = `${bits.map((b, i) => cell(b, inWidths[i]!)).join(' ')} │ ${[...outputs].map((o, i) => cell(o, outWidths[i]!)).join(' ')}`;
        return { key: `r${n}`, text, head: false };
      });
      const key = named.key.map(([letter, name]) => ({ key: `k${letter}`, text: `${letter} = ${name}`, head: false }));
      return [{ key: 'head', text: header, head: true }, ...rows, ...(key.length === 0 ? [] : [{ key: 'gap', text: ' ', head: false }]), ...key];
    })
  );
  const open = table.pipe(
    map(t => t.ids.length > 0),
    distinctUntilChanged()
  );
  // The table's own width, which the column in the scroll view keeps, so
  // that past TABLE_MAX_WIDTH it overflows the view and scrolls.
  const tableWidth = lines.pipe(
    map(ls => Math.ceil(Math.max(0, ...ls.map(l => l.text.length)) * CHAR_WIDTH)),
    distinctUntilChanged()
  );
  const panelWidth = tableWidth.pipe(map(w => Math.min(TABLE_MAX_WIDTH, Math.max(CARD_WIDTH, w + TABLE_CHROME))));
  const panel = () => (
    <column key="table" width={panelWidth} gap={2} padding={12} borderRadius={8} backgroundColor="surface" borderColor="border" borderWidth={1} opacity={0.98} minHeight={0} flexShrink={1}>
      <row gap={10} y="center" marginBottom={4}>
        {heading(table.pipe(map(t => `TRUTH TABLE · ${t.ids.length} PART${t.ids.length === 1 ? '' : 'S'}`)))}
        <box flex={1} />
        {small('Close', close)}
      </row>
      <scrollview minHeight={0} flexShrink={1} overscrollBehavior="contain">
        <column gap={2} minWidth={tableWidth}>
          {each(lines, 'key', line => (
            <text text={line.text} fontSize={12} fontFamily="monospace" fontWeight={line.head ? 600 : 400} color={line.head ? 'text' : 'textMuted'} textWrap="none" />
          ))}
        </column>
      </scrollview>
    </column>
  );
  return open.pipe(map(on => (on ? [panel()] : [])));
}
