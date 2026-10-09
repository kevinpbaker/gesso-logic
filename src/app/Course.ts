import { CIRCUIT_VERSION, type Circuit, type Component, type Wire } from '../sim/Circuit';
import { circuitFrom, writeCircuit } from '../sim/CircuitFile';
import type { Kind } from '../sim/Primitives';
import { runTests } from './CircuitTests';
import { kindName } from './Describe';
import { allowedKinds, LESSONS, type Lesson } from './CourseLessons';

/**
 * The course's circuits: where each lesson starts, an answer to each
 * for anyone who skips one, and the marking.
 *
 * A lesson's circuit is its switches down the left and its LEDs down
 * the right, named as its tests name them, with its brief in a note and
 * its tests in the level. The chips it may use come with it: the ones
 * the person built in earlier lessons, or the answer for any lesson they
 * skipped, so every lesson can be done whatever came before.
 */


const pinRef = (end: string) => {
  const dot = end.indexOf('.');
  return { component: end.slice(0, dot), pin: end.slice(dot + 1) };
};

function levelOf(components: readonly Component[], wires: readonly (readonly [string, string])[]): Circuit {
  return {
    version: CIRCUIT_VERSION,
    components,
    wires: wires.map(([from, to], i): Wire => ({ id: `w${i + 1}`, from: pinRef(from), to: pinRef(to) }))
  };
}

/** A lesson's switches and LEDs, named as its tests name them: switches down the left, LEDs down the right. */
function edges(lesson: Lesson): Component[] {
  return [
    ...lesson.inputs.map(
      (pin, i): Component => ({ id: pin.name, kind: 'input', x: 0, y: 4 * i, label: pin.name, ...(pin.width === undefined ? {} : { width: pin.width }) })
    ),
    ...lesson.outputs.map(
      (pin, i): Component => ({ id: pin.name, kind: 'output', x: 44, y: 4 * i, label: pin.name, ...(pin.width === undefined ? {} : { width: pin.width }) })
    )
  ];
}

const gate = (id: string, kind: Kind, x: number, y: number): Component => ({ id, kind, x, y });
const chip = (id: string, name: string, x: number, y: number): Component => ({ id, kind: 'chip', chip: name, x, y });

