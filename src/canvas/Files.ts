import { BehaviorSubject } from 'rxjs';

import { ShellService, type ComponentContext, type ShellFileResult, type ShellRecentFile } from 'gesso-framework';

import { Circuit, type SaveRequest } from '../app/CircuitContract';
import { FILE_TYPE } from '../sim/CircuitFile';

/**
 * Opening and saving, on the render worker, where the shell is.
 *
 * The document lives on the application worker and the file pickers on
 * the main thread, so a save goes round: `requestSave` asks the
 * application worker for the file text, which comes back as the
 * `saving` view key; that goes to the shell's picker, and `finishSave`
 * tells the application worker where it went. A browser shows a picker
 * only while the click that asked for it is fresh, and Chrome counts
 * five seconds; the round trip is a few milliseconds.
 *
 * With the File System Access API a picked file comes back with a
 * handle the shell remembers, so Save writes back to it and the recent
 * list can reopen it after a reload. Without one — Firefox, Safari —
 * open is a file input and save is a download, and `finishSave` says
 * which happened.
 */
export interface FileActions {
  open(): void;
  /** Picks a circuit file and adds it to the document as a chip. */
  insertChip(): void;
  save(asNew: boolean): void;
  /** Opens files dropped on the canvas: the first, if it reads as a circuit. */
  openDropped(files: readonly { readonly name: string; readonly bytes?: ArrayBuffer }[]): void;
  openRecent(handle: number): void;
  /** The files the shell remembers, most recent first; refreshed by `refreshRecent`. */
  readonly recent: BehaviorSubject<readonly ShellRecentFile[]>;
  refreshRecent(): void;
}

export function fileActions(ctx: ComponentContext): FileActions {
  const circuit = ctx.channel(Circuit);
  const shell = ctx.inject(ShellService);
  const recent = new BehaviorSubject<readonly ShellRecentFile[]>([]);
  const decoder = new TextDecoder();

  const refreshRecent = () => {
    void shell.recentFiles().then(result => {
      if (result.outcome === 'ok') recent.next(result.recent);
    });
  };
  const opened = (result: ShellFileResult, what: string) => {
    const file = result.files[0];
    if (result.outcome === 'ok' && file !== undefined) {
      circuit.send.open(decoder.decode(file.bytes), file.name, file.handle);
      refreshRecent();
    } else if (result.outcome !== 'cancelled') {
      circuit.send.finishSave(null, `Couldn't open ${what}: ${result.error ?? result.outcome}`);
    }
  };

  let handled = 0;
  ctx.effect(circuit.view.saving, (request: SaveRequest) => {
    if (request.serial === 0 || request.serial === handled) return;
    handled = request.serial;
    void shell
      .saveFile({
        name: request.name,
        text: request.text,
        mediaType: FILE_TYPE.mediaType,
        accept: [FILE_TYPE],
        ...(request.handle === null ? {} : { handle: request.handle })
      })
      .then(result => {
        if (result.outcome === 'ok' && result.saved !== null) {
          const { name, handle, via } = result.saved;
          circuit.send.finishSave({ name, handle }, via === 'download' ? `Downloaded ${name}` : `Saved ${name}`);
          refreshRecent();
        } else {
          circuit.send.finishSave(
            null,
            result.outcome === 'cancelled' ? null : `Couldn't save: ${result.error ?? result.outcome}`
          );
        }
      });
  });

  return {
    open: () => void shell.openFiles({ accept: [FILE_TYPE] }).then(result => opened(result, 'the file')),
    save: asNew => circuit.send.requestSave(asNew),
    insertChip: () =>
      void shell.openFiles({ accept: [FILE_TYPE] }).then(result => {
        const file = result.files[0];
        if (result.outcome === 'ok' && file !== undefined) {
          circuit.send.importChip(decoder.decode(file.bytes), file.name);
        } else if (result.outcome !== 'cancelled') {
          circuit.send.finishSave(null, `Couldn't insert that file: ${result.error ?? result.outcome}`);
        }
      }),
    openDropped: files => {
      const file = files[0];
      if (file?.bytes !== undefined) {
        circuit.send.open(decoder.decode(file.bytes), file.name, null);
      }
    },
    openRecent: handle => void shell.reopenFile(handle).then(result => opened(result, 'that file')),
    recent,
    refreshRecent
  };
}
