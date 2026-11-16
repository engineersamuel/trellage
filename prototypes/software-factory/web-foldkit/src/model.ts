import { Schema } from "effect"
import { Decision as Approval } from "../../shared/approvals"
import { chat } from "./chatProgram"
import * as DiffPanel from "./diffPanel"
import * as ReportViewer from "./reportViewer"
import * as Goals from "./goals"
import * as Tournaments from "./tournaments"
import * as Settings from "./settings"
import * as Workers from "./workers"

export const Model = Schema.Struct({
  chat: chat.Model,
  workers: Workers.Model,
  settings: Settings.Model,
  goals: Goals.Model,
  tournaments: Tournaments.Model,
  diffPanel: DiffPanel.Model,
  reportViewer: ReportViewer.Model,
  /** Waiting human decisions, oldest first, from the shared Effect store (shared/approvals.ts). */
  approvals: Schema.Array(Approval),
  /** The worker picked in the Inbox tree (?worker=); none when the pick is a conversation. */
  maybeFocusedWorkerId: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
