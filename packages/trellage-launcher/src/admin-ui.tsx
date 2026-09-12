/**
 * Ink admin screen: a global table of every discovered TRX/Chellage profile
 * with health/install status, async doctor diagnostics, guide viewing, and a
 * confirmed terminal-launch action. Composes the pure `admin-table.ts`,
 * `admin-model.ts`, `admin-run-manager.ts`, `admin-status.ts`, and
 * `admin-launch.ts` modules; contains no new subprocess or filesystem logic
 * of its own (see module docs for each).
 */
import React, { useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useWindowSize } from "ink"

import { aggregateAdminProfiles, loadAdminProfileGuideBody, toProfileGuideIdentity, type AdminProfileEntry } from "./admin-model.ts"
import { refreshAdminEntries } from "./admin-refresh.ts"
import { AdminRunManager, type AdminRunStatus } from "./admin-run-manager.ts"
import {
  buildAdminLaunchCommand,
  buildDiagnosticCommand,
  isRepairSupported,
  launchAdminProfile,
  repairRefFor,
  repairThenRecheckDoctor,
  setupRefFor,
} from "./admin-launch.ts"
import { controlsForStatus, historyScopeLabel, statusLabel, type AdminStatus } from "./admin-status.ts"
import type { AdminSortKey } from "./admin-table.ts"
import { adminProfileType, adminTableColumnWidths, filterAdminProfiles, resolveAdminViewState, sortAdminProfiles } from "./admin-table.ts"
import { runBatchedDoctorChecks } from "./admin-batch-scheduler.ts"
import { selectPendingDiagnosisTargets, selectPendingRepairTargets, shouldStartBatch } from "./admin-diagnosis-dispatch.ts"
import { DoctorFailureDiagnosisProvider, type DoctorFailureDiagnosisResult } from "./admin-diagnosis-provider.ts"
import { forkFailureToHerdrWorktree, isForkToHerdrAvailable, type HerdrForkOutcome } from "./admin-herdr-fork.ts"
import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import type { CommandRunner, HerdrEnvironment } from "./guide-launch.ts"
import { CommandRunnerError } from "./guide-launch.ts"
import { MarkdownTextViewport, spinnerFrameAt } from "./guide-ui.tsx"
import { type AdminVersionColumns } from "./admin-version-check.ts"
import {
  harnessVersionEntriesForForceResync,
  harnessVersionColumnsFor,
  harnessVersionOperationKeyFor,
  reconcileHarnessVersionResults,
  refreshedSandboxInstalledState,
  type AdminHarnessVersionResult,
  type AdminInstalledVersionState,
} from "./admin-harness-version.ts"
import {
  createHarnessVersionCacheSaveQueue,
  defaultAdminHarnessVersionCachePath,
  loadHarnessVersionCache,
  type AdminHarnessVersionCacheEntry,
  type AdminHarnessVersionCacheRecord,
} from "./admin-harness-version-cache.ts"
import {
  harnessVersionRefFor,
  harnessVersionResultForOperation,
  runBatchedHarnessVersionChecks,
} from "./admin-harness-version-scheduler.ts"
import {
  HarnessUpdateManager,
  harnessUpdateKeyFor,
  harnessUpdatePlanFor,
  refreshHarnessUpdateVersions,
  type HarnessUpdateOutcome,
  type HarnessUpdatePlan,
} from "./admin-harness-update.ts"
import { buildInventoryCommand, parseInventoryOutput, type AdminInventoryOutcome } from "./admin-inventory.ts"
import { refreshHarnessUpdateGroupVersions } from "./admin-harness-update-all.ts"
import { HarnessUpdateAllOverlay, HarnessUpdateAllStatus, useHarnessUpdateAll } from "./admin-harness-update-all-ui.tsx"
import { checkAdminHarnessUpdates } from "./admin-harness-update-discovery.ts"
import { checkAdminSkillsUpdates } from "./admin-skills-check.ts"

type DiagnosisState =
  | { readonly status: "diagnosing" }
  | { readonly status: "done"; readonly result: DoctorFailureDiagnosisResult }
  | { readonly status: "error"; readonly message: string }

type HarnessUpdateState =
  | { readonly status: "running"; readonly targetCount: number; readonly surface: AdminProfileEntry["surface"] }
  | { readonly status: "done"; readonly outcome: HarnessUpdateOutcome }
  | { readonly status: "error"; readonly message: string }

const sortCycle: ReadonlyArray<AdminSortKey> = ["name", "health", "install", "surface"]

const runStatusOf = (entry: AdminProfileEntry, snapshot: AdminRunStatus): AdminStatus => {
  if (!entry.doctorSupported) return "unsupported"
  if (snapshot.state === "idle" && entry.health === "malformed-output") return "malformed-output"
  return snapshot.state
}

/**
 * Renders a status's required plain-text label (see `admin-status.ts`) and,
 * only while `running`, an additional animated spinner glyph in front of
 * it. The glyph is always paired with the unchanged plain-text label so
 * status is never communicated by color/animation alone — it is a visual
 * accent, not a replacement for the text.
 */
const StatusText = ({ status, tick, bold = false, dimColor = false }: { readonly status: AdminStatus; readonly tick: number; readonly bold?: boolean; readonly dimColor?: boolean }) => (
  <Text bold={bold} dimColor={dimColor}>
    {status === "running" ? <Text color="cyan">{spinnerFrameAt(tick)} </Text> : null}
    {statusLabel(status)}
  </Text>
)

/**
 * Colors a `VERSION`/`LATEST VERSION` cell by comparison status: green when
 * a completed check confirms the installed release matches the latest
 * (`"match"`), yellow when a completed check names a newer release
 * (`"mismatch"` — orange isn't part of Ink's base 16-color palette, so
 * yellow is the closest accessible equivalent), or plain/dim when the
 * launcher doesn't support checks, no check has run yet, or the result was
 * malformed (`"unknown"`) — color is always an accent on top of the same
 * readable text, never the only way the state is conveyed.
 */
const versionCellColor = (status: AdminVersionColumns["status"]): "green" | "yellow" | undefined =>
  status === "match" ? "green" : status === "mismatch" ? "yellow" : undefined

/**
 * Renders `[key] label` shortcut hints with the bracketed key highlighted
 * in bold cyan so it visually pops out from the surrounding text, while
 * keeping every label as ordinary plain text — color is always an accent
 * on top of readable text, never the only way meaning is conveyed.
 */
const ShortcutHints = ({ items }: { readonly items: ReadonlyArray<{ readonly key: string; readonly label: string }> }) =>
  items.length === 0 ? null : (
    <Text>
      {items.map((item, index) => (
        <Text key={item.key}>
          {index > 0 ? "   " : ""}
          <Text bold color="cyan">
            [{item.key}]
          </Text>{" "}
          <Text dimColor>{item.label}</Text>
        </Text>
      ))}
    </Text>
  )

const HarnessVersionDetail = ({
  supported,
  result,
  running,
  tick,
}: {
  readonly supported: boolean
  readonly result: AdminHarnessVersionResult | undefined
  readonly running: boolean
  readonly tick: number
}) => {
  if (!supported) return <Text dimColor>Harness version: not supported by this launcher.</Text>
  const columns = harnessVersionColumnsFor(true, result)
  const color = versionCellColor(columns.status)
  const valueStyle = color === undefined ? {} : { color }
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        Harness version:{" "}
        {running ? (
          <Text color="cyan">{spinnerFrameAt(tick)} checking…</Text>
        ) : (
          <Text bold {...valueStyle}>
            {columns.installed}
          </Text>
        )}
        {" · Latest version: "}
        {running ? (
          <Text color="cyan">{spinnerFrameAt(tick)} checking…</Text>
        ) : result === undefined ? (
          <Text dimColor>not yet checked</Text>
        ) : (
          <Text bold {...valueStyle}>
            {columns.latest}
          </Text>
        )}
      </Text>
      {result?.installed.kind === "unavailable" ? (
        <Text dimColor wrap="wrap">
          {result.installed.diagnostic}
        </Text>
      ) : null}
      {result?.latest.kind === "failed" ? (
        <Text color="red" wrap="wrap">
          {result.latest.diagnostic}
        </Text>
      ) : null}
    </Box>
  )
}

