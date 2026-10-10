import { spawn, spawnSync } from "node:child_process"
import { acquireProfileGuard, profileGuardProfiles } from "./lifecycle-guard.ts"
import { lifecycleRuntime, lifecycleRuntimeCommand, profileOperationArguments } from "./lifecycle-runtime.ts"
import { ensureFxProvider } from "./adapters.ts"
import { main as runNative } from "./run.ts"

const runFxOperation = async (operation: string, args: ReadonlyArray<string>): Promise<number> => {
  const profile = args.find((argument) => !argument.startsWith("-")) ?? "default"
  if (profile !== "default") throw new Error(`unknown Fx profile: ${profile}`)
  if (operation === "upgrade" && args.includes("--skills-only")) {
    process.stdout.write("default: Fx uses host ~/.fx skills; no Trellage-managed skill state\n")
    return 0
  }
  if (["setup", "repair"].includes(operation)) {
    await ensureFxProvider(process.env)
    const result = spawnSync(process.env.TRELLAGE_FX_BIN ?? "fx", ["--version"], { encoding: "utf8" })
    if (result.status !== 0) throw new Error("Fx is not installed or cannot be executed")
    process.stdout.write(`trx ${operation} fx: ready (${result.stdout.trim()})\n`)
    return 0
  }
  if (operation === "doctor") {
    await ensureFxProvider(process.env)
    const result = spawnSync(process.env.TRELLAGE_FX_BIN ?? "fx", ["--version"], { encoding: "utf8" })
    if (result.status !== 0) throw new Error("Fx is not installed or cannot be executed")
    process.stdout.write(`trx doctor fx: OK (${result.stdout.trim()}, shared host ~/.fx)\n`)
    return 0
  }
  if (operation === "harness-version") {
    const result = spawnSync(process.env.TRELLAGE_FX_BIN ?? "fx", ["--version"], { encoding: "utf8" })
    const installed = result.status === 0 ? (result.stdout.trim().match(/[0-9]+\.[0-9]+\.[0-9]+/)?.[0] ?? null) : null
    console.log(
      JSON.stringify({ schemaVersion: 1, launcher: "fx", harness: "fx", installed, latest: null, latestKnown: false }),
    )
    return 0
  }
  if (operation === "inventory") {
    const result = spawnSync(process.env.TRELLAGE_FX_BIN ?? "fx", ["--version"], { encoding: "utf8" })
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        launcher: "fx",
        harness: "fx",
        profile: "default",
        readiness: result.status === 0 ? "healthy" : "not-setup",
        plugins: [],
        skills: { packageCount: null, visibleCount: null },
        mcps: [],
      }),
    )
    return 0
  }
  if (operation === "skills-update" || operation === "skills-check") {
    process.stdout.write("default: Fx uses host ~/.fx skills; no Trellage-managed skill state\n")
    return 0
  }
  if (operation === "upgrade")
    throw new Error(
      "Fx upgrades are managed by its installed package manager; replace the fx binary, then run trx doctor fx default",
    )
  if (operation === "list") {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        launcher: "fx",
        harness: "fx",
        sandbox: false,
        profiles: [{ name: "default", description: "Fx with shared host context through copilot-proxy-rs" }],
      }),
    )
    return 0
  }
  throw new Error(`Fx does not support lifecycle operation ${operation}`)
}

