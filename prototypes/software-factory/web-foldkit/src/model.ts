import { Schema } from "effect"
import { Decision as Approval } from "../../shared/approvals"
import { chat } from "./chatProgram"
import * as DiffPanel from "./diffPanel"
import * as ReportViewer from "./reportViewer"
import * as Goals from "./goals"
import * as Settings from "./settings"
import * as Workers from "./workers"

export const Model = Schema.Struct({
  chat: chat.Model,
  workers: Workers.Model,
  settings: Settings.Model,
  goals: Goals.Model,
  diffPanel: DiffPanel.Model,
  reportViewer: ReportViewer.Model,
  /** Waiting human decisions, oldest first, from the shared Effect store (shared/approvals.ts). */
  approvals: Schema.Array(Approval),
})
export type Model = typeof Model.Type
