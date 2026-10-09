import { combineLatest, map, type Observable } from 'rxjs';

import type { UiChild } from 'gesso-core';
import { internalState } from 'gesso-framework';

import type { CourseView, LevelView, Readings } from '../app/CircuitContract';
import { COURSE_END, LESSONS, lessonById, rowShowing, tableOf, type Lesson } from '../app/CourseLessons';
import { action, small } from './controls';

/**
 * The course, in a card over the canvas: the lessons as a row of
 * numbers, the one open — what to build, from what — and a Check that
 * marks it. The circuit is the document, built on the canvas like any
 * other; the card only says what it should do and whether it does.
 *
 * Open from Help, and by itself whenever the document is a lesson.
 */

const WIDTH = 300;
const INNER = WIDTH - 24;

export interface CourseActions {
  /** Opens a lesson: where it was left, or with `fresh`, where it starts. */
  open(id: string, fresh: boolean): void;
  check(): void;
  answer(): void;
  /** Opens the computer, to look inside after the last lesson. */
  computer(): void;
  close(): void;
}

/** Which lesson the card is about: the one open, or else the first not passed. */
export function lessonToShow(course: CourseView): string | null {
  return course.lesson ?? LESSONS.find(lesson => !course.done.includes(lesson.id))?.id ?? null;
}

/** What the card reads of the circuit: its parts and wires, what its switches and LEDs show, and its revision. */
export interface CourseCircuit {
  readonly level: Observable<LevelView>;
  readonly readings: Observable<Readings>;
  readonly revision: Observable<number>;
}

/**
 * Lesson 1, a step at a time, for someone who has never placed a part:
 * each step ticks itself off when the circuit shows it done, and the
 * next one says how.
 */
const FIRST_STEPS: readonly { readonly title: string; readonly how: string; readonly done: (s: StepState) => boolean }[] = [
  {
    title: 'Place a NAND gate',
    how: 'Click NAND in the palette on the left (or press Shift+A), then click the canvas between a and out.',
    done: s => s.level.parts.some(p => p.kind === 'nand')
  },
  {
    title: 'Wire a to both of its inputs',
    how: 'Drag from the dot on the right of switch a to the NAND’s top input dot. Then drag from a again, to its bottom input.',
    done: s => s.level.wires.filter(w => joins(s, w, 'a.out', 'a') || joins(s, w, 'a.out', 'b')).length >= 2
  },
  {
    title: 'Wire the NAND to the LED',
    how: 'Drag from the dot on the NAND’s right side to the dot on the left of the LED, out.',
    done: s => s.level.wires.some(w => joins(s, w, 'out.in', 'out'))
  },
  {
    title: 'Try it',
    how: 'Click switch a to select it, then click it again to flip it. Watch the LED, and the table above, as a goes 0 and 1.',
    done: s => s.flipped || s.passed
  },
  {
    title: 'Check it',
    how: 'When both rows of the table are ticked, press Check.',
    done: s => s.passed
  }
];

interface StepState {
  readonly level: LevelView;
  readonly flipped: boolean;
  readonly passed: boolean;
}

/** Whether a wire joins `end` to a NAND's `pin`, whichever way it was drawn. */
function joins(s: StepState, wire: LevelView['wires'][number], end: string, pin: string): boolean {
  const nand = (ref: string) => {
    const [id, name] = ref.split('.');
    return name === pin && s.level.parts.some(p => p.id === id && p.kind === 'nand');
  };
  return (wire.from === end && nand(wire.to)) || (wire.to === end && nand(wire.from));
}

/** A value as the table shows it: a bit, a number, or a dash for any. */
const cell = (value: number | null) => (value === null ? '–' : String(value));

/**
 * The lesson's tests as a table, the row the switches are set to now
 * marked, and every row seen showing what it should ticked: a person
 * learns the table by flipping the switches, and Check is then a
 * formality.
 */
