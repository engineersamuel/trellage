import path from "node:path"
import { spawn } from "node:child_process"

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u
const safeLauncherAlias = /^[a-z][a-z0-9-]{0,63}$/u
const safeProfileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const safeAgentName = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const safeShellText = /^[A-Za-z0-9_./:-]+$/u
const gitBranchPrefix = "refs/heads/"
const commandOutputLimitBytes = 1024 * 1024
const forcedKillDelayMs = 1000
const guideCaptureSources: ReadonlyArray<GuideCaptureSource> = [
  "selection",
  "transcript",
  "sandbox-transcript",
  "terminal",
  "capture-queue",
]
const guideCaptureConfidences: ReadonlyArray<GuideCaptureConfidence> = ["user-selected", "exact", "snapshot", "user-curated"]

const appendTruncatedChunk = (target: Array<Buffer>, buffer: Buffer, currentLength: number): number => {
  target.push(buffer)
  let boundedLength = currentLength + buffer.length
  while (boundedLength > commandOutputLimitBytes) {
    const first = target[0]
    if (first === undefined) return 0
    const excess = boundedLength - commandOutputLimitBytes
    if (first.length <= excess) {
      target.shift()
      boundedLength -= first.length
    } else {
      target[0] = first.subarray(excess)
      boundedLength -= excess
    }
  }
  return boundedLength
}

export type GuideSurface = "native" | "sandbox"
export type PromptDeliveryMode = "none" | "argv"
export type PromptHandlingMode = "none" | "argv" | "manual-paste"
export type HerdrPromptDeliveryMode = "command" | "agent"
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown"
export type HerdrSplitDirection = "right" | "down"
export type HerdrInvocationSurface = "pane" | "popup"
export type GuideCaptureSource = "selection" | "transcript" | "sandbox-transcript" | "terminal" | "capture-queue"
export type GuideCaptureConfidence = "user-selected" | "exact" | "snapshot" | "user-curated"
export type GuideLaunchErrorKind = "blocked" | "timeout" | "startup" | "invalid-output"
export type WorktreeCollisionKind = "branch-exists" | "branch-active" | "path-active"
export type GitWorktreeInspectionKind = "ready" | "collision" | "invalid-branch"

export interface NativeSelectedProfile {
  readonly surface: "native"
  readonly launcher: string
  readonly commandPath: string
  readonly profile: string
  readonly headlessPrompt: boolean
  readonly agent?: string
}

export interface SandboxSelectedProfile {
  readonly surface: "sandbox"
  readonly commandPath: string
  readonly profile: string
  readonly headlessPrompt: boolean
}

export type SelectedProfile = NativeSelectedProfile | SandboxSelectedProfile

export interface ArgvPromptDelivery {
  readonly mode: "argv"
  readonly prompt: string
}

export interface NoPromptDelivery {
  readonly mode: "none"
}

export type PromptDelivery = ArgvPromptDelivery | NoPromptDelivery

export interface CommandSpec {
  readonly executable: string
  readonly args: ReadonlyArray<string>
}

export interface BuiltCommandSpec {
  readonly command: CommandSpec
  readonly promptHandling: PromptHandlingMode
}

export interface BuiltHerdrGuideLaunch {
  readonly command: CommandSpec
  readonly promptDelivery: HerdrPromptDeliveryMode
}

export interface CommandRunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly outputOverflow?: "terminate" | "truncate"
}

export interface CommandRunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: 0
}

export interface CommandRunner {
  run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult>
}

export interface HerdrEnvironment {
  readonly HERDR_ENV?: string
  readonly HERDR_WORKSPACE_ID?: string
  readonly HERDR_PANE_ID?: string
  readonly TRELLAGE_GUIDE_HERDR_CONTEXT_JSON?: string
}

export interface HerdrContext {
  readonly workspaceId: string
  readonly paneId: string
  readonly surface: HerdrInvocationSurface
  readonly cwd?: string
  readonly capture?: GuideCaptureProvenance
}

export interface GuideCaptureProvenance {
  readonly source: GuideCaptureSource
  readonly confidence: GuideCaptureConfidence
  readonly agent?: string
  readonly sessionId?: string
  readonly identitySource?: string
  readonly profile?: string
}

export interface TimeController {
  readonly now: () => number
  readonly sleep: (milliseconds: number) => Promise<void>
}

export interface WaitForIdleOptions {
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
  readonly time?: TimeController
}

export interface LaunchInHerdrPaneOptions extends WaitForIdleOptions {
  readonly paneId: string
  readonly cwd: string
  readonly command: CommandSpec
  readonly prompt: string
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly promptTimeoutMs: number
}

export interface CurrentWorkspaceHandoffOptions extends Omit<LaunchInHerdrPaneOptions, "paneId"> {
  readonly callerPaneId: string
  readonly direction: HerdrSplitDirection
}

export interface HerdrWorktreeHandle {
  readonly workspaceId: string
  readonly rootPaneId: string
  readonly checkoutPath: string
}

export interface WorktreeCreateOptions {
  readonly primaryCheckoutPath: string
  readonly branch: string
  readonly baseRef: string
}

export interface WorktreeOpenOptions {
  readonly primaryCheckoutPath: string
  readonly path: string
}

export interface WorktreeHandoffOptions extends Omit<LaunchInHerdrPaneOptions, "paneId" | "cwd"> {
  readonly primaryCheckoutPath: string
  readonly branch: string
  readonly baseRef: string
}