const harnessUpdateSurfaceLabel = (surface: AdminProfileEntry["surface"]): string =>
  surface === "sandbox" ? "container" : "native"

const CompletedHarnessUpdate = ({ outcome }: { readonly outcome: HarnessUpdateOutcome }) => {
  const failures = outcome.results.filter((result) => result.state === "failure")
  return (
    <Text dimColor wrap="wrap">
      Updated {outcome.results.length - failures.length}/{outcome.results.length} {outcome.harness}{" "}
      {harnessUpdateSurfaceLabel(outcome.surface)} profiles.
      {failures.length === 0
        ? ""
        : ` Failed: ${failures.map((result) => `${result.name}: ${result.diagnostic}`).join("; ")}.`}
    </Text>
  )
}

const HarnessUpdateStatus = ({ state, tick }: { readonly state: HarnessUpdateState | undefined; readonly tick: number }) => {
  if (state === undefined) return null
  if (state.status === "running") {
    return (
      <Text color="cyan">
        {spinnerFrameAt(tick)} Updating {state.targetCount} {harnessUpdateSurfaceLabel(state.surface)} profiles…
      </Text>
    )
  }
  if (state.status === "error") {
    return (
      <Text color="red" wrap="wrap">
        Harness update or version refresh failed: {state.message}
      </Text>
    )
  }
  return <CompletedHarnessUpdate outcome={state.outcome} />
}

const HarnessUpdateControl = ({
  plan,
  state,
  tick,
  confirming,
}: {
  readonly plan: HarnessUpdatePlan | undefined
  readonly state: HarnessUpdateState | undefined
  readonly tick: number
  readonly confirming: boolean
}) => {
  const canUpdate = plan !== undefined && state?.status !== "running"

  if (plan === undefined && state === undefined) return null
  return (
    <Box flexDirection="column">
      {canUpdate ? <ShortcutHints items={[{ key: "U", label: "update harness" }]} /> : null}
      {confirming && plan !== undefined ? (
        <Text color="yellow" wrap="wrap">
          Press [y] to update {plan.harness} for all {plan.targets.length} {harnessUpdateSurfaceLabel(plan.surface)} profiles,
          or any other key to cancel.{" "}
          {plan.latestVersion === undefined
            ? "The update command will resolve the configured version."
            : `Latest reported: ${plan.latestVersion}. Existing version pins are preserved.`}
        </Text>
      ) : null}
      <HarnessUpdateStatus state={state} tick={tick} />
    </Box>
  )
}

type DetailConfirmation = "launch" | "fork" | "repair" | "harness-update"

const forkOutcomeMessage = (outcome: HerdrForkOutcome): string => {
  if (outcome.kind === "launched") return `Forked to a new Herdr worktree: ${outcome.result.checkoutPath}`
  if (outcome.kind === "unavailable") return "Herdr is not available in this session."
  if (outcome.kind === "not-ready") return `Worktree is not ready to create (${outcome.inspection.kind}).`
  return outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
}

const repairStatusNote = (
  repairMessage: string | undefined,
  repairState: AdminRunStatus["state"],
  setupState: AdminRunStatus["state"],
  doctorStatus: AdminStatus,
): string | undefined => {
  if (repairMessage !== undefined) return repairMessage
  if (repairState === "idle") return undefined
  if (setupState === "idle") return `Repair ${repairState} (recheck: ${statusLabel(doctorStatus)}).`
  return `Repair ${repairState}, setup ${setupState} (recheck: ${statusLabel(doctorStatus)}).`
}

const DetailSummary = ({
  entry,
  versionResult,
  versionRunning,
  tick,
}: {
  readonly entry: AdminProfileEntry
  readonly versionResult: AdminHarnessVersionResult | undefined
  readonly versionRunning: boolean
  readonly tick: number
}) => (
  <>
    <Text bold color="cyan">
      {entry.name}{" "}
      <Text dimColor>
        · {entry.surface}
        {entry.launcher === undefined ? "" : ` · ${entry.launcher}`}
      </Text>
    </Text>
    <Text wrap="wrap">{entry.description}</Text>
    <Text>
      Health: <Text bold>{entry.health}</Text> · Install: <Text bold>{entry.install}</Text>
    </Text>
    <HarnessVersionDetail
      supported={entry.harnessVersionSupported}
      result={versionResult}
      running={versionRunning}
      tick={tick}
    />
    {entry.healthDiagnostic === undefined ? null : (
      <Text dimColor wrap="wrap">
        {entry.healthDiagnostic}
      </Text>
    )}
  </>
)

const DoctorPanel = ({
  entry,
  snapshot,
  status,
  controls,
  canFork,
  canRepair,
  versionRunning,
  tick,
}: {
  readonly entry: AdminProfileEntry
  readonly snapshot: AdminRunStatus
  readonly status: AdminStatus
  readonly controls: ReturnType<typeof controlsForStatus>
  readonly canFork: boolean
  readonly canRepair: boolean
  readonly versionRunning: boolean
  readonly tick: number
}) => {
  const shortcutItems = [
    controls.canTrigger ? { key: "d", label: "run doctor" } : undefined,
    controls.canCancel ? { key: "c", label: "cancel" } : undefined,
    controls.canRetry ? { key: "r", label: "retry" } : undefined,
    { key: "g", label: "view guide" },
    entry.inventorySupported ? { key: "i", label: "view inventory" } : undefined,
    { key: "l", label: "launch in terminal" },
    canFork ? { key: "f", label: "fork to fix" } : undefined,
    canRepair ? { key: "p", label: "repair profile" } : undefined,
    entry.harnessVersionSupported && !versionRunning ? { key: "u", label: "resync version" } : undefined,
  ].filter((item): item is { readonly key: string; readonly label: string } => item !== undefined)
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        Doctor status: <StatusText status={status} tick={tick} bold /></Text>
      {snapshot.latest === undefined ? null : (
        <Text dimColor wrap="wrap">
          {(snapshot.latest.stdout || snapshot.latest.stderr || "").slice(0, 4000)}
        </Text>
      )}
      {snapshot.history.length === 0 ? null : (
        <Text dimColor>
          {historyScopeLabel} ({snapshot.history.length} run{snapshot.history.length === 1 ? "" : "s"} recorded)
        </Text>
      )}
      <Box marginTop={1} paddingX={1} borderStyle="round" borderColor="gray" flexDirection="column">
        <ShortcutHints items={shortcutItems} />
      </Box>
    </Box>
  )
}

const DiagnosisPanel = ({
  diagnosis,
  herdrAvailable,
}: {
  readonly diagnosis: DiagnosisState | undefined
  readonly herdrAvailable: boolean | undefined
}) => {
  if (diagnosis === undefined) return null
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        Copilot diagnosis
      </Text>
      {diagnosis.status === "diagnosing" ? <Text color="yellow">Diagnosing failure…</Text> : null}
      {diagnosis.status === "error" ? (
        <Text color="yellow" wrap="wrap">
          Diagnosis unavailable: {diagnosis.message}
        </Text>
      ) : null}
      {diagnosis.status === "done" ? (
        <Box flexDirection="column">
          <Text wrap="wrap">{diagnosis.result.summary}</Text>
          <Text wrap="wrap" dimColor>
            Suggested fix: {diagnosis.result.suggestedFix}
          </Text>
          {herdrAvailable === false ? <Text dimColor>Herdr is unavailable in this session; fork to fix is disabled.</Text> : null}
        </Box>
      ) : null}
    </Box>
  )
}

