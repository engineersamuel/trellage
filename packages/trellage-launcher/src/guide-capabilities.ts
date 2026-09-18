import { validateHeadlessCapabilitiesV1, type CombinedGuideCatalog, type HeadlessCapabilitiesV1 } from "./guide-catalog.ts"
import type { CommandRunner } from "./guide-launch.ts"

const unavailableCapabilities: HeadlessCapabilitiesV1 = {
  schemaVersion: 1,
  prompt: false,
  outputFormats: ["text"],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "none",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "none",
  changedFiles: "none",
  usage: false,
  cost: false,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
}

/** Refresh launch capabilities after matching; the startup catalog may contain only cached capabilities. */
export const resolveGuideCapabilities = async (
  catalog: CombinedGuideCatalog,
  runner: CommandRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<CombinedGuideCatalog> => {
  signal?.throwIfAborted()
  const copilot = catalog.native.filter(({ launcher }) => launcher === "cpx")
  const first = copilot[0]
  if (first === undefined) return catalog
  let capabilities: ReadonlyMap<string, HeadlessCapabilitiesV1> = new Map()
  try {
    if (copilot.some(({ commandPath }) => commandPath !== first.commandPath)) {
      throw new Error("Copilot catalog has inconsistent executable paths")
    }
    const result = await runner.run(first.commandPath, ["list", "--json"], {
      cwd,
      timeoutMs: 5_000,
      ...(signal === undefined ? {} : { signal }),
    })
    signal?.throwIfAborted()
    const payload = JSON.parse(result.stdout)
    if (payload?.schemaVersion !== 1 || payload.launcher !== "cpx" || payload.harness !== "copilot" || !Array.isArray(payload.profiles)) {
      throw new Error("Invalid Copilot capability catalog")
    }
    const refreshed = new Map<string, HeadlessCapabilitiesV1>()
    for (const profile of payload.profiles) {
      if (typeof profile?.name !== "string" || refreshed.has(profile.name)) {
        throw new Error("Invalid Copilot profile identity")
      }
      refreshed.set(profile.name, validateHeadlessCapabilitiesV1(profile.headless, "Copilot headless capabilities"))
    }
    if (copilot.some(({ name }) => !refreshed.has(name))) {
      throw new Error("Copilot capability catalog omitted a profile")
    }
    capabilities = refreshed
  } catch {
    signal?.throwIfAborted()
  }
  return {
    ...catalog,
    native: catalog.native.map((entry) => entry.launcher === "cpx"
      ? { ...entry, headless: capabilities.get(entry.name) ?? unavailableCapabilities }
      : entry),
  }
}
