import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  clampAugmentedIntent,
  GuideAugmentError,
  GuideAugmentPhase,
  runCodebaseAugment,
  runResearchAugment,
  type GuideAugmentContext,
} from "../src/guide-augment.js"
import type { CombinedGuideCatalog } from "../src/guide-catalog.js"
import { guideIntentMaximumLength } from "../src/guide-api.js"
import type { CommandRunOptions, CommandRunResult, CommandRunner } from "../src/guide-launch.js"
import type { GuideEnrichInput, GuideProvider } from "../src/guide-provider.js"

interface RecordedCall {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly options?: CommandRunOptions
}

/** Runs `effect` for each call, so a fake can write the file a real command would have written. */
class FakeRunner implements CommandRunner {
  readonly calls: Array<RecordedCall> = []

  constructor(private readonly effect: (call: RecordedCall) => Promise<CommandRunResult>) {}

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    const call: RecordedCall = { executable, args, ...(options === undefined ? {} : { options }) }
    this.calls.push(call)
    return this.effect(call)
  }
}

const ok = async (): Promise<CommandRunResult> => ({ stdout: "", stderr: "", exitCode: 0 })

const guide = {
  schemaVersion: 1 as const,
  capabilities: ["evidence-backed-rpi-delivery"],
  bestFor: ["Durable research before planning", "Evidence-backed implementation"],
  avoidFor: ["Sessions that need an approval pause", "Skill discovery work"],
  prerequisites: [{ id: "copilot-cli", description: "GitHub Copilot CLI on the host." }],
  workflows: [
    {
      id: "rpi-research",
      description: "Open a durable research phase.",
      examples: ["Research the retry logic", "Investigate the timeout"],
      promptTemplate: "Research: {{intent}}",
    },
  ],
}

const catalogWith = (native: CombinedGuideCatalog["native"]): CombinedGuideCatalog => ({
  schemaVersion: 1,
  sandboxCommandPath: "/opt/trellage/bin/trellage",
  native,
  sandbox: [],
})

const hveEntry: CombinedGuideCatalog["native"][number] = {
  launcher: "cpx",
  harness: "copilot",
  name: "hve",
  description: "Copilot CLI with the HVE Core RPI plugin.",
  headless: {
    schemaVersion: 1,
    prompt: true,
    outputFormats: ["text"],
    eventContract: null,
    trellageEventContract: null,
    sessionId: "none",
    resume: false,
    resumeWithPrompt: false,
    questionToolControl: "hard-deny",
    changedFiles: "git-diff",
    usage: false,
    cost: false,
    modelOverride: true,
    effortOverride: false,
    testedHarnessVersion: null,
  },
  sandbox: false,
  herdrCompatibility: { status: "untested" },
  guide,
  commandPath: "/opt/trellage/cpx/bin/cpx",
}

const researchCatalog = catalogWith([hveEntry])

let workspace: string
const phases: Array<GuideAugmentPhase> = []
const activity: Array<string> = []

const contextFor = (runner: CommandRunner, signal = new AbortController().signal): GuideAugmentContext => ({
  runner,
  cwd: workspace,
  signal,
  onPhase: (phase) => phases.push(phase),
  onActivity: (line) => activity.push(line),
})

const researchNotePath = (slug: string): string =>
  path.join(workspace, ".copilot-tracking", "research", "2026-09-02", `${slug}-research.md`)

const writeNote = async (slug: string, content: string): Promise<string> => {
  const file = researchNotePath(slug)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, "utf8")
  return file
}

/** Dates a note back an hour, so "the run left it alone" is unambiguous. */
const ageNote = async (file: string): Promise<void> => {
  const past = new Date(Date.now() - 3_600_000)
  await utimes(file, past, past)
}

const writeLaneNote = async (slug: string, content: string): Promise<void> => {
  const file = path.join(workspace, ".copilot-tracking", "research", "subagents", "2026-09-02", `${slug}-research.md`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, "utf8")
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "guide-augment-test-"))
  phases.length = 0
  activity.length = 0
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe("clampAugmentedIntent", () => {
  it("keeps text within the bound unchanged", () => {
    expect(clampAugmentedIntent("short")).toBe("short")
  })

  it("clamps over-length text to the intent bound and marks the truncation", () => {
    const clamped = clampAugmentedIntent("x".repeat(guideIntentMaximumLength + 500))
    expect([...clamped]).toHaveLength(guideIntentMaximumLength)
    expect(clamped).toContain("[truncated: augmented prompt exceeded the intent limit]")
  })
})

