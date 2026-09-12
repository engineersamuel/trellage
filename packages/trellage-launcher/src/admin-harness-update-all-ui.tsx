import React, { useEffect, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import type { AdminProfileEntry } from "./admin-model.ts"
import type { AdminHarnessVersionResult } from "./admin-harness-version.ts"
import { harnessUpgradeVersionPreview } from "./admin-harness-update-preview.ts"
import type {
  HarnessUpdateGroupReport,
  HarnessUpdateManager,
  HarnessUpdatePlan,
  HarnessUpdateQueueEvent,
  HarnessUpdateResult,
  HarnessUpdateStep,
} from "./admin-harness-update.ts"
import {
  harnessUpdateAllPlanFor,
  harnessUpdateAllSummary,
  runAllHarnessUpdates,
  type HarnessUpdateAllOutcome,
  type HarnessUpdateAllPlan,
} from "./admin-harness-update-all.ts"
import { MarkdownTextViewport } from "./guide-ui.tsx"
import type { NativeSkillsUpdateEvent } from "./admin-skills-update.ts"
import type { UpdateCommandResult } from "./admin-update-command.ts"
import type { AdminSkillsCheckResult } from "./admin-skills-check.ts"
import {
  hasSelectedAdminUpdates,
  selectAvailableAdminUpdates,
  type AdminUpdateSelection,
  type UpdateCheckIssue,
} from "./admin-update-selection.ts"

interface AllUpdateViewBase {
  readonly plan: HarnessUpdateAllPlan
  readonly catalogProfileCount: number
  readonly visible: boolean
  readonly completedSteps: number
  readonly activePlan: HarnessUpdatePlan | undefined
  readonly activeStep: HarnessUpdateStep | undefined
  readonly results: ReadonlyMap<string, HarnessUpdateResult>
  readonly reports: ReadonlyArray<HarnessUpdateGroupReport>
  readonly stage: "skills" | "harnesses"
  readonly skillsEvent: NativeSkillsUpdateEvent | undefined
  readonly skillsResults: ReadonlyMap<string, HarnessUpdateResult>
  readonly skillsCache: UpdateCommandResult | undefined
  readonly checking: boolean
  readonly skillChecks: ReadonlyMap<string, AdminSkillsCheckResult>
  readonly versionChecks: ReadonlyMap<string, AdminHarnessVersionResult>
  readonly issues: ReadonlyArray<UpdateCheckIssue>
  readonly harnessUpdateRefs: ReadonlySet<string>
  readonly skillUpdateRefs: ReadonlySet<string>
  readonly dependentSkillRefs: ReadonlySet<string>
  readonly sharedSkillsUpdate: boolean
}

export type HarnessUpdateAllView = AllUpdateViewBase &
  (
    | { readonly phase: "confirming"; readonly message?: string }
    | { readonly phase: "running"; readonly cancelling: boolean }
    | { readonly phase: "done"; readonly outcome: HarnessUpdateAllOutcome }
    | { readonly phase: "error"; readonly message: string }
  )

const confirmationView = (plan: HarnessUpdateAllPlan): HarnessUpdateAllView => ({
  phase: "confirming",
  visible: true,
  plan,
  catalogProfileCount: plan.profileCount,
  completedSteps: 0,
  activePlan: undefined,
  activeStep: undefined,
  results: new Map(),
  reports: [],
  stage: "harnesses",
  skillsEvent: undefined,
  skillsResults: new Map(),
  skillsCache: undefined,
  checking: true,
  skillChecks: new Map(),
  versionChecks: new Map(),
  issues: [],
  harnessUpdateRefs: new Set(),
  skillUpdateRefs: new Set(),
  dependentSkillRefs: new Set(),
  sharedSkillsUpdate: false,
})

const emptySelectionPlan = (): HarnessUpdateAllPlan => ({
  groups: [],
  skills: undefined,
  unsupported: [],
  profileCount: 0,
  nativeUpdateCount: 0,
  containerUpdateCount: 0,
})

const selectedView = (state: HarnessUpdateAllView, routerCommandPath: string): HarnessUpdateAllView => {
  if (state.phase !== "confirming") return state
  if (state.checking) return { ...state, plan: emptySelectionPlan() }
  const selection = selectAvailableAdminUpdates(
    state.plan,
    (entry) => state.versionChecks.get(entry.ref),
    state.skillChecks,
    routerCommandPath,
  )
  return applySelection(state, selection)
}

const applySelection = (state: HarnessUpdateAllView, selection: AdminUpdateSelection): HarnessUpdateAllView => ({
  ...state,
  ...selection,
})

const applySkillsEvent = (state: HarnessUpdateAllView, event: NativeSkillsUpdateEvent): HarnessUpdateAllView => {
  const next: HarnessUpdateAllView = { ...state, stage: "skills", skillsEvent: event }
  if (event.kind === "cache-completed") return { ...next, skillsCache: event.result }
  if (event.kind === "profile-completed")
    return { ...next, skillsResults: new Map(state.skillsResults).set(event.result.ref, event.result) }
  return next
}

const applyQueueEvent = (state: HarnessUpdateAllView | undefined, event: HarnessUpdateQueueEvent): HarnessUpdateAllView | undefined => {
  if (state?.phase !== "running") return state
  switch (event.kind) {
    case "skills":
      return applySkillsEvent(state, event.event)
    case "started":
      return { ...state, stage: "harnesses", activePlan: event.plan, activeStep: undefined }
    case "step-started":
      return { ...state, activeStep: event.step }
    case "step-completed": {
      const results = new Map(state.results)
      for (const result of event.results) results.set(result.ref, result)
      return { ...state, results, activeStep: undefined, completedSteps: state.completedSteps + 1 }
    }
    case "completed":
      return { ...state, activePlan: undefined, reports: [...state.reports, event.report] }
  }
}

interface HarnessUpdateAllControlOptions {
  readonly entries: ReadonlyArray<AdminProfileEntry>
  readonly manager: HarnessUpdateManager
  readonly refresh: (plan: HarnessUpdatePlan) => Promise<void>
  readonly versionResultFor: (entry: AdminProfileEntry) => AdminHarnessVersionResult | undefined
  readonly blockReason: () => string | undefined
  readonly routerCommandPath: string
  readonly checkVersions: (signal: AbortSignal) => Promise<ReadonlyMap<string, AdminHarnessVersionResult>>
  readonly checkSkills: (signal: AbortSignal) => Promise<ReadonlyMap<string, AdminSkillsCheckResult>>
}

export const useHarnessUpdateAll = (options: HarnessUpdateAllControlOptions) => {
  const [state, setState] = useState<HarnessUpdateAllView | undefined>(undefined)
  const controller = useRef<AbortController | undefined>(undefined)
  const discovery = useRef<AbortController | undefined>(undefined)
  useEffect(
    () => () => {
      controller.current?.abort()
      discovery.current?.abort()
    },
    [],
  )

  const open = () => {
    if (controller.current !== undefined) {
      setState((previous) => (previous === undefined ? previous : { ...previous, visible: true }))
      return
    }
    const next = confirmationView(harnessUpdateAllPlanFor(options.entries, options.versionResultFor, options.routerCommandPath))
    if (options.manager.isBusy()) {
      setState({
        ...next,
        plan: emptySelectionPlan(),
        checking: false,
        phase: "error",
        message: "A harness update is already running. Wait for it to finish before updating all.",
      })
      return
    }
    discovery.current?.abort()
    const abort = new AbortController()
    discovery.current = abort
    setState(next)
    void Promise.all([options.checkVersions(abort.signal), options.checkSkills(abort.signal)])
      .then(([versionChecks, skillChecks]) => {
        if (abort.signal.aborted) return
        setState((previous) => (previous?.phase === "confirming" ? { ...previous, checking: false, versionChecks, skillChecks } : previous))
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        abort.abort()
        const message = error instanceof Error ? error.message : String(error)
        setState((previous) =>
          previous === undefined ? previous : { ...previous, plan: emptySelectionPlan(), checking: false, phase: "error", message },
        )
      })
  }

  const close = () => {
    discovery.current?.abort()
    setState((previous) =>
      previous?.phase === "confirming" ? undefined : previous === undefined ? previous : { ...previous, visible: false },
    )
  }

  const confirm = () => {
    if (state?.phase !== "confirming" || state.checking || controller.current !== undefined) return
    const selected = selectedView(state, options.routerCommandPath)
    if (!hasSelectedAdminUpdates(selected.plan)) return
    const reason = options.blockReason()
    if (reason !== undefined) {
      setState({ ...state, message: reason })
      return
    }
    const abort = new AbortController()
    controller.current = abort
    setState({ ...selected, phase: "running", cancelling: false })
    void runAllHarnessUpdates(selected.plan, options.manager, {
      refresh: options.refresh,
      signal: abort.signal,
      onProgress: (event) => setState((previous) => applyQueueEvent(previous, event)),
    })
      .then((outcome) => setState((previous) => (previous === undefined ? previous : { ...previous, phase: "done", outcome })))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setState((previous) => (previous === undefined ? previous : { ...previous, phase: "error", message }))
      })
      .finally(() => {
        controller.current = undefined
      })
  }

  const cancel = () => {
    controller.current?.abort()
    setState((previous) => (previous?.phase === "running" ? { ...previous, cancelling: true } : previous))
  }
  return {
    state: state === undefined ? undefined : selectedView(state, options.routerCommandPath),
    open,
    close,
    confirm,
    cancel,
    running: state?.phase === "running",
  }
}

