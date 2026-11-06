// The one app state of the CopilotKit UI and its pure reducer. No React, no fetch, no DOM:
// every change is a named Action, so tests drive `reduce` directly (like Foldkit's story tests).
import { Data } from "effect"
import type { Decision } from "../../../shared/approvals"
import type { SecurityReview, SettingsDocument, StepDecision, Thread, Worker } from "../../../shared/schemas"

/** Start and end of one tool call, from the factory feed. AG-UI messages carry no times. */
export type ToolTiming = { readonly startedAt: number; readonly endedAt?: number; readonly failed?: boolean; readonly error?: string }

export type Model = {
  readonly workers: Readonly<Record<string, Worker>>
  readonly settings: SettingsDocument | null
  readonly settingsError: string | null
  /** Why the settings did not load. The shell shows it with a retry, instead of an empty page. */
  readonly settingsLoadError: string | null
  /** The last failed worker command (stop, abort, message), until the user dismisses it. */
  readonly workerError: string | null
  readonly securityReviews: readonly SecurityReview[]
  /** Jev's latest step decisions, newest last (delivery run card). */
  readonly stepDecisions: readonly StepDecision[]
  readonly threads: readonly Thread[]
  /** Thread the chat shows. A fresh id that is not in `threads` is a new, unsaved conversation. */
  readonly threadId: string
  /** Bumped to reload the open thread (another client wrote it); the chat remounts and reconnects. */
  readonly threadVersion: number
  readonly proto: number
  readonly report: { readonly ref: string; readonly agent?: string } | null
  readonly settingsOpen: boolean
  readonly toolTimings: Readonly<Record<string, ToolTiming>>
  /** Every decision (approvals and questions), from the shared approvals store. */
  readonly decisions: readonly Decision[]
}

export type Action = Data.TaggedEnum<{
  WorkersLoaded: { readonly workers: readonly Worker[] }
  WorkerChanged: { readonly worker: Worker }
  WorkerStopped: { readonly id: string }
  SettingsLoaded: { readonly document: SettingsDocument }
  SettingsChanged: { readonly settings: SettingsDocument["settings"]; readonly css: string }
  SettingsPatchFinished: { readonly error: string | null }
  SettingsLoadFailed: { readonly error: string }
  WorkerCommandFailed: { readonly error: string }
  WorkerErrorDismissed: {}
  SecurityReviewsLoaded: { readonly reviews: readonly SecurityReview[] }
  StepsLoaded: { readonly reviews: readonly SecurityReview[]; readonly decisions: readonly StepDecision[] }
  ThreadsLoaded: { readonly threads: readonly Thread[] }
  ThreadSelected: { readonly threadId: string }
  ThreadReloaded: {}
  ProtoChanged: { readonly proto: number }
  ReportOpened: { readonly ref: string; readonly agent?: string }
  ReportClosed: {}
  SettingsToggled: { readonly open?: boolean }
  DecisionsChanged: { readonly decisions: readonly Decision[] }
  ToolStarted: { readonly id: string; readonly at: number }
  ToolFinished: { readonly id: string; readonly at: number; readonly failed: boolean; readonly error?: string }
}>
export const Action = Data.taggedEnum<Action>()

/** Tool timings kept; older ones are dropped so a long session stays small. */
export const MAX_TOOL_TIMINGS = 2000

export const initial = (threadId: string, proto: number): Model => ({
  workers: {},
  settings: null,
  settingsError: null,
  settingsLoadError: null,
  workerError: null,
  securityReviews: [],
  stepDecisions: [],
  threads: [],
  threadId,
  threadVersion: 0,
  proto,
  report: null,
  settingsOpen: false,
  toolTimings: {},
  decisions: [],
})

const trim = (t: Readonly<Record<string, ToolTiming>>): Readonly<Record<string, ToolTiming>> => {
  const keys = Object.keys(t)
  return keys.length <= MAX_TOOL_TIMINGS ? t : Object.fromEntries(keys.slice(-MAX_TOOL_TIMINGS).map((k) => [k, t[k]!]))
}

/** The panel shows another worker: an error about the old one no longer applies. */
const focusChanged = (m: Model, next: SettingsDocument["settings"]): boolean => m.settings?.settings.focus !== next.focus

