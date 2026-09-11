import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import path from "node:path"
import { CommandRunnerError, parseGitWorktreeList, type CommandRunner, type NativeSelectedProfile, type SelectedProfile } from "./guide-launch.js"
import type { GuideGoalExecution } from "./guide-goal-execution.js"
import { assertGuideGoalProfile } from "./guide-goal-transport.js"

type JsonObject = Readonly<Record<string, unknown>>

export interface GuideGoalReadiness {
  readonly kind: "checked" | "blocked" | "unknown"
  readonly summary: string
  readonly diagnostic: string
}

export interface GuideGoalReadinessServices {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly readJson?: (file: string) => Promise<JsonObject | undefined>
  readonly realpath?: (directory: string) => Promise<string>
  readonly readDirectory?: (directory: string) => Promise<ReadonlyArray<string>>
  readonly pathExists?: (file: string) => Promise<boolean>
  readonly localSettingsPaths?: (cwd: string, version: string) => Promise<ReadonlyArray<string>>
}

class GoalReadinessEvidenceError extends Error {}
class GoalReadinessUnknownError extends Error {}

const isRecord = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

const parseObject = (source: string, name: string): JsonObject => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (cause) {
    throw new GoalReadinessEvidenceError(`${name} is not valid JSON.`, { cause })
  }
  if (!isRecord(value)) throw new GoalReadinessEvidenceError(`${name} must be a JSON object.`)
  return value
}