const completedStatus = (outcome: HarnessUpdateAllOutcome): string => {
  const summary = harnessUpdateAllSummary(outcome)
  const label = outcome.cancelled ? "Update all cancelled" : "Update all finished"
  const harnesses = `${label}: ${summary.updated} updated, ${summary.failed} failed, ${summary.unsupported} unsupported, ${summary.refreshFailed} refresh errors, ${summary.notRun} not run.`
  const cache = summary.skillsCacheFailed ? "Shared skill cache refresh failed. " : ""
  return `${harnesses}\n${cache}Native skills: ${summary.nativeSkillsUpdated} updated, ${summary.nativeSkillsFailed} failed, ${summary.nativeSkillsNotRun} not run.`
}

const runningStatus = (state: HarnessUpdateAllView): string =>
  state.stage === "skills"
    ? `Updating Native skills: ${state.skillsResults.size}/${state.plan.skills?.targets.length ?? 0} profiles processed.`
    : `Updating harnesses and Container skills: ${state.completedSteps}/${state.plan.nativeUpdateCount + state.plan.containerUpdateCount} commands completed.`

const viewStatus = (state: HarnessUpdateAllView): string => {
  switch (state.phase) {
    case "confirming":
      return confirmationStatus(state)
    case "running":
      return state.cancelling ? "Cancel requested. Completed updates are kept." : runningStatus(state)
    case "done":
      return completedStatus(state.outcome)
    case "error":
      return `Update all could not finish: ${state.message}`
  }
}

