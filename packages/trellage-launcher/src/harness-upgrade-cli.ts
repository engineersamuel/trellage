import { createInterface } from "node:readline"
import {
  harnessUpdateAllPlanFor,
  harnessUpdateAllSummary,
  refreshHarnessUpdateGroupVersions,
  runAllHarnessUpdates,
  type HarnessUpdateAllOutcome,
  type HarnessUpdateAllPlan,
} from "./admin-harness-update-all.ts"
import { HarnessUpdateManager, type HarnessUpdatePlan, type HarnessUpdateQueueEvent } from "./admin-harness-update.ts"
import type { AdminHarnessVersionCacheRecord } from "./admin-harness-version-cache.ts"
import { aggregateAdminProfiles } from "./admin-model.ts"
import { AdminRunManager } from "./admin-run-manager.ts"
import { nativeSkillsUpdateCommand, type NativeSkillsUpdateEvent, type NativeSkillsUpdatePlan } from "./admin-skills-update.ts"
import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import { renderCommandPreview, type CommandRunner } from "./guide-launch.ts"

export const harnessUpgradeHelpText = `Usage:
  trx upgrade all [--native] [--yes | --dry-run]

Update harness versions AND skills for every Native catalog profile.
The preview includes profiles hidden by Admin filters. One queue runs:
1. Native harness updates: shared runtimes once.
2. Shared Native skill-cache refresh: one trx skills update.
3. Native profile skill copies and verification, including Agency.
Native skill copies are final; harness updates cannot overwrite them afterward.
Admin U remains the selected harness-only action.

Without a flag, preview the scope and require you to type yes at a terminal.
--native is accepted for compatibility; every update is already Native.
--yes authorizes updates without an interactive terminal.
--dry-run reads the catalog and previews the scope without running
updates, readiness probes, or version checks.

Existing profile version and source pins are preserved. Unsupported profiles,
fallbacks, failures, and unreadable installed versions are reported.
Independent updates continue after failures. Cancellation stops later updates.
Exit status is nonzero for incomplete discovery, unsupported profiles, failed
harness or skill updates, failed installed-version reads, and profiles not run.
A failed skill cache refresh skips Native copies, not independent harness updates.
Cancellation exits 130.

This does not install or upgrade Trellage itself.`

export type HarnessUpgradeScope = "all" | "native"
export type HarnessUpgradeArgs =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly approval: "confirm" | "yes" | "dry-run"; readonly scope: HarnessUpgradeScope }

const helpArguments: Record<string, true> = { "--help": true, "-h": true, help: true }
const isHelpArgument = (argument: string | undefined): boolean =>
  argument !== undefined && Object.hasOwn(helpArguments, argument)
const usageError = (): Error =>
  new Error("Use trx upgrade all [--native] [--yes | --dry-run], or trx upgrade --help.")

export const parseHarnessUpgradeArgv = (argv: ReadonlyArray<string>): HarnessUpgradeArgs => {
  if (argv.length === 1 && isHelpArgument(argv[0])) return { kind: "help" }
  if (argv[0] !== "all" || argv.length > 3) throw usageError()
  const flags = argv.slice(1)
  if (flags.length === 1 && isHelpArgument(flags[0])) return { kind: "help" }
  let approval: "confirm" | "yes" | "dry-run" = "confirm"
  let scope: HarnessUpgradeScope = "all"
  for (const flag of flags) {
    if (flag === "--native" && scope === "all") scope = "native"
    else if (flag === "--yes" && approval === "confirm") approval = "yes"
    else if (flag === "--dry-run" && approval === "confirm") approval = "dry-run"
    else throw usageError()
  }
  return { kind: "run", approval, scope }
}

export type HarnessUpgradeConfirmation = "confirmed" | "cancelled" | "unavailable"

export class InteractiveTerminalRequiredError extends Error {
  constructor(cause: unknown) {
    super("an interactive controlling terminal is required", { cause })
    this.name = "InteractiveTerminalRequiredError"
  }
}

const unavailableTerminalCodes = new Set(["ENXIO", "ENOTTY", "ENOENT", "EACCES", "EPERM"])

