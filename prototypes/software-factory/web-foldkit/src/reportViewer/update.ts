import { Option, Record, Result } from "effect";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { Dialog } from "@foldkit/ui";
import { FetchBrief, FetchReport, OpenBlob, OpenThread, StartFinding } from "./command";
import { briefRef, fileName, findings, reportHtml, toMdx } from "./domain";
import { Message } from "./message";
import type { Model } from "./model";

type UpdateReturn = Update.Return<Model, Message>;
type Step = Update.Step<Model, Message>;

export const DIALOG_ID = "report-viewer";

export const init = (): UpdateReturn => ({
  model: {
    dialog: Dialog.init({ id: DIALOG_ID }),
    ref: "",
    maybeAgent: Option.none(),
    report: AsyncData.Idle(),
    maybeBrief: Option.none(),
    view: "full",
    starts: {},
  },
});

const writeDialog = (model: Model, dialog: Dialog.Model): Model => (dialog === model.dialog ? model : modifyFields(model, { dialog: () => dialog }));
const toGotDialogMessage = (message: Dialog.Message) => Message.GotDialogMessage({ message });
const foldDialogOut = Dialog.OutMessage.match<Step>({ Opened: () => (model) => ({ model }), Closed: () => (model) => ({ model }) });
const dialogStep = (f: (dialog: Dialog.Model) => Update.ReturnWithOutMessage<Dialog.Model, Dialog.Message, Dialog.OutMessage>) =>
  Update.foldChildStep({ update: f, read: (m: Model) => Option.some(m.dialog), write: writeDialog, toParentMessage: toGotDialogMessage, foldOutMessage: foldDialogOut });

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: writeDialog,
  toParentMessage: toGotDialogMessage,
  foldOutMessage: foldDialogOut,
});

/** Open the viewer on `ref` (reports/x.md). `maybeAgent` is the agent whose worktree a relative path means. */
export const open =
  (ref: string, maybeAgent: Option.Option<string>): Step =>
  (model) =>
    Update.combine<Model, Message>(
      modifyFields(model, {
        ref: () => ref,
        maybeAgent: () => maybeAgent,
        report: (): Model["report"] => AsyncData.Loading(),
        maybeBrief: () => Option.none(),
        view: () => "full",
        starts: () => ({}),
      }),
      [dialogStep(Dialog.open), (next) => ({ model: next, commands: [FetchReport({ ref, agent: Option.getOrNull(maybeAgent) })] })],
    );

/** Close the viewer (the agent's open_report never closes it; the human does). */
export const close: Step = dialogStep(Dialog.close);

const withStart = (model: Model, rank: number, state: Model["starts"][string]): Model =>
  modifyFields(model, { starts: (starts) => Record.set(starts, String(rank), state) });

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotDialogMessage: ({ message }) => foldDialog(model, message),
    // A reply for a report the viewer no longer shows is dropped.
    SucceededFetchReport: ({ ref, report }) =>
      ref !== model.ref
        ? { model }
        : {
            model: modifyFields(model, { report: () => AsyncData.succeed(report) }),
            commands: Option.match(Option.fromNullishOr(briefRef(report.path)), {
              onNone: () => [],
              onSome: (brief) => [FetchBrief({ ref, briefRef: brief, threadId: report.threadId })],
            }),
          },
    FailedFetchReport: ({ ref, error }) =>
      ref !== model.ref ? { model } : { model: modifyFields(model, { report: (current) => AsyncData.settle(current, Result.fail(error)) }) },
    // A synthesis with a brief opens on the brief: same findings, skimmable.
    SucceededFetchBrief: ({ ref, content }) =>
      ref !== model.ref ? { model } : { model: modifyFields(model, { maybeBrief: () => Option.some(content), view: () => "brief" }) },
    FailedFetchBrief: () => ({ model }),
    ClickedView: ({ view }) => ({ model: modifyFields(model, { view: () => view }) }),
    ClickedStart: ({ rank }) =>
      Option.match(
        Option.flatMap(AsyncData.getData(model.report), (report) =>
          Option.map(Option.fromNullishOr(findings(report.content).find((f) => f.rank === rank)), (finding) => ({ report, finding })),
        ),
        {
          onNone: () => ({ model }),
          onSome: ({ report, finding }) => ({
            model: withStart(model, rank, { _tag: "Starting" }),
            commands: [StartFinding({ rank, path: report.path, thread: report.threadId, title: `${finding.rank}. ${finding.title}`, body: finding.body })],
          }),
        },
      ),
    SucceededStart: ({ rank, threadId, branch }) => ({
      model: withStart(model, rank, { _tag: "Started", branch }),
      commands: [OpenThread({ threadId })],
    }),
    FailedStart: ({ rank, error }) => ({ model: withStart(model, rank, { _tag: "FailedStart", error }) }),
    ClickedOpenHtml: () =>
      Option.match(AsyncData.getData(model.report), {
        onNone: () => ({ model }),
        onSome: (report) => ({ model, commands: [OpenBlob({ text: reportHtml(report), type: "text/html", download: null })] }),
      }),
    ClickedDownloadMdx: () =>
      Option.match(AsyncData.getData(model.report), {
        onNone: () => ({ model }),
        onSome: (report) => ({
          model,
          commands: [OpenBlob({ text: toMdx(report.content), type: "text/markdown", download: fileName(report.path).replace(/\.md$/, ".mdx") })],
        }),
      }),
    CompletedOpenBlob: () => ({ model }),
    CompletedOpenThread: () => ({ model }),
  });