export interface ExistingWorktreeHandoffOptions extends Omit<LaunchInHerdrPaneOptions, "paneId" | "cwd"> {
  readonly primaryCheckoutPath: string
  readonly path: string
}

export interface HerdrPaneLaunchResult {
  readonly paneId: string
  readonly commandPreview: string
}

export interface HerdrWorktreeLaunchResult extends HerdrPaneLaunchResult {
  readonly workspaceId: string
  readonly rootPaneId: string
  readonly checkoutPath: string
}

export interface GitWorktreeEntry {
  readonly path: string
  readonly branch: string | null
  readonly head: string | null
}

interface GitInspectionBase {
  readonly currentCheckoutRoot: string
  readonly primaryCheckoutPath: string
  readonly currentHeadSha: string
  readonly baseRef: string
  readonly branch: string
  readonly dirty: boolean
  readonly branchExists: boolean
  readonly activeBranchWorktree: GitWorktreeEntry | null
  readonly activePathWorktree: GitWorktreeEntry | null
  readonly targetPath?: string
}

export interface GitInspectionReady extends GitInspectionBase {
  readonly kind: "ready"
}

export interface WorktreeCollisionResult extends GitInspectionBase {
  readonly kind: "collision"
  readonly collision: {
    readonly kind: WorktreeCollisionKind
    readonly path?: string
  }
}

export interface InvalidBranchResult {
  readonly kind: "invalid-branch"
  readonly branch: string
}

export type GitWorktreeInspection = GitInspectionReady | WorktreeCollisionResult | InvalidBranchResult

interface JsonRecord {
  readonly [key: string]: unknown
}

const systemTime: TimeController = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const parseJsonRecord = (source: string, name: string): JsonRecord => {
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    throw new GuideLaunchError({
      kind: "invalid-output",
      message: `${name} did not return valid JSON`,
    })
  }
  if (!isRecord(payload)) {
    throw new GuideLaunchError({
      kind: "invalid-output",
      message: `${name} did not return a JSON object`,
    })
  }
  return payload
}

const getRecord = (value: unknown, name: string): JsonRecord => {
  if (!isRecord(value)) {
    throw new GuideLaunchError({
      kind: "invalid-output",
      message: `${name} must be an object`,
    })
  }
  return value
}

const getString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new GuideLaunchError({
      kind: "invalid-output",
      message: `${name} must be a non-empty string`,
    })
  }
  return value
}

const validateLauncher = (value: unknown): string => {
  const launcher = getString(value, "selected profile launcher")
  if (!safeLauncherAlias.test(launcher)) {
    throw new Error("selected profile launcher must be a safe lowercase alias")
  }
  return launcher
}

const validateProfileName = (value: unknown): string => {
  const profile = getString(value, "selected profile profile")
  if (controlCharacters.test(profile)) {
    throw new Error("selected profile profile must not contain control characters")
  }
  if (!safeProfileName.test(profile)) {
    throw new Error("selected profile profile must be a simple identifier")
  }
  return profile
}

const validateCommandPath = (value: unknown): string => {
  const commandPath = getString(value, "selected profile commandPath")
  if (controlCharacters.test(commandPath)) {
    throw new Error("selected profile commandPath must not contain control characters")
  }
  if (!path.isAbsolute(commandPath)) {
    throw new Error("selected profile commandPath must be an absolute path")
  }
  return commandPath
}

const validateHeadlessPrompt = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("selected profile headlessPrompt must be a boolean")
  return value
}

const validateAgent = (value: unknown, launcher: string): string | undefined => {
  if (value === undefined) return undefined
  const agent = getString(value, "selected profile agent")
  if (launcher !== "cpx") throw new Error("selected profile agent is supported only by the cpx launcher")
  if (!safeAgentName.test(agent)) throw new Error("selected profile agent must be a simple agent identifier")
  return agent
}

const normalizePromptDelivery = (delivery?: PromptDelivery): PromptDelivery => delivery ?? { mode: "none" }

const hasNonEmptyText = (value: string | undefined): value is string => typeof value === "string" && value.length > 0

const parseAgentStatus = (value: unknown): HerdrAgentStatus => {
  const status = getString(value, "Herdr agent status")
  switch (status) {
    case "idle":
    case "working":
    case "blocked":
    case "done":
    case "unknown":
      return status
    default:
      throw new GuideLaunchError({
        kind: "invalid-output",
        message: `Herdr agent status is invalid: ${status}`,
      })
  }
}

export class InvalidBranchError extends Error {
  readonly kind = "invalid-branch" as const
  readonly branch: string

  constructor(branch: string, cause?: unknown) {
    super(`invalid git branch name: ${branch}`, cause === undefined ? undefined : { cause })
    this.name = "InvalidBranchError"
    this.branch = branch
  }
}

const combineOutput = (error: CommandRunnerError): string => `${error.stderr}\n${error.stdout}`

const resolvePromptFailure = (paneId: string, error: CommandRunnerError): GuideLaunchError => {
  const combined = combineOutput(error)
  if (combined.includes("agent_blocked")) {
    return new GuideLaunchError({
      kind: "blocked",
      paneId,
      stderr: error.stderr,
      message: `Herdr blocked prompt delivery for pane ${paneId}`,
      cause: error,
    })
  }
  if (error.kind === "timed-out" || combined.includes("timeout")) {
    return new GuideLaunchError({
      kind: "timeout",
      paneId,
      stderr: error.stderr,
      message: `Herdr prompt delivery timed out for pane ${paneId}`,
      cause: error,
    })
  }
  return new GuideLaunchError({
    kind: "startup",
    paneId,
    stderr: error.stderr,
    message: `Herdr prompt delivery failed for pane ${paneId}`,
    cause: error,
  })
}