/** Each lesson's answer, its parts between its switches and LEDs. */
const ANSWERS: Readonly<Record<string, { parts: Component[]; wires: [string, string][] }>> = {
  not: { parts: [gate('n', 'nand', 16, 0)], wires: [['a.out', 'n.a'], ['a.out', 'n.b'], ['n.out', 'out.in']] },
  and: {
    parts: [gate('n', 'nand', 12, 0), chip('inv', 'NOT', 24, 0)],
    wires: [['a.out', 'n.a'], ['b.out', 'n.b'], ['n.out', 'inv.a'], ['inv.out', 'out.in']]
  },
  or: {
    parts: [chip('na', 'NOT', 10, 0), chip('nb', 'NOT', 10, 6), gate('n', 'nand', 26, 0)],
    wires: [['a.out', 'na.a'], ['b.out', 'nb.a'], ['na.out', 'n.a'], ['nb.out', 'n.b'], ['n.out', 'out.in']]
  },
  xor: {
    parts: [chip('o', 'OR', 10, 0), gate('n', 'nand', 10, 8), chip('x', 'AND', 26, 0)],
    wires: [['a.out', 'o.a'], ['b.out', 'o.b'], ['a.out', 'n.a'], ['b.out', 'n.b'], ['o.out', 'x.a'], ['n.out', 'x.b'], ['x.out', 'out.in']]
  },
  'half adder': {
    parts: [chip('x', 'XOR', 16, 0), chip('y', 'AND', 16, 8)],
    wires: [['a.out', 'x.a'], ['b.out', 'x.b'], ['a.out', 'y.a'], ['b.out', 'y.b'], ['x.out', 's.in'], ['y.out', 'c.in']]
  },
  'full adder': {
    parts: [chip('h1', 'half adder', 10, 0), chip('h2', 'half adder', 22, 4), chip('o', 'OR', 34, 8)],
    wires: [
      ['a.out', 'h1.a'],
      ['b.out', 'h1.b'],
      ['h1.s', 'h2.a'],
      ['cin.out', 'h2.b'],
      ['h2.s', 's.in'],
      ['h1.c', 'o.a'],
      ['h2.c', 'o.b'],
      ['o.out', 'cout.in']
    ]
  },
  'adder 4': {
    parts: [
      { id: 'sa', kind: 'split', x: 6, y: 0, width: 4 },
      { id: 'sb', kind: 'split', x: 6, y: 8, width: 4 },
      chip('f0', 'full adder', 14, 0),
      chip('f1', 'full adder', 22, 0),
      chip('f2', 'full adder', 30, 0),
      chip('f3', 'full adder', 38, 0),
      { id: 'js', kind: 'join', x: 40, y: 10, width: 4 }
    ],
    wires: [
      ['A.out', 'sa.in'],
      ['B.out', 'sb.in'],
      ['cin.out', 'f0.cin'],
      ...[0, 1, 2, 3].flatMap((i): [string, string][] => [
        [`sa.b${i}`, `f${i}.a`],
        [`sb.b${i}`, `f${i}.b`],
        [`f${i}.s`, `js.b${i}`],
        [`f${i}.cout`, i === 3 ? 'cout.in' : `f${i + 1}.cin`]
      ]),
      ['js.out', 'S.in']
    ]
  },
  'mux 2': {
    parts: [chip('ns', 'NOT', 8, 12), chip('x1', 'AND', 20, 0), chip('x2', 'AND', 20, 6), chip('o', 'OR', 32, 2)],
    wires: [
      ['s.out', 'ns.a'],
      ['a.out', 'x1.a'],
      ['ns.out', 'x1.b'],
      ['b.out', 'x2.a'],
      ['s.out', 'x2.b'],
      ['x1.out', 'o.a'],
      ['x2.out', 'o.b'],
      ['o.out', 'y.in']
    ]
  },
  'D latch': {
    parts: [chip('nd', 'NOT', 8, 6), gate('s1', 'nand', 18, 0), gate('r1', 'nand', 18, 6), gate('gq', 'nand', 30, 0), gate('gqn', 'nand', 30, 6)],
    wires: [
      ['d.out', 'nd.a'],
      ['d.out', 's1.a'],
      ['en.out', 's1.b'],
      ['nd.out', 'r1.a'],
      ['en.out', 'r1.b'],
      ['s1.out', 'gq.a'],
      ['gqn.out', 'gq.b'],
      ['r1.out', 'gqn.a'],
      ['gq.out', 'gqn.b'],
      ['gq.out', 'q.in'],
      ['gqn.out', 'qn.in']
    ]
  },
  'D flip-flop': {
    parts: [chip('nc', 'NOT', 8, 8), chip('m', 'D latch', 18, 0), chip('sl', 'D latch', 30, 0)],
    wires: [
      ['clk.out', 'nc.a'],
      ['d.out', 'm.d'],
      ['nc.out', 'm.en'],
      ['m.q', 'sl.d'],
      ['clk.out', 'sl.en'],
      ['sl.q', 'q.in'],
      ['sl.qn', 'qn.in']
    ]
  }
};

/** A lesson's answer, as a level of its own. */
export function answer(lesson: Lesson): Circuit {
  const { parts, wires } = ANSWERS[lesson.id]!;
  return levelOf([...edges(lesson), ...parts], wires);
}

/**
 * The definitions a lesson's chips need, by name, and the ones those
 * need: the person's own, from `built`, or the answer for a lesson they
 * have not built.
 */
