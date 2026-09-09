import type { AdminProfileEntry } from "./admin-model.js"
import type { AdminRunManager } from "./admin-run-manager.js"
import type { AdminHarnessVersionCacheRecord } from "./admin-harness-version-cache.js"
import {
  harnessVersionRefFor,
  runBatchedHarnessVersionChecks,
  type HarnessVersionSchedulerOptions,
} from "./admin-harness-version-scheduler.js"
import { harnessVersionOperationKeyFor, harnessVersionReleaseKeyFor, type AdminHarnessVersionResult } from "./admin-harness-version.js"
import type { CommandRunner, CommandSpec } from "./guide-launch.js"
import { runProfileUpdateStep, updateDiagnostic, type ProfileUpdateResult, type ProfileUpdateStep } from "./admin-update-command.js"
import {
  runNativeSkillsUpdate,
  type NativeSkillsUpdateEvent,
  type NativeSkillsUpdateOutcome,
  type NativeSkillsUpdatePlan,
} from "./admin-skills-update.js"

interface NativeHarnessUpdate {
  readonly command: "update" | "harness-update"
  readonly shared: boolean
}

// cpx, cdx, and grx use ordinary update commands for profile plugins or skills.
const nativeHarnessUpdates: ReadonlyMap<string, NativeHarnessUpdate> = new Map([
  ["cpx", { command: "harness-update", shared: true }],
  ["cdx", { command: "harness-update", shared: true }],
  ["grx", { command: "harness-update", shared: true }],
  ["cldx", { command: "harness-update", shared: true }],
  ["fmx", { command: "update", shared: false }],
  ["jcx", { command: "update", shared: true }],
  ["omp", { command: "update", shared: true }],
  ["picx", { command: "update", shared: true }],
  ["prx", { command: "update", shared: true }],
])

export type HarnessUpdateStep = ProfileUpdateStep

export interface HarnessUpdatePlan {
  readonly key: string
  readonly surface: AdminProfileEntry["surface"]
  readonly harness: string
  readonly latestVersion: string | undefined
  readonly targets: ReadonlyArray<AdminProfileEntry>
  readonly steps: ReadonlyArray<HarnessUpdateStep>
}

export type HarnessUpdateResult = ProfileUpdateResult

export interface HarnessUpdateOutcome {
  readonly key: string
  readonly surface: AdminProfileEntry["surface"]
  readonly harness: string
  readonly results: ReadonlyArray<HarnessUpdateResult>
}

export interface HarnessUpdateGroupReport {
  readonly plan: HarnessUpdatePlan
  readonly outcome: HarnessUpdateOutcome
  readonly refreshError?: string
}

export type HarnessUpdateQueueEvent =
  | { readonly kind: "skills"; readonly event: NativeSkillsUpdateEvent }
  | { readonly kind: "started"; readonly plan: HarnessUpdatePlan; readonly index: number; readonly total: number }
  | { readonly kind: "step-started"; readonly plan: HarnessUpdatePlan; readonly step: HarnessUpdateStep }
  | {
      readonly kind: "step-completed"
      readonly plan: HarnessUpdatePlan
      readonly step: HarnessUpdateStep
      readonly results: ReadonlyArray<HarnessUpdateResult>
    }
  | { readonly kind: "completed"; readonly report: HarnessUpdateGroupReport; readonly index: number; readonly total: number }

export interface HarnessUpdateQueueOptions {
  readonly refresh: (plan: HarnessUpdatePlan) => Promise<void>
  readonly onProgress?: (event: HarnessUpdateQueueEvent) => void
  readonly signal?: AbortSignal
  readonly skills?: NativeSkillsUpdatePlan
}

export interface HarnessUpdateQueueOutcome {
  readonly reports: ReadonlyArray<HarnessUpdateGroupReport>
  readonly skills: NativeSkillsUpdateOutcome | undefined
}

interface HarnessUpdateRunOptions {
  readonly signal?: AbortSignal
  readonly onStepStart?: (step: HarnessUpdateStep) => void
  readonly onStepComplete?: (step: HarnessUpdateStep, results: ReadonlyArray<HarnessUpdateResult>) => void
}

export const harnessUpdateKeyFor = (entry: AdminProfileEntry): string | undefined => {
  if (entry.harness === undefined || entry.commandPath.length === 0) return undefined
  if (entry.surface === "sandbox") {
    return harnessVersionReleaseKeyFor(entry) === undefined ? undefined : `sandbox:${entry.harness}`
  }
  return entry.launcher !== undefined && nativeHarnessUpdates.has(entry.launcher) ? `native:${entry.launcher}` : undefined
}

