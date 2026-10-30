import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { adapters } from "./adapters.ts"
import { executableOnPath, harnessBinaryAvailable } from "./requirements.ts"
import { lifecycleRuntime, lifecycleRuntimeCommand } from "./lifecycle-runtime.ts"
import type { ResolvedNamedProfile } from "./selection.ts"
import { resolveInstructionFile } from "./resources.ts"
import type { Prerequisite } from "./prerequisites.ts"

export interface ReadinessReason {
  readonly code: string
  readonly message: string
  readonly prerequisite: string | null
}
export interface LocalReadiness {
  readonly status: "ready" | "unavailable"
  readonly reasons: ReadonlyArray<ReadinessReason>
  readonly automaticSetup: ReadonlyArray<string>
  readonly unverified: ReadonlyArray<string>
}
export interface NativeReadinessContext {
  readonly environment: NodeJS.ProcessEnv
  readonly cwd: string
  readonly shippedRoot: string
  readonly configDirectory?: string
}
const missingCommand = (command: string): ReadinessReason => ({
  code: "missing-executable",
  message: `Required executable is unavailable: ${command}`,
  prerequisite: command,
})
const result = (
  reasons: ReadinessReason[],
  automaticSetup: string[] = [],
  unverified = ["credential-validity", "service-reachability"],
): LocalReadiness => ({ status: reasons.length ? "unavailable" : "ready", reasons, automaticSetup, unverified })

const inspectPrerequisites = async (
  profile: ResolvedNamedProfile,
  environment: NodeJS.ProcessEnv,
): Promise<{ reasons: ReadinessReason[]; setup: string[] }> => {
  const prerequisites = new Map<string, Pick<Prerequisite, "command" | "autoInstall">>()
  const definitions = [profile.definition, ...profile.alwaysProfiles]
  for (const definition of definitions)
    for (const entry of definition.prerequisites ?? [])
      if (!prerequisites.has(entry.command)) prerequisites.set(entry.command, entry)
  if (definitions.some((item) => item.skills.length || item.plugins.length || item.repository))
    prerequisites.set("git", { command: "git" })
  const reasons: ReadinessReason[] = []
  const setup: string[] = []
  for (const entry of prerequisites.values()) {
    if (await executableOnPath(entry.command, environment)) continue
    if (entry.autoInstall) setup.push(`install:${entry.command}`)
    else reasons.push(missingCommand(entry.command))
  }
  return { reasons, setup }
}

export const inspectHarnessReadiness = async (
  harness: string,
  context: NativeReadinessContext,
): Promise<LocalReadiness> => {
  const reasons: ReadinessReason[] = []
  if (!adapters[harness])
    return result([
      { code: "unsupported-harness", message: "No installed Trellage adapter for this harness", prerequisite: harness },
    ])
  try {
    if (!(await harnessBinaryAvailable(harness, context.environment))) reasons.push(missingCommand(harness))
    if (harness === "grok" && !["darwin", "linux"].includes(process.platform))
      reasons.push({
        code: "unsupported-platform",
        message: "Grok workspace sandbox requires macOS or Linux",
        prerequisite: "platform",
      })
  } catch {
    reasons.push({
      code: "inspection-failed",
      message: "Could not inspect the required harness executable safely",
      prerequisite: harness,
    })
  }
  return result(reasons)
}

const optionalStat = (file: string) =>
  lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })

const inspectEnvironment = (profile: ResolvedNamedProfile, environment: NodeJS.ProcessEnv): ReadinessReason[] => {
  const definitions = [profile.definition, ...profile.alwaysProfiles]
  const reasons: ReadinessReason[] = []
  for (const name of new Set(definitions.flatMap((item) => item.required_environment ?? []))) {
    if (
      !environment[name]?.trim() &&
      !(name === "TRANSCRIPT_API_KEY" && environment.TRELLAGE_RUN_TRANSCRIPT_API_KEY_PRESENT === "1")
    )
      reasons.push({
        code: "missing-environment",
        message: `Required environment variable is not set: ${name}`,
        prerequisite: name,
      })
  }
  return reasons
}