const ConfirmationPrompt = ({
  confirmation,
  entry,
}: {
  readonly confirmation: DetailConfirmation | undefined
  readonly entry: AdminProfileEntry
}) => {
  if (confirmation === "launch") {
    return <Text color="yellow">Press [y] to hand this terminal to {entry.name} now, or any other key to cancel.</Text>
  }
  if (confirmation === "fork") {
    return (
      <Text color="yellow">
        Press [y] to create a new Herdr worktree and hand it {entry.name}&apos;s suggested fix now, or any other key to cancel.
      </Text>
    )
  }
  if (confirmation === "repair") {
    return (
      <Text color="yellow">
        Press [y] to run {entry.name}&apos;s repair (and setup, if still needed) now and recheck doctor afterward, or any other key to
        cancel.
      </Text>
    )
  }
  return null
}

const DetailMessages = ({
  launchMessage,
  forkMessage,
  repairNote,
}: {
  readonly launchMessage: string | undefined
  readonly forkMessage: string | undefined
  readonly repairNote: string | undefined
}) => (
  <>
    {launchMessage === undefined ? null : <Text dimColor>{launchMessage}</Text>}
    {forkMessage === undefined ? null : (
      <Text dimColor wrap="wrap">
        {forkMessage}
      </Text>
    )}
    {repairNote === undefined ? null : (
      <Text dimColor wrap="wrap">
        {repairNote}
      </Text>
    )}
  </>
)

interface DetailInputOptions {
  readonly confirmation: DetailConfirmation | undefined
  readonly entry: AdminProfileEntry
  readonly controls: ReturnType<typeof controlsForStatus>
  readonly canFork: boolean
  readonly canRepair: boolean
  readonly versionRunning: boolean
  readonly confirmLaunch: () => void
  readonly confirmFork: () => void
  readonly confirmRepair: () => void
  readonly cancelConfirmation: () => void
  readonly runOrRetryDoctor: () => void
  readonly cancelDoctor: () => void
  readonly onOpenGuide: (entry: AdminProfileEntry) => void
  readonly onOpenInventory: (entry: AdminProfileEntry) => void
  readonly setConfirmation: (confirmation: DetailConfirmation) => void
  readonly onForceResyncVersion: (entry: AdminProfileEntry) => void
  readonly harnessUpdatePlan: HarnessUpdatePlan | undefined
  readonly onUpdateHarness: (plan: HarnessUpdatePlan) => void
}

const handleDetailConfirmation = (input: string, options: DetailInputOptions): boolean => {
  if (options.confirmation === undefined) return false
  if (input === "y") {
    if (options.confirmation === "launch") options.confirmLaunch()
    if (options.confirmation === "fork") options.confirmFork()
    if (options.confirmation === "repair") options.confirmRepair()
    if (options.confirmation === "harness-update" && options.harnessUpdatePlan !== undefined)
      options.onUpdateHarness(options.harnessUpdatePlan)
  }
  options.cancelConfirmation()
  return true
}

const handleDoctorInput = (input: string, options: DetailInputOptions): boolean => {
  if ((input === "d" || input === "r") && (options.controls.canTrigger || options.controls.canRetry)) {
    options.runOrRetryDoctor()
    return true
  }
  if (input === "c" && options.controls.canCancel) {
    options.cancelDoctor()
    return true
  }
  return false
}

const handleDetailShortcut = (input: string, options: DetailInputOptions): void => {
  if (handleDoctorInput(input, options)) return
  if (input === "g") options.onOpenGuide(options.entry)
  else if (input === "i" && options.entry.inventorySupported) options.onOpenInventory(options.entry)
  else if (input === "l") options.setConfirmation("launch")
  else if (input === "f" && options.canFork) options.setConfirmation("fork")
  else if (input === "p" && options.canRepair) options.setConfirmation("repair")
  else if (input === "u" && options.entry.harnessVersionSupported && !options.versionRunning)
    options.onForceResyncVersion(options.entry)
  else if (input === "U" && options.harnessUpdatePlan !== undefined) options.setConfirmation("harness-update")
}

