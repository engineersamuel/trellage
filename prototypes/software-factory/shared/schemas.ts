// Schemas of the coordinator API payloads the UIs read. Decoding strips unknown keys, so each
// Struct lists every field a UI uses. Fields older servers or stored rows may lack get defaults.
import { Effect, Schema } from "effect"

const withDefault = <S extends Schema.Top>(value: S["Encoded"]) => Schema.withDecodingDefaultKey<S>(Effect.succeed(value))
const NullableNumber = Schema.NullOr(Schema.Number).pipe(withDefault(null))
const NullableString = Schema.NullOr(Schema.String).pipe(withDefault(null))

export const Worker = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  status: Schema.String,
  model: Schema.String,
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
})
export type Worker = typeof Worker.Type

const DraftAction = Schema.Literals(["council", "debate", "research", "hyperresearch"])
export const Draft = Schema.Struct({
  versions: Schema.Array(Schema.Struct({
    id: Schema.String,
    prompt: Schema.String,
    source: Schema.Literals(["human", "enhance"]),
    title: Schema.optionalKey(Schema.String),
    notes: Schema.optionalKey(Schema.String),
    at: Schema.Number,
  })),
  current: Schema.String,
  pending: Schema.optionalKey(Schema.Struct({
    kind: Schema.Literal("enhance"),
    candidates: Schema.Array(Schema.Struct({ title: Schema.String, prompt: Schema.String, notes: Schema.String })),
    at: Schema.Number,
  })),
  reports: Schema.Array(Schema.Struct({ action: DraftAction, workerId: Schema.String, path: Schema.String, versionId: Schema.String })),
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

/** GET /api/steps: only the part the shared UIs read. */
export const Steps = Schema.Struct({ securityReviews: Schema.Array(SecurityReview).pipe(withDefault([])) })

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
export const SearchHit = Schema.Struct({ seq: Schema.Number, workerId: Schema.String, type: Schema.String, timestamp: Schema.String, snippet: Schema.String })

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
})
export type Settings = typeof Settings.Type

export const SettingsOptions = Schema.Struct({
  navbarItems: Schema.Array(Schema.String),
  panelPositions: Schema.Array(Schema.String),
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
export const StartedConversation = Schema.Struct({ threadId: Schema.String, branch: Schema.NullOr(Schema.String).pipe(withDefault(null)) })