const readSettings = async (file: string): Promise<JsonObject | undefined> => {
  let status: Awaited<ReturnType<typeof lstat>>
  try {
    status = await lstat(file)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  if (!status.isFile() || status.size > 1024 * 1024 || (status.mode & 0o022) !== 0) {
    throw new GoalReadinessEvidenceError(`Goal readiness cannot read unsafe or oversized settings: ${file}`)
  }
  if (await realpath(path.dirname(file)) !== path.dirname(file)) {
    throw new GoalReadinessEvidenceError(`Goal readiness cannot follow a redirected settings directory: ${file}`)
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (opened.ino !== status.ino || opened.dev !== status.dev || opened.size > 1024 * 1024) {
      throw new GoalReadinessEvidenceError(`Goal readiness settings changed while being read: ${file}`)
    }
    return parseObject(await handle.readFile("utf8"), file)
  } finally {
    await handle.close()
  }
}

const readSettingsDirectory = async (directory: string): Promise<ReadonlyArray<string>> => {
  try {
    const status = await lstat(directory)
    if (!status.isDirectory() || (status.mode & 0o022) !== 0 || await realpath(directory) !== directory) {
      throw new GoalReadinessEvidenceError(`Goal readiness cannot read an unsafe settings directory: ${directory}`)
    }
    return (await readdir(directory)).filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort()
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
}

const pathExists = async (file: string): Promise<boolean> => {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

const versionAtLeast = (version: string, minimum: readonly [number, number, number]): boolean => {
  const parts = version.split(".").map(Number)
  for (const [index, minimumPart] of minimum.entries()) {
    const part = parts[index]
    if (part === undefined || !Number.isSafeInteger(part)) return false
    if (part !== minimumPart) return part > minimumPart
  }
  return true
}

const unknown = (diagnostic: string): GuideGoalReadiness => ({
  kind: "unknown", summary: "Goal readiness is unknown", diagnostic,
})

const blocked = (diagnostic: string): GuideGoalReadiness => ({
  kind: "blocked", summary: "Goal activation is blocked", diagnostic,
})

const checked = (summary: string): GuideGoalReadiness => ({
  kind: "checked", summary,
  diagnostic: "These are read-only runtime checks. Model execution and goal activation are not confirmed.",
})

const checkCodexGoal = async (
  runner: CommandRunner,
  selected: NativeSelectedProfile,
  cwd: string,
  services: GuideGoalReadinessServices,
  signal?: AbortSignal,
): Promise<GuideGoalReadiness> => {
  const env = services.env ?? process.env
  const home = env.HOME ?? homedir()
  if (!path.isAbsolute(home)) return unknown("HOME must identify the actual managed Codex profile directory.")
  const options = {
    cwd, env: { ...env, CODEX_HOME: path.join(home, ".local/share/trellage/profiles/codex", selected.profile, "home") },
    timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }),
  }
  const output = await runner.run("codex", ["--version"], options)
  const version = /^codex(?:-cli)? (\d+\.\d+\.\d+)\s*$/u.exec(output.stdout.trim())?.[1]
  if (version === undefined || !versionAtLeast(version, [0, 153, 4])) {
    return unknown("Native /goal is confirmed for stable Codex 0.153.4 or later. Check the installed runtime; no goal was submitted.")
  }
  // Bare feature listing can silently skip project config that a cdx launch trusts.
  const features = await runner.run(
    selected.commandPath, ["inventory", selected.profile, "--goal-features"], options,
  ).catch((error: unknown) => {
    if (error instanceof CommandRunnerError && error.kind === "exited") {
      throw new GoalReadinessUnknownError(
        `Codex goal features cannot be confirmed with the launch configuration. Check the installed launcher's inventory PROFILE --goal-features support and its diagnostic: ${error.stderr.trim() || error.message}`,
        { cause: error },
      )
    }
    throw error
  })
  const goals = /^goals\s+stable\s+(true|false)\s*$/mu.exec(features.stdout)?.[1]
  if (goals === "false") return blocked("The Codex launch configuration disables goals. No settings were changed.")
  if (goals !== "true") return unknown("The launch-configured Codex runtime did not report the effective stable goals feature. Check its configuration before native input.")
  if (features.stderr.trim().length > 0) return unknown(`Codex reported configuration diagnostics: ${features.stderr.trim()}`)
  return checked(`Codex ${version} reports goals enabled; manual native input is required`)
}

interface ClaudeRuntime {
  readonly version: string
  readonly profileHome: string
  readonly evaluatorModel: string
  readonly modelsUrl: string
}

const readClaudeRuntime = (source: string, selected: NativeSelectedProfile): ClaudeRuntime | undefined => {
  const payload = parseObject(source, "Claude runtime")
  if (payload.schemaVersion !== 1 || payload.launcher !== selected.launcher || payload.harness !== "claude") {
    throw new GoalReadinessEvidenceError("Claude runtime identity does not match the selected profile.")
  }
  const runtime = payload.goalRuntime
  if (!isRecord(runtime)) return undefined
  if (
    typeof payload.installed !== "string" || !/^\d+\.\d+\.\d+$/u.test(payload.installed) ||
    typeof runtime.profileHome !== "string" || !path.isAbsolute(runtime.profileHome) ||
    typeof runtime.evaluatorModel !== "string" || runtime.evaluatorModel.trim().length === 0 ||
    runtime.modelsUrl !== "http://127.0.0.1:8080/v1/models"
  ) {
    throw new GoalReadinessEvidenceError("Claude goal runtime evidence is incomplete or invalid.")
  }
  return {
    version: payload.installed, profileHome: runtime.profileHome,
    evaluatorModel: runtime.evaluatorModel, modelsUrl: runtime.modelsUrl,
  }
}

const managedClaudeDirectory = (platform: NodeJS.Platform): string | undefined =>
  platform === "darwin" ? "/Library/Application Support/ClaudeCode" : platform === "linux" ? "/etc/claude-code" : undefined

const optionalBoolean = (settings: JsonObject, name: string): boolean | undefined => {
  const value = settings[name]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new GoalReadinessEvidenceError(`Claude ${name} setting is not a boolean.`)
  return value
}

interface ClaudeSettingsSource {
  readonly file: string
  readonly managed: boolean
  readonly required?: boolean
}

interface ClaudeHookSettings {
  readonly hooksDisabled: boolean
  readonly managedOnly: boolean
  readonly policyHelper: unknown
}

const mergeClaudeHookSettings = (
  current: ClaudeHookSettings,
  settings: JsonObject,
  managed: boolean,
): ClaudeHookSettings => ({
  hooksDisabled: optionalBoolean(settings, "disableAllHooks") ?? current.hooksDisabled,
  managedOnly: managed ? optionalBoolean(settings, "allowManagedHooksOnly") ?? current.managedOnly : current.managedOnly,
  policyHelper: managed && settings.policyHelper !== undefined ? settings.policyHelper : current.policyHelper,
})

const checkClaudeHookSettings = async (
  readJson: NonNullable<GuideGoalReadinessServices["readJson"]>,
  sources: ReadonlyArray<ClaudeSettingsSource>,
): Promise<GuideGoalReadiness | undefined> => {
  let policy: ClaudeHookSettings = { hooksDisabled: false, managedOnly: false, policyHelper: undefined }
  for (const source of sources) {
    const settings = await readJson(source.file)
    if (settings === undefined) {
      if (source.required === true) return unknown("Managed Claude settings are missing. Check the selected profile before using /goal.")
      continue
    }
    policy = mergeClaudeHookSettings(policy, settings, source.managed)
  }
  if (policy.managedOnly) return blocked("Managed Claude policy allows only managed hooks. Native /goal is not available.")
  if (policy.policyHelper !== undefined && policy.policyHelper !== null) return unknown("Claude uses a managed policy helper. Its effective hook policy cannot be checked without running that helper; no helper was executed.")
  return policy.hooksDisabled ? blocked("Effective Claude settings disable all hooks. Native /goal is not available.") : undefined
}

const requireOwnedSettingsRoot = async (root: string): Promise<void> => {
  if (!path.isAbsolute(root) || process.getuid === undefined) throw new GoalReadinessUnknownError("Claude's local settings root could not be established.")
  for (const directory of [root, path.join(root, ".git"), path.join(root, ".claude")]) {
    try {
      const status = await lstat(directory)
      if (status.uid !== process.getuid() || status.isSymbolicLink()) {
        throw new GoalReadinessUnknownError("Claude's effective local settings cannot be confirmed for a redirected or differently owned checkout.")
      }
    } catch (error) {
      if (!isMissingFile(error) || directory !== path.join(root, ".claude")) throw error
    }
  }
}

const claudeLocalSettingsPaths = async (
  runner: CommandRunner,
  cwd: string,
  version: string,
  home: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<string>> => {
  const local = path.join(cwd, ".claude/settings.local.json")
  if (!versionAtLeast(version, [2, 1, 211])) return [local]
  const options = { cwd, timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) }
  let root: string
  try {
    root = (await runner.run("git", ["rev-parse", "--show-toplevel"], options)).stdout.trim()
  } catch (error) {
    if (error instanceof CommandRunnerError && error.kind === "exited" && /not a git repository/iu.test(error.stderr)) return [local]
    throw error
  }
  if (root === home) return [local]
  await requireOwnedSettingsRoot(root)
  const worktrees = parseGitWorktreeList((await runner.run("git", ["worktree", "list", "--porcelain"], options)).stdout)
  const primary = worktrees[0]?.path
  if (primary === undefined) throw new GoalReadinessUnknownError("Claude's primary checkout settings could not be located.")
  await requireOwnedSettingsRoot(primary)
  return [...new Set([local, path.join(primary, ".claude/settings.local.json")])]
}

const checkExternalClaudePolicy = async (
  state: JsonObject,
  services: GuideGoalReadinessServices,
): Promise<GuideGoalReadiness | undefined> => {
  const env = services.env ?? process.env
  if (state.oauthAccount !== undefined || env.WSL_INTEROP !== undefined || env.WSL_DISTRO_NAME !== undefined) {
    return unknown("Claude may have server-managed or Windows policy. The effective hook policy is not available to this read-only adapter; check /status before native goal input.")
  }
  if (env.CLAUDE_CODE_SIMPLE !== undefined && env.CLAUDE_CODE_SIMPLE !== "" && env.CLAUDE_CODE_SIMPLE !== "0") {
    return unknown("CLAUDE_CODE_SIMPLE changes the available runtime features. Goal activation is not confirmed in this mode; no environment settings were changed.")
  }
  if ((services.platform ?? process.platform) !== "darwin") return undefined
  const exists = services.pathExists ?? pathExists
  const preferences = "/Library/Managed Preferences"
  for (const directory of [preferences, path.join(preferences, userInfo().username)]) {
    if (await exists(path.join(directory, "com.anthropic.claudecode.plist"))) {
      return unknown("Claude has macOS managed preferences. Their effective hook policy cannot be confirmed by this file adapter; check /status before native goal input.")
    }
  }
  return undefined
}

const checkClaudeSettings = async (
  runner: CommandRunner,
  runtime: ClaudeRuntime,
  cwd: string,
  services: GuideGoalReadinessServices,
  signal?: AbortSignal,
): Promise<GuideGoalReadiness | undefined> => {
  const readJson = services.readJson ?? readSettings
  const workspace = await (services.realpath ?? realpath)(cwd)
  const state = await readJson(path.join(runtime.profileHome, ".claude.json"))
  if (state === undefined || !isRecord(state.projects)) return unknown("The managed Claude profile has no recorded workspace trust. Review workspace trust outside this goal launch.")
  const project = state.projects[workspace]
  if (!isRecord(project) || project.hasTrustDialogAccepted !== true) {
    return blocked(`Claude has not accepted workspace trust for ${workspace}. No trust or permission settings were changed.`)
  }
  const externalPolicy = await checkExternalClaudePolicy(state, services)
  if (externalPolicy !== undefined) return externalPolicy
  const managedDirectory = managedClaudeDirectory(services.platform ?? process.platform)
  if (managedDirectory === undefined) return unknown("Managed Claude hook policy cannot be checked on this operating system.")
  const managedParts = await (services.readDirectory ?? readSettingsDirectory)(path.join(managedDirectory, "managed-settings.d"))
  const localFiles = services.localSettingsPaths === undefined
    ? await claudeLocalSettingsPaths(runner, workspace, runtime.version, services.env?.HOME ?? process.env.HOME ?? homedir(), signal)
    : await services.localSettingsPaths(workspace, runtime.version)
  return checkClaudeHookSettings(readJson, [
    { file: path.join(runtime.profileHome, "settings.json"), managed: false, required: true },
    { file: path.join(workspace, ".claude/settings.json"), managed: false },
    ...localFiles.map((file) => ({ file, managed: false })),
    { file: path.join(managedDirectory, "managed-settings.json"), managed: true },
    ...managedParts.filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort().map((name) => ({
      file: path.join(managedDirectory, "managed-settings.d", name), managed: true,
    })),
  ])
}

const checkClaudeGoal = async (
  runner: CommandRunner,
  selected: NativeSelectedProfile,
  cwd: string,
  services: GuideGoalReadinessServices,
  signal?: AbortSignal,
): Promise<GuideGoalReadiness> => {
  const options = { cwd, timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) }
  const version = await runner.run(selected.commandPath, ["harness-version"], options)
  const runtime = readClaudeRuntime(version.stdout, selected)
  if (runtime === undefined) return unknown("This Claude launcher does not expose its goal evaluator runtime. Refresh the managed launcher before automatic goal delivery, or inspect the runtime and use native input manually.")
  // Claude's published changelog introduces interactive and -p /goal in 2.1.139.
  if (!versionAtLeast(runtime.version, [2, 1, 139])) return unknown("Native /goal is confirmed for Claude 2.1.139 or later. Check the installed runtime before goal delivery.")
  const expectedHome = path.join(services.env?.HOME ?? process.env.HOME ?? homedir(), ".local/share/trellage/profiles/claude/default/home")
  if (runtime.profileHome !== expectedHome) return unknown("Claude runtime evidence points to a different managed profile home. Refresh the selected launcher before goal delivery.")
  const settings = await checkClaudeSettings(runner, runtime, cwd, services, signal)
  if (settings !== undefined) return settings
  const models = parseObject((await runner.run(
    "curl", ["--fail", "--silent", "--show-error", "--max-time", "5", runtime.modelsUrl], options,
  )).stdout, "Claude evaluator model inventory")
  const entries = models.data ?? models.models
  if (!Array.isArray(entries)) return unknown("The configured Claude proxy did not return a model inventory.")
  if (!entries.some((entry) => isRecord(entry) && (entry.id ?? entry.slug) === runtime.evaluatorModel)) {
    return blocked(`The configured Claude goal evaluator model ${runtime.evaluatorModel} is unavailable. Check model access; no model or permission settings were changed.`)
  }
  return checked(`Claude ${runtime.version} passes the native goal trust, hook, and evaluator-inventory checks`)
}