const runGit = async (
  runner: CommandRunner,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: CommandRunOptions,
): Promise<CommandRunResult> =>
  runner.run(
    "git",
    ["--no-pager", "-C", cwd, ...args],
    options?.timeoutMs === undefined && options?.signal === undefined && options?.env === undefined
      ? undefined
      : {
          ...(options?.env === undefined ? {} : { env: options.env }),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
  )

const resolveGitRoot = async (runner: CommandRunner, cwd: string): Promise<string> => {
  const result = await runGit(runner, cwd, ["rev-parse", "--show-toplevel"])
  const root = result.stdout.trim()
  if (!hasNonEmptyText(root)) throw new Error("git rev-parse returned an empty root")
  return path.resolve(root)
}

export const validateGitBranchName = async (runner: CommandRunner, cwd: string, branch: string): Promise<void> => {
  try {
    await runGit(runner, cwd, ["check-ref-format", "--branch", branch])
  } catch (error) {
    if (error instanceof CommandRunnerError && error.kind === "exited") {
      throw new InvalidBranchError(branch, error)
    }
    throw error
  }
}

const resolveCurrentHeadSha = async (runner: CommandRunner, cwd: string): Promise<string> => {
  const result = await runGit(runner, cwd, ["rev-parse", "HEAD"])
  const head = result.stdout.trim()
  if (!/^[0-9a-f]{40,64}$/u.test(head)) throw new Error("git rev-parse returned an invalid HEAD SHA")
  return head
}

const checkBranchExists = async (runner: CommandRunner, repoRoot: string, branch: string): Promise<boolean> => {
  try {
    await runGit(runner, repoRoot, ["show-ref", "--verify", "--quiet", `${gitBranchPrefix}${branch}`])
    return true
  } catch (error) {
    if (error instanceof CommandRunnerError && error.kind === "exited" && error.exitCode === 1) return false
    throw error
  }
}

export class CommandRunnerError extends Error {
  readonly kind: "spawn-failed" | "exited" | "aborted" | "timed-out" | "output-limit"
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string

  constructor(options: {
    readonly kind: "spawn-failed" | "exited" | "aborted" | "timed-out" | "output-limit"
    readonly executable: string
    readonly args: ReadonlyArray<string>
    readonly message: string
    readonly exitCode?: number | null
    readonly signal?: NodeJS.Signals | null
    readonly stdout?: string
    readonly stderr?: string
    readonly cause?: unknown
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "CommandRunnerError"
    this.kind = options.kind
    this.executable = options.executable
    this.args = [...options.args]
    this.exitCode = options.exitCode ?? null
    this.signal = options.signal ?? null
    this.stdout = options.stdout ?? ""
    this.stderr = options.stderr ?? ""
  }
}

export class GuideLaunchError extends Error {
  readonly kind: GuideLaunchErrorKind
  readonly paneId?: string
  readonly stderr?: string

  constructor(options: {
    readonly kind: GuideLaunchErrorKind
    readonly message: string
    readonly paneId?: string
    readonly stderr?: string
    readonly cause?: unknown
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "GuideLaunchError"
    this.kind = options.kind
    if (options.paneId !== undefined) this.paneId = options.paneId
    if (options.stderr !== undefined) this.stderr = options.stderr
  }
}

export const parseSelectedProfile = (value: unknown): SelectedProfile => {
  if (!isRecord(value)) throw new Error("selected profile must be an object")
  const surface = getString(value.surface, "selected profile surface")
  if (surface === "native") {
    const launcher = validateLauncher(value.launcher)
    const agent = validateAgent(value.agent, launcher)
    return {
      surface,
      launcher,
      commandPath: validateCommandPath(value.commandPath),
      profile: validateProfileName(value.profile),
      headlessPrompt: validateHeadlessPrompt(value.headlessPrompt),
      ...(agent === undefined ? {} : { agent }),
    }
  }
  if (surface === "sandbox") {
    return {
      surface,
      commandPath: validateCommandPath(value.commandPath),
      profile: validateProfileName(value.profile),
      headlessPrompt: validateHeadlessPrompt(value.headlessPrompt),
    }
  }
  throw new Error("selected profile surface must be native or sandbox")
}

const nativePromptArgs = (
  selectedProfile: NativeSelectedProfile,
  baseArgs: ReadonlyArray<string>,
  prompt: string,
): ReadonlyArray<string> => {
  if (selectedProfile.launcher === "cdx") return [...baseArgs, "--", prompt]
  if (!selectedProfile.headlessPrompt) return baseArgs
  return [...baseArgs, selectedProfile.launcher === "cpx" ? "-i" : "-p", prompt]
}

export const buildGuideLaunchCommand = (
  selectedProfile: SelectedProfile,
  delivery?: PromptDelivery,
): BuiltCommandSpec => {
  const normalizedDelivery = normalizePromptDelivery(delivery)
  const baseArgs =
    selectedProfile.surface === "native"
      ? [
          selectedProfile.profile,
          ...(selectedProfile.agent === undefined ? [] : ["--agent", selectedProfile.agent]),
        ]
      : ["--profile", selectedProfile.profile]
  if (normalizedDelivery.mode === "argv") {
    if (selectedProfile.surface === "sandbox") {
      return {
        command: {
          executable: selectedProfile.commandPath,
          args: [...baseArgs, normalizedDelivery.prompt],
        },
        promptHandling: "argv",
      }
    }
    return {
      command: {
        executable: selectedProfile.commandPath,
        args: nativePromptArgs(selectedProfile, baseArgs, normalizedDelivery.prompt),
      },
      promptHandling:
        selectedProfile.headlessPrompt || selectedProfile.launcher === "cdx" ? "argv" : "manual-paste",
    }
  }
  return {
    command: {
      executable: selectedProfile.commandPath,
      args: baseArgs,
    },
    promptHandling: "none",
  }
}

export const buildHerdrGuideLaunch = (
  selectedProfile: SelectedProfile,
  prompt: string,
): BuiltHerdrGuideLaunch => {
  if (selectedProfile.surface === "native" && selectedProfile.launcher === "cpx") {
    const baseCommand = buildGuideLaunchCommand(selectedProfile).command
    return {
      command: { executable: baseCommand.executable, args: [...baseCommand.args, "-i", prompt] },
      promptDelivery: "command",
    }
  }
  if (selectedProfile.surface === "native" && selectedProfile.launcher === "cdx") {
    const baseCommand = buildGuideLaunchCommand(selectedProfile).command
    return {
      command: { executable: baseCommand.executable, args: [...baseCommand.args, "--", prompt] },
      promptDelivery: "command",
    }
  }
  return {
    command: buildGuideLaunchCommand(selectedProfile).command,
    promptDelivery: "agent",
  }
}

export const posixShellEscape = (value: string): string => {
  if (value.length === 0) return "''"
  if (safeShellText.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export const renderCommandPreview = (command: CommandSpec): string =>
  [command.executable, ...command.args].map(posixShellEscape).join(" ")

export const createNodeCommandRunner = (): CommandRunner => ({
  run: (executable, args, options) =>
    new Promise<CommandRunResult>((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(
          new CommandRunnerError({
            kind: "aborted",
            executable,
            args,
            message: `command aborted before start: ${executable}`,
          }),
        )
        return
      }

      const stdoutChunks: Array<Buffer> = []
      const stderrChunks: Array<Buffer> = []
      let stdoutLength = 0
      let stderrLength = 0
      let terminationKind: "aborted" | "timed-out" | "output-limit" | null = null
      let outputLimitStream: "stdout" | "stderr" | null = null
      let settled = false
      let child: ReturnType<typeof spawn>
      let timer: ReturnType<typeof setTimeout> | undefined
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined

      const snapshotOutput = (): { readonly stdout: string; readonly stderr: string } => ({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      })

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
        if (options?.signal !== undefined) options.signal.removeEventListener("abort", onAbort)
      }

      const finalize = (
        result:
          | { readonly type: "resolve"; readonly value: CommandRunResult }
          | { readonly type: "reject"; readonly error: CommandRunnerError },
      ) => {
        if (settled) return
        settled = true
        cleanup()
        if (result.type === "resolve") resolve(result.value)
        else reject(result.error)
      }

      const requestTermination = (kind: "aborted" | "timed-out" | "output-limit", stream?: "stdout" | "stderr") => {
        if (terminationKind !== null) return
        terminationKind = kind
        if (stream !== undefined) outputLimitStream = stream
        child.kill("SIGTERM")
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL")
        }, forcedKillDelayMs)
      }

      const appendChunk = (target: Array<Buffer>, chunk: Buffer | string, stream: "stdout" | "stderr") => {
        if (terminationKind === "output-limit") return
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
        const nextLength = (stream === "stdout" ? stdoutLength : stderrLength) + buffer.length
        if (nextLength > commandOutputLimitBytes) {
          if (options?.outputOverflow !== "truncate") {
            requestTermination("output-limit", stream)
            return
          }
          const boundedLength = appendTruncatedChunk(
            target,
            buffer,
            stream === "stdout" ? stdoutLength : stderrLength,
          )
          if (stream === "stdout") stdoutLength = boundedLength
          else stderrLength = boundedLength
          return
        }
        target.push(buffer)
        if (stream === "stdout") stdoutLength = nextLength
        else stderrLength = nextLength
      }

      const onAbort = () => {
        requestTermination("aborted")
      }

      try {
        child = spawn(executable, [...args], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.env === undefined ? {} : { env: options.env }),
        })
      } catch (error) {
        finalize({
          type: "reject",
          error: new CommandRunnerError({
            kind: "spawn-failed",
            executable,
            args,
            message: `failed to spawn command: ${executable}`,
            cause: error,
          }),
        })
        return
      }

      child.stdout?.on("data", (chunk: Buffer | string) => {
        appendChunk(stdoutChunks, chunk, "stdout")
      })
      child.stderr?.on("data", (chunk: Buffer | string) => {
        appendChunk(stderrChunks, chunk, "stderr")
      })
      child.once("error", (error) => {
        const output = snapshotOutput()
        finalize({
          type: "reject",
          error: new CommandRunnerError({
            kind: terminationKind ?? "spawn-failed",
            executable,
            args,
            message:
              terminationKind === "timed-out"
                ? `command timed out: ${executable}`
                : terminationKind === "aborted"
                  ? `command aborted: ${executable}`
                  : terminationKind === "output-limit"
                    ? `command exceeded ${outputLimitStream ?? "output"} limit: ${executable}`
                    : `command failed to start: ${executable}`,
            stdout: output.stdout,
            stderr: output.stderr,
            cause: error,
          }),
        })
      })
      child.once("close", (exitCode, signal) => {
        const output = snapshotOutput()
        if (terminationKind === "timed-out") {
          finalize({
            type: "reject",
            error: new CommandRunnerError({
              kind: "timed-out",
              executable,
              args,
              exitCode,
              signal,
              stdout: output.stdout,
              stderr: output.stderr,
              message: `command timed out: ${executable}`,
            }),
          })
          return
        }
        if (terminationKind === "aborted") {
          finalize({
            type: "reject",
            error: new CommandRunnerError({
              kind: "aborted",
              executable,
              args,
              exitCode,
              signal,
              stdout: output.stdout,
              stderr: output.stderr,
              message: `command aborted: ${executable}`,
            }),
          })
          return
        }
        if (terminationKind === "output-limit") {
          finalize({
            type: "reject",
            error: new CommandRunnerError({
              kind: "output-limit",
              executable,
              args,
              exitCode,
              signal,
              stdout: output.stdout,
              stderr: output.stderr,
              message: `command exceeded ${outputLimitStream ?? "output"} limit: ${executable}`,
            }),
          })
          return
        }
        if (exitCode !== 0) {
          finalize({
            type: "reject",
            error: new CommandRunnerError({
              kind: "exited",
              executable,
              args,
              exitCode,
              signal,
              stdout: output.stdout,
              stderr: output.stderr,
              message: `command exited with status ${exitCode ?? "unknown"}: ${executable}`,
            }),
          })
          return
        }
        finalize({
          type: "resolve",
          value: {
            stdout: output.stdout,
            stderr: output.stderr,
            exitCode: 0,
          },
        })
      })

      if (options?.signal !== undefined) options.signal.addEventListener("abort", onAbort, { once: true })
      timer =
        options?.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              requestTermination("timed-out")
            }, options.timeoutMs)
    }),
})