export const reduce = (m: Model, a: Action): Model =>
  Action.$match(a, {
    WorkersLoaded: ({ workers }) => ({ ...m, workers: Object.fromEntries(workers.map((w) => [w.id, w])) }),
    WorkerChanged: ({ worker }) => ({ ...m, workers: { ...m.workers, [worker.id]: worker } }),
    WorkerStopped: ({ id }) => {
      const { [id]: _, ...rest } = m.workers
      return { ...m, workers: rest }
    },
    SettingsLoaded: ({ document }) => ({ ...m, settings: document, settingsLoadError: null, workerError: focusChanged(m, document.settings) ? null : m.workerError }),
    SettingsChanged: ({ settings, css }) =>
      m.settings ? { ...m, settings: { ...m.settings, settings, css }, workerError: focusChanged(m, settings) ? null : m.workerError } : m,
    SettingsPatchFinished: ({ error }) => ({ ...m, settingsError: error }),
    SettingsLoadFailed: ({ error }) => ({ ...m, settingsLoadError: error }),
    WorkerCommandFailed: ({ error }) => ({ ...m, workerError: error }),
    WorkerErrorDismissed: () => ({ ...m, workerError: null }),
    SecurityReviewsLoaded: ({ reviews }) => ({ ...m, securityReviews: reviews }),
    StepsLoaded: ({ reviews, decisions }) => ({ ...m, securityReviews: reviews, stepDecisions: decisions }),
    ThreadsLoaded: ({ threads }) => ({ ...m, threads }),
    ThreadSelected: ({ threadId }) => ({ ...m, threadId }),
    ThreadReloaded: () => ({ ...m, threadVersion: m.threadVersion + 1 }),
    ProtoChanged: ({ proto }) => ({ ...m, proto }),
    ReportOpened: ({ ref, agent }) => ({ ...m, report: agent === undefined ? { ref } : { ref, agent } }),
    ReportClosed: () => ({ ...m, report: null }),
    SettingsToggled: ({ open }) => ({ ...m, settingsOpen: open ?? !m.settingsOpen }),
    DecisionsChanged: ({ decisions }) => ({ ...m, decisions }),
    // A replayed start keeps the first time; a start after the end is ignored.
    ToolStarted: ({ id, at }) => (m.toolTimings[id] ? m : { ...m, toolTimings: trim({ ...m.toolTimings, [id]: { startedAt: at } }) }),
    ToolFinished: ({ id, at, failed, error }) => {
      const t = m.toolTimings[id] ?? { startedAt: at }
      const done: ToolTiming = error === undefined ? { ...t, endedAt: at, failed } : { ...t, endedAt: at, failed, error }
      return { ...m, toolTimings: trim({ ...m.toolTimings, [id]: done }) }
    },
  })

/** Workers in panel order: coordinator first, then by name. */
export const sortedWorkers = (workers: Model["workers"]): Worker[] =>
  Object.values(workers).sort((a, b) => (a.role === "coordinator" ? -1 : b.role === "coordinator" ? 1 : a.name.localeCompare(b.name)))

/** Feed event → actions. Pure: the bridge applies them. Reload-type events are handled by the bridge. */
export const feedActions = (ev: { type: string; timestamp: string; data: any }): Action[] => {
  const d = ev.data ?? {}
  const at = Date.parse(ev.timestamp)
  switch (ev.type) {
    case "factory.worker_started":
    case "factory.worker_updated":
      return [Action.WorkerChanged({ worker: d })]
    case "factory.worker_stopped":
      return [Action.WorkerStopped({ id: d.id })]
    case "factory.settings_updated":
      return [Action.SettingsChanged({ settings: d.settings, css: d.css })]
    case "tool.execution_start":
      return d.toolCallId && !Number.isNaN(at) ? [Action.ToolStarted({ id: d.toolCallId, at })] : []
    case "tool.execution_complete": {
      if (!d.toolCallId || Number.isNaN(at)) return []
      const failed = d.success === false
      const msg = d.error?.message
      return [Action.ToolFinished({ id: d.toolCallId, at, failed, ...(failed && typeof msg === "string" ? { error: msg } : {}) })]
    }
    default:
      return []
  }
}
