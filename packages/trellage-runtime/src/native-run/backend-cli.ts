import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { prepareBackendComposition } from "./backend-composition.ts"
import { createSelectionHistory, scopeKeysFor } from "./history.ts"
import { acquireLease } from "./lease.ts"
import { acquireBackendGuard, backendGuardPresets } from "./backend-guard.ts"
import { nativeHarness, nativeBackendPath, backendArguments, type NativeHarnessRegistration } from "./registry.ts"

type BackendGuard = ReturnType<typeof acquireBackendGuard>
type Signal = "SIGTERM" | "SIGINT" | "SIGHUP"

const ensureMaintenanceSupport = (
  command: string,
  argv: ReadonlyArray<string>,
  harness: string,
  env: NodeJS.ProcessEnv,
): void => {
  if (argv[0] !== "harness-update" && argv[0] !== "skills-update") return
  const help = spawnSync(command, ["--help"], { env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 })
  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`
  if (help.status !== 0 || !new RegExp(`\\b${argv[0]}\\b`).test(text))
    throw new Error(`${harness} does not support ${argv[0]}. Refresh the installed Trellage launcher first.`)
}

const externalProfile = (entry: NativeHarnessRegistration, profile: string): string =>
  Object.entries(entry.presets).find(([, backend]) => backend === profile)?.[0] ?? profile

const writeBackendOutput = (
  output: string,
  operation: string,
  json: boolean,
  harness: string,
  entry: NativeHarnessRegistration,
): void => {
  if (operation === "list" && !json) {
    const translated = output.split("\n").map((line) => {
      const fields = line.split("\t")
      fields[0] = externalProfile(entry, fields[0]!)
      return fields.join("\t")
    }).join("\n")
    process.stdout.write(translated)
    return
  }
  if (!json) return
  try {
    const value = JSON.parse(output)
    if (value.launcher === entry.id) value.launcher = harness
    if (value.harness === "oh-my-pi") value.harness = "omp"
    if (Array.isArray(value.profiles))
      for (const profile of value.profiles) profile.name = externalProfile(entry, profile.name)
    if (typeof value.profile === "string") value.profile = externalProfile(entry, value.profile)
    console.log(JSON.stringify(value))
  } catch {
    process.stdout.write(output)
  }
}

const backendExitCode = (cancelledBy: Signal | undefined, code: number | null, signal: NodeJS.Signals | null): number => {
  if (cancelledBy === undefined && code !== null) return code
  const termination = cancelledBy ?? signal
  if (termination === "SIGTERM") return 143
  if (termination === "SIGINT") return 130
  if (termination === "SIGHUP") return 129
  return 1
}

const signalController = (grouped: boolean, guard: BackendGuard) => {
  let child: ChildProcess | undefined
  let cancelledBy: Signal | undefined
  const signalChild = (signal: Signal) => {
    if (child?.pid === undefined) return
    if (!grouped) {
      guard.signalTree(child.pid, signal)
      return
    }
    try { process.kill(-child.pid, signal) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
  }
  const signals: ReadonlyArray<Signal> = ["SIGTERM", "SIGINT", "SIGHUP"]
  const handlers = signals.map((signal) => () => {
    cancelledBy ??= signal
    signalChild(signal)
  })
  return {
    attach(value: ChildProcess) { child = value },
    cancelled: () => cancelledBy,
    install() { signals.forEach((signal, index) => process.on(signal, handlers[index]!)) },
    remove() { signals.forEach((signal, index) => process.off(signal, handlers[index]!)) },
    signal: signalChild,
  }
}

interface SpawnBackendOptions {
  readonly command: string
  readonly argv: ReadonlyArray<string>
  readonly env: NodeJS.ProcessEnv
  readonly operation: string
  readonly harness: string
  readonly args: ReadonlyArray<string>
  readonly entry: NativeHarnessRegistration
  readonly guard: BackendGuard
  readonly guardedPresets: ReadonlyArray<string>
  readonly onSpawn: () => void
}

const spawnBackend = ({
  command, argv, env, operation, harness, args, entry, guard, guardedPresets, onSpawn,
}: SpawnBackendOptions): Promise<number> => new Promise<number>((resolve, reject) => {
  const json = operation !== "run" && (args.includes("--json") || args.includes("--goal-features") || operation === "workflow-check" || operation === "harness-version")
  const capture = json || operation === "list"
  const grouped = operation !== "run" && guardedPresets.length > 0
  const controller = signalController(grouped, guard)
  controller.install()
  let child: ChildProcess
  try {
    child = spawn(command, argv, { stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", env, detached: grouped })
    controller.attach(child)
  } catch (error) {
    controller.remove()
    reject(error)
    return
  }
  let guardError: unknown
  let output = ""
  child.once("spawn", () => {
    try {
      if (child.pid !== undefined) guard.attachChild(child.pid, grouped)
    } catch (error) {
      guardError = error
      controller.signal("SIGTERM")
      return
    }
    const cancelledBy = controller.cancelled()
    if (cancelledBy) controller.signal(cancelledBy)
    onSpawn()
  })
  child.stdout?.on("data", (chunk) => { output += String(chunk) })
  child.once("error", (error) => {
    controller.remove()
    reject(error)
  })
  child.once("close", (code, signal) => {
    controller.remove()
    if (guardError !== undefined) {
      reject(guardError)
      return
    }
    if (output) writeBackendOutput(output, operation, json, harness, entry)
    resolve(backendExitCode(controller.cancelled(), code, signal))
  })
})

const prepareInvocation = async (
  operation: string,
  harness: string,
  args: ReadonlyArray<string>,
) => {
  const prepared = operation === "run" ? await prepareBackendComposition(harness, args) : undefined
  const preparedArgs = prepared
    ? [prepared.preset, ...(prepared.interactive ? ["--interactive"] : []), ...(prepared.nativeAuth ? ["--native-auth"] : []), "--", ...prepared.forwarded]
    : args
  const argv = backendArguments(operation, harness, preparedArgs)
  const env = prepared
    ? { ...process.env, TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT: prepared.layout.generationPath, TRELLAGE_NATIVE_COMPOSITION_HARNESS: harness }
    : process.env
  for (const warning of prepared?.plan.warnings ?? []) console.error(`trx: ${warning}`)
  return { prepared, argv, env }
}

export const runNativeBackend = async (operation: string, harness: string, args: ReadonlyArray<string>): Promise<number> => {
  const entry = nativeHarness(harness)
  if (!entry) throw new Error(`unknown native harness: ${harness}`)
  const command = nativeBackendPath(entry)
  const { prepared, argv, env } = await prepareInvocation(operation, harness, args)
  if (prepared?.dryRun || (!prepared && argv.includes("--dry-run"))) {
    console.log(JSON.stringify({ harness, command, args: argv.filter((arg) => arg !== "--dry-run") }, null, 2))
    return 0
  }
  ensureMaintenanceSupport(command, argv, harness, env)
  const historyKeys = prepared ? await scopeKeysFor(process.cwd()) : undefined
  let recorded: Promise<void> = Promise.resolve()
  const guardedPresets = backendGuardPresets(operation, harness, prepared ? [prepared.preset] : args)
  const guard = acquireBackendGuard(harness, guardedPresets, operation)
  let lease: Awaited<ReturnType<typeof acquireLease>> | undefined
  try {
    lease = prepared ? await acquireLease(prepared.paths, prepared.plan.generationId) : undefined
    return await spawnBackend({
      command, argv, env, operation, harness, args, entry, guard, guardedPresets,
      onSpawn: () => {
        if (prepared && historyKeys)
          recorded = createSelectionHistory(prepared.paths)
            .record(historyKeys, { harness, profiles: prepared.profiles })
            .catch(() => undefined)
      },
    })
  } finally {
    try { await recorded; await lease?.release() }
    finally { guard.release() }
  }
}

if (import.meta.main) {
  const [operation, harness, ...args] = process.argv.slice(2)
  try {
    if (!operation || !harness) throw new Error("expected OPERATION HARNESS [PROFILE] [ARGS...]")
    process.exitCode = await runNativeBackend(operation, harness, args)
  } catch (error) {
    console.error(`trx: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
