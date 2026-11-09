import { Array, Option, Result, pipe } from "effect";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { Dialog } from "@foldkit/ui";
import { FetchDiff } from "./command";
import { orderedPaths } from "./domain";
import { Message } from "./message";
import type { Model } from "./model";

type UpdateReturn = Update.Return<Model, Message>;
type Step = Update.Step<Model, Message>;

export const DIALOG_ID = "diff-panel";
/** Thread id the server reads as "the factory run worktree" (no conversation open). */
export const RUN_WORKTREE = "-";

export const init = (): UpdateReturn => ({
  model: {
    dialog: Dialog.init({ id: DIALOG_ID }),
    threadId: RUN_WORKTREE,
    diff: AsyncData.Idle(),
    maybeSelectedPath: Option.none(),
  },
});

const writeDialog = (model: Model, dialog: Dialog.Model): Model => (dialog === model.dialog ? model : modifyFields(model, { dialog: () => dialog }));
const toGotDialogMessage = (message: Dialog.Message) => Message.GotDialogMessage({ message });

const foldDialogOut = Dialog.OutMessage.match<Step>({ Opened: () => (model) => ({ model }), Closed: () => (model) => ({ model }) });

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: writeDialog,
  toParentMessage: toGotDialogMessage,
  foldOutMessage: foldDialogOut,
});

const fetch: Step = (model) => ({
  model: modifyFields(model, { diff: (current) => Option.getOrElse(AsyncData.revalidateOrLoad(current), () => current) }),
  commands: [FetchDiff({ threadId: model.threadId })],
});

/** Show `threadId`'s worktree: the navbar counts follow the open conversation even while the panel is closed. */
export const follow =
  (threadId: string): Step =>
  (model) =>
    model.threadId === threadId
      ? { model }
      : fetch(modifyFields(model, { threadId: () => threadId, diff: () => AsyncData.Idle(), maybeSelectedPath: () => Option.none() }));

/** Total added and removed lines of the loaded changes, for the navbar button. */
export const totals = (model: Model): Option.Option<{ added: number; removed: number }> =>
  Option.map(AsyncData.getData(model.diff), ({ files }) => ({
    added: Array.reduce(files, 0, (n, f) => n + f.added),
    removed: Array.reduce(files, 0, (n, f) => n + f.removed),
  }));

/** Open the panel on `threadId`'s worktree and load its changes fresh. */
export const open =
  (threadId: string): Step =>
  (model) =>
    Update.combine(model.threadId === threadId ? model : modifyFields(model, { threadId: () => threadId, diff: () => AsyncData.Idle(), maybeSelectedPath: () => Option.none() }), [
      Update.foldChildStep({ update: Dialog.open, read: (m: Model) => Option.some(m.dialog), write: writeDialog, toParentMessage: toGotDialogMessage, foldOutMessage: foldDialogOut }),
      fetch,
    ]);

const paths = (model: Model): ReadonlyArray<string> =>
  Option.match(AsyncData.getData(model.diff), { onNone: () => [], onSome: ({ files }) => orderedPaths(files) });

/** Keep the selection when the file is still changed, else pick the first file. */
const keepSelection = (model: Model): Model => {
  const all = paths(model);
  const kept = Option.filter(model.maybeSelectedPath, (p) => all.includes(p));
  return modifyFields(model, { maybeSelectedPath: () => (Option.isSome(kept) ? kept : Array.head(all)) });
};

const select = (model: Model, maybePath: Option.Option<string>): UpdateReturn => ({
  model: Option.isSome(maybePath) && !Option.contains(model.maybeSelectedPath, maybePath.value)
    ? modifyFields(model, { maybeSelectedPath: () => maybePath })
    : model,
});

const step = (model: Model, by: number): UpdateReturn => {
  const all = paths(model);
  const at = pipe(model.maybeSelectedPath, Option.flatMap((p) => Array.findFirstIndex(all, (x) => x === p)), Option.getOrElse(() => -1));
  return select(model, Array.get(all, Math.min(all.length - 1, Math.max(0, at + by))));
};

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotDialogMessage: ({ message }) => foldDialog(model, message),
    ClickedRefresh: () => fetch(model),
    ReceivedFileChange: () => fetch(model),
    // A reply for a worktree the panel no longer shows (the conversation changed while it loaded) is dropped.
    SucceededFetchDiff: ({ threadId, diff }) =>
      threadId === model.threadId ? { model: keepSelection(modifyFields(model, { diff: () => AsyncData.succeed(diff) })) } : { model },
    FailedFetchDiff: ({ threadId, error }) =>
      threadId === model.threadId ? { model: modifyFields(model, { diff: (current) => AsyncData.settle(current, Result.fail(error)) }) } : { model },
    ClickedFile: ({ path }) => select(model, Option.some(path)),
    PressedNextFile: () => step(model, 1),
    PressedPreviousFile: () => step(model, -1),
    CompletedMountNativeDiff: () => ({ model }),
  });
