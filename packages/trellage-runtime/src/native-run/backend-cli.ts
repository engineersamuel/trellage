import { spawn, spawnSync } from "node:child_process"
import { prepareBackendComposition } from "./backend-composition.ts"
import { createSelectionHistory, scopeKeysFor } from "./history.ts"
import { acquireLease } from "./lease.ts"
import { acquireBackendGuard, backendGuardPresets } from "./backend-guard.ts"
import { nativeHarness, nativeBackendPath, backendArguments } from "./registry.ts"

export const runNativeBackend = async (operation: string, harness: string, args: ReadonlyArray<string>): Promise<number> => {
  const entry = nativeHarness(harness)
  if (!entry) throw new Error(`unknown native harness: ${harness}`)
  const command = nativeBackendPath(entry)
  const prepared = operation === "run" ? await prepareBackendComposition(harness, args) : undefined
  const argv = backendArguments(operation, harness, prepared ? [prepared.preset, ...(prepared.interactive ? ["--interactive"] : []), ...(prepared.nativeAuth ? ["--native-auth"] : []), "--", ...prepared.forwarded] : args)
  const env = prepared ? { ...process.env, TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT: prepared.layout.generationPath, TRELLAGE_NATIVE_COMPOSITION_HARNESS: harness } : process.env
  if (prepared) for (const warning of prepared.plan.warnings) console.error(`trx: ${warning}`)
  if (prepared?.dryRun || (!prepared && argv.includes("--dry-run"))) {
    console.log(JSON.stringify({ harness, command, args: argv.filter((arg) => arg !== "--dry-run") }, null, 2))
    return 0
  }
  if (argv[0] === "harness-update" || argv[0] === "skills-update") {
    const help = spawnSync(command, ["--help"], { env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 })
    const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`
    if (help.status !== 0 || !new RegExp(`\\b${argv[0]}\\b`).test(text))
      throw new Error(`${harness} does not support ${argv[0]}. Refresh the installed Trellage launcher first.`)
  }
  const historyKeys = prepared ? await scopeKeysFor(process.cwd()) : undefined
  let recorded: Promise<void> = Promise.resolve()
  const guardedPresets = backendGuardPresets(operation, harness, prepared ? [prepared.preset] : args)
  const guard = acquireBackendGuard(harness, guardedPresets, operation)
  let lease: Awaited<ReturnType<typeof acquireLease>> | undefined
  try {
    lease = prepared ? await acquireLease(prepared.paths, prepared.plan.generationId) : undefined
    return await new Promise<number>((resolve, reject) => {
      const json = operation !== "run" && (args.includes("--json") || args.includes("--goal-features") || operation === "workflow-check" || operation === "harness-version")
      const capture = json || operation === "list"
      const grouped = operation !== "run" && guardedPresets.length > 0
      const child = spawn(command, argv, { stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", env, detached: grouped })
      const signalChild = (signal: NodeJS.Signals) => {
        if (grouped && child.pid !== undefined) {
          try { process.kill(-child.pid, signal) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
        } else if (child.pid !== undefined) guard.signalTree(child.pid, signal)
      }
      let guardError: unknown
      child.once("spawn", () => {
        try { if (child.pid !== undefined) guard.attachChild(child.pid, grouped) }
        catch (error) { guardError = error; signalChild("SIGTERM"); return }
        if (prepared && historyKeys)
          recorded = createSelectionHistory(prepared.paths).record(historyKeys, { harness, profiles: prepared.profiles }).catch(() => undefined)
      })
      let output = ""
      child.stdout?.on("data", (chunk) => { output += String(chunk) })
      const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const
      let cancelledBy: (typeof signals)[number] | undefined
      const forwards = signals.map((signal) => () => { cancelledBy ??= signal; signalChild(signal) })
      const removeSignals = () => signals.forEach((signal, index) => process.off(signal, forwards[index]!))
      signals.forEach((signal, index) => process.on(signal, forwards[index]!))
      child.once("error", (error) => { removeSignals(); reject(error) })
      child.once("close", (code, signal) => {
        removeSignals()
        if (guardError !== undefined) { reject(guardError); return }
        if (operation === "list" && !json && output) {
          output = output.split("\n").map((line) => {
            const fields = line.split("\t")
            fields[0] = Object.entries(entry.presets).find(([, backend]) => backend === fields[0])?.[0] ?? fields[0]!
            return fields.join("\t")
          }).join("\n")
          process.stdout.write(output)
        }
        if (json && output) {
          try {
            const value = JSON.parse(output)
            if (value.launcher === entry.legacyLauncher) value.launcher = harness
            if (value.harness === "oh-my-pi") value.harness = "omp"
            if (Array.isArray(value.profiles)) for (const profile of value.profiles)
              profile.name = Object.entries(entry.presets).find(([, backend]) => backend === profile.name)?.[0] ?? profile.name
            if (typeof value.profile === "string")
              value.profile = Object.entries(entry.presets).find(([, backend]) => backend === value.profile)?.[0] ?? value.profile
            console.log(JSON.stringify(value))
          } catch { process.stdout.write(output) }
        }
        const termination = cancelledBy ?? signal
        resolve(cancelledBy === undefined && code !== null ? code : termination === "SIGTERM" ? 143 : termination === "SIGINT" ? 130 : termination === "SIGHUP" ? 129 : 1)
      })
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