export const runInteractiveCommand = async (
  command: CommandSpec,
  options?: Pick<CommandRunOptions, "cwd" | "env">,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      shell: false,
      windowsHide: true,
      stdio: "inherit",
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.env === undefined ? {} : { env: options.env }),
    })
    let settled = false
    child.once("error", (cause) => {
      if (settled) return
      settled = true
      reject(
        new CommandRunnerError({
          kind: "spawn-failed",
          executable: command.executable,
          args: command.args,
          message: `failed to start interactive command: ${command.executable}`,
          cause,
        }),
      )
    })
    child.once("close", (exitCode, signal) => {
      if (settled) return
      settled = true
      if (exitCode === 0) {
        resolve()
        return
      }
      reject(
        new CommandRunnerError({
          kind: "exited",
          executable: command.executable,
          args: command.args,
          exitCode,
          signal,
          message: `interactive command exited with status ${exitCode ?? "unknown"}: ${command.executable}`,
        }),
      )
    })
  })

  const optionalBoundedText = (value: unknown, name: string, maximum: number): string | undefined => {
    if (value === undefined) return undefined
    const text = getString(value, name)
    if (text.length > maximum || controlCharacters.test(text)) {
      throw new GuideLaunchError({
        kind: "invalid-output",
        message: `${name} is invalid`,
      })
    }
    return text
  }

  const parseGuideCaptureProvenance = (value: unknown): GuideCaptureProvenance | undefined => {
    if (value === undefined) return undefined
    const fields = getRecord(value, "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture")
    const allowedKeys = new Set(["source", "confidence", "agent", "sessionId", "identitySource", "profile"])
    const unexpectedKeys = Object.keys(fields).filter((key) => !allowedKeys.has(key))
    if (unexpectedKeys.length > 0) {
      throw new GuideLaunchError({
        kind: "invalid-output",
        message: `TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture contains unsupported keys: ${unexpectedKeys.join(", ")}`,
      })
    }
    const source = getString(fields.source, "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture.source")
    const confidence = getString(fields.confidence, "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture.confidence")
    if (!guideCaptureSources.includes(source as GuideCaptureSource)) {
      throw new GuideLaunchError({
        kind: "invalid-output",
        message: "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture has an unsupported source",
      })
    }
    if (!guideCaptureConfidences.includes(confidence as GuideCaptureConfidence)) {
      throw new GuideLaunchError({
        kind: "invalid-output",
        message: "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture has an unsupported confidence",
      })
    }
    const expectedConfidence = source === "selection"
      ? "user-selected"
      : source === "terminal"
        ? "snapshot"
        : source === "capture-queue"
          ? "user-curated"
          : "exact"
    if (confidence !== expectedConfidence) {
      throw new GuideLaunchError({
        kind: "invalid-output",
        message: "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture source and confidence do not match",
      })
    }
    const agent = optionalBoundedText(fields.agent, "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture.agent", 128)
    const sessionId = optionalBoundedText(
      fields.sessionId,
      "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture.sessionId",
      128,
    )
    const identitySource = optionalBoundedText(
      fields.identitySource,
      "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture.identitySource",
      128,
    )
    const profile = optionalBoundedText(fields.profile, "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.capture.profile", 128)
    return {
      source: source as GuideCaptureSource,
      confidence: confidence as GuideCaptureConfidence,
      ...(agent === undefined ? {} : { agent }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(identitySource === undefined ? {} : { identitySource }),
      ...(profile === undefined ? {} : { profile }),
    }
  }

  const parsePopupHerdrContext = (source: string): HerdrContext => {
    const fields = parseJsonRecord(source, "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON")
  const allowedKeys = new Set(["schemaVersion", "surface", "workspaceId", "paneId", "cwd", "capture"])
  const unexpectedKeys = Object.keys(fields).filter((key) => !allowedKeys.has(key))
  if (unexpectedKeys.length > 0) {
    throw new GuideLaunchError({
      kind: "invalid-output",
      message: `TRELLAGE_GUIDE_HERDR_CONTEXT_JSON contains unsupported keys: ${unexpectedKeys.join(", ")}`,
    })
  }
  if (fields.schemaVersion !== 1 || fields.surface !== "popup") {
    throw new GuideLaunchError({
      kind: "invalid-output",
      message: "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON must identify a schema version 1 popup",
    })
  }
  const workspaceId = getString(fields.workspaceId, "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.workspaceId")
  const paneId = getString(fields.paneId, "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.paneId")
  const cwd = getString(fields.cwd, "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON.cwd")
  if (
    controlCharacters.test(workspaceId) ||
    controlCharacters.test(paneId) ||
    controlCharacters.test(cwd) ||
    workspaceId.length > 256 ||
    paneId.length > 256 ||
    cwd.length > 4096 ||
    !path.isAbsolute(cwd)
  ) {
    throw new GuideLaunchError({
      kind: "invalid-output",
      message: "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON contains invalid source pane metadata",
    })
  }
  const capture = parseGuideCaptureProvenance(fields.capture)
  return {
    workspaceId,
    paneId,
    surface: "popup",
    cwd,
    ...(capture === undefined ? {} : { capture }),
  }
}

export const getHerdrContext = (env: HerdrEnvironment): HerdrContext | null => {
  if (env.HERDR_ENV !== "1") return null
  if (hasNonEmptyText(env.HERDR_WORKSPACE_ID) && hasNonEmptyText(env.HERDR_PANE_ID)) {
    return {
      workspaceId: env.HERDR_WORKSPACE_ID,
      paneId: env.HERDR_PANE_ID,
      surface: "pane",
    }
  }
  const source = env.TRELLAGE_GUIDE_HERDR_CONTEXT_JSON
  return hasNonEmptyText(source) ? parsePopupHerdrContext(source) : null
}

export const isHerdrAvailable = (env: HerdrEnvironment, probeSucceeded: boolean): boolean =>
  getHerdrContext(env) !== null && probeSucceeded

export const probeHerdrAvailability = async (runner: CommandRunner, options?: CommandRunOptions): Promise<boolean> => {
  await runner.run("herdr", ["--help"], options)
  return true
}

export const parseHerdrSplitPaneId = (source: string): string => {
  const root = parseJsonRecord(source, "Herdr pane split")
  const result = getRecord(root.result, "Herdr pane split result")
  const pane = getRecord(result.pane, "Herdr pane split result.pane")
  return getString(pane.pane_id, "Herdr pane split result.pane.pane_id")
}

export const parseHerdrWorktreeHandle = (source: string, commandName: string): HerdrWorktreeHandle => {
  const root = parseJsonRecord(source, commandName)
  const result = getRecord(root.result, `${commandName} result`)
  const workspace = getRecord(result.workspace, `${commandName} result.workspace`)
  const rootPane = getRecord(result.root_pane, `${commandName} result.root_pane`)
  const worktree = getRecord(result.worktree, `${commandName} result.worktree`)
  const checkoutPath = getString(worktree.path, `${commandName} result.worktree.path`)
  if (controlCharacters.test(checkoutPath) || !path.isAbsolute(checkoutPath)) {
    throw new GuideLaunchError({
      kind: "invalid-output",
      message: `${commandName} result.worktree.path must be an absolute path`,
    })
  }
  return {
    workspaceId: getString(workspace.workspace_id, `${commandName} result.workspace.workspace_id`),
    rootPaneId: getString(rootPane.pane_id, `${commandName} result.root_pane.pane_id`),
    checkoutPath,
  }
}

export const parseHerdrAgentInfo = (source: string): HerdrAgentStatus => {
  const root = parseJsonRecord(source, "Herdr agent get")
  const result = getRecord(root.result, "Herdr agent get result")
  const agent = getRecord(result.agent, "Herdr agent get result.agent")
  return parseAgentStatus(agent.agent_status)
}

export const getHerdrAgentStatus = async (runner: CommandRunner, paneId: string): Promise<HerdrAgentStatus> => {
  const result = await runner.run("herdr", ["agent", "get", paneId])
  return parseHerdrAgentInfo(result.stdout)
}

const isTransientAgentRecognitionError = (error: unknown): boolean =>
  error instanceof CommandRunnerError &&
  error.kind === "exited" &&
  (combineOutput(error).includes("agent_not_found") || combineOutput(error).includes("not an active named agent"))

const sleepUntilNextPoll = async (time: TimeController, deadline: number, pollIntervalMs: number): Promise<boolean> => {
  if (time.now() >= deadline) return false
  await time.sleep(Math.min(pollIntervalMs, Math.max(0, deadline - time.now())))
  return true
}

const readHerdrPromptReadyStatus = async (
  runner: CommandRunner,
  paneId: string,
): Promise<HerdrAgentStatus | "retry"> => {
  try {
    return await getHerdrAgentStatus(runner, paneId)
  } catch (error) {
    if (isTransientAgentRecognitionError(error)) return "retry"
    throw error
  }
}

const isHerdrPromptReadyStatus = (status: HerdrAgentStatus, paneId: string): boolean => {
  if (status === "idle" || status === "done") return true
  if (status === "blocked") {
    throw new GuideLaunchError({
      kind: "blocked",
      paneId,
      message: `Herdr agent in pane ${paneId} is blocked`,
    })
  }
  return false
}

export const waitForHerdrAgentIdle = async (
  runner: CommandRunner,
  paneId: string,
  options?: WaitForIdleOptions,
): Promise<void> => {
  const timeoutMs = options?.timeoutMs ?? 30_000
  const pollIntervalMs = options?.pollIntervalMs ?? 250
  const time = options?.time ?? systemTime
  const deadline = time.now() + timeoutMs

  while (time.now() <= deadline) {
    const status = await readHerdrPromptReadyStatus(runner, paneId)
    if (status === "retry") {
      if (!(await sleepUntilNextPoll(time, deadline, pollIntervalMs))) break
      continue
    }
    if (isHerdrPromptReadyStatus(status, paneId)) return
    if (!(await sleepUntilNextPoll(time, deadline, pollIntervalMs))) break
  }

  throw new GuideLaunchError({
    kind: "startup",
    paneId,
    message: `Herdr agent in pane ${paneId} did not become idle before timeout`,
  })
}

export const launchInHerdrPaneAndPrompt = async (
  runner: CommandRunner,
  options: LaunchInHerdrPaneOptions,
): Promise<HerdrPaneLaunchResult> => {
  const commandPreview = `env TRELLAGE_AUTOMATION=1 ${renderCommandPreview(options.command)}`
  await runner.run("herdr", ["pane", "run", options.paneId, commandPreview], {
    cwd: options.cwd,
  })
  if (options.promptDelivery === "command") {
    return {
      paneId: options.paneId,
      commandPreview,
    }
  }
  await waitForHerdrAgentIdle(runner, options.paneId, options)
  try {
    await runner.run(
      "herdr",
      ["agent", "prompt", options.paneId, options.prompt, "--wait", "--timeout", String(options.promptTimeoutMs)],
      {
        cwd: options.cwd,
        timeoutMs: options.promptTimeoutMs + 1_000,
      },
    )
  } catch (error) {
    if (error instanceof CommandRunnerError) throw resolvePromptFailure(options.paneId, error)
    throw error
  }
  return {
    paneId: options.paneId,
    commandPreview,
  }
}

export const splitHerdrPane = async (
  runner: CommandRunner,
  options: {
    readonly anchorPaneId: string
    readonly cwd: string
    readonly direction: HerdrSplitDirection
  },
): Promise<string> => {
  const split = await runner.run(
    "herdr",
    [
      "pane",
      "split",
      "--pane",
      options.anchorPaneId,
      "--cwd",
      options.cwd,
      "--direction",
      options.direction,
      "--no-focus",
    ],
    { cwd: options.cwd },
  )
  return parseHerdrSplitPaneId(split.stdout)
}

export const handoffToCurrentHerdrWorkspace = async (
  runner: CommandRunner,
  options: CurrentWorkspaceHandoffOptions,
): Promise<HerdrPaneLaunchResult> => {
  const paneId = await splitHerdrPane(runner, {
    anchorPaneId: options.callerPaneId,
    cwd: options.cwd,
    direction: options.direction,
  })
  return launchInHerdrPaneAndPrompt(runner, {
    paneId,
    cwd: options.cwd,
    command: options.command,
    prompt: options.prompt,
    promptDelivery: options.promptDelivery,
    promptTimeoutMs: options.promptTimeoutMs,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.time === undefined ? {} : { time: options.time }),
  })
}