export const checkGuideGoalReadiness = async (
  runner: CommandRunner,
  selected: SelectedProfile,
  cwd: string,
  execution: GuideGoalExecution,
  signal?: AbortSignal,
  services: GuideGoalReadinessServices = {},
): Promise<GuideGoalReadiness> => {
  assertGuideGoalProfile(selected, execution)
  if (selected.surface === "sandbox") {
    if (execution.controller === "graph-of-loops") return checked("The selected Graph profile is available; its authored controller owns progress and completion")
    return unknown("Sandbox doctor does not expose effective goal runtime, workspace trust, hook policy, or evaluator access. Check them in the selected Sandbox before native input; automatic goal delivery is not confirmed.")
  }
  try {
    return execution.controller === "codex-goal"
      ? await checkCodexGoal(runner, selected, cwd, services, signal)
      : await checkClaudeGoal(runner, selected, cwd, services, signal)
  } catch (error) {
    if (error instanceof CommandRunnerError) {
      return unknown(error.stderr.trim() || error.stdout.trim() || error.message)
    }
    if (error instanceof GoalReadinessEvidenceError) return blocked(error.message)
    if (error instanceof GoalReadinessUnknownError) return unknown(error.message)
    if (error instanceof Error && "code" in error) {
      return unknown(`Goal runtime settings cannot be read (${String(error.code)}). Check the selected profile without changing trust or permissions.`)
    }
    throw error
  }
}
