import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Message as ChatMessage, ChatMessageSchema, ThreadSchema } from "@plana-solutions/agent-interface"
import { Decision as Approval } from "../../shared/approvals"
import * as DiffPanel from "./diffPanel"
import * as ReportViewer from "./reportViewer"
import * as Goals from "./goals"
import * as Settings from "./settings"
import * as Workers from "./workers"

export const Message = defineMessageUnion({
  GotChatMessage: { message: ChatMessage },
  GotWorkersMessage: { message: Workers.Message },
  GotSettingsMessage: { message: Settings.Message },
  GotGoalsMessage: { message: Goals.Message },
  GotDiffPanelMessage: { message: DiffPanel.Message },
  GotReportViewerMessage: { message: ReportViewer.Message },
  /** The navbar "Changes" button: open the diff panel on the open conversation's worktree. */
  ClickedOpenChanges: {},
  // Feed events, one Message per kind, decoded in the feed Subscription.
  ReceivedThreadUpdate: { threadId: Schema.optional(Schema.String) },
  ReceivedFeedGap: {},
  /** The feed reported a change a chat card shows (workers, decisions, reviews, Jev steps). */
  ReceivedCardDataChange: {},
  // Window and shared-module events
  RequestedOpenThread: { threadId: Schema.String },
  RequestedNewThread: {},
  /** A click on a report path (reports/x.md) anywhere on the page, or the agent's open_report. */
  RequestedOpenReport: { ref: Schema.String, maybeAgent: Schema.Option(Schema.String) },
  PressedKey: { key: Schema.String },
  UpdatedApprovals: { pending: Schema.Array(Approval) },
  // Command results
  SucceededReloadThread: { threadId: Schema.String, messages: Schema.Array(ChatMessageSchema) },
  FailedReloadThread: { error: Schema.String },
  SucceededRefreshThreads: { threads: Schema.Array(ThreadSchema) },
  FailedRefreshThreads: { error: Schema.String },
  CompletedSyncThreadUrl: {},
  CompletedSyncExtensionWorkers: {},
  CompletedShowAgent: {},
  CompletedAttachSlot: {},
})
export type Message = typeof Message.Type
