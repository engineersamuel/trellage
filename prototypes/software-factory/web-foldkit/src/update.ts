import { Equal, Option } from "effect"
import { AsyncData, Command, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { ChatBackend, Flags } from "@plana-solutions/agent-interface"
import { currentProto } from "../../shared/protos"
import {
  foldChat,
  newThread,
  openThread,
  refreshCards,
  showRefreshedThreads,
  showReloadedThread,
  toGotChatMessage,
} from "./chat"
import { chat } from "./chatProgram"
import { RefreshThreads, ReloadThread, SetLayout, SyncExtensionWorkers, SyncThreadUrl } from "./command"
import { COORDINATOR_ID } from "./domain"
import { Message } from "./message"
import type { Model } from "./model"
import * as DiffPanel from "./diffPanel"
import * as ReportViewer from "./reportViewer"
import * as Goals from "./goals"
import * as Settings from "./settings"
import * as WorkerPanel from "./workerPanel"

export type UpdateReturn = Update.Return<Model, Message, ChatBackend>
type Step = Update.Step<Model, Message, ChatBackend>

export const toGotWorkerPanelMessage = (message: WorkerPanel.Message): Message =>
  Message.GotWorkerPanelMessage({ message })
export const toGotSettingsMessage = (message: Settings.Message): Message => Message.GotSettingsMessage({ message })
export const toGotGoalsMessage = (message: Goals.Message): Message => Message.GotGoalsMessage({ message })
export const toGotDiffPanelMessage = (message: DiffPanel.Message): Message => Message.GotDiffPanelMessage({ message })
export const toGotReportViewerMessage = (message: ReportViewer.Message): Message =>
  Message.GotReportViewerMessage({ message })

const readWorkerPanel = (model: Model) => Option.some(model.workerPanel)
// An unchanged child keeps the parent Model: Foldkit renders only when the Model reference changes, and the panel
// ignores most feed events (stream deltas, other workers).
const writeWorkerPanel = (model: Model, next: WorkerPanel.Model): Model =>
  next === model.workerPanel ? model : modifyFields(model, { workerPanel: () => next })
const readSettings = (model: Model) => Option.some(model.settings)
const writeSettings = (model: Model, next: Settings.Model): Model =>
  next === model.settings ? model : modifyFields(model, { settings: () => next })

/** Ask the server to focus a worker; the settings broadcast that follows moves the panel. */
const requestFocus = (workerId: string): Step =>
  Update.foldChildStep({
    update: Settings.requestFocus(workerId),
    read: readSettings,
    write: writeSettings,
    toParentMessage: toGotSettingsMessage,
  })

/** Show `workerId` in the panel. */
const focusWorker = (workerId: string): Step =>
  Update.foldChildStep({
    update: WorkerPanel.focus(workerId),
    read: readWorkerPanel,
    write: writeWorkerPanel,
    toParentMessage: toGotWorkerPanelMessage,
  })

const abortWorker = (workerId: string): Step =>
  Update.foldChildStep({
    update: WorkerPanel.abort(workerId),
    read: readWorkerPanel,
    write: writeWorkerPanel,
    toParentMessage: toGotWorkerPanelMessage,
  })

const pressSettingsHotkey = (action: string): Step =>
  Update.foldChildStep({
    update: Settings.pressHotkey(action),
    read: readSettings,
    write: writeSettings,
    toParentMessage: toGotSettingsMessage,
  })

const foldWorkerPanel = Update.foldChild({
  read: readWorkerPanel,
  write: writeWorkerPanel,
  toParentMessage: toGotWorkerPanelMessage,
  update: WorkerPanel.update,
  // The user picked a worker: the focus setting decides which worker every UI shows.
  foldOutMessage: WorkerPanel.OutMessage.match<Step>({ SelectedWorker: ({ workerId }) => requestFocus(workerId) }),
})

const foldGoals = Update.foldChild({
  read: (model: Model) => Option.some(model.goals),
  write: (model: Model, next: Goals.Model): Model =>
    next === model.goals ? model : modifyFields(model, { goals: () => next }),
  toParentMessage: toGotGoalsMessage,
  update: Goals.update,
})

const readDiffPanel = (model: Model) => Option.some(model.diffPanel)
const writeDiffPanel = (model: Model, next: DiffPanel.Model): Model =>
  next === model.diffPanel ? model : modifyFields(model, { diffPanel: () => next })

const foldDiffPanel = Update.foldChild({
  read: readDiffPanel,
  write: writeDiffPanel,
  toParentMessage: toGotDiffPanelMessage,
  update: DiffPanel.update,
})

/** Open the diff panel on the open conversation's worktree, or the factory run worktree when none is open. */
const openChanges: Step = (model) =>
  Update.foldChildStep({
    update: DiffPanel.open(Option.getOrElse(model.chat.maybeSelectedThreadId, () => DiffPanel.RUN_WORKTREE)),
    read: readDiffPanel,
    write: writeDiffPanel,
    toParentMessage: toGotDiffPanelMessage,
  })(model)

const readReportViewer = (model: Model) => Option.some(model.reportViewer)
const writeReportViewer = (model: Model, next: ReportViewer.Model): Model =>
  next === model.reportViewer ? model : modifyFields(model, { reportViewer: () => next })
const foldReportViewer = Update.foldChild({
  read: readReportViewer,
  write: writeReportViewer,
  toParentMessage: toGotReportViewerMessage,
  update: ReportViewer.update,
})

/** Open the report viewer on `ref`. */
const openReport = (ref: string, maybeAgent: Option.Option<string>): Step =>
  Update.foldChildStep({
    update: ReportViewer.open(ref, maybeAgent),
    read: readReportViewer,
    write: writeReportViewer,
    toParentMessage: toGotReportViewerMessage,
  })

const foldSettings = Update.foldChild({
  read: readSettings,
  write: writeSettings,
  toParentMessage: toGotSettingsMessage,
  update: Settings.update,
  foldOutMessage: Settings.OutMessage.match<Step>({ ReceivedFocus: ({ workerId }) => focusWorker(workerId) }),
})

/** Reload the open conversation only while no run streams into it (our own runs arrive live). */
const reloadOpenThread =
  (maybeChangedThreadId: Option.Option<string>): Step =>
  (model) => ({
    model,
    commands: Option.match(model.chat.maybeSelectedThreadId, {
      onNone: () => [],
      onSome: (threadId) =>
        // eslint-disable-next-line no-underscore-dangle -- run state is a tagged union
        model.chat.run._tag === "Idle" &&
        Option.match(maybeChangedThreadId, { onNone: () => true, onSome: (changed) => changed === threadId })
          ? [ReloadThread({ threadId })]
          : [],
    }),
  })

const refreshThreads: Step = (model) => ({ model, commands: [RefreshThreads()] })

const handleMessage = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    GotChatMessage: ({ message: childMessage }) => foldChat(model, childMessage),
    GotWorkerPanelMessage: ({ message: childMessage }) => foldWorkerPanel(model, childMessage),
    GotSettingsMessage: ({ message: childMessage }) => foldSettings(model, childMessage),
    GotGoalsMessage: ({ message: childMessage }) => foldGoals(model, childMessage),
    GotDiffPanelMessage: ({ message: childMessage }) => foldDiffPanel(model, childMessage),
    GotReportViewerMessage: ({ message: childMessage }) => foldReportViewer(model, childMessage),
    ClickedOpenChanges: () => openChanges(model),
    ReceivedThreadUpdate: ({ threadId }) =>
      Update.combine(model, [refreshThreads, reloadOpenThread(Option.fromNullishOr(threadId))]),
    // After a feed gap the open thread and the thread list may be stale. The panel and settings reload their own data.
    ReceivedFeedGap: () => Update.combine(model, [refreshThreads, reloadOpenThread(Option.none()), refreshCards]),
    ReceivedCardDataChange: () => refreshCards(model),
    RequestedOpenThread: ({ threadId }) => openThread(threadId)(model),
    RequestedNewThread: () => newThread(model),
    RequestedSelectWorker: ({ workerId }) => requestFocus(workerId)(model),
    RequestedOpenReport: ({ ref, maybeAgent }) => openReport(ref, maybeAgent)(model),
    UpdatedProto: ({ proto }) => ({ model: modifyFields(model, { protoIndex: () => proto }) }),
    ReceivedLayoutRequest: ({ layout }) => ({
      model,
      commands: layout === model.protoIndex ? [] : [SetLayout({ layout })],
    }),
    CompletedSetLayout: () => ({ model }),
    PressedKey: ({ key }) =>
      Option.match(
        Option.flatMap(Settings.maybeSettings(model.settings), (settings) =>
          Option.fromNullishOr(settings.hotkeys[key]),
        ),
        {
          onNone: () => ({ model }),
          onSome: (action) =>
            action === "abortCoordinator" ? abortWorker(COORDINATOR_ID)(model) : pressSettingsHotkey(action)(model),
        },
      ),
    // The approvals store sends a new list on every reload; the same decisions keep the same Model.
    UpdatedApprovals: ({ pending }) => ({
      model: Equal.equals(model.approvals, pending) ? model : modifyFields(model, { approvals: () => pending }),
    }),
    SucceededReloadThread: ({ threadId, messages }) => showReloadedThread(threadId, messages)(model),
    // The chat keeps what it shows; the next feed event or feed gap retries.
    FailedReloadThread: () => ({ model }),
    SucceededRefreshThreads: ({ threads }) => showRefreshedThreads(threads)(model),
    FailedRefreshThreads: () => ({ model }),
    CompletedSyncThreadUrl: () => ({ model }),
    CompletedSyncExtensionWorkers: () => ({ model }),
    CompletedAttachSlot: () => ({ model }),
  })

