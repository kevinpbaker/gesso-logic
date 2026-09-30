import { combineLatest, distinctUntilChanged, map, type Observable } from 'rxjs';

import type { UiChild } from 'gesso-core';

import type { DocumentSummary, Status } from '../app/CircuitContract';
import { heading, small } from './controls';

/**
 * The tour: five things to try on the showpiece, in a small card over
 * the canvas, each ticked off as it happens rather than when a button
 * is pressed, and each with a button that does it for you.
 *
 * It opens by itself on a first visit, which lands on Pong (see
 * `restore`), and from Help → Take the tour. Nothing in it is needed:
 * Pong is playing, the CPU is a chip on the canvas, and double-clicking
 * a chip is what the canvas has always done. It says where to look.
 */

/** What the tour watches. */
export interface TourSources {
  readonly document: Observable<DocumentSummary>;
  readonly status: Observable<Status>;
  /** Whether the analyser panel is open, and how tall it is: the card sits above it. */
  readonly analyser: Observable<boolean>;
  readonly analyserHeight: Observable<number>;
  /** Whether an arrow key has held a button yet. */
  readonly played: Observable<boolean>;
}

/** What its buttons do. */
export interface TourActions {
  openChips(path: readonly string[]): void;
  toTop(): void;
  showAnalyser(): void;
  close(): void;
}

interface Progress {
  readonly played: boolean;
  readonly inCpu: boolean;
  readonly inAlu: boolean;
  readonly analyser: boolean;
  readonly rewired: boolean;
}

export function tour(open: Observable<boolean>, sources: TourSources, actions: TourActions): Observable<UiChild[]> {
  // An edit made while the clock runs, since the tour opened, on the
  // document it opened on: the "rewire it while it plays" step.
  let baseline: { revision: number; opened: number } | null = null;
  let rewired = false;
  // A step done stays done while the tour is open: stepping back out of
  // the ALU does not undo having been in it.
  let reached = { cpu: false, alu: false, analyser: false };
  const progress: Observable<Progress> = combineLatest([open, sources.document, sources.status, sources.analyser, sources.played]).pipe(
    map(([isOpen, d, s, analyser, played]) => {
      if (!isOpen) {
        baseline = null;
        rewired = false;
        reached = { cpu: false, alu: false, analyser: false };
      } else if (baseline === null || baseline.opened !== d.opened) {
        baseline = { revision: d.revision, opened: d.opened };
        rewired = false;
      } else if (s.running && d.revision !== baseline.revision) {
        rewired = true;
      }
      const chips = d.path.map(level => level.chip);
      if (isOpen) {
        reached = {
          cpu: reached.cpu || chips.includes('CPU'),
          alu: reached.alu || chips.includes('ALU'),
          analyser: reached.analyser || analyser
        };
      }
      return { played, inCpu: reached.cpu, inAlu: reached.alu, analyser: reached.analyser, rewired };
    }),
    distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b))
  );

  const steps: readonly { readonly title: string; readonly how: string; readonly done: (p: Progress) => boolean; readonly show?: () => void }[] = [
    {
      title: 'Play Pong',
      how: 'You are on the left: hold ↑ or ↓ to move your paddle. The game runs on an 8-bit CPU made of gates.',
      done: p => p.played
    },
    {
      title: 'Look inside the CPU',
      how: 'Double-click the chip marked CPU. The game keeps playing.',
      done: p => p.inCpu || p.inAlu,
      show: () => actions.openChips(['cpu'])
    },
    {
      title: 'Open the ALU',
      how: 'Inside the CPU, double-click the datapath, then the ALU. Every wire shows its live value.',
      done: p => p.inAlu,
      show: () => actions.openChips(['cpu', 'datapath', 'alu'])
    },
    {
      title: 'Watch the program counter',
      how: 'Open the logic analyser: the program counter’s waveform scrolls by as the game plays.',
      done: p => p.analyser,
      show: () => actions.showAnalyser()
    },
    {
      title: 'Rewire it while it plays',
      how: 'Back at the top, click a wire and press Delete, then drag from pin to pin to draw it again. The game never stops.',
      done: p => p.rewired,
      show: () => actions.toTop()
    }
  ];

  return combineLatest([open, progress, sources.analyser, sources.analyserHeight]).pipe(
    map(([isOpen, p, analyserOpen, analyserHeight]) => {
      if (!isOpen) return [];
      // Every step a line; the next one to do says how, and offers to.
      const next = steps.findIndex(step => !step.done(p));
      return [
        <column
          key="tour"
          position="absolute"
          left={12}
          bottom={analyserOpen ? analyserHeight + 24 : 12}
          width={286}
          gap={7}
          padding={12}
          borderRadius={10}
          backgroundColor="surface"
          borderColor="border"
          borderWidth={1}
          opacity={0.97}>
          <row y="center" width={262}>
            <text text="A tour" fontSize={13} fontWeight={700} color="text" selectable={false} />
            <box flex={1} />
            {small('Close', actions.close)}
          </row>
          {steps.map((step, i) => {
            const done = step.done(p);
            return (
              <column key={`step${i}`} gap={4} width={262}>
                <row gap={7} y="center">
                  <box
                    width={15}
                    height={15}
                    borderRadius={8}
                    backgroundColor={done ? 'primary' : 'controlBackground'}
                    borderColor={done ? 'primary' : i === next ? 'primary' : 'controlBorder'}
                    borderWidth={1}
                    x="center"
                    y="center">
                    <text text={done ? '✓' : String(i + 1)} fontSize={9} fontWeight={700} color={done ? 'background' : 'textMuted'} selectable={false} />
                  </box>
                  <text text={step.title} fontSize={12} fontWeight={i === next ? 700 : 400} color={done ? 'textMuted' : 'text'} selectable={false} />
                </row>
                {i === next ? (
                  <column gap={5} paddingLeft={22}>
                    <text text={step.how} fontSize={11} color="textMuted" textWrap="word" width={240} />
                    {step.show === undefined ? null : <row>{small('Show me', step.show)}</row>}
                  </column>
                ) : null}
              </column>
            );
          })}
          {heading(next < 0 ? 'That’s the tour. The game is still playing.' : 'Everything here happens while the game runs.')}
        </column>
      ];
    })
  );
}