export const normalizeInteractiveTerminalError = (cause: unknown): unknown => {
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string" && unavailableTerminalCodes.has(cause.code)) {
    return new InteractiveTerminalRequiredError(cause)
  }
  return cause
}

export const confirmHarnessUpgrade = (
  input: NodeJS.ReadableStream & { readonly isTTY?: boolean },
  output: NodeJS.WritableStream,
  signal?: AbortSignal,
): Promise<HarnessUpgradeConfirmation> => {
  if (input.isTTY !== true) return Promise.resolve("unavailable")
  if (signal?.aborted === true) return Promise.resolve("cancelled")
  return new Promise((resolve) => {
    const prompt = createInterface({ input, output, terminal: true })
    const cancel = () => finish("cancelled")
    const finish = (result: HarnessUpgradeConfirmation) => {
      prompt.removeListener("close", cancel)
      prompt.removeListener("SIGINT", cancel)
      signal?.removeEventListener("abort", cancel)
      prompt.close()
      resolve(result)
    }
    prompt.once("close", cancel)
    prompt.once("SIGINT", cancel)
    signal?.addEventListener("abort", cancel, { once: true })
    prompt.question("Update all supported harness versions and skills? Type yes to update, or press Enter to cancel: ", (answer) =>
      finish(answer.trim().toLowerCase() === "yes" ? "confirmed" : "cancelled"),
    )
  })
}

export interface HarnessUpgradeCliOptions {
  readonly argv: ReadonlyArray<string>
  readonly readCatalog: () => CombinedGuideCatalog | Promise<CombinedGuideCatalog>
  readonly runner: CommandRunner
  readonly cwd: string
  readonly routerCommandPath?: string
  readonly writeLine: (line: string) => void
  readonly confirm?: (signal?: AbortSignal) => Promise<HarnessUpgradeConfirmation>
  readonly signal?: AbortSignal
}

type WriteLine = HarnessUpgradeCliOptions["writeLine"]

const groupLabel = (group: HarnessUpdatePlan): string =>
  `Native ${group.harness} (${group.key})`

const completeCatalogEntries = (catalog: CombinedGuideCatalog) => {
  if (catalog.native.length === 0) {
    throw new Error("Incomplete catalog: Native profiles are required. No harness or skill updates were started.")
  }
  const entries = aggregateAdminProfiles(catalog)
  if (new Set(entries.map((entry) => entry.ref)).size !== catalog.native.length) {
    throw new Error("Incomplete catalog: profile identities were lost or duplicated. No harness or skill updates were started.")
  }
  return entries
}

const completeCatalogPlan = (catalog: CombinedGuideCatalog, options: HarnessUpgradeCliOptions): HarnessUpdateAllPlan => {
  const entries = completeCatalogEntries(catalog)
  const plan = harnessUpdateAllPlanFor(entries, undefined, options.routerCommandPath ?? "trx")
  if (plan.profileCount !== entries.length) {
    throw new Error("Incomplete catalog: the update plan lost profile targets. No updates were started.")
  }
  return plan
}

const discoverUpgradePlan = async (options: HarnessUpgradeCliOptions): Promise<HarnessUpdateAllPlan | "cancelled"> => {
  try {
    options.signal?.throwIfAborted()
    return completeCatalogPlan(await options.readCatalog(), options)
  } catch (error) {
    if (options.signal?.aborted !== true) throw error
    return "cancelled"
  }
}

const writeSkillsPreview = (skills: NativeSkillsUpdatePlan | undefined, write: WriteLine): void => {
  if (skills === undefined) return
  write(`Native skills: refresh shared caches once; copy and verify ${skills.targets.length} catalog profiles.`)
  write(`  Refresh: ${renderCommandPreview(skills.refresh)}`)
  write("  Caches: native-common, Codex YouTube, Oh My Pi community, and guide Prompt Master.")
  for (const entry of skills.targets) {
    const command = nativeSkillsUpdateCommand(entry)
    write(
      command === undefined
        ? `Unsupported Native skills ${entry.ref}: No skills-update command is available.`
        : `  ${entry.ref}: ${renderCommandPreview(command)}`,
    )
  }
}