/** Effects that follow from a Model change, whatever Message caused it: keep the URL and the extension host in step. */
const syncOutside =
  (previous: Model): Step =>
  (model) => ({
    model,
    commands: [
      ...(Equal.equals(previous.chat.maybeSelectedThreadId, model.chat.maybeSelectedThreadId)
        ? []
        : [SyncThreadUrl({ maybeThreadId: model.chat.maybeSelectedThreadId })]),
      ...Option.match(AsyncData.getData(model.workerPanel.workers), {
        onNone: () => [],
        onSome: (workers) =>
          Option.contains(AsyncData.getData(previous.workerPanel.workers), workers)
            ? []
            : [SyncExtensionWorkers({ workers })],
      }),
    ],
  })

/** The diff panel (and its navbar counts) follows the open conversation, or the run worktree when none is open. */
const followThread: Step = (model) =>
  Update.foldChildStep({
    update: DiffPanel.follow(Option.getOrElse(model.chat.maybeSelectedThreadId, () => DiffPanel.RUN_WORKTREE)),
    read: readDiffPanel,
    write: writeDiffPanel,
    toParentMessage: toGotDiffPanelMessage,
  })(model)

export const update = (model: Model, message: Message): UpdateReturn =>
  Update.combine(model, [(stepModel) => handleMessage(stepModel, message), followThread, syncOutside(model)])

