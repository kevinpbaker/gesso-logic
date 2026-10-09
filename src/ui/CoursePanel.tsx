import { combineLatest, map, type Observable } from 'rxjs';

import type { UiChild } from 'gesso-core';
import { internalState } from 'gesso-framework';

import type { CourseView } from '../app/CircuitContract';
import { COURSE_END, LESSONS, lessonById } from '../app/CourseLessons';
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

export function coursePanel(open: Observable<boolean>, course: Observable<CourseView>, bottom: Observable<number>, actions: CourseActions): Observable<UiChild[]> {
  const hint = internalState<string | null>(null);
  return combineLatest([open, course, bottom, hint]).pipe(
    map(([isOpen, c, lift, hinted]) => {
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