const inspectInstructions = async (
  profile: ResolvedNamedProfile,
  context: NativeReadinessContext,
): Promise<ReadinessReason[]> => {
  if (profile.name === "clean") return []
  const definitions = [profile.definition, ...profile.alwaysProfiles]
  const reasons: ReadinessReason[] = []
  for (const id of new Set(definitions.flatMap((definition) => definition.instructions))) {
    const instruction = profile.catalog.instructions[id]!
    const file = resolveInstructionFile(instruction.file, context.configDirectory ?? context.cwd, context.shippedRoot)
    const info = await optionalStat(file)
    if (!info?.isFile() || info.size > 64 * 1024)
      reasons.push({
        code: "missing-config",
        message: `Instruction file is missing or unsafe: ${id}`,
        prerequisite: id,
      })
  }
  return reasons
}

const usesLifecycle = (profile: ResolvedNamedProfile, environment: NodeJS.ProcessEnv): boolean => {
  switch (profile.harness) {
    case "agency":
    case "copilot":
    case "omp":
      return true
    case "jcode":
      return !path.isAbsolute(environment.TRELLAGE_JCODE_BIN ?? "")
    case "prime":
      return environment.TRELLAGE_PRIME_SKIP_REPAIR !== "1"
    case "claude":
      return (
        !profile.definitionKey.startsWith("preset-claude-") ||
        ["default", "office", "office-charts"].includes(profile.name)
      )
    default:
      return false
  }
}

const inspectLifecycle = async (
  profile: ResolvedNamedProfile,
  context: NativeReadinessContext,
): Promise<ReadinessReason[]> => {
  const runtime = lifecycleRuntime(profile.harness)
  if (!runtime || !usesLifecycle(profile, context.environment)) return []
  const override = context.environment[`TRELLAGE_${profile.harness.toUpperCase()}_LIFECYCLE_BIN`]
  const executable =
    override && path.isAbsolute(override)
      ? override
      : lifecycleRuntimeCommand(runtime, context.environment.HOME, context.shippedRoot)
  return (await executableOnPath(executable, context.environment))
    ? []
    : [missingCommand(`${profile.harness}-lifecycle`)]
}

const inspectLaunchSetup = async (
  profile: ResolvedNamedProfile,
  context: NativeReadinessContext,
): Promise<{ reasons: ReadinessReason[]; setup: string[] }> => {
  if (profile.name === "clean") {
    const clean = adapters[profile.harness]!.clean
    const blockers = clean.supported ? ((await clean.blockers?.find(context.cwd)) ?? []) : []
    return {
      reasons: blockers.map((blocker) => ({
        code: "workspace-blocked",
        message: `Clean launch would load repository configuration: ${blocker}`,
        prerequisite: "workspace",
      })),
      setup: [],
    }
  }
  const setup = ["composition-generation"]
  const definitions = [profile.definition, ...profile.alwaysProfiles]
  if (definitions.some((item) => item.skills.length || item.plugins.length)) setup.push("selected-resource-refresh")
  return { reasons: await inspectLifecycle(profile, context), setup }
}

const inspectWorkingDirectories = async (
  profile: ResolvedNamedProfile,
  environment: NodeJS.ProcessEnv,
): Promise<{ reasons: ReadinessReason[]; setup: string[] }> => {
  const reasons: ReadinessReason[] = []
  const setup: string[] = []
  for (const definition of [profile.definition, ...profile.alwaysProfiles]) {
    if (!definition.current_working_directory) continue
    const directory = definition.current_working_directory.replace(/^~(?=\/|$)/u, environment.HOME ?? "")
    const info = await optionalStat(directory)
    if (!info && definition.repository) setup.push("profile-repository-clone")
    else if (!info?.isDirectory() || info.isSymbolicLink())
      reasons.push({
        code: "missing-config",
        message: "Profile working directory is missing or unsafe",
        prerequisite: "current_working_directory",
      })
  }
  return { reasons, setup }
}

