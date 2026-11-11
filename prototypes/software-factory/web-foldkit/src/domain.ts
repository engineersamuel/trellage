// Payload schemas of the coordinator API this app reads.
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { ConfigValue, FactoryConfigView, Settings, SettingsDocument, SettingsOptions } from "../../shared/schemas"

export const Worker = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  status: Schema.String,
  auth: Schema.String,
  model: Schema.String,
  pid: Schema.NullOr(Schema.Number),
  rssKb: Schema.NullOr(Schema.Number),
  contextTokens: Schema.optional(Schema.NullOr(Schema.Number)),
  contextLimit: Schema.optional(Schema.NullOr(Schema.Number)),
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  /** Directory the agent works in; the diff panel reloads for tool calls of agents in its worktree. */
  workdir: Schema.optional(Schema.NullOr(Schema.String)),
  /** SDLC step the agent runs (research, plan, implement, ...); its critter shows it. */
  step: Schema.optional(Schema.NullOr(Schema.String)),
})
export type Worker = typeof Worker.Type

export const COORDINATOR_ID = "coordinator"

/** Name of the backend a worker talks to, from its auth mode. */
export const backendName = (auth: string): string => (auth === "proxy" ? "copilot-proxy-rs" : "native Copilot")

// Factory settings (shared/schemas.ts).
export { ConfigValue, FactoryConfigView, Settings, SettingsDocument, SettingsOptions }
export const ConfigAsyncData = AsyncData.Schema(FactoryConfigView, Schema.String)

export const SettingsAsyncData = AsyncData.Schema(SettingsDocument, Schema.String)

// Delivery: the SDLC step catalog Jev picks from, the run worktree, and Jev's decisions.
const Step = Schema.Struct({ id: Schema.String, description: Schema.String, skills: Schema.Array(Schema.String) })
const Run = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  worktree: Schema.String,
  branch: Schema.String,
  dirty: Schema.Boolean,
})
const StepDecision = Schema.Struct({
  step: Schema.String,
  moreWork: Schema.Number,
  confidence: Schema.Number,
  request: Schema.String,
})
const FanOutDecision = Schema.Struct({
  selected: Schema.Array(Schema.String),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  request: Schema.String,
})
export const JevDecision = Schema.Union([StepDecision, FanOutDecision])
export type JevDecision = typeof JevDecision.Type
const SecurityFinding = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  severity: Schema.String,
  file: Schema.String,
  verdict: Schema.String,
  reason: Schema.String,
})
export const SecurityReview = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  model: Schema.String,
  findings: Schema.Array(SecurityFinding),
  error: Schema.optional(Schema.String),
})
export type SecurityReview = typeof SecurityReview.Type
export const Delivery = Schema.Struct({
  steps: Schema.Array(Step),
  run: Schema.NullOr(Run),
  decisions: Schema.Array(JevDecision),
  securityReviews: Schema.Array(SecurityReview),
})
export type Delivery = typeof Delivery.Type
export const DeliveryAsyncData = AsyncData.Schema(Delivery, Schema.String)

export const CronDraft = Schema.Struct({ name: Schema.String, every: Schema.String, prompt: Schema.String })
export type CronDraft = typeof CronDraft.Type
export const EMPTY_CRON_DRAFT: CronDraft = { name: "", every: "60", prompt: "" }
