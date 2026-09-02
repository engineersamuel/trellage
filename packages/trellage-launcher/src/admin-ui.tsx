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

import { aggregateAdminProfiles, loadAdminProfileGuideBody, toProfileGuideIdentity, type AdminProfileEntry } from "./admin-model.js"
import { refreshAdminEntries } from "./admin-refresh.js"
import { AdminRunManager, type AdminRunStatus } from "./admin-run-manager.js"
import { buildAdminLaunchCommand, buildDiagnosticCommand, isRepairSupported, launchAdminProfile, repairRefFor, repairThenRecheckDoctor } from "./admin-launch.js"
import { controlsForStatus, historyScopeLabel, statusLabel, type AdminStatus } from "./admin-status.js"
import type { AdminSortKey } from "./admin-table.js"
import { adminProfileType, adminTableColumnWidths, filterAdminProfiles, resolveAdminViewState, sortAdminProfiles } from "./admin-table.js"
import { runBatchedDoctorChecks } from "./admin-batch-scheduler.js"
import { selectPendingDiagnosisTargets, selectPendingRepairTargets, shouldStartBatch } from "./admin-diagnosis-dispatch.js"
import { DoctorFailureDiagnosisProvider, type DoctorFailureDiagnosisResult } from "./admin-diagnosis-provider.js"
import { forkFailureToHerdrWorktree, isForkToHerdrAvailable, type HerdrForkOutcome } from "./admin-herdr-fork.js"
import type { CombinedGuideCatalog } from "./guide-catalog.js"
import type { CommandRunner, HerdrEnvironment } from "./guide-launch.js"
import { MarkdownTextViewport, spinnerFrameAt } from "./guide-ui.js"

type DiagnosisState =
  | { readonly status: "diagnosing" }
  | { readonly status: "done"; readonly result: DoctorFailureDiagnosisResult }
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

