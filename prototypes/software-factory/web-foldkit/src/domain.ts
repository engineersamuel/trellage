// Payload schemas of the coordinator API this app reads.
import { Schema } from "effect";
import { AsyncData } from "foldkit";

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
});
export type Worker = typeof Worker.Type;

export const COORDINATOR_ID = "coordinator";

/** Name of the backend a worker talks to, from its auth mode. */
export const backendName = (auth: string): string => (auth === "proxy" ? "copilot-proxy-rs" : "native Copilot");

// Factory settings: the same document the coordinator agent edits with update_settings.
const Palette = Schema.Struct({
  bg: Schema.String,
  surface: Schema.String,
  border: Schema.String,
  text: Schema.String,
  muted: Schema.String,
  accent: Schema.String,
});
const Cron = Schema.Struct({ everySeconds: Schema.Number, prompt: Schema.String, enabled: Schema.Boolean });
const Extension = Schema.Struct({
  slot: Schema.String,
  js: Schema.String,
  css: Schema.String,
  enabled: Schema.Boolean,
  description: Schema.String,
});

export const Settings = Schema.Struct({
  theme: Schema.String,
  themes: Schema.Record(Schema.String, Palette),
  layout: Schema.Struct({ panel: Schema.String, panelWidth: Schema.Number }),
  navbar: Schema.Array(Schema.String),
  animations: Schema.Boolean,
  hotkeys: Schema.Record(Schema.String, Schema.String),
  focus: Schema.String,
  banner: Schema.NullOr(Schema.String),
  agent: Schema.Struct({
    model: Schema.String,
    reasoningEffort: Schema.String,
    disabledTools: Schema.Array(Schema.String),
    instructions: Schema.String,
  }),
  crons: Schema.Record(Schema.String, Cron),
  extensions: Schema.Record(Schema.String, Extension),
  repo: Schema.String,
});
export type Settings = typeof Settings.Type;

export const SettingsOptions = Schema.Struct({
  navbarItems: Schema.Array(Schema.String),
  panelPositions: Schema.Array(Schema.String),
  efforts: Schema.Array(Schema.String),
  toolKinds: Schema.Array(Schema.String),
  models: Schema.Array(Schema.String),
});
export type SettingsOptions = typeof SettingsOptions.Type;

/** GET /api/settings: the document, its generated theme CSS, and the choices the controls offer. */
export const SettingsDocument = Schema.Struct({ settings: Settings, css: Schema.String, options: SettingsOptions });
export type SettingsDocument = typeof SettingsDocument.Type;
export const SettingsAsyncData = AsyncData.Schema(SettingsDocument, Schema.String);

// Delivery: the SDLC step catalog Jev picks from, the run worktree, and Jev's decisions.
const Step = Schema.Struct({ id: Schema.String, description: Schema.String, skills: Schema.Array(Schema.String) });
const Run = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  worktree: Schema.String,
  branch: Schema.String,
  dirty: Schema.Boolean,
});
const StepDecision = Schema.Struct({
  step: Schema.String,
  moreWork: Schema.Number,
  confidence: Schema.Number,
  request: Schema.String,
});
const FanOutDecision = Schema.Struct({
  selected: Schema.Array(Schema.String),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  request: Schema.String,
});
export const JevDecision = Schema.Union([StepDecision, FanOutDecision]);
export type JevDecision = typeof JevDecision.Type;
const SecurityFinding = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  severity: Schema.String,
  file: Schema.String,
  verdict: Schema.String,
  reason: Schema.String,
});
export const SecurityReview = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  model: Schema.String,
  findings: Schema.Array(SecurityFinding),
  error: Schema.optional(Schema.String),
});
export type SecurityReview = typeof SecurityReview.Type;
export const Delivery = Schema.Struct({
  steps: Schema.Array(Step),
  run: Schema.NullOr(Run),
  decisions: Schema.Array(JevDecision),
  securityReviews: Schema.Array(SecurityReview),
});
export type Delivery = typeof Delivery.Type;
export const DeliveryAsyncData = AsyncData.Schema(Delivery, Schema.String);

export const CronDraft = Schema.Struct({ name: Schema.String, every: Schema.String, prompt: Schema.String });
export type CronDraft = typeof CronDraft.Type;
export const EMPTY_CRON_DRAFT: CronDraft = { name: "", every: "60", prompt: "" };