const writeHarnessPreview = (groups: ReadonlyArray<HarnessUpdatePlan>, write: WriteLine): void => {
  for (const group of groups) {
    write(`${groupLabel(group)}: ${group.targets.length} profiles`)
    for (const entry of group.targets) write(`  ${entry.ref}`)
    for (const step of group.steps) write(`  Command: ${renderCommandPreview(step.command)}`)
  }
}

const writePreview = (plan: HarnessUpdateAllPlan, write: WriteLine): void => {
  write(`Update all harness versions and skills: ${plan.profileCount} catalog profiles, ${plan.groups.length} supported harness groups.`)
  write(`Scope: ${plan.nativeUpdateCount} Native runtime/profile updates.`)
  write("Includes the full catalog, without Admin filters. Existing profile version and source pins are preserved.")
  write("Trellage installation and upgrades are separate. Unsupported profiles are not substituted with plugin updates.")
  writeHarnessPreview(
    plan.groups.filter((group) => group.surface === "native"),
    write,
  )
  writeSkillsPreview(plan.skills, write)
  for (const { entry, diagnostic } of plan.unsupported) write(`Unsupported harness ${entry.ref}: ${diagnostic}`)
}

const writeSkillsProgress = (event: NativeSkillsUpdateEvent, write: WriteLine): void => {
  if (event.kind === "cache-started") {
    write("Native skills: refreshing shared caches once.")
  } else if (event.kind === "cache-completed") {
    write(
      event.result.state === "success"
        ? "Native skills caches refreshed."
        : `Native skills cache failed: ${event.result.diagnostic}. Native copies will not run; no stale cache is used.`,
    )
  } else if (event.kind === "profile-started") {
    write(`Copying and verifying Native skills: ${event.entry.ref}`)
  } else {
    const { result } = event
    write(result.state === "success" ? `Updated Native skills ${result.ref}` : `Failed Native skills ${result.ref}: ${result.diagnostic}`)
  }
}

const writeProgress = (event: HarnessUpdateQueueEvent, write: WriteLine): void => {
  if (event.kind === "skills") {
    writeSkillsProgress(event.event, write)
    return
  }
  if (event.kind === "started") {
    write(`[${event.index + 1}/${event.total}] ${groupLabel(event.plan)}`)
  } else if (event.kind === "step-started") {
    write(`Running: ${renderCommandPreview(event.step.command)}`)
  } else if (event.kind === "step-completed") {
    for (const result of event.results) {
      write(result.state === "success" ? `Updated harness ${result.ref}` : `Failed harness ${result.ref}: ${result.diagnostic}`)
    }
  } else if (event.report.refreshError !== undefined) {
    write(`Installed-version refresh failed for ${groupLabel(event.report.plan)}: ${event.report.refreshError}`)
  }
}

const upgradeRunner = (options: HarnessUpgradeCliOptions): CommandRunner => ({
  run: (executable, args, runOptions) => {
    const signals = [options.signal, runOptions?.signal].filter((signal): signal is AbortSignal => signal !== undefined)
    return options.runner.run(executable, args, {
      ...runOptions,
      cwd: options.cwd,
      ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
    })
  },
})

const versionRefresh = (runner: CommandRunner, write: WriteLine): ((group: HarnessUpdatePlan) => Promise<void>) => {
  const manager = new AdminRunManager({ runner })
  let cache: AdminHarnessVersionCacheRecord = { schemaVersion: 2, entries: {} }
  return (group) =>
    refreshHarnessUpdateGroupVersions(group, manager, cache, (key, entry, source) => {
      cache = { schemaVersion: 2, entries: { ...cache.entries, [key]: entry } }
      const { installed, latest } = entry.result
      write(`Installed ${source.ref}: ${installed.kind === "known" ? installed.version : `unavailable: ${installed.diagnostic}`}`)
      if (latest.kind === "failed") write(`Latest-version lookup failed for ${source.ref}: ${latest.diagnostic}`)
      if (latest.kind === "unsupported") write(`Latest-version lookup unsupported for ${source.ref}.`)
    })
}

