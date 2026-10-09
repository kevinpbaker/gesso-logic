import { describe, expect, it } from 'vitest';

import { compile } from '../sim/Netlist';
import type { CourseView, LevelView } from './CircuitContract';
import { CircuitService } from './CircuitService';
import { answer, chipsFor, lessonCircuit, mark } from './Course';
import { LESSONS } from './CourseLessons';

describe('the course', () => {
  it.each(LESSONS.map(lesson => [lesson.title, lesson] as const))('%s: its answer passes, and where it starts does not', (_, lesson) => {
    const chips = chipsFor(lesson.chips, {});
    expect(mark(lesson, answer(lesson), chips)).toMatchObject({ passed: true });
    const start = lessonCircuit(lesson, {});
    expect(() => compile(start)).not.toThrow();
    expect(mark(lesson, start, start.chips).passed).toBe(false);
  });

  it('brings each lesson the chips it may use, and the ones they are made of', () => {
    const lesson = LESSONS.find(l => l.id === 'adder 4')!;
    expect(Object.keys(lessonCircuit(lesson, {}).chips!).sort()).toEqual(['AND', 'NOT', 'OR', 'XOR', 'full adder', 'half adder']);
  });

  it('uses the person’s own chip over the answer, once they have built it', () => {
    const not = LESSONS[0]!;
    const own = answer(not);
    const mine = { ...own, components: own.components.map(c => (c.id === 'n' ? { ...c, x: 99 } : c)) };
    expect(chipsFor(['NOT'], { NOT: mine })['NOT']!.components.find(c => c.id === 'n')!.x).toBe(99);
  });

  it('refuses parts the lesson leaves out, by name', () => {
    const lesson = LESSONS.find(l => l.id === 'and')!;
    const level = { ...answer(lesson), components: [...answer(lesson).components, { id: 'g', kind: 'and' as const, x: 0, y: 20 }] };
    expect(mark(lesson, level, chipsFor(lesson.chips, {})).lines[0]).toBe('This lesson is built from NAND gates and your NOT only. Take out: AND gate.');
  });
});

describe('the course in the service', () => {
  class MapStore {
    readonly data = new Map<string, string>();
    read(key: string) {
      return Promise.resolve({ value: this.data.get(key) ?? null });
    }
    write(key: string, value: string) {
      this.data.set(key, value);
      return Promise.resolve();
    }
    remove(key: string) {
      this.data.delete(key);
      return Promise.resolve();
    }
  }

  async function started(course = new MapStore(), store = new MapStore()) {
    const service = new CircuitService({ schedule: () => {}, store, course });
    let view!: CourseView;
    let level!: LevelView;
    service.courseView.subscribe(v => (view = v));
    service.levelView.subscribe(v => (level = v));
    await service.restore();
    return { service, course, store, view: () => view, level: () => level };
  }

  it('opens a lesson, marks it, and gives the chip built to the lessons after', async () => {
    const { service, course, view, level } = await started();
    service.openLesson('not');
    expect(view().lesson).toBe('not');
    expect(level().parts.map(p => p.id)).toEqual(['a', 'out', 'brief']);
    service.checkLesson();
    expect(view().marking).toMatchObject({ passed: false });

    // Built by hand: a NAND with both inputs on a.
    service.place('nand', 16, 0, 'n');
    service.connect({ component: 'a', pin: 'out' }, { component: 'n', pin: 'a' }, 'w1');
    service.connect({ component: 'a', pin: 'out' }, { component: 'n', pin: 'b' }, 'w2');
    service.connect({ component: 'n', pin: 'out' }, { component: 'out', pin: 'in' }, 'w3');
    service.checkLesson();
    expect(view()).toMatchObject({ done: ['not'], marking: { passed: true } });

    // The next lesson has the NOT just built, with its NAND at 16.
    service.openLesson('and');
    service.place('chip', 20, 0, 'inv', undefined, 'NOT');
    expect(level().parts.find(p => p.id === 'inv')).toMatchObject({ kind: 'chip', chip: 'NOT' });
    expect(JSON.parse(course.data.get('progress')!).built.NOT).toContain('"id":"n","kind":"nand","x":16');

    // Going back finds the work where it was left; afresh, where it starts.
    service.openLesson('not');
    expect(level().parts.some(p => p.id === 'n')).toBe(true);
    service.openLesson('not', true);
    expect(level().parts.some(p => p.id === 'n')).toBe(false);
  });

  it('shows an answer to check, and remembers where it was after a reload', async () => {
    const first = await started();
    first.service.openLesson('xor');
    first.service.showAnswer();
    first.service.checkLesson();
    expect(first.view().marking.passed).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const again = await started(first.course, first.store);
    expect(again.view()).toMatchObject({ done: ['xor'] });
  });

  it('stops being a lesson when another document opens', async () => {
    const { service, view } = await started();
    service.openLesson('or');
    service.loadScene('counter');
    expect(view().lesson).toBeNull();
  });
});