const AdminDetailPanel = ({
  entry,
  runManager,
  guideRoot,
  diagnosis,
  herdrAvailable,
  onForkToFix,
  columns,
  tick,
}: {
  readonly entry: AdminProfileEntry
  readonly runManager: AdminRunManager
  readonly guideRoot: string
  readonly diagnosis: DiagnosisState | undefined
  readonly herdrAvailable: boolean | undefined
  readonly onForkToFix: (entry: AdminProfileEntry, diagnosis: DoctorFailureDiagnosisResult | undefined) => Promise<HerdrForkOutcome>
  readonly columns: number
  readonly tick: number
}) => {
  const [, forceRender] = useState(0)
  const [guideBody, setGuideBody] = useState<string | undefined>(undefined)
  const [guideNote, setGuideNote] = useState<string | undefined>(undefined)
  const [launchConfirming, setLaunchConfirming] = useState(false)
  const [launchMessage, setLaunchMessage] = useState<string | undefined>(undefined)
  const [forkConfirming, setForkConfirming] = useState(false)
  const [forkMessage, setForkMessage] = useState<string | undefined>(undefined)
  const [repairConfirming, setRepairConfirming] = useState(false)
  const [repairMessage, setRepairMessage] = useState<string | undefined>(undefined)

  useEffect(() => {
    setGuideBody(undefined)
    setGuideNote(undefined)
    setLaunchConfirming(false)
    setLaunchMessage(undefined)
    setForkConfirming(false)
    setForkMessage(undefined)
    setRepairConfirming(false)
    setRepairMessage(undefined)
  }, [entry.ref])

  const snapshot = runManager.status(entry.ref)
  const status = runStatusOf(entry, snapshot)
  const controls = controlsForStatus(status)
  const repairSnapshot = runManager.status(repairRefFor(entry))
  const canRepair = isRepairSupported(entry) && controls.canRetry && repairSnapshot.state !== "running"
  const repairNote =
    repairMessage ??
    (repairSnapshot.state === "idle"
      ? undefined
      : `Repair ${repairSnapshot.state} (recheck: ${statusLabel(status)}).`)

  const openGuide = () => {
    loadAdminProfileGuideBody(guideRoot, toProfileGuideIdentity(entry))
      .then((result) => {
        if (result.available) setGuideBody(result.body)
        else setGuideNote(result.reason)
      })
      .catch((error: unknown) => setGuideNote(error instanceof Error ? error.message : String(error)))
  }

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
   * re-triggers the doctor check to recheck — regardless of the repair
   * outcome, per the requested "run once, then recheck" behavior. Shares
   * `repairThenRecheckDoctor` with the on-load auto-repair dispatch in
   * `AdminRoot` so a manual `[p]` press and an automatic repair behave
   * identically. Never parses or executes the Copilot-suggested-fix text
   * itself; this always runs the same fixed, safe command for the profile.
   */
  const confirmRepair = () => {
    setRepairConfirming(false)
    setRepairMessage(`Running ${entry.name}'s repair…`)
    repairThenRecheckDoctor(entry, runManager)
      .then((outcome) => {
        setRepairMessage(`Repair attempted; doctor recheck: ${outcome.doctorState}.`)
      })
      .catch((error: unknown) => setRepairMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => forceRender((value) => value + 1))
  }

  const confirmLaunch = () => {
    launchAdminProfile(entry, true)
      .then(() => setLaunchMessage(`Handed the terminal to ${entry.name}.`))
      .catch((error: unknown) => setLaunchMessage(error instanceof Error ? error.message : String(error)))
    setLaunchConfirming(false)
  }

  const canFork = diagnosis?.status === "done" && herdrAvailable === true
  const confirmFork = () => {
    setForkConfirming(false)
    setForkMessage(`Creating a Herdr worktree to fix ${entry.name}…`)
    onForkToFix(entry, diagnosis?.status === "done" ? diagnosis.result : undefined)
      .then((outcome) => {
        if (outcome.kind === "launched") setForkMessage(`Forked to a new Herdr worktree: ${outcome.result.checkoutPath}`)
        else if (outcome.kind === "unavailable") setForkMessage("Herdr is not available in this session.")
        else if (outcome.kind === "not-ready") setForkMessage(`Worktree is not ready to create (${outcome.inspection.kind}).`)
        else setForkMessage(outcome.error instanceof Error ? outcome.error.message : String(outcome.error))
      })
      .catch((error: unknown) => setForkMessage(error instanceof Error ? error.message : String(error)))
  }

  useInput((input) => {
    if (launchConfirming) {
      if (input === "y") confirmLaunch()
      else setLaunchConfirming(false)
      return
    }
    if (forkConfirming) {
      if (input === "y") confirmFork()
      else setForkConfirming(false)
      return
    }
    if (repairConfirming) {
      if (input === "y") confirmRepair()
      else setRepairConfirming(false)
      return
    }
    if (input === "g") openGuide()
    else if ((input === "d" || input === "r") && (controls.canTrigger || controls.canRetry)) runOrRetryDoctor()
    else if (input === "c" && controls.canCancel) cancelDoctor()
    else if (input === "l") setLaunchConfirming(true)
    else if (input === "f" && canFork) setForkConfirming(true)
    else if (input === "p" && canRepair) setRepairConfirming(true)
  })

  const latest = snapshot.latest
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
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
        {entry.version === undefined ? "" : ` · Version: ${entry.version}`}
      </Text>
      {entry.healthDiagnostic === undefined ? null : (
        <Text dimColor wrap="wrap">
          {entry.healthDiagnostic}
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text>
          Doctor status: <StatusText status={status} tick={tick} bold /></Text>
        {latest === undefined ? null : (
          <Text dimColor wrap="wrap">
            {(latest.stdout || latest.stderr || "").slice(0, 4000)}
          </Text>
        )}
        {snapshot.history.length === 0 ? null : (
          <Text dimColor>
            {historyScopeLabel} ({snapshot.history.length} run{snapshot.history.length === 1 ? "" : "s"} recorded)
          </Text>
        )}
        <Box marginTop={1} paddingX={1} borderStyle="round" borderColor="gray" flexDirection="column">
          <ShortcutHints
            items={[
              controls.canTrigger ? { key: "d", label: "run doctor" } : undefined,
              controls.canCancel ? { key: "c", label: "cancel" } : undefined,
              controls.canRetry ? { key: "r", label: "retry" } : undefined,
              { key: "g", label: "view guide" },
              { key: "l", label: "launch in terminal" },
              canFork ? { key: "f", label: "fork to fix" } : undefined,
              canRepair ? { key: "p", label: "repair profile" } : undefined,
            ].filter((item): item is { readonly key: string; readonly label: string } => item !== undefined)}
          />
        </Box>
      </Box>
      {diagnosis === undefined ? null : (
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
      )}
      {guideNote === undefined ? null : (
        <Text color="yellow" wrap="wrap">
          {guideNote}
        </Text>
      )}
      {guideBody === undefined ? null : (
        <Box flexDirection="column" marginTop={1}>
          <MarkdownTextViewport value={guideBody} width={Math.max(20, columns - 6)} height={18} resetKey={entry.ref} />
          <ShortcutHints items={[{ key: "PageUp/PageDown", label: "scroll guide" }]} />
        </Box>
      )}
      {launchConfirming ? (
        <Text color="yellow">Press [y] to hand this terminal to {entry.name} now, or any other key to cancel.</Text>
      ) : null}
      {launchMessage === undefined ? null : <Text dimColor>{launchMessage}</Text>}
      {forkConfirming ? (
        <Text color="yellow">
          Press [y] to create a new Herdr worktree and hand it {entry.name}&apos;s suggested fix now, or any other key to cancel.
        </Text>
      ) : null}
      {forkMessage === undefined ? null : (
        <Text dimColor wrap="wrap">
          {forkMessage}
        </Text>
      )}
      {repairConfirming ? (
        <Text color="yellow">
          Press [y] to run {entry.name}&apos;s repair now and recheck doctor afterward, or any other key to cancel.
        </Text>
      ) : null}
      {repairNote === undefined ? null : (
        <Text dimColor wrap="wrap">
          {repairNote}
        </Text>
      )}
      <Box marginTop={1} paddingX={1} borderStyle="round" borderColor="gray">
        <ShortcutHints items={[{ key: "j/k", label: "move selection" }, { key: "q", label: "quit" }]} />
      </Box>
    </Box>
  )
}

export const AdminApp = ({
  entries,
  runManager,
  guideRoot,
  runner,
  diagnosisProvider,
  herdrEnv,
  cwd,
}: {
  readonly entries: ReadonlyArray<AdminProfileEntry>
  readonly runManager: AdminRunManager
  readonly guideRoot: string
  readonly runner: CommandRunner
  readonly diagnosisProvider: DoctorFailureDiagnosisProvider
  readonly herdrEnv: HerdrEnvironment
  readonly cwd: string
}) => {
  const { exit } = useApp()
  const { rows, columns } = useWindowSize()
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [sortIndex, setSortIndex] = useState(0)
  const [sortDescending, setSortDescending] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [tick, setTick] = useState(0)
  const [diagnosisByRef, setDiagnosisByRef] = useState<ReadonlyMap<string, DiagnosisState>>(new Map())
  const [herdrAvailable, setHerdrAvailable] = useState<boolean | undefined>(undefined)
  const batchStartedRefs = useRef<Set<string>>(new Set())
  const diagnosedRefs = useRef<Set<string>>(new Set())
  const repairAttemptedRefs = useRef<Set<string>>(new Set())

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
  const statusesByRef = useMemo(() => {
    const map = new Map<string, AdminStatus>()
    for (const entry of sorted) map.set(entry.ref, runStatusOf(entry, runManager.status(entry.ref)))
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed on every tick so live status changes are reflected
  }, [sorted, runManager, tick])
  const widths = useMemo(() => adminTableColumnWidths(sorted, statusesByRef, columns), [sorted, statusesByRef, columns])

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      exit()
      return
    }
    if (searching) {
      if (key.return || key.escape) {
        setSearching(false)
        return
      }
      if (key.backspace || key.delete) {
        setQuery((value) => value.slice(0, -1))
        return
      }
      if (char.length === 1) setQuery((value) => value + char)
      return
    }
    if (char === "/") {
      setSearching(true)
      return
    }
    if (char === "q" || key.escape) {
      exit()
      return
    }
    if (char === "j" || key.downArrow) {
      setSelectedIndex((value) => Math.min(sorted.length - 1, value + 1))
      return
    }
    if (char === "k" || key.upArrow) {
      setSelectedIndex((value) => Math.max(0, value - 1))
      return
    }
    if (char === "s") {
      setSortIndex((value) => (value + 1) % sortCycle.length)
      return
    }
    if (char === "S") {
      setSortDescending((value) => !value)
      return
    }
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Trellage Admin — {entries.length} profiles
        </Text>
        <Text dimColor>
          sort: {sortCycle[sortIndex]}
          {sortDescending ? " ↓" : " ↑"}
        </Text>
      </Box>
      {searching ? (
        <Text dimColor>Search: {query}█</Text>
      ) : (
        <ShortcutHints
          items={[
            { key: "/", label: "search" },
            { key: "s", label: "sort" },
            { key: "S", label: "reverse" },
            { key: "j/k", label: "move" },
            { key: "q", label: "quit" },
          ]}
        />
      )}
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
          </Box>
          {sorted.slice(0, Math.max(3, rows - 8)).map((entry, index) => {
            const active = index === boundedIndex
            const status = runStatusOf(entry, runManager.status(entry.ref))
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
              </Box>
            )
          })}
        </Box>
      ) : null}
      {selected !== undefined ? (
        <AdminDetailPanel
          entry={selected}
          runManager={runManager}
          guideRoot={guideRoot}
          diagnosis={diagnosisByRef.get(selected.ref)}
          herdrAvailable={herdrAvailable}
          onForkToFix={onForkToFix}
          columns={columns}
          tick={tick}
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
}: {
  readonly catalog: CombinedGuideCatalog
  readonly runner: CommandRunner
  readonly runManager: AdminRunManager
  readonly guideRoot: string
  readonly cwd: string
  readonly diagnosisProvider: DoctorFailureDiagnosisProvider
  readonly herdrEnv: HerdrEnvironment
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
      />
    </Box>
  )
}