const buildHarnessUpdateCommand = (entry: AdminProfileEntry): CommandSpec => {
  if (entry.surface === "sandbox") {
    return { executable: entry.commandPath, args: ["upgrade", entry.name, "--strict-harness"] }
  }
  const update = nativeHarnessUpdates.get(entry.launcher ?? "")
  if (update === undefined) throw new Error(`Harness update is not supported for ${entry.ref}`)
  return {
    executable: entry.commandPath,
    args: update.command === "harness-update" ? ["harness-update"] : ["update", entry.name],
  }
}

export const harnessUpdatePlanFor = (
  selected: AdminProfileEntry,
  entries: ReadonlyArray<AdminProfileEntry>,
  versionResult: AdminHarnessVersionResult | undefined,
): HarnessUpdatePlan | undefined => {
  const key = harnessUpdateKeyFor(selected)
  if (key === undefined || selected.harness === undefined) return undefined
  const targets = [
    ...new Map(
      entries
        .filter((entry) => harnessUpdateKeyFor(entry) === key && entry.commandPath === selected.commandPath)
        .map((entry) => [entry.ref, entry]),
    ).values(),
  ].sort((left, right) => left.ref.localeCompare(right.ref))
  if (!targets.some((entry) => entry.ref === selected.ref)) return undefined

  const shared = selected.surface === "native" && nativeHarnessUpdates.get(selected.launcher ?? "")?.shared === true
  const steps = shared
    ? [{ command: buildHarnessUpdateCommand(selected), targets }]
    : targets.map((entry) => ({ command: buildHarnessUpdateCommand(entry), targets: [entry] }))
  return {
    key,
    surface: selected.surface,
    harness: selected.harness,
    latestVersion: versionResult?.latest.kind === "known" ? versionResult.latest.version : undefined,
    targets,
    steps,
  }
}

export const harnessUpdateRefreshTargets = (plan: HarnessUpdatePlan): ReadonlyArray<AdminProfileEntry> => {
  if (plan.surface === "sandbox") return plan.targets
  const scopes = new Map<string, AdminProfileEntry>()
  for (const target of plan.targets) {
    const key = harnessVersionOperationKeyFor(target)
    if (key !== undefined && !scopes.has(key)) scopes.set(key, target)
  }
  return [...scopes.values()]
}

export const refreshHarnessUpdateVersions = async (
  plan: HarnessUpdatePlan,
  runManager: AdminRunManager,
  cache: AdminHarnessVersionCacheRecord,
  onResult: NonNullable<HarnessVersionSchedulerOptions["onResult"]>,
): Promise<void> => {
  for (const target of harnessUpdateRefreshTargets(plan)) {
    const key = harnessVersionOperationKeyFor(target)
    if (key === undefined) throw new Error(`Harness version refresh is not supported for ${target.ref}`)
    await runManager.waitForIdle(harnessVersionRefFor(key))
    await runBatchedHarnessVersionChecks([target], runManager, cache, {
      forceResync: true,
      refreshLatest: false,
      selectedEntryRef: target.ref,
      onResult,
    })
  }
}

export const runHarnessUpdate = async (
  plan: HarnessUpdatePlan,
  runner: CommandRunner,
  cwd: string,
  options: HarnessUpdateRunOptions = {},
): Promise<HarnessUpdateOutcome> => {
  const results: Array<HarnessUpdateResult> = []
  for (const step of plan.steps) {
    options.onStepStart?.(step)
    const stepResults = await runProfileUpdateStep(step, runner, cwd, options.signal)
    results.push(...stepResults)
    options.onStepComplete?.(step, stepResults)
  }
  return { key: plan.key, surface: plan.surface, harness: plan.harness, results }
}

const queueScopeKey = (plans: ReadonlyArray<HarnessUpdatePlan>, skills: NativeSkillsUpdatePlan | undefined): string =>
  JSON.stringify({
    harnesses: plans.map((plan) => ({
      key: plan.key,
      steps: plan.steps.map((step) => ({ command: step.command, refs: step.targets.map((entry) => entry.ref) })),
    })),
    skills:
      skills === undefined
        ? undefined
        : {
            refresh: skills.refresh,
            targets: skills.targets.map((entry) => [entry.ref, entry.launcher, entry.name, entry.commandPath]),
          },
  })