function lessonTable(lesson: Lesson, readings: Readings, seen: ReadonlySet<number>): UiChild {
  const table = tableOf(lesson.tests);
  const widths = [...table.inputs, ...table.outputs].map((name, i) =>
    Math.max(name.length, ...table.rows.map(r => cell([...r.inputs, ...r.outputs][i] ?? null).length))
  );
  const line = (values: readonly string[]) =>
    `${values.slice(0, table.inputs.length).map((v, i) => v.padEnd(widths[i]!)).join(' ')} │ ${values
      .slice(table.inputs.length)
      .map((v, i) => v.padEnd(widths[table.inputs.length + i]!))
      .join(' ')}`;
  return (
    <column key="table" gap={1} width={INNER} padding={6} borderRadius={6} backgroundColor="background">
      <text text={line([...table.inputs, ...table.outputs])} fontSize={12} fontFamily="monospace" fontWeight={700} color="textMuted" textWrap="none" />
      {table.rows.map((r, i) => {
        const now = rowShowing(table, r, readings);
        const mark = seen.has(i) ? '✓' : now.set ? '←' : ' ';
        const wrong = now.set && !now.right ? `  shows ${table.outputs.map(name => readings[name] ?? '?').join(' ')}` : '';
        return (
          <row key={`r${i}`} width={INNER - 12} backgroundColor={now.set ? 'selectionBackground' : undefined} borderRadius={3}>
            <text
              text={`${line([...r.inputs, ...r.outputs].map(cell))}  ${mark}${wrong}`}
              fontSize={12}
              fontFamily="monospace"
              color={seen.has(i) ? 'primary' : 'text'}
              textWrap="none"
            />
          </row>
        );
      })}
    </column>
  );
}

