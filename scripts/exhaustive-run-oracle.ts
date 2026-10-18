import type { RunOptions } from "@trellage/runtime/native-run"
import { adapters } from "@trellage/runtime/native-run"
import type { NativeCatalog } from "@trellage/runtime/native-config"
import type { DomainValue } from "./exhaustive-cli-domains.ts"

export type RunOutcome = "usage" | "unsupported" | "unknown-profile" | "isolation" | "dry-run" | "launched"

/** Expected validation order for the declared domains in an empty owned workspace. */
export const expectedRunOutcome = (options: RunOptions | undefined, catalog: NativeCatalog): RunOutcome => {
  if (!options || !Object.hasOwn(adapters, options.harness)) return "usage"
  const adapter = adapters[options.harness]!
  if (options.effort !== undefined && !adapter.efforts.includes(options.effort)) return "usage"
  if (options.forwardedArgs.some((argument) => adapter.managedFlags.includes(argument.split("=", 1)[0]!)))
    return "usage"
  if (options.resume && !["claude", "codex", "copilot", "grok", "pi", "uji"].includes(options.harness))
    return "unsupported"
  const clean = options.profiles.includes("clean")
  if (clean) {
    if (options.profiles.length > 1 || options.skills?.length) return "usage"
    if (!["claude", "codex", "copilot", "pi"].includes(options.harness)) return "unsupported"
    if (
      adapter.clean.supported &&
      options.forwardedArgs.some(
        (argument) => adapter.clean.supported && adapter.clean.managedFlags?.includes(argument.split("=", 1)[0]!),
      )
    )
      return "usage"
    return options.dryRun ? "dry-run" : "launched"
  }
  const resolved = options.profiles.map((name) =>
    Object.hasOwn(catalog.profiles, name)
      ? name
      : Object.hasOwn(catalog.profiles, `preset-${options.harness}-${name}`)
        ? `preset-${options.harness}-${name}`
        : name,
  )
  if (
    resolved.some(
      (name) => catalog.profiles[name]?.harnesses && !catalog.profiles[name]!.harnesses!.includes(options.harness),
    )
  )
    return "unsupported"
  // Uji's provider policy validates its model before composition resolves unknown profiles.
  if (options.harness === "uji" && options.model !== undefined && !/^copilot-proxy-rs\/.+$/u.test(options.model))
    return "usage"
  if (resolved.some((name) => !Object.hasOwn(catalog.profiles, name))) return "unknown-profile"
  if (options.dryRun) return "dry-run"
  if (options.harness !== "pi" && !options.allowUnprovenIsolation) return "isolation"
  return "launched"
}

export const expectedRun = (selected: ReadonlyMap<string, DomainValue>): RunOptions | undefined => {
  const form = selected.get("syntax")!.form
  if (form === "missing-value" || form === "unknown-option") return undefined
  const reversed = form === "reverse-options"
  const present = (name: string): boolean => selected.get(name)!.argv.length !== 0
  const positionals = [...selected.get("harness")!.argv, ...selected.get("profiles")!.argv]
  const [harness, ...profiles] = positionals
  const model = selected.get("--model")!.argv[1]
  const skill = selected.get("--skill")!
  if (!harness || model === "" || skill.id === "invalid") return undefined
  const inlineResume = selected.get("inline-resume")!.argv[0]
  return {
    harness,
    profiles,
    forwardedArgs: selected.get("forwarded")!.argv.slice(1),
    dryRun: present("--dry-run"),
    plan: present("--plan"),
    noAlways: present("--no-always"),
    allowUnprovenIsolation: reversed
      ? !present("--require-proven-isolation")
      : present("--allow-unproven-isolation") || !present("--require-proven-isolation"),
    ...(model === undefined ? {} : { model }),
    ...(present("--effort") ? { effort: selected.get("--effort")!.argv[1]! } : {}),
    ...(skill.argv.length
      ? {
          skills: (form === "repeat-values" ? [...skill.argv, ...skill.argv] : skill.argv).filter(
            (_, index) => index % 2 === 1,
          ),
        }
      : {}),
    ...(reversed && present("--continue")
      ? { resume: { kind: "continue" as const } }
      : reversed && present("--resume")
        ? { resume: { kind: "pick" as const } }
        : inlineResume !== undefined
          ? { resume: { kind: "pick" as const, id: inlineResume.slice("--resume=".length) } }
          : present("--resume")
            ? { resume: { kind: "pick" as const } }
            : present("--continue")
              ? { resume: { kind: "continue" as const } }
              : {}),
  }
}