describe("research augmentation", () => {
  it("returns the note the run created, not one that already existed", async () => {
    await ageNote(await writeNote("older", "Stale note from an earlier session."))
    const runner = new FakeRunner(async () => {
      await writeNote("fresh", "# Research\n\nThe retry path swallows partial failures.")
      return ok()
    })

    const result = await runResearchAugment("fix the flaky test", researchCatalog, contextFor(runner))

    expect(result).toContain("swallows partial failures")
    expect(result).not.toContain("Stale note")
    expect(phases).toEqual([GuideAugmentPhase.RunningResearch, GuideAugmentPhase.ReadingNote])
  })

  it("runs the catalog's own cpx path against the working directory", async () => {
    const runner = new FakeRunner(async () => {
      await writeNote("fresh", "note")
      return ok()
    })

    await runResearchAugment("fix the flaky test", researchCatalog, contextFor(runner))

    const call = runner.calls[0]
    expect(call?.executable).toBe("/opt/trellage/cpx/bin/cpx")
    expect(call?.args[0]).toBe("hve")
    expect(call?.args[1]).toBe("-p")
    expect(call?.args[2]).toContain("fix the flaky test")
    expect(call?.options?.cwd).toBe(workspace)
  })

  it("streams the research run's output into the activity window", async () => {
    const runner = new FakeRunner(async ({ options }) => {
      options?.onOutput?.("\u001b[36mreading\u001b[0m guide-ui.tsx\r", "stdout")
      options?.onOutput?.("wrote the note\n", "stderr")
      await writeNote("fresh", "# Research\n\nFindings.")
      return ok()
    })

    await runResearchAugment("intent", researchCatalog, contextFor(runner))

    expect(activity).toEqual(["reading guide-ui.tsx", "wrote the note"])
  })

  it("names the setup command when the cpx/hve profile is not installed", async () => {
    const runner = new FakeRunner(ok)

    await expect(runResearchAugment("intent", catalogWith([]), contextFor(runner))).rejects.toThrow(
      /cpx setup hve/u,
    )
    expect(runner.calls).toHaveLength(0)
  })

  it("fails when the run left every note untouched", async () => {
    await ageNote(await writeNote("older", "Stale note."))
    const runner = new FakeRunner(ok)

    await expect(runResearchAugment("intent", researchCatalog, contextFor(runner))).rejects.toThrow(
      /wrote no note/u,
    )
  })

  it("returns a note the run rewrote in place, which is how a repeated intent resumes", async () => {
    const existing = await writeNote("same-task", "First pass.")
    await ageNote(existing)
    const runner = new FakeRunner(async () => {
      await writeNote("same-task", "# Research\n\nSecond pass, now with the retry evidence.")
      return ok()
    })

    const result = await runResearchAugment("intent", researchCatalog, contextFor(runner))

    expect(result).toContain("Second pass")
  })

  it("ignores worker lane notes under research/subagents and takes the primary artifact", async () => {
    const runner = new FakeRunner(async () => {
      await writeNote("fresh", "# Research\n\nThe primary artifact.")
      await writeLaneNote("lane", "Raw worker evidence.")
      return ok()
    })

    const result = await runResearchAugment("intent", researchCatalog, contextFor(runner))

    expect(result).toContain("The primary artifact")
    expect(result).not.toContain("Raw worker evidence")
  })

  it("quotes the run's own closing words when it writes nothing", async () => {
    const runner = new FakeRunner(async () => ({
      stdout: "## rpi-research: retries\nResearch disposition: Blocked\nThe request needs a target package.",
      stderr: "",
      exitCode: 0 as const,
    }))

    await expect(runResearchAugment("intent", researchCatalog, contextFor(runner))).rejects.toThrow(
      /needs a target package/u,
    )
  })

  it("reports the failing command when cpx exits non-zero", async () => {
    const runner = new FakeRunner(async () => {
      throw new Error("cpx hve exited with code 1")
    })

    await expect(runResearchAugment("intent", researchCatalog, contextFor(runner))).rejects.toThrow(
      GuideAugmentError,
    )
  })

  it("passes the abort signal to the runner", async () => {
    const abort = new AbortController()
    const runner = new FakeRunner(async () => {
      await writeNote("fresh", "note")
      return ok()
    })

    await runResearchAugment("intent", researchCatalog, contextFor(runner, abort.signal))

    expect(runner.calls[0]?.options?.signal).toBe(abort.signal)
  })

  it("clamps an over-length note to the intent bound", async () => {
    const runner = new FakeRunner(async () => {
      await writeNote("fresh", "y".repeat(guideIntentMaximumLength + 100))
      return ok()
    })

    const result = await runResearchAugment("intent", researchCatalog, contextFor(runner))

    expect([...result]).toHaveLength(guideIntentMaximumLength)
  })
})

const providerWith = (enrich: GuideProvider["enrich"]): GuideProvider =>
  ({
    match: async () => {
      throw new Error("unused")
    },
    generate: async () => {
      throw new Error("unused")
    },
    refine: async () => {
      throw new Error("unused")
    },
    optimize: async () => {
      throw new Error("unused")
    },
    ...(enrich === undefined ? {} : { enrich }),
  }) as GuideProvider

