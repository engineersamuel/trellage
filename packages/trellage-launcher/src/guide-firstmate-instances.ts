import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import {
  ProfileGuideValidationError,
  canonicalFirstmateInstanceJson,
  firstmateInstanceCli,
  firstmateInstanceLimits,
  firstmateInstanceListSnapshotDigest,
  firstmateWorktreeBindingDigest,
  parseFirstmateInstanceCreateResultV1,
  parseFirstmateInstanceCreationPlanV1,
  parseFirstmateInstanceListResultV1,
  parseFirstmateInstanceLocatorRefreshResultV1,
  parseFirstmateInstanceName,
  parseFirstmateInstancePlanResultV1,
  parseFirstmateInstanceResolveResultV1,
  type FirstmateInstanceCreateResultV1,
  type FirstmateInstanceCreationPlanV1,
  type FirstmateInstanceDescriptorV1,
  type FirstmateInstanceDiagnosticV1,
  type FirstmateInstanceListResultV1,
  type FirstmateInstancePlanResultV1,
  type FirstmateInstanceResolveResultV1,
  type FirstmateNamedInstanceDescriptorV1,
} from "@trellage/guide-core"
import {
  CommandRunnerError,
  parseSelectedProfile,
  type CommandRunResult,
  type CommandRunner,
  type NativeSelectedProfile,
} from "./guide-launch.ts"

export interface FirstmateInstanceCommandOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export class FirstmateInstanceCommandError extends Error {
  readonly creationResult: FirstmateInstanceCreateResultV1 | undefined
  readonly approvedPlan: FirstmateInstanceCreationPlanV1 | undefined

  constructor(
    message: string,
    options: ErrorOptions & {
      readonly creationResult?: FirstmateInstanceCreateResultV1
      readonly approvedPlan?: FirstmateInstanceCreationPlanV1
    } = {},
  ) {
    super(message, options)
    this.name = "FirstmateInstanceCommandError"
    this.creationResult = options.creationResult
    this.approvedPlan = options.approvedPlan
  }
}

const maximumUiInstances = 1024
const controls = /[\u0000-\u001f\u007f-\u009f]/u
const commandPath = (value: string): string => {
  if (!path.isAbsolute(value) || controls.test(value) || value.length > firstmateInstanceLimits.pathChars) {
    throw new Error("Firstmate instance operations require an absolute path without control characters.")
  }
  return value
}

const diagnosticText = (diagnostics: ReadonlyArray<FirstmateInstanceDiagnosticV1>): string =>
  diagnostics.map(({ message }) => message).join("\n")

const partialCreation = (
  stdout: string,
  plan: FirstmateInstanceCreationPlanV1 | undefined,
): FirstmateInstanceCreateResultV1 | undefined => {
  if (plan === undefined || Buffer.byteLength(stdout, "utf8") > firstmateInstanceLimits.envelopeBytes) return undefined
  try {
    return parseFirstmateInstanceCreateResultV1(JSON.parse(stdout), plan)
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ProfileGuideValidationError) return undefined
    throw error
  }
}

const failureMessage = (operation: string, error: unknown, overflow: boolean): string => {
  if (overflow || (error instanceof CommandRunnerError && error.kind === "output-limit")) {
    return `Firstmate instance ${operation} exceeded its output limit. Refresh the same instance before further action.`
  }
  const detail = error instanceof CommandRunnerError
    ? stripVTControlCharacters(error.stderr).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "").trim().slice(0, 2000)
    : ""
  return `Firstmate instance ${operation} failed.${detail.length === 0 ? "" : ` ${detail}`}`
}

interface InstanceListProgress {
  readonly snapshot: string
  readonly total: number
}

const appendInstancePage = (
  instances: Array<FirstmateInstanceDescriptorV1>,
  result: FirstmateInstanceListResultV1,
  previous: InstanceListProgress | undefined,
): { readonly progress: InstanceListProgress; readonly cursor: string | null } => {
  if (result.state !== "page") throw new FirstmateInstanceCommandError(diagnosticText(result.diagnostics))
  if (result.page.total > maximumUiInstances) {
    throw new FirstmateInstanceCommandError(`Firstmate reports more than ${maximumUiInstances} instances. Use an explicit CLI selector; the guide will not show a partial list.`)
  }
  if (result.page.offset !== instances.length ||
      (previous !== undefined && (result.page.snapshotDigest !== previous.snapshot || result.page.total !== previous.total))) {
    throw new FirstmateInstanceCommandError("Firstmate instance pages changed or skipped records. Refresh the complete instance list.")
  }
  instances.push(...result.instances)
  return {
    progress: { snapshot: result.page.snapshotDigest, total: result.page.total },
    cursor: result.page.nextCursor,
  }
}