export const intentToSlug = (intent: string): string => {
  const normalized = intent
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .replaceAll(/-{2,}/gu, "-")
  const slug = normalized.slice(0, 48).replace(/-+$/u, "")
  return slug.length > 0 ? slug : "worktree"
}

export const defaultWorktreeBranch = (intent: string): string => `worktree/${intentToSlug(intent)}`

export const parseGitWorktreeList = (source: string): ReadonlyArray<GitWorktreeEntry> => {
  const trimmed = source.trim()
  if (trimmed.length === 0) return []
  const blocks = trimmed.split(/\n\s*\n/gu)
  return blocks.map((block, index) => {
    const lines = block.split(/\n/gu).filter((line) => line.length > 0)
    const pathLine = lines.find((line) => line.startsWith("worktree "))
    if (pathLine === undefined) throw new Error(`git worktree block ${index} is missing worktree path`)
    const branchLine = lines.find((line) => line.startsWith("branch "))
    const headLine = lines.find((line) => line.startsWith("HEAD "))
    return {
      path: path.resolve(pathLine.slice("worktree ".length)),
      branch: branchLine === undefined ? null : branchLine.slice("branch ".length),
      head: headLine === undefined ? null : headLine.slice("HEAD ".length),
    }
  })
}

const invalidBranchResult = (branch: string): InvalidBranchResult => ({
  kind: "invalid-branch",
  branch,
})