const inspectAgencyConfiguration = async (context: NativeReadinessContext): Promise<ReadinessReason[]> => {
  const reasons: ReadinessReason[] = []
  for (const command of ["npm", "npx"])
    if (!(await executableOnPath(command, context.environment))) reasons.push(missingCommand(command))
  const root = path.join(context.environment.HOME ?? "", ".local/share/trellage/profiles/agency/trellage-azure")
  const marker = path.join(root, ".managed-by-trellage-agency-profiles")
  const markerInfo = await optionalStat(marker)
  if (
    !markerInfo?.isFile() ||
    markerInfo.size > 128 ||
    (await readFile(marker, "utf8")).trim() !== "trellage-agency-profile-v1"
  )
    reasons.push({
      code: "missing-config",
      message: "Agency profile setup is missing or invalid; run trx setup agency azure",
      prerequisite: "agency-profile",
    })
  let worktree = path.resolve(context.cwd)
  while (worktree !== path.dirname(worktree) && !(await optionalStat(path.join(worktree, ".git"))))
    worktree = path.dirname(worktree)
  const config = await optionalStat(path.join(worktree, "agency.toml"))
  if (!config?.isFile())
    reasons.push({
      code: "missing-config",
      message: "Agency needs a repository agency.toml",
      prerequisite: "agency.toml",
    })
  return reasons
}

const inspectAgencyAuth = async (
  context: NativeReadinessContext,
): Promise<{ reasons: ReadinessReason[]; unverified: string[] }> => {
  const envAuth = ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID"].every((name) =>
    context.environment[name]?.trim(),
  )
  const reasons: ReadinessReason[] = []
  if (!envAuth && !(await executableOnPath("az", context.environment)))
    reasons.push({
      code: "missing-config",
      message: "Agency requires Azure environment credentials or the Azure CLI",
      prerequisite: "azure-auth",
    })
  return { reasons, unverified: envAuth ? [] : ["azure-account-presence"] }
}

const inspectCopilotAuth = async (
  context: NativeReadinessContext,
): Promise<{ reasons: ReadinessReason[]; unverified: string[] }> => {
  if (["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].some((name) => context.environment[name]?.trim()))
    return { reasons: [], unverified: [] }
  // Secret stores cannot be interrogated without invoking a credential helper.
  if ((await executableOnPath("gh", context.environment)) || (await executableOnPath("security", context.environment)))
    return { reasons: [], unverified: ["credential-store-presence"] }
  return {
    reasons: [
      {
        code: "missing-config",
        message: "Copilot authentication needs a token environment variable or a local credential helper",
        prerequisite: "copilot-auth",
      },
    ],
    unverified: [],
  }
}

export const inspectProfileReadiness = async (
  profile: ResolvedNamedProfile,
  harnessReadiness: LocalReadiness,
  context: NativeReadinessContext,
): Promise<LocalReadiness> => {
  const reasons = [...harnessReadiness.reasons]
  if (profile.resolutionProblem)
    reasons.push({ code: "invalid-profile", message: profile.resolutionProblem, prerequisite: profile.definitionKey })
  const setup: string[] = [],
    unverified = [...harnessReadiness.unverified]
  try {
    const prerequisites = await inspectPrerequisites(profile, context.environment)
    reasons.push(...prerequisites.reasons)
    setup.push(...prerequisites.setup)
    reasons.push(...inspectEnvironment(profile, context.environment))
    reasons.push(...(await inspectInstructions(profile, context)))
    const launchSetup = await inspectLaunchSetup(profile, context)
    reasons.push(...launchSetup.reasons)
    setup.push(...launchSetup.setup)
    const directories = await inspectWorkingDirectories(profile, context.environment)
    reasons.push(...directories.reasons)
    setup.push(...directories.setup)
    if (profile.harness === "agency") {
      reasons.push(...(await inspectAgencyConfiguration(context)))
      const auth = await inspectAgencyAuth(context)
      reasons.push(...auth.reasons)
      unverified.push(...auth.unverified)
    }
    if (["copilot", "omp"].includes(profile.harness)) {
      const auth = await inspectCopilotAuth(context)
      reasons.push(...auth.reasons)
      unverified.push(...auth.unverified)
    }
  } catch {
    reasons.push({
      code: "inspection-failed",
      message: "Could not inspect profile prerequisites safely",
      prerequisite: profile.name,
    })
  }
  return result(reasons, [...new Set(setup)], unverified)
}
