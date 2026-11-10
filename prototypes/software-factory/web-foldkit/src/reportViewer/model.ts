import { Schema } from "effect";
import { Dialog } from "@foldkit/ui";
import { ReportAsyncData } from "./domain";

export const View = Schema.Literals(["brief", "full", "source"]);
export type View = typeof View.Type;

/** What a finding's "Start in Factory" button shows. */
export const StartState = Schema.Union([
  Schema.TaggedStruct("Starting", {}),
  Schema.TaggedStruct("Started", { branch: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("FailedStart", { error: Schema.String }),
]);
export type StartState = typeof StartState.Type;

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  /** The path the human or the agent asked for, e.g. reports/synthesis.md. */
  ref: Schema.String,
  /** Agent that wrote the link: a relative path means that agent's conversation worktree. */
  maybeAgent: Schema.Option(Schema.String),
  report: ReportAsyncData.schema,
  /** The skimmable brief next to a synthesis (reports/x.brief.md), when there is one. */
  maybeBrief: Schema.Option(Schema.String),
  view: View,
  /** Start buttons by finding rank. */
  starts: Schema.Record(Schema.String, StartState),
});
export type Model = typeof Model.Type;