const writeHarnessNotRun = (outcome: HarnessUpdateAllOutcome, write: WriteLine): void => {
  const reported = new Set(outcome.reports.flatMap((report) => report.outcome.results.map((result) => result.ref)))
  for (const group of outcome.plan.groups) {
    for (const entry of group.targets) {
      if (!reported.has(entry.ref)) write(`Harness not run ${entry.ref}: ${outcome.cancelled ? "cancelled" : "no result was reported"}.`)
    }
  }
}

const skillsNotRunReason = (outcome: HarnessUpdateAllOutcome): string => {
  if (outcome.cancelled) return "cancelled"
  if (outcome.skills?.cache.state === "failure") return "shared cache refresh failed; no stale cache is used"
  return "no result was reported"
}

const writeSkillsNotRun = (outcome: HarnessUpdateAllOutcome, write: WriteLine): void => {
  const reported = new Set(outcome.skills?.results.map((result) => result.ref) ?? [])
  for (const entry of outcome.plan.skills?.targets ?? []) {
    if (!reported.has(entry.ref)) write(`Native skills not run ${entry.ref}: ${skillsNotRunReason(outcome)}.`)
  }
}

const skillsCacheStatus = (outcome: HarnessUpdateAllOutcome): string => {
  if (outcome.plan.skills === undefined) return "not required"
  if (outcome.skills === undefined) return "not run"
  return outcome.skills.cache.state === "success" ? "updated" : "failed"
}

const writeOutcome = (outcome: HarnessUpdateAllOutcome, write: WriteLine): number => {
  const summary = harnessUpdateAllSummary(outcome)
  writeHarnessNotRun(outcome, write)
  writeSkillsNotRun(outcome, write)
  write(
    `Harness summary: ${summary.updated} updated, ${summary.failed} failed, ${summary.unsupported} unsupported, ` +
      `${summary.refreshFailed} installed-version refresh failures, ${summary.notRun} not run.`,
  )
  write(
    `Native skills summary: ${summary.nativeSkillsUpdated} updated, ${summary.nativeSkillsFailed} failed, ` +
      `${summary.nativeSkillsNotRun} not run; shared cache: ${skillsCacheStatus(outcome)}.`,
  )
  if (outcome.cancelled) {
    write("Update all cancelled. Completed updates were not rolled back.")
    return 130
  }
  write(
    summary.success
      ? "All catalog harness versions and skills were updated."
      : "Update all did not complete successfully. See the diagnostics above.",
  )
  return summary.success ? 0 : 1
}

const authorizeUpdates = async (approval: "confirm" | "yes", options: HarnessUpgradeCliOptions): Promise<HarnessUpgradeConfirmation> => {
  if (options.signal?.aborted === true) return "cancelled"
  if (approval === "yes") return "confirmed"
  return options.confirm?.(options.signal) ?? "unavailable"
}

export const runHarnessUpgradeCli = async (options: HarnessUpgradeCliOptions): Promise<number> => {
  const args = parseHarnessUpgradeArgv(options.argv)
  if (args.kind === "help") {
    options.writeLine(harnessUpgradeHelpText)
    return 0
  }
  const runner = upgradeRunner(options)
  const plan = await discoverUpgradePlan(options)
  if (plan === "cancelled") {
    options.writeLine("Update all cancelled. No harness or skill updates were started.")
    return 130
  }
  writePreview(plan, options.writeLine)
  if (args.approval === "dry-run") {
    options.writeLine("Dry run. No harness or skill updates or installed-version checks were started.")
    const unsupportedSkills = plan.skills?.targets.some((entry) => nativeSkillsUpdateCommand(entry) === undefined) ?? false
    return plan.unsupported.length === 0 && !unsupportedSkills ? 0 : 1
  }
  const confirmation = await authorizeUpdates(args.approval, options)
  if (confirmation !== "confirmed") {
    options.writeLine(
      confirmation === "cancelled"
        ? "Update all cancelled. No harness or skill updates were started."
        : "No approval: an interactive terminal is required. Use --yes to authorize updates, or --dry-run to preview.",
    )
    return confirmation === "cancelled" ? 130 : 1
  }
  const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager(runner, options.cwd), {
    refresh: versionRefresh(runner, options.writeLine),
    onProgress: (event) => writeProgress(event, options.writeLine),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return writeOutcome(outcome, options.writeLine)
}
