// Schemas of the coordinator API payloads the UIs read. Decoding strips unknown keys, so each
// Struct lists every field a UI uses. Fields older servers or stored rows may lack get defaults.
import { Effect, Schema } from "effect"
import { DIFF_STYLES } from "./diff"
import { TREE_STYLES } from "./treeLines"

const withDefault = <S extends Schema.Top>(value: S["Encoded"]) =>
  Schema.withDecodingDefaultKey<S>(Effect.succeed(value))
const NullableNumber = Schema.NullOr(Schema.Number).pipe(withDefault(null))
const NullableString = Schema.NullOr(Schema.String).pipe(withDefault(null))

export const Worker = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  status: Schema.String,
  model: Schema.String,
  /** How the model was picked; older servers do not send it. */
  modelSource: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("routed"), by: Schema.String, confidence: Schema.Number }),
      Schema.Struct({ kind: Schema.Literals(["pinned", "fallback", "default"]) }),
    ]),
  ),
  auth: Schema.String,
  pid: NullableNumber,
  rssKb: NullableNumber,
  home: Schema.String.pipe(withDefault("")),
  task: NullableString,
  lastMessage: NullableString,
  owner: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** SDK that runs the agent: copilot, claude or pi. */
  harness: Schema.optionalKey(Schema.String),
  eventCount: Schema.Number.pipe(withDefault(0)),
  contextTokens: NullableNumber,
  contextLimit: NullableNumber,
  /** When the factory started this agent (ms); gives the spawn order. */
  startedAt: Schema.optionalKey(Schema.Number),
  /** SDLC step the agent runs (research, plan, implement, ...); its critter shows it. */
  step: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type Worker = typeof Worker.Type

const DraftAction = Schema.Literals(["council", "debate", "research", "hyperresearch", "deep-research"])
export const Draft = Schema.Struct({
  versions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      prompt: Schema.String,
      source: Schema.Literals(["human", "enhance"]),
      title: Schema.optionalKey(Schema.String),
      notes: Schema.optionalKey(Schema.String),
      at: Schema.Number,
    }),
  ),
  current: Schema.String,
  pending: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literal("enhance"),
      candidates: Schema.Array(Schema.Struct({ title: Schema.String, prompt: Schema.String, notes: Schema.String })),
      at: Schema.Number,
    }),
  ),
  reports: Schema.Array(
    Schema.Struct({ action: DraftAction, workerId: Schema.String, path: Schema.String, versionId: Schema.String }),
  ),
  startedAt: Schema.optionalKey(Schema.Number),
})
export type Draft = typeof Draft.Type

export const Thread = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** Always sent by the coordinator; defaulted so a partial payload still lists the conversation. */
  createdAt: Schema.Number.pipe(withDefault(0)),
  folderId: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  worktree: Schema.optionalKey(Schema.String),
  base: Schema.optionalKey(Schema.String),
  cleanedAt: Schema.optionalKey(Schema.Number),
  archivedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  desk: Schema.optionalKey(Schema.Boolean),
  parentThreadId: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(Draft),
})
export type Thread = typeof Thread.Type

export const Folder = Schema.Struct({ id: Schema.String, name: Schema.String, path: Schema.String })
export type Folder = typeof Folder.Type

/** GET /api/threads/get */
export const Threads = Schema.Struct({ threads: Schema.Array(Thread), folders: Schema.Array(Folder) })

export const Finding = Schema.Struct({
  id: Schema.String.pipe(withDefault("")),
  title: Schema.String.pipe(withDefault("")),
  severity: Schema.String.pipe(withDefault("")),
  file: Schema.String.pipe(withDefault("")),
  summary: Schema.optionalKey(Schema.String),
  audit: Schema.optionalKey(Schema.String),
  verdict: Schema.String.pipe(withDefault("")),
  reason: Schema.String.pipe(withDefault("")),
  confidence: Schema.optionalKey(Schema.Number),
})

export const SecurityReview = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.String,
  model: Schema.String,
  findings: Schema.Array(Finding),
  error: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.Number),
})
export type SecurityReview = typeof SecurityReview.Type

/** One Jev step decision (factory.step_decided). Fan-out decisions have no `step` and are skipped by readers. */
export const StepDecision = Schema.Struct({
  step: Schema.optionalKey(Schema.String),
  moreWork: Schema.optionalKey(Schema.Number),
  confidence: Schema.optionalKey(Schema.Number),
  request: Schema.String.pipe(withDefault("")),
  at: Schema.optionalKey(Schema.Number),
  /** Coordinator that asked Jev; missing on older decisions (the Factory desk). */
  scopeId: Schema.optionalKey(Schema.String),
})
export type StepDecision = typeof StepDecision.Type

/** GET /api/steps: only the part the shared UIs read. */
export const Steps = Schema.Struct({
  securityReviews: Schema.Array(SecurityReview).pipe(withDefault([])),
  decisions: Schema.Array(StepDecision).pipe(withDefault([])),
})