const temporaryPackDirectories = async (): Promise<ReadonlyArray<string>> =>
  (await readdir(os.tmpdir())).filter((entry) => entry.startsWith("trellage-guide-pack-"))

describe("codebase augmentation", () => {
  it("packs the repository, enriches the intent and removes the pack", async () => {
    const before = await temporaryPackDirectories()
    let seen: GuideEnrichInput | undefined
    const runner = new FakeRunner(async ({ args }) => {
      await writeFile(args[args.length - 1] ?? "", "# Repository\n\nsrc/guide-ui.tsx", "utf8")
      return ok()
    })
    const provider = providerWith(async (input) => {
      seen = input
      return { intent: "Fix the flaky test in src/guide-ui.tsx" }
    })

    const result = await runCodebaseAugment("fix the flaky test", provider, contextFor(runner))

    expect(result).toBe("Fix the flaky test in src/guide-ui.tsx")
    expect(seen?.intent).toBe("fix the flaky test")
    expect(seen?.pack).toContain("src/guide-ui.tsx")
    expect(runner.calls[0]?.executable).toBe("npx")
    expect(runner.calls[0]?.args).toContain("--compress")
    expect(phases).toEqual([GuideAugmentPhase.PackingRepository, GuideAugmentPhase.RewritingIntent])
    expect(await temporaryPackDirectories()).toEqual(before)
  })

  it("narrows the repomix scope until the pack fits the budget", async () => {
    let attempt = 0
    const runner = new FakeRunner(async ({ args }) => {
      attempt += 1
      await writeFile(args[args.length - 1] ?? "", attempt < 3 ? "z".repeat(400_001) : "# Repository\n\nsrc/app.ts")
      return ok()
    })
    let seen: GuideEnrichInput | undefined
    const provider = providerWith(async (input) => {
      seen = input
      return { intent: "narrowed" }
    })

    expect(await runCodebaseAugment("intent", provider, contextFor(runner))).toBe("narrowed")
    expect(runner.calls).toHaveLength(3)
    expect(runner.calls[0]?.args).toContain("--ignore")
    expect(runner.calls[0]?.args).not.toContain("--include")
    expect(runner.calls[1]?.args).toContain("--include")
    expect(runner.calls[2]?.args).toContain("--remove-comments")
    expect(seen?.pack).toContain("src/app.ts")
    expect(activity.some((line) => line.includes("narrowing"))).toBe(true)
  })

  it("keeps the whole repository when it already fits, and never narrows", async () => {
    const runner = new FakeRunner(async ({ args }) => {
      await writeFile(args[args.length - 1] ?? "", "# Repository\n\nsrc/app.ts", "utf8")
      return ok()
    })

    await runCodebaseAugment("intent", providerWith(async () => ({ intent: "kept" })), contextFor(runner))

    expect(runner.calls).toHaveLength(1)
  })

  it("points at repomix.config.json when even the narrowest scope is over budget", async () => {
    const runner = new FakeRunner(async ({ args }) => {
      await writeFile(args[args.length - 1] ?? "", "z".repeat(400_001), "utf8")
      return ok()
    })

    await expect(
      runCodebaseAugment("intent", providerWith(async () => ({ intent: "unused" })), contextFor(runner)),
    ).rejects.toThrow(/repomix\.config\.json/u)
  })

  it("streams repomix output into the activity window", async () => {
    const runner = new FakeRunner(async ({ args, options }) => {
      options?.onOutput?.("\u001b[32mPacking\u001b[0m 12 files\nDone\n", "stdout")
      await writeFile(args[args.length - 1] ?? "", "# Repository\n\nsrc/app.ts", "utf8")
      return ok()
    })

    await runCodebaseAugment("intent", providerWith(async () => ({ intent: "kept" })), contextFor(runner))

    expect(activity).toContain("Packing 12 files")
    expect(activity).toContain("Done")
  })

  it("removes the pack directory when the run fails", async () => {
    const before = await temporaryPackDirectories()
    const runner = new FakeRunner(async () => {
      throw new Error("repomix is unavailable")
    })

    await expect(
      runCodebaseAugment("intent", providerWith(async () => ({ intent: "unused" })), contextFor(runner)),
    ).rejects.toThrow(GuideAugmentError)
    expect(await temporaryPackDirectories()).toEqual(before)
  })

  it("fails before packing when the provider has no enrich phase", async () => {
    const runner = new FakeRunner(ok)

    await expect(runCodebaseAugment("intent", providerWith(undefined), contextFor(runner))).rejects.toThrow(
      /does not support codebase augmentation/u,
    )
    expect(runner.calls).toHaveLength(0)
  })
})