/** ?thread=<id> in the address bar opens that conversation on load. */
const openThreadFromUrl =
  (maybeThreadId: Option.Option<string>): Step =>
  (model) =>
    Option.match(maybeThreadId, { onNone: () => ({ model }), onSome: (threadId) => openThread(threadId)(model) })

export const init = (
  flags: Flags,
  url: Parameters<typeof chat.init>[1],
  maybeThreadId: Option.Option<string>,
): UpdateReturn => {
  const workerPanel = WorkerPanel.init(COORDINATOR_ID)
  const settings = Settings.init()
  const goals = Goals.init()
  const diffPanel = DiffPanel.init()
  const reportViewer = ReportViewer.init()
  const app = Update.foldChildInit(chat.init(flags, url), {
    toParentMessage: toGotChatMessage,
    toParentModel: (chatModel): Model => ({
      chat: chatModel,
      workerPanel: workerPanel.model,
      settings: settings.model,
      goals: goals.model,
      diffPanel: diffPanel.model,
      reportViewer: reportViewer.model,
      protoIndex: currentProto(),
      approvals: [],
    }),
  })
  return Update.combine(app.model, [
    (model) => ({
      model,
      commands: [
        ...(app.commands ?? []),
        ...Command.mapMessages(workerPanel.commands, toGotWorkerPanelMessage),
        ...Command.mapMessages(settings.commands, toGotSettingsMessage),
      ],
    }),
    openThreadFromUrl(maybeThreadId),
    followThread,
  ])
}