const completeInstanceList = (
  profile: string, instances: ReadonlyArray<FirstmateInstanceDescriptorV1>, progress: InstanceListProgress,
): ReadonlyArray<FirstmateInstanceDescriptorV1> => {
  if (instances.length !== progress.total || firstmateInstanceListSnapshotDigest(profile, instances) !== progress.snapshot) {
    throw new FirstmateInstanceCommandError("Firstmate instance listing does not match its complete snapshot.")
  }
  return instances
}

const outputMonitor = (signal: AbortSignal | undefined) => {
  const controller = new AbortController()
  const bytes = { stdout: 0, stderr: 0 }
  let overflow = false
  return {
    signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
    overflowed: () => overflow,
    onOutput: (text: string, stream: "stdout" | "stderr"): void => {
      bytes[stream] += Buffer.byteLength(text, "utf8")
      if (bytes[stream] > firstmateInstanceLimits.envelopeBytes && !overflow) {
        overflow = true
        controller.abort()
      }
    },
  }
}

const requireBoundedOutput = (
  result: CommandRunResult, overflow: boolean, operation: string, approvedPlan: FirstmateInstanceCreationPlanV1 | undefined,
): void => {
  if (!overflow && Buffer.byteLength(result.stdout, "utf8") <= firstmateInstanceLimits.envelopeBytes &&
      Buffer.byteLength(result.stderr, "utf8") <= firstmateInstanceLimits.envelopeBytes) return
  throw new FirstmateInstanceCommandError(failureMessage(operation, undefined, true), {
    ...(approvedPlan === undefined ? {} : { approvedPlan }),
  })
}

const commandFailure = (
  cause: unknown, operation: string, overflow: boolean, approvedPlan: FirstmateInstanceCreationPlanV1 | undefined,
): FirstmateInstanceCommandError => {
  if (cause instanceof FirstmateInstanceCommandError) return cause
  const creationResult = cause instanceof CommandRunnerError && !overflow
    ? partialCreation(cause.stdout, approvedPlan)
    : undefined
  return new FirstmateInstanceCommandError(failureMessage(operation, cause, overflow), {
    cause,
    ...(approvedPlan === undefined ? {} : { approvedPlan }),
    ...(creationResult === undefined ? {} : { creationResult }),
  })
}

const parseInstanceOutput = <T>(
  stdout: string, parse: (value: unknown) => T, operation: string, approvedPlan: FirstmateInstanceCreationPlanV1 | undefined,
): T => {
  try {
    return parse(JSON.parse(stdout))
  } catch (cause) {
    if (!(cause instanceof SyntaxError || cause instanceof ProfileGuideValidationError)) throw cause
    throw new FirstmateInstanceCommandError(`Firstmate instance ${operation} returned invalid output: ${cause.message}`, {
      cause,
      ...(approvedPlan === undefined ? {} : { approvedPlan }),
    })
  }
}

export class FirstmateInstancesClient {
  private readonly executable: string
  private readonly profileName: string
  private readonly sourceRevision: string
  private readonly cwd: string

  constructor(private readonly runner: CommandRunner, profile: NativeSelectedProfile, cwd: string) {
    const selected = parseSelectedProfile(profile)
    if (selected.surface !== "native" || selected.launcher !== "fmx" || selected.orchestration?.instances === undefined) {
      throw new Error("Named fleet discovery requires a Firstmate backend with instance support.")
    }
    this.executable = selected.commandPath
    this.profileName = selected.profile
    this.sourceRevision = selected.orchestration.sourceRevision
    this.cwd = commandPath(cwd)
  }

  async list(options: FirstmateInstanceCommandOptions = {}): Promise<ReadonlyArray<FirstmateInstanceDescriptorV1>> {
    const instances: Array<FirstmateInstanceDescriptorV1> = []
    let cursor: string | undefined
    let progress: InstanceListProgress | undefined
    while (true) {
      const result = await this.invoke([
        "instances", "list", this.profileName, "--json",
        firstmateInstanceCli.limit, String(firstmateInstanceLimits.pageItems),
        ...(cursor === undefined ? [] : [firstmateInstanceCli.cursor, cursor]),
      ], parseFirstmateInstanceListResultV1, options)
      this.requireProfile(result.profile)
      const appended = appendInstancePage(instances, result, progress)
      progress = appended.progress
      if (appended.cursor === null) return completeInstanceList(this.profileName, instances, progress)
      cursor = appended.cursor
    }
  }