/** One stored raw event (GET /api/workers/:id/events, GET /api/events). `data` stays free-form. */
export const StoredEvent = Schema.Struct({
  seq: Schema.Number,
  workerId: Schema.String,
  type: Schema.String,
  agentId: Schema.NullOr(Schema.String).pipe(withDefault(null)),
  timestamp: Schema.String,
  data: Schema.Any,
})

/** GET /api/search */
export const SearchHit = Schema.Struct({
  seq: Schema.Number,
  workerId: Schema.String,
  type: Schema.String,
  timestamp: Schema.String,
  snippet: Schema.String,
})

// Factory settings: the same document the coordinator agent edits with update_settings.
export const Palette = Schema.Struct({
  bg: Schema.String,
  surface: Schema.String,
  border: Schema.String,
  text: Schema.String,
  muted: Schema.String,
  accent: Schema.String,
})
const Cron = Schema.Struct({ everySeconds: Schema.Number, prompt: Schema.String, enabled: Schema.Boolean })
const Extension = Schema.Struct({
  slot: Schema.String,
  js: Schema.String,
  css: Schema.String,
  enabled: Schema.Boolean,
  description: Schema.String,
})

export const Settings = Schema.Struct({
  theme: Schema.String,
  themes: Schema.Record(Schema.String, Palette),
  navbar: Schema.Array(Schema.String),
  animations: Schema.Boolean,
  diffStyle: Schema.Literals(DIFF_STYLES).pipe(Schema.withDecodingDefaultKey(Effect.succeed("terminal" as const))),
  /** Animated critter on each agent of the Inbox conversation tree and canvas. */
  inboxCritters: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Connector lines of the Inbox conversation tree: classic, tree (growing tree) or vine (ivy vine). */
  treeStyle: Schema.Literals(TREE_STYLES).pipe(Schema.withDecodingDefaultKey(Effect.succeed("tree" as const))),
  hotkeys: Schema.Record(Schema.String, Schema.String),
  focus: Schema.String,
  banner: Schema.NullOr(Schema.String),
  agent: Schema.Struct({
    model: Schema.String,
    reasoningEffort: Schema.String,
    disabledTools: Schema.Array(Schema.String),
    instructions: Schema.String,
  }),
  /** Model and effort of the repo sub-coordinators (the delivery loops); the global ones use `agent`. */
  subAgent: Schema.Struct({ model: Schema.String, reasoningEffort: Schema.String }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ model: "claude-opus-5.5", reasoningEffort: "high" })),
  ),
  /** Agent SDK of every worker: auto (the step decides; Copilot SDK by default) or one SDK forced for all workers. */
  /** forceWithLease: finish workers may `git push --force-with-lease` their own branch (after a rebase). */
  workers: Schema.Struct({
    harness: Schema.String,
    forceWithLease: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ harness: "auto", forceWithLease: true }))),
  /** Engine behind every factory decision (gates, lenses, findings, triage, next step). Hot-swappable: the next decision uses it. */
  decisions: Schema.Struct({ engine: Schema.String }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ engine: "jev" })),
  ),
  crons: Schema.Record(Schema.String, Cron),
  extensions: Schema.Record(Schema.String, Extension),
  repo: Schema.String,
})
export type Settings = typeof Settings.Type

export const SettingsOptions = Schema.Struct({
  navbarItems: Schema.Array(Schema.String),
  efforts: Schema.Array(Schema.String),
  toolKinds: Schema.Array(Schema.String),
  models: Schema.Array(Schema.String),
})
export type SettingsOptions = typeof SettingsOptions.Type

/** GET /api/settings: the document, its generated theme CSS, and the choices the controls offer. */
export const SettingsDocument = Schema.Struct({ settings: Settings, css: Schema.String, options: SettingsOptions })
export type SettingsDocument = typeof SettingsDocument.Type

/** GET /api/reports: one saved report file of a conversation worktree. */
export const Report = Schema.Struct({
  threadId: Schema.String,
  folderId: Schema.String,
  title: Schema.String,
  path: Schema.String,
  file: Schema.String,
  content: Schema.String,
})
export type Report = typeof Report.Type

/** POST /api/reports/start: the new conversation that runs the finding. */
export const StartedConversation = Schema.Struct({
  threadId: Schema.String,
  branch: Schema.NullOr(Schema.String).pipe(withDefault(null)),
})

/** GET /api/config: every factory config key with its value, source and reload rule; prompt names; load errors. */
export const ConfigValue = Schema.Struct({
  key: Schema.String,
  value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
  source: Schema.Literals(["default", "file", "override"]),
  reload: Schema.Literals(["live", "run"]),
})
export type ConfigValue = typeof ConfigValue.Type
export const FactoryConfigView = Schema.Struct({
  path: Schema.String,
  error: Schema.NullOr(Schema.String),
  values: Schema.Array(ConfigValue),
  prompts: Schema.Array(Schema.String),
  promptErrors: Schema.Record(Schema.String, Schema.String),
  /** User prompt copies made from an older shipped version. */
  stalePrompts: Schema.Array(Schema.Struct({ name: Schema.String, basedOn: Schema.String, shipped: Schema.String })),
})
export type FactoryConfigView = typeof FactoryConfigView.Type
