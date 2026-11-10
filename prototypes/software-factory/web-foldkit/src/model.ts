import { Schema } from "effect";
import { Decision as Approval } from "../../shared/approvals";
import { chat } from "./chatProgram";
import * as DiffPanel from "./diffPanel";
import * as ReportViewer from "./reportViewer";
import * as Goals from "./goals";
import * as Settings from "./settings";
import * as WorkerPanel from "./workerPanel";

export const Model = Schema.Struct({
  chat: chat.Model,
  workerPanel: WorkerPanel.Model,
  settings: Settings.Model,
  goals: Goals.Model,
  diffPanel: DiffPanel.Model,
  reportViewer: ReportViewer.Model,
  /** Prototype layout index from shared/protos; 0 is the classic layout. */
  protoIndex: Schema.Number,
  /** Waiting human decisions, oldest first, from the shared Effect store (shared/approvals.ts). */
  approvals: Schema.Array(Approval),
});
export type Model = typeof Model.Type;