const resolveGitInspectionBase = async (
  runner: CommandRunner,
  options: {
    readonly cwd: string
    readonly branch: string
    readonly targetPath?: string
  },
): Promise<GitInspectionBase> => {
  const currentCheckoutRoot = await resolveGitRoot(runner, options.cwd)
  const status = await runGit(runner, currentCheckoutRoot, ["status", "--porcelain"])
  const currentHeadSha = await resolveCurrentHeadSha(runner, currentCheckoutRoot)
  const branchExists = await checkBranchExists(runner, currentCheckoutRoot, options.branch)
  const worktrees = parseGitWorktreeList(
    (await runGit(runner, currentCheckoutRoot, ["worktree", "list", "--porcelain"])).stdout,
  )
  const primaryCheckoutPath = worktrees[0]?.path
  if (primaryCheckoutPath === undefined) throw new Error("git worktree list did not return a primary checkout")
  const currentWorktree = worktrees.find((entry) => entry.path === currentCheckoutRoot) ?? null
  if (currentWorktree === null) throw new Error("git worktree list did not include the current checkout")
  const resolvedTargetPath = options.targetPath === undefined ? undefined : path.resolve(options.targetPath)
  return {
    currentCheckoutRoot,
    primaryCheckoutPath,
    currentHeadSha,
    baseRef: currentCheckoutRoot === primaryCheckoutPath ? "HEAD" : currentHeadSha,
    branch: options.branch,
    dirty: status.stdout.length > 0,
    branchExists,
    activeBranchWorktree: worktrees.find((entry) => entry.branch === `${gitBranchPrefix}${options.branch}`) ?? null,
    activePathWorktree:
      resolvedTargetPath === undefined ? null : (worktrees.find((entry) => entry.path === resolvedTargetPath) ?? null),
    ...(resolvedTargetPath === undefined ? {} : { targetPath: resolvedTargetPath }),
  }
}

