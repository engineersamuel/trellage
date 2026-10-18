import type { RunOptions } from "../../packages/trellage-runtime/src/native-run/run.ts"
import { adapters } from "../../packages/trellage-runtime/src/native-run/adapters.ts"
import type { commandInventory } from "./inventory.ts"

/** Public CLI translations, kept independent of adapter.resumeArgs implementations. */
export function expectedRunArgumentTail(
  harness: string,
  resume: RunOptions["resume"],
  forwarded: readonly string[],
): readonly string[] {
  let args: string[]
  switch (harness) {
    case "agency":
    case "fx":
    case "headlong":
    case "jcode":
    case "omp":
    case "prime":
      args = []
      break
    case "pi":
    case "claude":
    case "grok":
      args = !resume
        ? []
        : resume.kind === "continue"
          ? ["--continue"]
          : resume.id
            ? ["--resume", resume.id]
            : ["--resume"]
      break
    case "copilot":
      args = !resume
        ? []
        : resume.kind === "continue"
          ? ["--continue"]
          : resume.id
            ? [`--resume=${resume.id}`]
            : ["--resume"]
      return [...args, ...forwarded.filter((argument) => argument !== "--plan")]
    case "codex":
      args = !resume
        ? []
        : resume.kind === "continue"
          ? ["resume", "--last"]
          : resume.id
            ? ["resume", resume.id]
            : ["resume"]
      if (args.length && forwarded[0] === "exec") return ["exec", ...args, ...forwarded.slice(1)]
      break
    case "uji":
      args = !resume ? ["new"] : resume.kind === "pick" && resume.id ? ["resume", "--id", resume.id] : ["resume"]
      break
    default:
      throw Error(`No resume command expectation for harness ${harness}`)
  }
  return [...args, ...forwarded]
}

export function expectedRunRejection(
  options: RunOptions,
  inventory: Awaited<ReturnType<typeof commandInventory>>,
): string | undefined {
  const adapter = Object.hasOwn(adapters, options.harness)
    ? adapters[options.harness as keyof typeof adapters]
    : undefined
  if (!adapter) return "usage"
  if (options.effort !== undefined && !adapter.efforts.includes(options.effort)) return "usage"
  if (options.forwardedArgs.some((argument) => adapter.managedFlags.includes(argument.split("=", 1)[0]!)))
    return "usage"
  const clean = options.profiles.includes("clean")
  if (clean) {
    if (options.profiles.length > 1 || options.skills?.length) return "usage"
    if (!adapter.clean.supported) return "unsupported"
    if (
      options.forwardedArgs.some(
        (argument) => adapter.clean.supported && adapter.clean.managedFlags?.includes(argument.split("=", 1)[0]!),
      )
    )
      return "usage"
    return undefined
  }
  const presets: readonly string[] | undefined = inventory.presets[options.harness as keyof typeof inventory.presets]
  const profiles = options.profiles.map((profile) =>
    Object.hasOwn(inventory.catalog.profiles, profile)
      ? profile
      : presets?.includes(profile)
        ? `preset-${options.harness}-${profile}`
        : profile,
  )
  for (const profile of profiles) {
    const supported = inventory.catalog.profiles[profile]?.harnesses
    if (supported && !supported.includes(options.harness)) return "unsupported"
  }
  if (options.harness === "uji" && options.model !== undefined && !/^copilot-proxy-rs\/.+$/u.test(options.model))
    return "usage"
  if (profiles.some((profile) => !Object.hasOwn(inventory.catalog.profiles, profile))) return "unknown-profile"
  if (!options.dryRun && !options.allowUnprovenIsolation && adapter.isolation.status !== "proven") return "isolation"
  return undefined
}