const confirmationStatus = (state: HarnessUpdateAllView): string => {
  if (state.checking) return "Checking harness versions and skill sources for available updates..."
  if (state.catalogProfileCount === 0) return "No profiles were discovered."
  if (state.phase === "confirming" && state.message !== undefined) return state.message
  if (hasSelectedAdminUpdates(state.plan)) return "Review the available updates below before you start."
  return state.issues.length > 0 ? "No confirmed updates. Some checks could not finish." : "Everything is up to date."
}
export const HarnessUpdateAllStatus = ({ state }: { readonly state: HarnessUpdateAllView | undefined }) => {
  if (state === undefined) return null
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">{viewStatus(state)}</Text>
      {state.phase === "running" ? <Text dimColor>Profile actions are paused. Press A to view progress or cancel.</Text> : null}
    </Box>
  )
}

type VersionResultFor = (entry: AdminProfileEntry) => AdminHarnessVersionResult | undefined

const profileResultLine = (entry: AdminProfileEntry, state: HarnessUpdateAllView, versionResultFor: VersionResultFor): string => {
  const result = state.results.get(entry.ref)
  const preview = harnessUpgradeVersionPreview(entry, versionResultFor(entry))
  const profile = `\`${entry.ref}\`: ${preview.text}`
  if (result?.state === "failure") return `- **Failed** ${profile}: ${result.diagnostic}`
  if (result?.state === "success") return `- **Updated** ${profile}`
  if (state.activeStep?.targets.some((target) => target.ref === entry.ref) === true) return `- **Running** ${profile}`
  if (state.phase === "confirming" && !state.harnessUpdateRefs.has(entry.ref)) return `- **Skills update** ${profile}`
  const label = state.phase === "confirming" ? "Planned" : state.phase === "done" ? "Not run" : "Queued"
  return `- ${label} ${profile}`
}

const groupLines = (group: HarnessUpdatePlan, state: HarnessUpdateAllView, versionResultFor: VersionResultFor): ReadonlyArray<string> => [
  `### ${group.surface === "native" ? "Native harness" : "Container harness and skills"}: ${group.harness}`,
  ...group.targets.map((entry) => profileResultLine(entry, state, versionResultFor)),
  "",
]

const skillsLines = (state: HarnessUpdateAllView): ReadonlyArray<string> => {
  if (state.plan.skills === undefined) return []
  const cache = state.skillsCache
  const lines = [
    "### Native skills",
    cache?.state === "failure"
      ? `**Shared cache refresh failed:** ${cache.diagnostic}`
      : "Refresh selected skills, then copy and verify the affected profiles.",
  ]
  if (state.sharedSkillsUpdate)
    lines.push(state.skillsCache?.state === "success" ? "- Shared skill cache updated" : "- Shared skill cache update")
  const dependencies = state.plan.skills.targets.filter((entry) => !state.skillUpdateRefs.has(entry.ref))
  if (dependencies.length > 0) lines.push(`Required after harness updates: synchronize managed skills for ${dependencies.length} profiles.`)
  lines.push(...state.plan.skills.targets.flatMap((entry) => skillResultLines(state, entry)))
  return [...lines, ""]
}

