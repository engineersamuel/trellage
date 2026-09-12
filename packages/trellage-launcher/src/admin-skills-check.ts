import { stripVTControlCharacters } from "node:util"
import { isKnownNativeLauncher, type AdminProfileEntry } from "./admin-model.ts"
import type { CommandRunner } from "./guide-launch.ts"
import { updateDiagnostic } from "./admin-update-command.ts"

export type AdminSkillsCheckResult = {
  readonly kind: "current" | "available" | "unknown"
  readonly diagnostic?: string
}

const unknown = (diagnostic: string): AdminSkillsCheckResult => ({ kind: "unknown", diagnostic })

const parseResult = (stdout: string): AdminSkillsCheckResult => {
  const lines = stdout.trim().split("\n")
  const results = lines.map((line): AdminSkillsCheckResult => {
    const value: unknown = JSON.parse(line)
    if (typeof value !== "object" || value === null || !("kind" in value))
      throw new Error("Invalid skills check output.")
    if (value.kind === "current" || value.kind === "available") {
      const diagnostic = "diagnostic" in value && typeof value.diagnostic === "string" ? value.diagnostic : undefined
      return diagnostic === undefined ? { kind: value.kind } : { kind: value.kind, diagnostic }
    }
    if (
      value.kind === "unknown" &&
      "diagnostic" in value &&
      typeof value.diagnostic === "string" &&
      value.diagnostic.trim()
    ) {
      return unknown(value.diagnostic)
    }
    throw new Error("Skills check returned no reliable freshness evidence.")
  })
  return (
    results.find((result) => result.kind === "unknown") ??
    results.find((result) => result.kind === "available") ?? { kind: "current" }
  )
}

const checkEntry = async (
  entry: AdminProfileEntry,
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal,
  helpChecks: Map<string, Promise<boolean>>,
): Promise<AdminSkillsCheckResult> => {
  if ((entry.surface === "native" && !isKnownNativeLauncher(entry.launcher ?? "")) || entry.commandPath.length === 0) {
    return unknown("This launcher has no supported read-only skills check.")
  }
  try {
    signal.throwIfAborted()
    let supported = helpChecks.get(entry.commandPath)
    if (supported === undefined) {
      supported = runner
        .run(entry.commandPath, ["--help"], {
          cwd,
          signal,
          timeoutMs: 10_000,
          env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
        })
        .then((output) =>
          /(?:^|\s)skills-check\s+PROFILE(?:\s|$)/m.test(
            stripVTControlCharacters(`${output.stdout}\n${output.stderr}`),
          ),
        )
      helpChecks.set(entry.commandPath, supported)
    }
    if (!(await supported)) return unknown("Refresh the installed Trellage launcher to enable read-only skills-check.")
    signal.throwIfAborted()
    const output = await runner.run(entry.commandPath, ["skills-check", entry.name], {
      cwd,
      signal,
      timeoutMs: 5 * 60 * 1000,
      terminationGraceMs: 15_000,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
    })
    signal.throwIfAborted()
    return parseResult(output.stdout)
  } catch (error: unknown) {
    return unknown(updateDiagnostic(error))
  }
}

const checkShared = async (
  runner: CommandRunner,
  cwd: string,
  routerCommandPath: string,
  signal: AbortSignal,
): Promise<AdminSkillsCheckResult> => {
  try {
    signal.throwIfAborted()
    const help = await runner.run(routerCommandPath, ["--help"], {
      cwd,
      signal,
      timeoutMs: 10_000,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
    })
    const text = stripVTControlCharacters(`${help.stdout}\n${help.stderr}`)
    if (!/(?:^|\s)skills\s+check\s+--json(?:\s|$)/m.test(text)) {
      return unknown("Refresh the installed router to enable read-only shared skills checks.")
    }
    signal.throwIfAborted()
    const output = await runner.run(routerCommandPath, ["skills", "check", "--json"], {
      cwd,
      signal,
      timeoutMs: 5 * 60 * 1000,
      terminationGraceMs: 15_000,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
    })
    signal.throwIfAborted()
    return parseResult(output.stdout)
  } catch (error: unknown) {
    return unknown(updateDiagnostic(error))
  }
}

export async function checkAdminSkillsUpdates(
  entries: ReadonlyArray<AdminProfileEntry>,
  runner: CommandRunner,
  cwd: string,
  routerCommandPath: string,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, AdminSkillsCheckResult>> {
  const results = new Map<string, AdminSkillsCheckResult>()
  const helpChecks = new Map<string, Promise<boolean>>()
  for (const entry of entries) results.set(entry.ref, await checkEntry(entry, runner, cwd, signal, helpChecks))
  results.set("skills:shared", await checkShared(runner, cwd, routerCommandPath, signal))
  return results
}