  async resolve(worktreePath: string, options: FirstmateInstanceCommandOptions = {}): Promise<FirstmateInstanceResolveResultV1> {
    const result = await this.invoke([
      "instances", "resolve", this.profileName, "--worktree", commandPath(worktreePath), "--json",
    ], parseFirstmateInstanceResolveResultV1, options)
    this.requireProfile(result.profile)
    return result
  }

  async plan(
    name: string,
    worktreePath: string,
    options: FirstmateInstanceCommandOptions = {},
  ): Promise<FirstmateInstancePlanResultV1> {
    const selectedName = parseFirstmateInstanceName(name)
    const result = await this.invoke([
      "instances", "plan", this.profileName, "--name", selectedName, "--worktree", commandPath(worktreePath),
      "--json", firstmateInstanceCli.expectedSourceRevision, this.sourceRevision,
    ], parseFirstmateInstancePlanResultV1, options)
    this.requireProfile(result.profile)
    if (result.state === "ready" && (result.plan.name !== selectedName || result.plan.sourceRevision !== this.sourceRevision)) {
      throw new FirstmateInstanceCommandError("The creation plan does not match the selected name and source revision.")
    }
    return result
  }

  create(
    approvedPlan: FirstmateInstanceCreationPlanV1,
    options: FirstmateInstanceCommandOptions = {},
  ): Promise<FirstmateInstanceCreateResultV1> {
    const plan = parseFirstmateInstanceCreationPlanV1(approvedPlan)
    this.requireProfile(plan.reference.profile)
    if (plan.sourceRevision !== this.sourceRevision ||
        canonicalFirstmateInstanceJson(plan) !== canonicalFirstmateInstanceJson(approvedPlan)) {
      throw new FirstmateInstanceCommandError("The approved creation plan changed. Nothing was sent.", { approvedPlan: plan })
    }
    return this.invoke([
      "instances", "create", this.profileName, "--json", firstmateInstanceCli.approveCreation, plan.approvalDigest,
    ], (value) => parseFirstmateInstanceCreateResultV1(value, plan), {
      ...options, timeoutMs: options.timeoutMs ?? 180_000,
    }, plan)
  }

  refreshLocator(
    previous: FirstmateNamedInstanceDescriptorV1,
    newPath: string,
    options: FirstmateInstanceCommandOptions = {},
  ): Promise<FirstmateNamedInstanceDescriptorV1> {
    this.requireProfile(previous.profile)
    return this.invoke([
      "instances", "refresh-locator", this.profileName, firstmateInstanceCli.selector, previous.reference.instanceId,
      "--worktree", commandPath(newPath), "--json",
      firstmateInstanceCli.expectedBindingDigest, firstmateWorktreeBindingDigest(previous.worktree.evidence),
      firstmateInstanceCli.confirm,
    ], (value) => parseFirstmateInstanceLocatorRefreshResultV1(value, previous), options)
  }

  private requireProfile(profile: string): void {
    if (profile !== this.profileName) {
      throw new FirstmateInstanceCommandError("Firstmate instance output belongs to another profile.")
    }
  }

  private async invoke<T>(
    args: ReadonlyArray<string>,
    parse: (value: unknown) => T,
    options: FirstmateInstanceCommandOptions,
    approvedPlan?: FirstmateInstanceCreationPlanV1,
  ): Promise<T> {
    options.signal?.throwIfAborted()
    const monitor = outputMonitor(options.signal)
    const operation = args[1] ?? "operation"
    let stdout: string
    try {
      const result = await this.runner.run(this.executable, args, {
        cwd: this.cwd,
        timeoutMs: options.timeoutMs ?? 30_000,
        terminationGraceMs: 10_000,
        signal: monitor.signal,
        outputOverflow: "terminate",
        ...(approvedPlan === undefined ? {} : { stdin: canonicalFirstmateInstanceJson(approvedPlan) }),
        onOutput: monitor.onOutput,
      })
      requireBoundedOutput(result, monitor.overflowed(), operation, approvedPlan)
      stdout = result.stdout
    } catch (cause) {
      throw commandFailure(cause, operation, monitor.overflowed(), approvedPlan)
    }
    return parseInstanceOutput(stdout, parse, operation, approvedPlan)
  }
}

export const createFirstmateInstancesClient = (
  runner: CommandRunner,
  profile: NativeSelectedProfile,
  cwd: string,
): FirstmateInstancesClient => new FirstmateInstancesClient(runner, profile, cwd)