const AdminDetailPanel = ({
  entry,
  runManager,
  diagnosis,
  herdrAvailable,
  onForkToFix,
  onOpenGuide,
  onOpenInventory,
  tick,
  versionResult,
  versionRunning,
  onForceResyncVersion,
  harnessUpdatePlan,
  harnessUpdateState,
  onUpdateHarness,
  onConfirmationChange,
  inputActive,
}: {
  readonly entry: AdminProfileEntry
  readonly runManager: AdminRunManager
  readonly diagnosis: DiagnosisState | undefined
  readonly herdrAvailable: boolean | undefined
  readonly onForkToFix: (entry: AdminProfileEntry, diagnosis: DoctorFailureDiagnosisResult | undefined) => Promise<HerdrForkOutcome>
  readonly onOpenGuide: (entry: AdminProfileEntry) => void
  readonly onOpenInventory: (entry: AdminProfileEntry) => void
  readonly tick: number
  readonly versionResult: AdminHarnessVersionResult | undefined
  readonly versionRunning: boolean
  readonly onForceResyncVersion: (entry: AdminProfileEntry) => void
  readonly harnessUpdatePlan: HarnessUpdatePlan | undefined
  readonly harnessUpdateState: HarnessUpdateState | undefined
  readonly onUpdateHarness: (plan: HarnessUpdatePlan) => void
  readonly onConfirmationChange: (active: boolean) => void
  readonly inputActive: boolean
}) => {
  const [, forceRender] = useState(0)
  const [confirmation, setConfirmation] = useState<DetailConfirmation | undefined>(undefined)
  const [launchMessage, setLaunchMessage] = useState<string | undefined>(undefined)
  const [forkMessage, setForkMessage] = useState<string | undefined>(undefined)
  const [repairMessage, setRepairMessage] = useState<string | undefined>(undefined)

  useEffect(() => {
    setConfirmation(undefined)
    onConfirmationChange(false)
    setLaunchMessage(undefined)
    setForkMessage(undefined)
    setRepairMessage(undefined)
    return () => onConfirmationChange(false)
  }, [entry.ref, onConfirmationChange])

  const updateConfirmation = (next: DetailConfirmation | undefined) => {
    setConfirmation(next)
    onConfirmationChange(next !== undefined)
  }

  const snapshot = runManager.status(entry.ref)
  const status = runStatusOf(entry, snapshot)
  const controls = controlsForStatus(status)
  const repairSnapshot = runManager.status(repairRefFor(entry))
  const setupSnapshot = runManager.status(setupRefFor(entry))
  const canRepair = isRepairSupported(entry) && controls.canRetry && repairSnapshot.state !== "running" && setupSnapshot.state !== "running"
  const repairNote = repairStatusNote(repairMessage, repairSnapshot.state, setupSnapshot.state, status)

  const runOrRetryDoctor = () => {
    const command = buildDiagnosticCommand(entry)
    const action = controls.canRetry
      ? runManager.retry(entry.ref, command.executable, command.args)
      : runManager.trigger(entry.ref, command.executable, command.args)
    void action.finally(() => forceRender((value) => value + 1))
    forceRender((value) => value + 1)
  }

  const cancelDoctor = () => {
    runManager.cancel(entry.ref)
    forceRender((value) => value + 1)
  }

  /**
   * Runs the profile's existing `repair PROFILE` subcommand exactly once
   * (the same real, documented action `omp repair`/`cldx repair`/etc.
   * already expose), tracked under `repairRefFor(entry)` so it never
   * overwrites the profile's own doctor history, then automatically
   * re-triggers the doctor check to recheck. If that recheck is still not
   * healthy, `repairThenRecheckDoctor` automatically escalates to the
   * profile's `setup PROFILE` subcommand once as well (e.g. `omp`'s
   * "installed version receipt is missing" case, which only `setup` can
   * create) and rechecks doctor again. Shares `repairThenRecheckDoctor`
   * with the on-load auto-repair dispatch in `AdminRoot` so a manual `[p]`
   * press and an automatic repair behave identically. Never parses or
   * executes the Copilot-suggested-fix text itself; this always runs the
   * same fixed, safe commands the profile's own launcher already exposes.
   */
  const confirmRepair = () => {
    setRepairMessage(`Running ${entry.name}'s repair…`)
    repairThenRecheckDoctor(entry, runManager)
      .then((outcome) => {
        const setupNote = outcome.setupState === undefined ? "" : ` Setup also attempted (${outcome.setupState}).`
        setRepairMessage(`Repair attempted; doctor recheck: ${outcome.doctorState}.${setupNote}`)
      })
      .catch((error: unknown) => setRepairMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => forceRender((value) => value + 1))
  }

  const confirmLaunch = () => {
    launchAdminProfile(entry, true)
      .then(() => setLaunchMessage(`Handed the terminal to ${entry.name}.`))
      .catch((error: unknown) => setLaunchMessage(error instanceof Error ? error.message : String(error)))
  }

  const canFork = diagnosis?.status === "done" && herdrAvailable === true
  const confirmFork = () => {
    setForkMessage(`Creating a Herdr worktree to fix ${entry.name}…`)
    onForkToFix(entry, diagnosis?.status === "done" ? diagnosis.result : undefined)
      .then((outcome) => setForkMessage(forkOutcomeMessage(outcome)))
      .catch((error: unknown) => setForkMessage(error instanceof Error ? error.message : String(error)))
  }

  useInput((input) => {
    const options: DetailInputOptions = {
      confirmation,
      entry,
      controls,
      canFork,
      canRepair,
      versionRunning,
      confirmLaunch,
      confirmFork,
      confirmRepair,
      cancelConfirmation: () => updateConfirmation(undefined),
      runOrRetryDoctor,
      cancelDoctor,
      onOpenGuide,
      onOpenInventory,
      setConfirmation: updateConfirmation,
      onForceResyncVersion,
      harnessUpdatePlan: harnessUpdateState?.status === "running" ? undefined : harnessUpdatePlan,
      onUpdateHarness,
    }
    if (!handleDetailConfirmation(input, options)) handleDetailShortcut(input, options)
  }, { isActive: inputActive })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <DetailSummary entry={entry} versionResult={versionResult} versionRunning={versionRunning} tick={tick} />
      <DoctorPanel
        entry={entry}
        snapshot={snapshot}
        status={status}
        controls={controls}
        canFork={canFork}
        canRepair={canRepair}
        versionRunning={versionRunning}
        tick={tick}
      />
      <DiagnosisPanel diagnosis={diagnosis} herdrAvailable={herdrAvailable} />
      <ConfirmationPrompt confirmation={confirmation} entry={entry} />
      <DetailMessages launchMessage={launchMessage} forkMessage={forkMessage} repairNote={repairNote} />
      <HarnessUpdateControl
        plan={harnessUpdatePlan}
        state={harnessUpdateState}
        tick={tick}
        confirming={confirmation === "harness-update"}
      />
      <Box marginTop={1} paddingX={1} borderStyle="round" borderColor="gray">
        <ShortcutHints items={[{ key: "j/k", label: "move selection" }, { key: "q", label: "quit" }]} />
      </Box>
    </Box>
  )
}

/**
 * Renders a profile's Markdown guide as a dedicated full-screen overlay that
 * replaces the table/detail view entirely rather than a small inline
 * scrollbox, so long guides get the whole terminal to read. `[q]`/Escape are
 * handled one level up in `AdminApp` (not here) so they close the overlay
 * back to the main list instead of exiting the whole app; PageUp/PageDown
 * scrolling is handled internally by `MarkdownTextViewport`.
 */