export const runProfileOperation = async (
  operation: string,
  harness: string,
  args: ReadonlyArray<string>,
): Promise<number> => {
  if (operation === "run") throw new Error("profile lifecycle cannot launch agents; use trx run")
  if (harness === "fx") return runFxOperation(operation, args)
  const runtime = lifecycleRuntime(harness)
  if (!runtime) throw new Error(`unknown managed profile harness: ${harness}`)
  const command = lifecycleRuntimeCommand(runtime)
  const argv = profileOperationArguments(operation, harness, args)
  if (operation === "skill" && harness === "jcode") {
    const prompt = spawnSync(command, argv, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 })
    if (prompt.status !== 0) throw new Error(prompt.stderr.trim() || "JCode manual skill preparation failed")
    return runNative(["jcode", "default", "--", "run", "--", prompt.stdout.trimEnd()])
  }
  if (argv.includes("--dry-run")) {
    console.log(
      JSON.stringify({ harness, command, args: argv.filter((argument) => argument !== "--dry-run") }, null, 2),
    )
    return 0
  }
  if (argv[0] === "harness-update" || argv[0] === "skills-update") {
    const help = spawnSync(command, ["--help"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 })
    const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`
    if (help.status !== 0 || !new RegExp(`\\b${argv[0]}\\b`).test(text))
      throw new Error(`${harness} does not support ${argv[0]}. Refresh the installed Trellage runtime first.`)
  }
  const guardedProfiles = profileGuardProfiles(operation, harness, args)
  const guard = acquireProfileGuard(harness, guardedProfiles, operation)
  try {
    return await new Promise<number>((resolve, reject) => {
      const json =
        args.includes("--json") ||
        args.includes("--goal-features") ||
        operation === "workflow-check" ||
        operation === "harness-version"
      const capture = json || operation === "list"
      const grouped = guardedProfiles.length > 0
      let child: ReturnType<typeof spawn> | undefined
      const signalChild = (signal: NodeJS.Signals) => {
        if (child?.pid === undefined) return
        if (grouped) {
          try {
            process.kill(-child.pid, signal)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
          }
          return
        }
        guard.signalTree(child.pid, signal)
      }
      const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const
      let cancelledBy: (typeof signals)[number] | undefined
      const forwards = signals.map((signal) => () => {
        cancelledBy ??= signal
        signalChild(signal)
      })
      const removeSignals = () => signals.forEach((signal, index) => process.off(signal, forwards[index]!))
      signals.forEach((signal, index) => process.on(signal, forwards[index]!))
      try {
        child = spawn(command, argv, { stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", detached: grouped })
      } catch (error) {
        removeSignals()
        reject(error)
        return
      }
      let guardError: unknown
      child.once("spawn", () => {
        try {
          if (child?.pid !== undefined) guard.attachChild(child.pid, grouped)
        } catch (error) {
          guardError = error
          signalChild("SIGTERM")
          return
        }
        if (cancelledBy !== undefined) signalChild(cancelledBy)
      })
      child.once("error", (error) => {
        removeSignals()
        reject(error)
      })
      let output = ""
      child.stdout?.on("data", (chunk) => {
        output += String(chunk)
      })
      child.once("close", (code, signal) => {
        removeSignals()
        if (guardError !== undefined) {
          reject(guardError)
          return
        }
        if (output) {
          try {
            const value = JSON.parse(output)
            if (value.launcher === runtime.runtimeName) value.launcher = harness
            if (value.harness === "oh-my-pi") value.harness = "omp"
            if (Array.isArray(value.profiles))
              for (const profile of value.profiles) {
                const publicName = nativePublicProfile(harness, profile.name)
                profile.name = publicName
              }
            if (typeof value.profile === "string") value.profile = nativePublicProfile(harness, value.profile)
            console.log(JSON.stringify(value))
          } catch {
            process.stdout.write(output)
          }
        }
        const termination = cancelledBy ?? signal
        resolve(
          cancelledBy === undefined && code !== null
            ? code
            : termination === "SIGTERM"
              ? 143
              : termination === "SIGINT"
                ? 130
                : termination === "SIGHUP"
                  ? 129
                  : 1,
        )
      })
    })
  } finally {
    guard.release()
  }
}

const nativePublicProfile = (harness: string, runtimeProfile: string): string => {
  if (harness === "agency" && runtimeProfile === "trellage-azure") return "azure"
  if (harness === "omp" && runtimeProfile === "copilot") return "default"
  return runtimeProfile
}

if (import.meta.main) {
  const [operation, harness, ...args] = process.argv.slice(2)
  try {
    if (!operation || !harness) throw new Error("expected OPERATION HARNESS [PROFILE] [ARGS...]")
    process.exitCode = await runProfileOperation(operation, harness, args)
  } catch (error) {
    console.error(`trx: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