const skillResultLines = (state: HarnessUpdateAllView, entry: AdminProfileEntry): ReadonlyArray<string> => {
  const result = state.skillsResults.get(entry.ref)
  if (!state.skillUpdateRefs.has(entry.ref) && result?.state !== "failure") return []
  if (result?.state === "success") return [`- **Skills updated** \`${entry.ref}\``]
  if (result?.state === "failure") return [`- **Skills failed** \`${entry.ref}\`: ${result.diagnostic}`]
  const label = state.phase === "done" || state.skillsCache?.state === "failure" ? "Skills not run" : "Skills update"
  return [`- ${label} \`${entry.ref}\``]
}

const viewBody = (state: HarnessUpdateAllView, versionResultFor: VersionResultFor): string => {
  if (state.checking) return ""
  const issues = state.issues.map(({ ref, diagnostic }) => `- \`${ref}\`: ${diagnostic}`)
  const refreshErrors = state.reports.flatMap((report) =>
    report.refreshError === undefined ? [] : [`- **Version refresh failed** ${report.plan.key}: ${report.refreshError}`],
  )
  return [
    ...refreshErrors,
    "",
    ...(hasSelectedAdminUpdates(state.plan)
      ? ["Available updates only. Current items are hidden.", "Version changes: current -> target."]
      : []),
    "",
    ...state.plan.groups.flatMap((group) => groupLines(group, state, versionResultFor)),
    ...skillsLines(state),
    ...(issues.length > 0 ? ["### Incomplete checks", "Unknown results are not counted as available updates.", ...issues] : []),
  ].join("\n")
}

const skillsOperation = (event: NativeSkillsUpdateEvent | undefined): string => {
  if (event?.kind === "profile-started") return `Copying and verifying skills: ${event.entry.ref}`
  if (event?.kind === "profile-completed") return `Skills ${event.result.state}: ${event.result.ref}`
  return "Refreshing shared Native skill caches."
}

const currentOperation = (state: HarnessUpdateAllView): string | undefined => {
  if (state.phase !== "running") return undefined
  if (state.stage === "skills") return skillsOperation(state.skillsEvent)
  if (state.activePlan === undefined) return undefined
  if (state.activeStep === undefined) return `Reading installed versions: ${state.activePlan.key}`
  const targets = state.activeStep.targets.map((entry) => entry.name).join(", ")
  return `${state.activePlan.key}: ${targets}`
}

const viewHints = (state: HarnessUpdateAllView): string => {
  if (state.phase === "confirming")
    return state.checking || !hasSelectedAdminUpdates(state.plan) ? "[q/Esc] close" : "[y] update selected items  [q/Esc] cancel"
  if (state.phase === "running") return "[c] cancel updates  [q/Esc] back (updates continue)"
  return "[q/Esc] back to list"
}

export const HarnessUpdateAllOverlay = ({
  state,
  columns,
  rows,
  onConfirm,
  onClose,
  onCancel,
}: {
  readonly state: HarnessUpdateAllView
  readonly columns: number
  readonly rows: number
  readonly onConfirm: () => void
  readonly onClose: () => void
  readonly onCancel: () => void
}) => {
  useInput((char, key) => {
    if (key.escape || char === "q") onClose()
    else if (char === "y" && state.phase === "confirming") onConfirm()
    else if (char === "c" && state.phase === "running") onCancel()
  })
  const operation = currentOperation(state)
  const versionResultFor: VersionResultFor = (entry) => state.versionChecks.get(entry.ref)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Update all harnesses and skills
      </Text>
      <Text>Available Native and Container updates, including profiles hidden by filters.</Text>
      <Text>
        Native updates: {state.plan.nativeUpdateCount} | Container builds: {state.plan.containerUpdateCount} | Incomplete checks:{" "}
        {state.issues.length}
      </Text>
      <Text>Native skill copies: {state.plan.skills?.targets.length ?? 0}. Container builds refresh their configured skills.</Text>
      <Text dimColor>Version and source pins are kept. Trellage itself is not updated. Sessions are not restarted.</Text>
      <Text wrap="wrap">{viewStatus(state)}</Text>
      {operation === undefined ? null : <Text wrap="wrap">{operation}</Text>}
      <Box marginTop={1}>
        <MarkdownTextViewport value={viewBody(state, versionResultFor)} width={Math.max(20, columns - 4)} height={Math.max(3, rows - 16)} />
      </Box>
      <Text dimColor>[PgUp/PgDn] scroll through all profiles and results</Text>
      <Text>{viewHints(state)}</Text>
    </Box>
  )
}
