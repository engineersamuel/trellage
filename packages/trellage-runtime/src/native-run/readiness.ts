import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { adapters } from "./adapters.ts"
import { executableOnPath, harnessBinaryAvailable } from "./requirements.ts"
import { lifecycleRuntime, lifecycleRuntimeCommand } from "./lifecycle-runtime.ts"
import type { ResolvedNamedProfile } from "./selection.ts"
import { resolveInstructionFile } from "./resources.ts"

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
  const definitions = [profile.definition, ...profile.alwaysProfiles]
  try {
    const commands = new Set(definitions.flatMap((item) => item.prerequisites?.map((entry) => entry.command) ?? []))
    if (definitions.some((item) => item.skills.length || item.plugins.length || item.repository)) commands.add("git")
    for (const command of commands)
      if (!(await executableOnPath(command, context.environment))) reasons.push(missingCommand(command))
    for (const name of new Set(definitions.flatMap((item) => item.required_environment ?? []))) {
      if (
        !context.environment[name]?.trim() &&
        !(name === "TRANSCRIPT_API_KEY" && context.environment.TRELLAGE_RUN_TRANSCRIPT_API_KEY_PRESENT === "1")
      )
        reasons.push({
          code: "missing-environment",
          message: `Required environment variable is not set: ${name}`,
          prerequisite: name,
        })
    }
    if (profile.name !== "clean")
      for (const id of new Set(definitions.flatMap((definition) => definition.instructions))) {
        const instruction = profile.catalog.instructions[id]!
        const file = resolveInstructionFile(
          instruction.file,
          context.configDirectory ?? context.cwd,
          context.shippedRoot,
        )
        const info = await lstat(file).catch((error) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (!info?.isFile() || info.size > 64 * 1024)
          reasons.push({
            code: "missing-config",
            message: `Instruction file is missing or unsafe: ${id}`,
            prerequisite: id,
          })
      }
    if (profile.name === "clean") {
      const clean = adapters[profile.harness]!.clean
      if (clean.supported) {
        for (const blocker of (await clean.blockers?.find(context.cwd)) ?? [])
          reasons.push({
            code: "workspace-blocked",
            message: `Clean launch would load repository configuration: ${blocker}`,
            prerequisite: "workspace",
          })
      }
    } else {
      setup.push("composition-generation")
      if (definitions.some((item) => item.skills.length || item.plugins.length)) setup.push("selected-resource-refresh")
      const runtime = lifecycleRuntime(profile.harness)
      const usesLifecycle =
        ["agency", "copilot", "omp"].includes(profile.harness) ||
        (profile.harness === "jcode" && !path.isAbsolute(context.environment.TRELLAGE_JCODE_BIN ?? "")) ||
        (profile.harness === "prime" && context.environment.TRELLAGE_PRIME_SKIP_REPAIR !== "1") ||
        (profile.harness === "claude" &&
          (!profile.definitionKey.startsWith("preset-claude-") ||
            ["default", "office", "office-charts"].includes(profile.name)))
      if (runtime && usesLifecycle) {
        const variable = `TRELLAGE_${profile.harness.toUpperCase()}_LIFECYCLE_BIN`
        const override = context.environment[variable]
        const executable =
          override && path.isAbsolute(override)
            ? override
            : lifecycleRuntimeCommand(runtime, context.environment.HOME, context.shippedRoot)
        if (!(await executableOnPath(executable, context.environment)))
          reasons.push(missingCommand(`${profile.harness}-lifecycle`))
      }
    }
    for (const definition of definitions) {
      if (definition.current_working_directory) {
        const directory = definition.current_working_directory.replace(/^~(?=\/|$)/u, context.environment.HOME ?? "")
        const info = await lstat(directory).catch((error) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (!info && definition.repository) setup.push("profile-repository-clone")
        else if (!info?.isDirectory() || info.isSymbolicLink())
          reasons.push({
            code: "missing-config",
            message: "Profile working directory is missing or unsafe",
            prerequisite: "current_working_directory",
          })
      }
    }
    if (profile.harness === "agency") {
      for (const command of ["npm", "npx"])
        if (!(await executableOnPath(command, context.environment))) reasons.push(missingCommand(command))
      const root = path.join(context.environment.HOME ?? "", ".local/share/trellage/profiles/agency/trellage-azure")
      const marker = path.join(root, ".managed-by-trellage-agency-profiles")
      const markerInfo = await lstat(marker).catch((error) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
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
      while (
        worktree !== path.dirname(worktree) &&
        !(await lstat(path.join(worktree, ".git")).catch((error) => {
          if (error.code === "ENOENT") return undefined
          throw error
        }))
      )
        worktree = path.dirname(worktree)
      const config = await lstat(path.join(worktree, "agency.toml")).catch((error) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!config?.isFile())
        reasons.push({
          code: "missing-config",
          message: "Agency needs a repository agency.toml",
          prerequisite: "agency.toml",
        })
      const envAuth = ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID"].every((name) =>
        context.environment[name]?.trim(),
      )
      if (!envAuth && !(await executableOnPath("az", context.environment)))
        reasons.push({
          code: "missing-config",
          message: "Agency requires Azure environment credentials or the Azure CLI",
          prerequisite: "azure-auth",
        })
      if (!envAuth) unverified.push("azure-account-presence")
    }
    if (["copilot", "omp"].includes(profile.harness)) {
      if (!["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].some((name) => context.environment[name]?.trim())) {
        // Secret stores cannot be interrogated without invoking a credential helper.
        if (
          (await executableOnPath("gh", context.environment)) ||
          (await executableOnPath("security", context.environment))
        )
          unverified.push("credential-store-presence")
        else
          reasons.push({
            code: "missing-config",
            message: "Copilot authentication needs a token environment variable or a local credential helper",
            prerequisite: "copilot-auth",
          })
      }
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