export class HarnessUpdateManager {
  private readonly inFlight = new Map<string, Promise<HarnessUpdateOutcome>>()
  private allRun: Promise<HarnessUpdateQueueOutcome> | undefined
  private allScopeKey: string | undefined

  constructor(
    private readonly runner: CommandRunner,
    private readonly cwd: string,
  ) {}

  isRunning(key: string): boolean {
    return this.inFlight.has(key)
  }

  isBusy(): boolean {
    return this.allRun !== undefined || this.inFlight.size > 0
  }

  run(plan: HarnessUpdatePlan, refresh: () => Promise<void>): Promise<HarnessUpdateOutcome> {
    if (this.allRun !== undefined) return Promise.reject(new Error("Update all is running. Wait for it to finish before using U."))
    return this.start(plan, refresh)
  }

  runAll(plans: ReadonlyArray<HarnessUpdatePlan>, options: HarnessUpdateQueueOptions): Promise<HarnessUpdateQueueOutcome> {
    const scopeKey = queueScopeKey(plans, options.skills)
    if (this.allRun !== undefined) {
      return this.allScopeKey === scopeKey
        ? this.allRun
        : Promise.reject(new Error("An update-all operation with a different scope is running. Wait for it to finish."))
    }
    if (this.inFlight.size > 0)
      return Promise.reject(new Error("A harness update is already running. Wait for it to finish before updating all."))
    const run = Promise.resolve()
      .then(() => this.runQueue(plans, options))
      .finally(() => {
        this.allRun = undefined
        this.allScopeKey = undefined
      })
    this.allScopeKey = scopeKey
    this.allRun = run
    return run
  }

  private async runQueue(plans: ReadonlyArray<HarnessUpdatePlan>, options: HarnessUpdateQueueOptions): Promise<HarnessUpdateQueueOutcome> {
    const native = plans.filter((plan) => plan.surface === "native")
    const containers = plans.filter((plan) => plan.surface === "sandbox")
    const nativeReports = await this.runGroupPhase(native, options, 0, plans.length)
    // Native harness updaters can rewrite skills; publish the final skill copies afterward.
    const skills =
      options.skills === undefined || options.signal?.aborted === true
        ? undefined
        : await runNativeSkillsUpdate(options.skills, this.runner, this.cwd, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onProgress: (event) => options.onProgress?.({ kind: "skills", event }),
          })
    const containerReports = await this.runGroupPhase(containers, options, native.length, plans.length)
    return { reports: [...nativeReports, ...containerReports], skills }
  }

  private async runGroupPhase(
    plans: ReadonlyArray<HarnessUpdatePlan>,
    options: HarnessUpdateQueueOptions,
    offset: number,
    total: number,
  ): Promise<ReadonlyArray<HarnessUpdateGroupReport>> {
    const reports: Array<HarnessUpdateGroupReport> = []
    for (const [index, plan] of plans.entries()) {
      if (options.signal?.aborted === true) break
      options.onProgress?.({ kind: "started", plan, index: index + offset, total })
      const report = await this.runQueuedGroup(plan, options)
      reports.push(report)
      options.onProgress?.({ kind: "completed", report, index: index + offset, total })
    }
    return reports
  }

  private async runQueuedGroup(plan: HarnessUpdatePlan, options: HarnessUpdateQueueOptions): Promise<HarnessUpdateGroupReport> {
    let refreshError: string | undefined
    const refresh = async () => {
      if (options.signal?.aborted === true) {
        refreshError = "Version refresh was cancelled."
        return
      }
      try {
        await options.refresh(plan)
      } catch (error: unknown) {
        refreshError = updateDiagnostic(error)
      }
    }
    const outcome = await this.start(plan, refresh, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onStepStart: (step) => options.onProgress?.({ kind: "step-started", plan, step }),
      onStepComplete: (step, results) => options.onProgress?.({ kind: "step-completed", plan, step, results }),
    })
    return { plan, outcome, ...(refreshError === undefined ? {} : { refreshError }) }
  }

  private start(
    plan: HarnessUpdatePlan,
    refresh: () => Promise<void>,
    options: HarnessUpdateRunOptions = {},
  ): Promise<HarnessUpdateOutcome> {
    const existing = this.inFlight.get(plan.key)
    if (existing !== undefined) return existing
    const run = runHarnessUpdate(plan, this.runner, this.cwd, options)
      .then(async (outcome) => {
        await refresh()
        return outcome
      })
      .finally(() => this.inFlight.delete(plan.key))
    this.inFlight.set(plan.key, run)
    return run
  }
}