const finalizeGitInspection = (base: GitInspectionBase): GitWorktreeInspection => {
  if (base.activePathWorktree !== null) {
    return {
      kind: "collision",
      ...base,
      collision: {
        kind: "path-active",
        path: base.activePathWorktree.path,
      },
    }
  }
  if (base.activeBranchWorktree !== null) {
    return {
      kind: "collision",
      ...base,
      collision: {
        kind: "branch-active",
        path: base.activeBranchWorktree.path,
      },
    }
  }
  if (base.branchExists) {
    return {
      kind: "collision",
      ...base,
      collision: {
        kind: "branch-exists",
      },
    }
  }
  return {
    kind: "ready",
    ...base,
  }
}

export const inspectGitWorktreeIntent = async (
  runner: CommandRunner,
  options: {
    readonly cwd: string
    readonly branch: string
    readonly targetPath?: string
  },
): Promise<GitWorktreeInspection> => {
  try {
    await validateGitBranchName(runner, options.cwd, options.branch)
  } catch (error) {
    if (error instanceof InvalidBranchError) return invalidBranchResult(options.branch)
    throw error
  }
  return finalizeGitInspection(await resolveGitInspectionBase(runner, options))
}

export const createHerdrWorktree = async (
  runner: CommandRunner,
  options: WorktreeCreateOptions,
): Promise<HerdrWorktreeHandle> => {
  await validateGitBranchName(runner, options.primaryCheckoutPath, options.branch)
  const result = await runner.run(
    "herdr",
    [
      "worktree",
      "create",
      "--cwd",
      options.primaryCheckoutPath,
      "--branch",
      options.branch,
      "--base",
      options.baseRef,
      "--no-focus",
    ],
    { cwd: options.primaryCheckoutPath },
  )
  return parseHerdrWorktreeHandle(result.stdout, "Herdr worktree create")
}