export function coursePanel(open: Observable<boolean>, course: Observable<CourseView>, circuit: CourseCircuit, bottom: Observable<number>, actions: CourseActions): Observable<UiChild[]> {
  const hint = internalState<string | null>(null);
  // Rows seen right, and whether a switch has been flipped, for the lesson
  // open and the circuit as it is: an edit can break a row seen working.
  let seenFor = '';
  let seen = new Set<number>();
  let lessonFor: string | null = null;
  let flipped = false;
  let firstReadings: string | null = null;
  return combineLatest([open, course, bottom, hint, circuit.readings, circuit.level, circuit.revision]).pipe(
    map(([isOpen, c, lift, hinted, readings, level, revision]) => {
      if (c.lesson !== lessonFor) {
        lessonFor = c.lesson;
        flipped = false;
        firstReadings = null;
      }
      const key = `${c.lesson}|${revision}`;
      if (key !== seenFor) {
        seenFor = key;
        seen = new Set();
      }
      const openLesson = c.lesson === null ? undefined : lessonById(c.lesson);
      if (openLesson !== undefined) {
        const table = tableOf(openLesson.tests);
        // An LED with nothing wired to it is dark, which is 0: a row of
        // 0s would be ticked before anything was built.
        const wired = table.outputs.every(name => level.wires.some(w => w.to === `${name}.in` || w.from === `${name}.in`));
        table.rows.forEach((r, i) => {
          if (wired && rowShowing(table, r, readings).right) seen.add(i);
        });
        const now = JSON.stringify(table.inputs.map(name => readings[name] ?? null));
        if (firstReadings === null) firstReadings = now;
        else if (now !== firstReadings) flipped = true;
      }
      if (!isOpen && c.lesson === null) return [];
      const shown = lessonToShow(c);
      const lesson = shown === null ? undefined : lessonById(shown);
      const n = lesson === undefined ? LESSONS.length : LESSONS.indexOf(lesson) + 1;
      const inLesson = lesson !== undefined && c.lesson === lesson.id;
      const passed = lesson !== undefined && c.done.includes(lesson.id);
      const next = lesson === undefined ? undefined : LESSONS[LESSONS.indexOf(lesson) + 1];
      const finished = c.done.length === LESSONS.length;
      const body: UiChild[] = [];
      if (lesson === undefined || (finished && !inLesson)) {
        body.push(...COURSE_END.map((line, i) => <text key={`end${i}`} text={line} width={INNER} fontSize={12} color="text" textWrap="word" />));
        body.push(<row key="end-actions" gap={6}>{action('Open the computer', actions.computer, 'accent')}</row>);
      } else {
        body.push(<text key="title" text={`${n}. ${lesson.title}`} width={INNER} fontSize={13} fontWeight={700} color="text" textWrap="word" />);
        body.push(...lesson.brief.map((line, i) => <text key={`brief${i}`} text={line} width={INNER} fontSize={12} color="text" textWrap="word" />));
        if (inLesson) {
          const table = tableOf(lesson.tests);
          body.push(
            <text
              key="goal"
              text={
                lesson.id === 'D latch' || lesson.id === 'D flip-flop'
                  ? 'The goal, a row at a time and in order: set the switches as a row says and the LEDs should show the rest. ✓ marks each row seen working.'
                  : `The goal: for each row, set the switches as it says, and the LED${table.outputs.length === 1 ? '' : 's'} should show the rest. ✓ marks each row seen working.`
              }
              width={INNER}
              fontSize={11}
              color="textMuted"
              textWrap="word"
            />
          );
          body.push(lessonTable(lesson, readings, seen));
          if (seen.size === table.rows.length && !passed) {
            body.push(<text key="all-seen" text="Every row works. Press Check." width={INNER} fontSize={12} fontWeight={600} color="primary" textWrap="word" />);
          }
        }
        if (inLesson && lesson.id === 'not') {
          const state: StepState = { level, flipped, passed };
          const nextStep = FIRST_STEPS.findIndex(step => !step.done(state));
          body.push(
            <column key="steps" gap={4} width={INNER}>
              {FIRST_STEPS.map((step, i) => {
                const done = step.done(state);
                return (
                  <column key={`s${i}`} gap={2} width={INNER}>
                    <text
                      text={`${done ? '✓' : i + 1 + '.'} ${step.title}`}
                      fontSize={12}
                      fontWeight={i === nextStep ? 700 : 400}
                      color={done ? 'textMuted' : 'text'}
                      textWrap="word"
                      width={INNER}
                    />
                    {i === nextStep ? <text text={step.how} fontSize={11} color="textMuted" textWrap="word" width={INNER - 14} paddingLeft={14} /> : null}
                  </column>
                );
              })}
            </column>
          );
        }
        if (hinted === lesson.id) body.push(<text key="hint" text={`Hint: ${lesson.hint}`} width={INNER} fontSize={12} color="secondary" textWrap="word" />);
        if (!inLesson) {
          body.push(
            <row key="start" gap={6}>
              {action(c.done.length === 0 && n === 1 ? 'Start lesson 1' : `Open lesson ${n}`, () => actions.open(lesson.id, false), 'accent')}
            </row>
          );
        } else {
          if (c.marking.lines.length > 0) {
            body.push(
              <column key="marking" gap={2} width={INNER}>
                {c.marking.lines.map((line, i) => (
                  <text key={`m${i}`} text={line} width={INNER} fontSize={12} fontWeight={i === 0 ? 600 : 400} color={c.marking.passed ? 'primary' : 'text'} textWrap="word" />
                ))}
              </column>
            );
          }
          if (passed && next === undefined) {
            body.push(...COURSE_END.map((line, i) => <text key={`end${i}`} text={line} width={INNER} fontSize={12} color="text" textWrap="word" />));
          }
          body.push(
            <row key="actions" gap={6} flexWrap="wrap" width={INNER}>
              {passed && next !== undefined
                ? action(`Next: ${next.title}`, () => actions.open(next.id, false), 'accent')
                : passed && next === undefined
                  ? action('Open the computer', actions.computer, 'accent')
                  : action('Check', actions.check, 'accent')}
              {passed ? small('Check again', actions.check, 'again') : null}
              {small(hinted === lesson.id ? 'Hide hint' : 'Hint', () => (hint.value = hinted === lesson.id ? null : lesson.id), 'hint')}
              {small('Show an answer', actions.answer, 'answer')}
              {small('Start over', () => actions.open(lesson.id, true), 'over')}
            </row>
          );
        }
      }
      return [
        <column
          key="course"
          position="absolute"
          left={12}
          bottom={lift}
          width={WIDTH}
          gap={8}
          padding={12}
          borderRadius={10}
          backgroundColor="surface"
          borderColor="border"
          borderWidth={1}
          opacity={0.98}>
          <row y="center" width={INNER}>
            <text text="Build a computer from NAND" fontSize={12} fontWeight={700} color="textMuted" selectable={false} />
            <box flex={1} />
            {small('Close', actions.close, 'close')}
          </row>
          <row gap={4} flexWrap="wrap" width={INNER}>
            {LESSONS.map((l, i) => {
              const done = c.done.includes(l.id);
              const here = l.id === c.lesson;
              return (
                <button
                  key={`l${i}`}
                  label={`Lesson ${i + 1}: ${l.title}${done ? ', passed' : ''}`}
                  onClick={() => actions.open(l.id, false)}
                  width={22}
                  height={22}
                  borderRadius={11}
                  x="center"
                  y="center"
                  cursor="pointer"
                  backgroundColor={done ? 'primary' : 'controlBackground'}
                  borderColor={here ? 'text' : done ? 'primary' : 'controlBorder'}
                  borderWidth={here ? 2 : 1}>
                  <text text={done ? '✓' : String(i + 1)} fontSize={10} fontWeight={700} color={done ? 'background' : 'textMuted'} selectable={false} />
                </button>
              );
            })}
          </row>
          {body}
        </column>
      ];
    })
  );
}