const GuideOverlay = ({
  entry,
  body,
  note,
  columns,
  rows,
}: {
  readonly entry: AdminProfileEntry
  readonly body: string | undefined
  readonly note: string | undefined
  readonly columns: number
  readonly rows: number
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">
        {entry.name} guide{" "}
        <Text dimColor>
          · {entry.surface}
          {entry.launcher === undefined ? "" : ` · ${entry.launcher}`}
        </Text>
      </Text>
    </Box>
    {note === undefined ? null : (
      <Text color="yellow" wrap="wrap">
        {note}
      </Text>
    )}
    {note === undefined && body === undefined ? <Text dimColor>Loading guide…</Text> : null}
    {body === undefined ? null : (
      <Box marginTop={1}>
        <MarkdownTextViewport value={body} width={Math.max(20, columns - 4)} height={Math.max(6, rows - 6)} resetKey={entry.ref} />
      </Box>
    )}
    <Box marginTop={1} paddingX={1} borderStyle="round" borderColor="gray">
      <ShortcutHints items={[{ key: "PageUp/PageDown", label: "scroll" }, { key: "q/Esc", label: "back to list" }]} />
    </Box>
  </Box>
)

const InventoryPlugins = ({ outcome }: { readonly outcome: Exclude<AdminInventoryOutcome, { readonly malformed: true }> }) => (
  <Box marginTop={1} flexDirection="column">
    <Text bold color="cyan">
      Plugins ({outcome.plugins.length})
    </Text>
    {outcome.plugins.length === 0 ? (
      <Text dimColor>None reported.</Text>
    ) : (
      outcome.plugins.map((plugin) => (
        <Text key={plugin.name}>
          · {plugin.name}
          {plugin.version === undefined ? "" : ` (${plugin.version})`}
        </Text>
      ))
    )}
  </Box>
)

const InventorySkills = ({ outcome }: { readonly outcome: Exclude<AdminInventoryOutcome, { readonly malformed: true }> }) => (
  <Box marginTop={1} flexDirection="column">
    <Text bold color="cyan">
      Skills
    </Text>
    <Text>
      {outcome.skills.visibleCount === undefined ? "visible: unknown" : `visible: ${outcome.skills.visibleCount}`}
      {" · "}
      {outcome.skills.packageCount === undefined ? "packages: unknown" : `packages: ${outcome.skills.packageCount}`}
    </Text>
    <Text dimColor wrap="wrap">
      Skills are managed as one shared bundle pinned to a single commit per profile, not individually versioned, so only counts are
      available.
    </Text>
  </Box>
)

const InventoryMcps = ({ outcome }: { readonly outcome: Exclude<AdminInventoryOutcome, { readonly malformed: true }> }) => (
  <Box marginTop={1} flexDirection="column">
    <Text bold color="cyan">
      MCP servers ({outcome.mcps.length})
    </Text>
    {outcome.mcps.length === 0 ? (
      <Text dimColor>None reported.</Text>
    ) : (
      outcome.mcps.map((name) => <Text key={name}>· {name}</Text>)
    )}
  </Box>
)

const InventoryDetails = ({ outcome }: { readonly outcome: Exclude<AdminInventoryOutcome, { readonly malformed: true }> }) => (
  <Box marginTop={1} flexDirection="column">
    <Text>
      Readiness: <Text bold>{outcome.readiness}</Text>
    </Text>
    <InventoryPlugins outcome={outcome} />
    <InventorySkills outcome={outcome} />
    <InventoryMcps outcome={outcome} />
  </Box>
)

const InventoryContent = ({
  status,
  outcome,
  message,
}: {
  readonly status: "loading" | "done" | "error"
  readonly outcome: AdminInventoryOutcome | undefined
  readonly message: string | undefined
}) => {
  if (status === "loading") return <Text dimColor>Loading inventory…</Text>
  if (status === "error") {
    return (
      <Text color="yellow" wrap="wrap">
        {message ?? "Inventory is unavailable."}
      </Text>
    )
  }
  if (outcome === undefined) return null
  if (outcome.malformed === true) {
    return (
      <Text color="yellow" wrap="wrap">
        {outcome.diagnostic}
      </Text>
    )
  }
  return <InventoryDetails outcome={outcome} />
}

/**
 * Renders a profile's install detail — plugins, skill counts, and MCP
 * servers — from the existing `inventory PROFILE --json` command (already
 * used read-only by `guide-preflight.ts`'s readiness check) as a
 * full-screen overlay, mirroring `GuideOverlay` exactly: `[q]`/Escape are
 * handled one level up in `AdminApp` so they return to the main list
 * rather than exiting the app. Skills are reported only as counts because
 * this architecture pins skills to one shared git commit per profile
 * rather than versioning them individually (see `admin-inventory.ts`) —
 * this view never fabricates a per-skill version it cannot know.
 */
const InventoryOverlay = ({
  entry,
  status,
  outcome,
  message,
}: {
  readonly entry: AdminProfileEntry
  readonly status: "loading" | "done" | "error"
  readonly outcome: AdminInventoryOutcome | undefined
  readonly message: string | undefined
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Box borderStyle="round" borderColor="blue" paddingX={1} justifyContent="space-between">
      <Text bold color="blue">
        {entry.name} inventory{" "}
        <Text dimColor>
          · {entry.surface}
          {entry.launcher === undefined ? "" : ` · ${entry.launcher}`}
        </Text>
      </Text>
    </Box>
    <InventoryContent status={status} outcome={outcome} message={message} />
    <Box marginTop={1} paddingX={1} borderStyle="round" borderColor="gray">
      <ShortcutHints items={[{ key: "q/Esc", label: "back to list" }]} />
    </Box>
  </Box>
)

interface AdminInputKey {
  readonly ctrl: boolean
  readonly escape: boolean
  readonly return: boolean
  readonly backspace: boolean
  readonly delete: boolean
  readonly downArrow: boolean
  readonly upArrow: boolean
}

interface AdminListInputOptions {
  readonly exit: () => void
  readonly openHarnessUpdates: () => void
  readonly sortedLength: number
  readonly setSearching: (value: boolean) => void
  readonly setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
  readonly setSortIndex: React.Dispatch<React.SetStateAction<number>>
  readonly setSortDescending: React.Dispatch<React.SetStateAction<boolean>>
}

const handleOverlayInput = (
  char: string,
  key: AdminInputKey,
  guideOpen: boolean,
  inventoryOpen: boolean,
  closeGuide: () => void,
  closeInventory: () => void,
): boolean => {
  if (guideOpen) {
    if (char === "q" || key.escape) closeGuide()
    return true
  }
  if (inventoryOpen) {
    if (char === "q" || key.escape) closeInventory()
    return true
  }
  return false
}

const handleSearchInput = (
  char: string,
  key: AdminInputKey,
  setSearching: (value: boolean) => void,
  setQuery: React.Dispatch<React.SetStateAction<string>>,
): void => {
  if (key.return || key.escape) {
    setSearching(false)
    return
  }
  if (key.backspace || key.delete) {
    setQuery((value) => value.slice(0, -1))
    return
  }
  if (char.length === 1) setQuery((value) => value + char)
}

const handleAdminListInput = (char: string, key: AdminInputKey, options: AdminListInputOptions): void => {
  if (char === "/") options.setSearching(true)
  else if (char === "A") options.openHarnessUpdates()
  else if (char === "q" || key.escape) options.exit()
  else if (char === "j" || key.downArrow)
    options.setSelectedIndex((value) => Math.min(options.sortedLength - 1, value + 1))
  else if (char === "k" || key.upArrow) options.setSelectedIndex((value) => Math.max(0, value - 1))
  else if (char === "s") options.setSortIndex((value) => (value + 1) % sortCycle.length)
  else if (char === "S") options.setSortDescending((value) => !value)
}

const profileWorkIsRunning = (entry: AdminProfileEntry, manager: AdminRunManager): boolean =>
  [entry.ref, repairRefFor(entry), setupRefFor(entry)].some((ref) => manager.status(ref).state === "running")

const AdminListHeader = ({
  profileCount,
  sortIndex,
  sortDescending,
  searching,
  query,
  updateAllRunning,
  versionCacheError,
}: {
  readonly profileCount: number
  readonly sortIndex: number
  readonly sortDescending: boolean
  readonly searching: boolean
  readonly query: string
  readonly updateAllRunning: boolean
  readonly versionCacheError: string | undefined
}) => (
  <>
    <Box justifyContent="space-between">
      <Text bold color="cyan">Trellage Admin — {profileCount} profiles</Text>
      <Text dimColor>
        sort: {sortCycle[sortIndex]}
        {sortDescending ? " ↓" : " ↑"}
      </Text>
    </Box>
    {searching ? <Text dimColor>Search: {query}█</Text> : (
      <ShortcutHints items={[
        { key: "A", label: updateAllRunning ? "view update progress" : "update all" },
        { key: "/", label: "search" },
        { key: "s", label: "sort" },
        { key: "S", label: "reverse" },
        { key: "j/k", label: "move" },
        { key: "q", label: "quit" },
      ]} />
    )}
    {versionCacheError === undefined ? null : (
      <Text color="red" wrap="wrap">Harness-version cache error: {versionCacheError}</Text>
    )}
  </>
)

export const AdminApp = ({
  entries,
  runManager,
  guideRoot,
  runner,
  diagnosisProvider,
  herdrEnv,
  cwd,
  routerCommandPath = "trx",
}: {
  readonly entries: ReadonlyArray<AdminProfileEntry>
  readonly runManager: AdminRunManager
  readonly guideRoot: string
  readonly runner: CommandRunner
  readonly diagnosisProvider: DoctorFailureDiagnosisProvider
  readonly herdrEnv: HerdrEnvironment
  readonly cwd: string
  readonly routerCommandPath?: string
}) => {
  const { exit } = useApp()
  const { rows, columns } = useWindowSize()
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [sortIndex, setSortIndex] = useState(0)
  const [sortDescending, setSortDescending] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [detailConfirmationActive, setDetailConfirmationActive] = useState(false)
  const [tick, setTick] = useState(0)
  const [diagnosisByRef, setDiagnosisByRef] = useState<ReadonlyMap<string, DiagnosisState>>(new Map())
  const [herdrAvailable, setHerdrAvailable] = useState<boolean | undefined>(undefined)
  const [guideOverlay, setGuideOverlay] = useState<
    { readonly entry: AdminProfileEntry; readonly body: string | undefined; readonly note: string | undefined } | undefined
  >(undefined)
  const [inventoryOverlay, setInventoryOverlay] = useState<
    | {
        readonly entry: AdminProfileEntry
        readonly status: "loading" | "done" | "error"
        readonly outcome: AdminInventoryOutcome | undefined
        readonly message: string | undefined
      }
    | undefined
  >(undefined)
  const batchStartedRefs = useRef<Set<string>>(new Set())
  const diagnosedRefs = useRef<Set<string>>(new Set())
  const repairAttemptedRefs = useRef<Set<string>>(new Set())
  const versionRunManagerRef = useRef<AdminRunManager | undefined>(undefined)
  if (versionRunManagerRef.current === undefined) versionRunManagerRef.current = new AdminRunManager({ runner })
  const versionRunManager = versionRunManagerRef.current
  const versionBatchStartedRefs = useRef<Set<string>>(new Set())
  const [versionCache, setVersionCache] = useState<AdminHarnessVersionCacheRecord>({ schemaVersion: 2, entries: {} })
  const [versionCacheError, setVersionCacheError] = useState<string | undefined>(undefined)
  const [sandboxInstalledByRef, setSandboxInstalledByRef] = useState<ReadonlyMap<string, AdminInstalledVersionState>>(
    new Map(),
  )
  const [versionCacheLoaded, setVersionCacheLoaded] = useState(false)
  const [harnessUpdateByKey, setHarnessUpdateByKey] = useState<ReadonlyMap<string, HarnessUpdateState>>(new Map())
  const harnessUpdateManager = useMemo(() => new HarnessUpdateManager(runner, cwd), [runner, cwd])
  const versionCachePath = useMemo(() => defaultAdminHarnessVersionCachePath(), [])
  const versionCacheSaveQueue = useMemo(() => createHarnessVersionCacheSaveQueue(versionCachePath), [versionCachePath])

  /**
   * Opens the full-screen guide overlay immediately (showing a loading
   * state) and asynchronously fills in its body/note once
   * `loadAdminProfileGuideBody` resolves. Guards every update against the
   * overlay having since been closed or switched to a different profile, so
   * a slow load for one entry can never clobber a newer overlay.
   */
  const openGuideOverlay = (entry: AdminProfileEntry) => {
    setGuideOverlay({ entry, body: undefined, note: undefined })
    loadAdminProfileGuideBody(guideRoot, toProfileGuideIdentity(entry))
      .then((result) => {
        setGuideOverlay((current) => {
          if (current === undefined || current.entry.ref !== entry.ref) return current
          return result.available ? { entry, body: result.body, note: undefined } : { entry, body: undefined, note: result.reason }
        })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setGuideOverlay((current) => (current === undefined || current.entry.ref !== entry.ref ? current : { entry, body: undefined, note: message }))
      })
  }

  const closeGuideOverlay = () => setGuideOverlay(undefined)

  /**
   * Opens the full-screen inventory overlay immediately (showing a loading
   * state) and runs the profile's existing `inventory PROFILE --json`
   * command once, asynchronously filling in the parsed result. This is a
   * one-shot, on-demand fetch (not tracked in either `AdminRunManager`
   * instance and not cached) since it is only ever needed while the
   * overlay is open, mirroring `openGuideOverlay`'s guard against a slow
   * result clobbering a newer overlay or a closed one.
   */
  const openInventoryOverlay = (entry: AdminProfileEntry) => {
    setInventoryOverlay({ entry, status: "loading", outcome: undefined, message: undefined })
    const command = buildInventoryCommand(entry)
    runner
      .run(command.executable, command.args, { cwd })
      .then((result) => {
        setInventoryOverlay((current) =>
          current === undefined || current.entry.ref !== entry.ref
            ? current
            : { entry, status: "done", outcome: parseInventoryOutput(result.stdout), message: undefined },
        )
      })
      .catch((error: unknown) => {
        const message =
          error instanceof CommandRunnerError
            ? error.stderr.trim() || error.stdout.trim() || error.message
            : error instanceof Error
              ? error.message
              : String(error)
        setInventoryOverlay((current) =>
          current === undefined || current.entry.ref !== entry.ref ? current : { entry, status: "error", outcome: undefined, message },
        )
      })
  }

  const closeInventoryOverlay = () => setInventoryOverlay(undefined)

  // Live-updates the table/detail pane to reflect `AdminRunManager` and
  // diagnosis-provider state that changes outside of React (async runs
  // settling in the background) without requiring user input.
  useEffect(() => {
    const interval = setInterval(() => setTick((value) => value + 1), 500)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const doctorRefs = entries.filter((entry) => entry.doctorSupported).map((entry) => entry.ref)
    if (!shouldStartBatch(doctorRefs, batchStartedRefs.current)) return
    batchStartedRefs.current = new Set(doctorRefs)
    void runBatchedDoctorChecks(entries, runManager)
  }, [entries, runManager])

  /**
   * Loads the on-disk 24h harness-version cache once at startup so a fresh
   * result from an earlier session is honored immediately (no redundant
   * `harness-version` subprocess for a launcher checked recently). A missing
   * or corrupt cache file resolves to an empty record (see
   * `admin-harness-version-cache.ts`), never blocking the rest of the UI.
   */
  useEffect(() => {
    let cancelled = false
    loadHarnessVersionCache(versionCachePath)
      .then((record) => {
        if (!cancelled) setVersionCache(record)
      })
      .finally(() => {
        if (!cancelled) setVersionCacheLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // The cache path and loader are fixed for the session; this runs exactly once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Persists each settled operation result to memory and an ordered disk
   * queue. Shared by startup, bounded retries, fallbacks, and manual resync.
   */
  const persistVersionResult = (
    operationKey: string,
    cacheEntry: AdminHarnessVersionCacheEntry,
    sourceEntry: AdminProfileEntry,
  ): void => {
    const refreshedInstalled =
      sourceEntry.surface === "sandbox" ? refreshedSandboxInstalledState(cacheEntry.result) : undefined
    if (refreshedInstalled !== undefined) {
      setSandboxInstalledByRef((previous) => new Map(previous).set(sourceEntry.ref, refreshedInstalled))
    }
    setVersionCache((previous) => {
      const next: AdminHarnessVersionCacheRecord = {
        schemaVersion: 2,
        entries: { ...previous.entries, [operationKey]: cacheEntry },
      }
      void versionCacheSaveQueue
        .enqueue(next)
        .then(() => setVersionCacheError(undefined))
        .catch((error: unknown) => setVersionCacheError(error instanceof Error ? error.message : String(error)))
      return next
    })
  }

  /**
   * Once the on-disk cache has loaded, runs the bounded-concurrency
   * `harness-version` batch (see `admin-harness-version-scheduler.ts`) for
   * every required operation whose cached result is stale, missing, or
   * incomplete. Native installed checks retain their natural scope while
   * latest lookups are deduplicated by release identity. Each result is
   * persisted as it settles.
   */
  useEffect(() => {
    if (!versionCacheLoaded) return
    const supportedOperations = Array.from(
      new Set(
        entries
          .filter((entry) => entry.harnessVersionSupported)
          .map((entry) => harnessVersionOperationKeyFor(entry) ?? ""),
      ),
    ).filter((operationKey) => operationKey.length > 0)
    if (!shouldStartBatch(supportedOperations, versionBatchStartedRefs.current)) return
    versionBatchStartedRefs.current = new Set(supportedOperations)
    void runBatchedHarnessVersionChecks(entries, versionRunManager, versionCache, {
      onResult: persistVersionResult,
    })
    // Re-runs only when the cache finishes loading or the profile set changes; `versionCache`
    // itself is read once at dispatch time via the closure and updated incrementally afterward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, versionRunManager, versionCacheLoaded, versionCachePath])

  /**
   * Forces the selected installed scope and its release group through the
   * same bounded scheduler. Sandbox producers receive `--refresh-latest`,
   * bypassing both the Admin cache and the CLI's 24-hour latest cache.
   */
  const forceResyncVersion = (entry: AdminProfileEntry) => {
    const relatedEntries = harnessVersionEntriesForForceResync(entry, entries)
    void runBatchedHarnessVersionChecks(relatedEntries, versionRunManager, versionCache, {
      forceResync: true,
      selectedEntryRef: entry.ref,
      onResult: persistVersionResult,
    }).finally(() => setTick((value) => value + 1))
    setTick((value) => value + 1)
  }

  const updateHarness = (plan: HarnessUpdatePlan) => {
    if (harnessUpdateManager.isRunning(plan.key)) return
    setHarnessUpdateByKey((previous) => new Map(previous).set(plan.key, {
      status: "running",
      targetCount: plan.targets.length,
      surface: plan.surface,
    }))
    void harnessUpdateManager
      .run(plan, () => refreshHarnessUpdateVersions(plan, versionRunManager, versionCache, persistVersionResult))
      .then((outcome) => {
        setHarnessUpdateByKey((previous) => new Map(previous).set(plan.key, { status: "done", outcome }))
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setHarnessUpdateByKey((previous) => new Map(previous).set(plan.key, { status: "error", message }))
      })
      .finally(() => setTick((value) => value + 1))
  }

  /**
   * Attempts one automatic `repair` for every repair-capable profile that
   * finishes the startup doctor batch (or any later retry) in a failed
   * state, then rechecks doctor — the same "run once, then recheck" action
   * as the manual `[p]` key, just triggered without waiting for the user to
   * select the profile first. `selectPendingRepairTargets` guarantees each
   * ref is auto-repaired at most once per session; a later manual `[p]`
   * retry remains available and independent. Runs on every poll tick (no
   * dependency array) to observe newly terminal-failed refs as the batch
   * settles in the background, exactly like the diagnosis-dispatch effect
   * above it.
   */
  useEffect(() => {
    if (harnessUpdateManager.isBusy()) return
    const statusesByRef = new Map<string, AdminRunStatus>(
      entries.filter((entry) => entry.doctorSupported).map((entry) => [entry.ref, runManager.status(entry.ref)]),
    )
    const repairSupportedRefs = new Set(entries.filter(isRepairSupported).map((entry) => entry.ref))
    const targets = selectPendingRepairTargets(statusesByRef, repairSupportedRefs, repairAttemptedRefs.current)
    if (targets.length === 0) return
    repairAttemptedRefs.current = new Set([...repairAttemptedRefs.current, ...targets])
    for (const ref of targets) {
      const entry = entries.find((candidate) => candidate.ref === ref)
      if (entry === undefined) continue
      void repairThenRecheckDoctor(entry, runManager).finally(() => setTick((value) => value + 1))
    }
    // Runs each poll tick to observe newly terminal-failed refs from `AdminRunManager`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  useEffect(() => {
    let cancelled = false
    isForkToHerdrAvailable(runner, herdrEnv, cwd)
      .then((available) => {
        if (!cancelled) setHerdrAvailable(available)
      })
      .catch(() => {
        if (!cancelled) setHerdrAvailable(false)
      })
    return () => {
      cancelled = true
    }
    // Herdr availability is probed once per process lifetime; runner/env/cwd are fixed for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const statusesByRef = new Map<string, AdminRunStatus>(
      entries.filter((entry) => entry.doctorSupported).map((entry) => [entry.ref, runManager.status(entry.ref)]),
    )
    const targets = selectPendingDiagnosisTargets(statusesByRef, diagnosedRefs.current)
    if (targets.length === 0) return
    diagnosedRefs.current = new Set([...diagnosedRefs.current, ...targets])
    setDiagnosisByRef((previous) => {
      const next = new Map(previous)
      for (const ref of targets) next.set(ref, { status: "diagnosing" })
      return next
    })
    for (const ref of targets) {
      const entry = entries.find((candidate) => candidate.ref === ref)
      if (entry === undefined) continue
      const snapshot = statusesByRef.get(ref)
      const capturedOutput = `${snapshot?.latest?.stdout ?? ""}\n${snapshot?.latest?.stderr ?? ""}`.trim()
      diagnosisProvider
        .diagnose({ ref, name: entry.name, capturedOutput })
        .then((result) => {
          setDiagnosisByRef((previous) => new Map(previous).set(ref, { status: "done", result }))
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          setDiagnosisByRef((previous) => new Map(previous).set(ref, { status: "error", message }))
        })
    }
    // Runs each poll tick to observe newly terminal-failed refs from `AdminRunManager`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  const onForkToFix = (entry: AdminProfileEntry, diagnosis: DoctorFailureDiagnosisResult | undefined): Promise<HerdrForkOutcome> => {
    if (herdrAvailable !== true) return Promise.resolve({ kind: "unavailable" })
    const snapshot = runManager.status(entry.ref)
    const capturedOutput = `${snapshot.latest?.stdout ?? ""}\n${snapshot.latest?.stderr ?? ""}`.trim()
    return forkFailureToHerdrWorktree(
      runner,
      { ref: entry.ref, name: entry.name, capturedOutput, ...(diagnosis === undefined ? {} : { diagnosis }) },
      { cwd, command: buildAdminLaunchCommand(entry), promptDelivery: "agent" },
    )
  }

  const filtered = useMemo(() => filterAdminProfiles(entries, query), [entries, query])
  const sorted = useMemo(
    () => sortAdminProfiles(filtered, sortCycle[sortIndex] ?? "name", sortDescending ? "desc" : "asc"),
    [filtered, sortIndex, sortDescending],
  )
  const viewState = resolveAdminViewState(entries, sorted, false)
  const boundedIndex = sorted.length === 0 ? 0 : Math.min(selectedIndex, sorted.length - 1)
  const selected = sorted[boundedIndex]
  const versionResultsByRef = reconcileHarnessVersionResults(
    entries,
    (operationKey) =>
      versionCache.entries[operationKey]?.result ?? harnessVersionResultForOperation(operationKey, versionRunManager),
    (ref) => sandboxInstalledByRef.get(ref),
  )
  const versionResultFor = (entry: AdminProfileEntry) => versionResultsByRef.get(entry.ref)
  const allUpdates = useHarnessUpdateAll({
    entries,
    manager: harnessUpdateManager,
    refresh: (plan) => refreshHarnessUpdateGroupVersions(plan, versionRunManager, versionCache, persistVersionResult),
    versionResultFor,
    routerCommandPath,
    checkVersions: (signal) => checkAdminHarnessUpdates(entries, runner, cwd, signal, persistVersionResult),
    checkSkills: (signal) => checkAdminSkillsUpdates(entries, runner, cwd, routerCommandPath, signal),
    blockReason: () => entries.some((entry) => profileWorkIsRunning(entry, runManager))
      ? "A profile check, repair, or setup is running. Wait for it to finish, then press y."
      : undefined,
  })
  const versionRunning = (entry: AdminProfileEntry) => {
    const operationKeys = new Set(
      harnessVersionEntriesForForceResync(entry, entries)
        .map(harnessVersionOperationKeyFor)
        .filter((operationKey): operationKey is string => operationKey !== undefined),
    )
    return [...operationKeys].some(
      (operationKey) => versionRunManager.status(harnessVersionRefFor(operationKey)).state === "running",
    )
  }
  const versionColumnsFor = (entry: AdminProfileEntry) =>
    harnessVersionColumnsFor(entry.harnessVersionSupported, versionResultFor(entry))
  const statusesByRef = useMemo(() => {
    const map = new Map<string, AdminStatus>()
    for (const entry of sorted) map.set(entry.ref, runStatusOf(entry, runManager.status(entry.ref)))
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed on every tick so live status changes are reflected
  }, [sorted, runManager, tick])
  const versionColumnsByRef = useMemo(() => {
    const map = new Map<string, AdminVersionColumns>()
    for (const entry of sorted) map.set(entry.ref, versionColumnsFor(entry))
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed on every tick so live version-check state changes are reflected
  }, [sorted, versionRunManager, versionCache, tick])
  const widths = useMemo(
    () => adminTableColumnWidths(sorted, statusesByRef, columns, versionColumnsByRef),
    [sorted, statusesByRef, versionColumnsByRef, columns],
  )

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      exit()
      return
    }
    if (allUpdates.state?.visible === true) return
    if (detailConfirmationActive) return
    if (
      handleOverlayInput(
        char,
        key,
        guideOverlay !== undefined,
        inventoryOverlay !== undefined,
        closeGuideOverlay,
        closeInventoryOverlay,
      )
    )
      return
    if (searching) {
      handleSearchInput(char, key, setSearching, setQuery)
      return
    }
    handleAdminListInput(char, key, {
      exit,
      openHarnessUpdates: allUpdates.open,
      sortedLength: sorted.length,
      setSearching,
      setSelectedIndex,
      setSortIndex,
      setSortDescending,
    })
  })

  if (allUpdates.state?.visible === true) {
    return (
      <HarnessUpdateAllOverlay
        state={allUpdates.state}
        columns={columns}
        rows={rows}
        onConfirm={allUpdates.confirm}
        onClose={allUpdates.close}
        onCancel={allUpdates.cancel}
      />
    )
  }

  if (guideOverlay !== undefined) {
    return <GuideOverlay entry={guideOverlay.entry} body={guideOverlay.body} note={guideOverlay.note} columns={columns} rows={rows} />
  }

  if (inventoryOverlay !== undefined) {
    return (
      <InventoryOverlay
        entry={inventoryOverlay.entry}
        status={inventoryOverlay.status}
        outcome={inventoryOverlay.outcome}
        message={inventoryOverlay.message}
      />
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <AdminListHeader
        profileCount={entries.length}
        sortIndex={sortIndex}
        sortDescending={sortDescending}
        searching={searching}
        query={query}
        updateAllRunning={allUpdates.running}
        versionCacheError={versionCacheError}
      />
      <HarnessUpdateAllStatus state={allUpdates.state} />
      {viewState === "discovering" ? <Text color="yellow">Discovering profiles…</Text> : null}
      {viewState === "empty-no-profiles" ? <Text color="yellow">No profiles were discovered.</Text> : null}
      {viewState === "empty-no-match" ? <Text color="yellow">No profiles match &quot;{query}&quot;.</Text> : null}
      {viewState === "ready" ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Box width={2}>
              <Text> </Text>
            </Box>
            <Box width={widths.harness}>
              <Text bold color="yellow">
                HARNESS
              </Text>
            </Box>
            <Box width={widths.name}>
              <Text bold color="cyan">
                PROFILE NAME
              </Text>
            </Box>
            <Box width={widths.type}>
              <Text bold color="green">
                TYPE
              </Text>
            </Box>
            <Box width={widths.status}>
              <Text bold color="magenta">
                STATUS
              </Text>
            </Box>
            <Box width={widths.version}>
              <Text bold color="blue">
                VERSION
              </Text>
            </Box>
            <Box width={widths.latestVersion}>
              <Text bold color="blue">
                LATEST VERSION
              </Text>
            </Box>
          </Box>
          {sorted.slice(0, Math.max(3, rows - 8)).map((entry, index) => {
            const active = index === boundedIndex
            const status = runStatusOf(entry, runManager.status(entry.ref))
            const versionRunningNow = versionRunning(entry)
            const versionCols = versionColumnsByRef.get(entry.ref) ?? versionColumnsFor(entry)
            const versionColor = versionCellColor(versionCols.status)
            return (
              <Box key={entry.ref}>
                <Box width={2}>
                  <Text bold={active} {...(active ? { color: "green" as const } : {})}>
                    {active ? "› " : "  "}
                  </Text>
                </Box>
                <Box width={widths.harness}>
                  <Text bold={active} color="yellow" dimColor={!active} wrap="truncate-end">
                    {entry.harness ?? "—"}
                  </Text>
                </Box>
                <Box width={widths.name}>
                  <Text bold={active} color="cyan" dimColor={!active} wrap="truncate-end">
                    {entry.name}
                  </Text>
                </Box>
                <Box width={widths.type}>
                  <Text bold={active} color="green" dimColor={!active} wrap="truncate-end">
                    {adminProfileType(entry)}
                  </Text>
                </Box>
                <Box width={widths.status}>
                  <StatusText status={status} tick={tick} bold={active} dimColor={!active} />
                </Box>
                <Box width={widths.version}>
                  <Text bold={active} {...(versionColor === undefined ? { dimColor: !active } : { color: versionColor })} wrap="truncate-end">
                    {versionRunningNow ? <Text color="cyan">{spinnerFrameAt(tick)} </Text> : null}
                    {versionRunningNow ? "checking…" : versionCols.installed}
                  </Text>
                </Box>
                <Box width={widths.latestVersion}>
                  <Text bold={active} {...(versionColor === undefined ? { dimColor: !active } : { color: versionColor })} wrap="truncate-end">
                    {versionRunningNow ? "" : versionCols.latest}
                  </Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      ) : null}
      {selected !== undefined ? (
        <AdminDetailPanel
          entry={selected}
          runManager={runManager}
          diagnosis={diagnosisByRef.get(selected.ref)}
          herdrAvailable={herdrAvailable}
          onForkToFix={onForkToFix}
          onOpenGuide={openGuideOverlay}
          onOpenInventory={openInventoryOverlay}
          tick={tick}
          versionResult={versionResultFor(selected)}
          versionRunning={versionRunning(selected)}
          onForceResyncVersion={forceResyncVersion}
          harnessUpdatePlan={allUpdates.running ? undefined : harnessUpdatePlanFor(selected, entries, versionResultFor(selected))}
          harnessUpdateState={harnessUpdateByKey.get(harnessUpdateKeyFor(selected) ?? "")}
          onUpdateHarness={updateHarness}
          onConfirmationChange={setDetailConfirmationActive}
          inputActive={!searching && !allUpdates.running}
        />
      ) : null}
    </Box>
  )
}

/**
 * Owns the async initial-discovery data flow: renders immediately with
 * unknown/stale entries (never blocking on health checks), then refreshes
 * once via `refreshAdminEntries` and re-renders when it resolves. A failed
 * refresh is surfaced as a banner without discarding the already-rendered
 * catalog entries.
 */
export const AdminRoot = ({
  catalog,
  runner,
  runManager,
  guideRoot,
  cwd,
  diagnosisProvider,
  herdrEnv,
  routerCommandPath = "trx",
}: {
  readonly catalog: CombinedGuideCatalog
  readonly runner: CommandRunner
  readonly runManager: AdminRunManager
  readonly guideRoot: string
  readonly cwd: string
  readonly diagnosisProvider: DoctorFailureDiagnosisProvider
  readonly herdrEnv: HerdrEnvironment
  readonly routerCommandPath?: string
}) => {
  const [entries, setEntries] = useState<ReadonlyArray<AdminProfileEntry>>(() => aggregateAdminProfiles(catalog))
  const [refreshError, setRefreshError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    refreshAdminEntries(runner, catalog, cwd)
      .then((refreshed) => {
        if (!cancelled) setEntries(refreshed)
      })
      .catch((error: unknown) => {
        if (!cancelled) setRefreshError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
    // Refresh runs once per process lifetime; the catalog/runner/cwd are fixed for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Box flexDirection="column">
      {refreshError === undefined ? null : (
        <Text color="red" wrap="wrap">
          Health/install refresh failed: {refreshError}. Showing last-known status.
        </Text>
      )}
      <AdminApp
        entries={entries}
        runManager={runManager}
        guideRoot={guideRoot}
        runner={runner}
        diagnosisProvider={diagnosisProvider}
        herdrEnv={herdrEnv}
        cwd={cwd}
        routerCommandPath={routerCommandPath}
      />
    </Box>
  )
}