export const openHerdrWorktree = async (
  runner: CommandRunner,
  options: WorktreeOpenOptions,
): Promise<HerdrWorktreeHandle> => {
  const result = await runner.run(
    "herdr",
    ["worktree", "open", "--cwd", options.primaryCheckoutPath, "--path", options.path, "--no-focus"],
    {
      cwd: options.primaryCheckoutPath,
    },
  )
  return parseHerdrWorktreeHandle(result.stdout, "Herdr worktree open")
}

export const createHerdrWorktreeAndHandoff = async (
  runner: CommandRunner,
  options: WorktreeHandoffOptions,
): Promise<HerdrWorktreeLaunchResult> => {
  const handle = await createHerdrWorktree(runner, {
    primaryCheckoutPath: options.primaryCheckoutPath,
    branch: options.branch,
    baseRef: options.baseRef,
  })
  const launch = await launchInHerdrPaneAndPrompt(runner, {
    paneId: handle.rootPaneId,
    cwd: handle.checkoutPath,
    command: options.command,
    prompt: options.prompt,
    promptDelivery: options.promptDelivery,
    promptTimeoutMs: options.promptTimeoutMs,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.time === undefined ? {} : { time: options.time }),
  })
  return {
    workspaceId: handle.workspaceId,
    rootPaneId: handle.rootPaneId,
    checkoutPath: handle.checkoutPath,
    paneId: launch.paneId,
    commandPreview: launch.commandPreview,
  }
}

export const openHerdrWorktreeAndHandoff = async (
  runner: CommandRunner,
  options: ExistingWorktreeHandoffOptions,
): Promise<HerdrWorktreeLaunchResult> => {
  const handle = await openHerdrWorktree(runner, {
    primaryCheckoutPath: options.primaryCheckoutPath,
    path: options.path,
  })
  const launch = await launchInHerdrPaneAndPrompt(runner, {
    paneId: handle.rootPaneId,
    cwd: handle.checkoutPath,
    command: options.command,
    prompt: options.prompt,
    promptDelivery: options.promptDelivery,
    promptTimeoutMs: options.promptTimeoutMs,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.time === undefined ? {} : { time: options.time }),
  })
  return {
    workspaceId: handle.workspaceId,
    rootPaneId: handle.rootPaneId,
    checkoutPath: handle.checkoutPath,
    paneId: launch.paneId,
    commandPreview: launch.commandPreview,
  }
}