export function chipsFor(names: readonly string[], built: Readonly<Record<string, Circuit>>): Record<string, Circuit> {
  const out: Record<string, Circuit> = {};
  const visit = (name: string) => {
    if (out[name] !== undefined) return;
    const lesson = LESSONS.find(l => l.chip === name);
    const definition = built[name] ?? (lesson === undefined ? undefined : answer(lesson));
    if (definition === undefined) return;
    const { chips: _, tests: __, traces: ___, ...body } = definition;
    out[name] = body;
    for (const c of body.components) if (c.kind === 'chip' && c.chip !== undefined) visit(c.chip);
  };
  names.forEach(visit);
  return out;
}

/** Where a lesson starts: its switches and LEDs, its brief in a note, its tests, and the chips it may use. */
export function lessonCircuit(lesson: Lesson, built: Readonly<Record<string, Circuit>>, start: Circuit | null = null): Circuit {
  const n = LESSONS.indexOf(lesson) + 1;
  const level = start ?? {
    ...levelOf(
      [
        ...edges(lesson),
        { id: 'brief', kind: 'note', x: 0, y: -8, label: `Lesson ${n}: ${lesson.title}\nMake the LEDs on the right do what the tests say.` }
      ],
      []
    )
  };
  const chips = chipsFor(lesson.chips, built);
  return { ...level, tests: lesson.tests, ...(Object.keys(chips).length === 0 ? {} : { chips }) };
}

/**
 * A lesson's circuit, or a chip built in one, read back from the text it
 * was kept as: its level, without the chips it uses, which a lesson
 * brings for itself. The text names chips it does not define, so it is
 * read with the answers' chips beside it, which have the same pins.
 */
export function readLessonLevel(text: string): Circuit {
  const data = JSON.parse(text) as { components?: { kind?: string; chip?: string }[] };
  const names = (data.components ?? []).flatMap(c => (c.kind === 'chip' && typeof c.chip === 'string' ? [c.chip] : []));
  const lent = chipsFor(names, {});
  const file = Object.keys(lent).length === 0 ? data : { ...data, chips: (JSON.parse(writeCircuit({ version: CIRCUIT_VERSION, components: [], wires: [], chips: lent })) as { chips: unknown }).chips };
  const { chips: _, ...level } = circuitFrom(file);
  return level;
}

export interface Marking {
  readonly passed: boolean;
  /** What to tell the person: what passed, or what is wrong, a line each. */
  readonly lines: readonly string[];
}

/** The parts a lesson allows, as a person reads them: “NAND gates and your NOT”. */
export function allowedText(lesson: Lesson): string {
  const kinds = lesson.kinds.map(k => (k === 'nand' ? 'NAND gates' : `${kindName(k).toLowerCase()}s`));
  const chips = lesson.chips.map(c => `your ${c}`);
  const all = [...kinds, ...chips];
  return all.length <= 1 ? (all[0] ?? 'nothing') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
}

/** Marks a lesson's circuit: its tests, as the lesson wrote them, and only the parts it allows. */
export function mark(lesson: Lesson, level: Circuit, chips: Circuit['chips']): Marking {
  const kinds = allowedKinds(lesson);
  const extra = new Set<string>();
  for (const c of level.components) {
    if (c.kind === 'chip') {
      if (c.chip === undefined || !lesson.chips.includes(c.chip)) extra.add(c.chip ?? 'a chip');
    } else if (!kinds.has(c.kind)) {
      extra.add(kindName(c.kind));
    }
  }
  if (extra.size > 0) {
    return {
      passed: false,
      lines: [
        `This lesson is built from ${allowedText(lesson)} only. Take out: ${[...extra].join(', ')}.`,
        'Your chips from earlier lessons are in the palette, under This circuit’s chips.'
      ]
    };
  }
  const report = runTests(level, chips, lesson.tests);
  if (report.error !== null) return { passed: false, lines: [`Not yet: ${report.error}.`] };
  if (report.failed === 0) return { passed: true, lines: [`✓ All ${report.rows} rows pass. ${lesson.chip} is yours to use from now on.`] };
  return {
    passed: false,
    lines: [
      `${report.failed} of ${report.rows} row${report.rows === 1 ? '' : 's'} not right yet:`,
      ...report.failures.map(f => `Line ${f.line}: ${f.message}`)
    ]
  };
}
