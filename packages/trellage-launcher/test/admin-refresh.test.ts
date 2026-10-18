import { describe, expect, it } from "vitest"

import type { ProfileGuideV1 } from "@trellage/guide-core"
import { refreshAdminEntries } from "../src/admin-refresh.ts"
import type { CompositionCatalog, HeadlessCapabilitiesV1 } from "../src/composition-catalog.ts"
import { type CommandRunOptions, type CommandRunResult, type CommandRunner } from "../src/guide-launch.ts"

const guide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["code-review"],
  bestFor: ["Reviewing pull requests", "Writing focused regression tests"],
  avoidFor: ["Long-running background jobs", "Unrelated content work"],
  prerequisites: [],
  workflows: [
    {
      id: "review",
      description: "Review a diff.",
      examples: ["Review my last commit", "Check this pull request"],
      promptTemplate: "Review the diff for: {{intent}}.",
    },
  ],
}

const headless: HeadlessCapabilitiesV1 = {
  schemaVersion: 1,
  prompt: true,
  outputFormats: ["json"],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "native",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "hard-deny",
  changedFiles: "native",
  usage: true,
  cost: true,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
}

const fixtureCatalog = (): CompositionCatalog => ({
  schemaVersion: 2,
  entries: [
    {
      ref: "native:copilot/hve", harness: "copilot", profiles: ["hve"], kind: "preset", canonicalHarness: true,
      description: "Copilot native launcher.", headless, herdrCompatibility: { status: "supported" }, guide,
      commandPath: "/opt/trellage/copilot/bin/trx", lifecycle: { runtime: "cpx", profile: "hve" },
    },
    {
      ref: "native:claude/broken", harness: "claude", profiles: ["broken"], kind: "preset", canonicalHarness: true,
      description: "Claude malformed inventory.", headless, herdrCompatibility: { status: "supported" }, guide,
      commandPath: "/opt/trellage/claude/bin/trx", lifecycle: { runtime: "cldx", profile: "broken" },
    },
    {
      ref: "native:codex/pstack", harness: "codex", profiles: ["pstack"], kind: "preset", canonicalHarness: true,
      description: "Codex native launcher.", headless, herdrCompatibility: { status: "supported" }, guide,
      commandPath: "/opt/trellage/codex/bin/trx", lifecycle: null,
    },
  ],
})

/** Routes each call by executable path so lifecycle-backed rows get distinct canned outcomes. */
class RoutingRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: ReadonlyArray<string> }> = []

  async run(executable: string, args: ReadonlyArray<string>, _options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args })
    if (executable.includes("copilot")) {
      return { stdout: '{"schemaVersion":2,"harness":"copilot","profiles":["hve"],"readiness":"healthy"}', stderr: "", exitCode: 0 }
    }
    if (executable.includes("claude")) return { stdout: "not json at all", stderr: "", exitCode: 0 }
    if (executable.includes("codex")) {
      return { stdout: '{"schemaVersion":2,"harness":"codex","profiles":["pstack"],"readiness":"healthy"}', stderr: "", exitCode: 0 }
    }
    throw new Error(`unexpected executable: ${executable}`)
  }
}

describe("refreshAdminEntries", () => {
  it("refreshes only lifecycle-backed profiles", async () => {
    const runner = new RoutingRunner()
    const entries = await refreshAdminEntries(runner, fixtureCatalog(), "/work")

    expect(runner.calls).toHaveLength(2)
    expect(runner.calls.some((call) => call.executable.includes("codex/bin/trx"))).toBe(false)

    const cpx = entries.find((entry) => entry.ref.includes("hve"))
    const cldx = entries.find((entry) => entry.ref.includes("broken"))
    const codex = entries.find((entry) => entry.ref.includes("pstack"))

    expect(cpx).toMatchObject({ health: "healthy", install: "installed", stale: false })
    expect(cldx).toMatchObject({ health: "malformed-output", install: "malformed-output", stale: false })
    expect(codex).toMatchObject({ health: "unknown", install: "unknown", stale: true })
  })
})
