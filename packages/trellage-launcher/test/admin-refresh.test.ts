import { describe, expect, it } from "vitest"

import type { ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { refreshAdminEntries } from "../src/admin-refresh.js"
import { parseGuideCatalog } from "../src/guide-catalog.js"
import { type CommandRunOptions, type CommandRunResult, type CommandRunner } from "../src/guide-launch.js"

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

const headless = {
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

const fixtureCatalog = () =>
  parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      sandboxCommandPath: "/opt/trellage/bin/trellage",
      native: [
        {
          launcher: "cpx",
          harness: "copilot",
          name: "hve",
          description: "Copilot native launcher.",
          headless,
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide,
          commandPath: "/opt/trellage/cpx/bin/cpx",
        },
        {
          launcher: "cldx",
          harness: "claude",
          name: "broken",
          description: "Claude native launcher returning malformed inventory.",
          headless,
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide,
          commandPath: "/opt/trellage/cldx/bin/cldx",
        },
        {
          launcher: "cdx",
          harness: "codex",
          name: "pstack",
          description: "Codex native launcher (no doctor support).",
          headless,
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide,
          commandPath: "/opt/trellage/cdx/bin/cdx",
        },
      ],
      sandbox: [],
    }),
  )

/** Routes each call by executable path so cpx/cldx get distinct canned outcomes. */
class RoutingRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: ReadonlyArray<string> }> = []

  async run(executable: string, args: ReadonlyArray<string>, _options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args })
    if (executable.includes("cpx")) {
      return { stdout: '{"schemaVersion":1,"launcher":"cpx","profile":"hve","readiness":"healthy"}', stderr: "", exitCode: 0 }
    }
    if (executable.includes("cldx")) {
      return { stdout: "not json at all", stderr: "", exitCode: 0 }
    }
    throw new Error(`unexpected executable: ${executable}`)
  }
}

describe("refreshAdminEntries", () => {
  it("checks only doctor-supporting profiles, isolating a malformed result from a healthy one", async () => {
    const runner = new RoutingRunner()
    const entries = await refreshAdminEntries(runner, fixtureCatalog(), "/work")

    expect(runner.calls).toHaveLength(2) // cpx + cldx checked; cdx skipped entirely.
    expect(runner.calls.some((call) => call.executable.includes("cdx/bin/cdx"))).toBe(false)

    const cpx = entries.find((entry) => entry.ref.includes("hve"))
    const cldx = entries.find((entry) => entry.ref.includes("broken"))
    const cdx = entries.find((entry) => entry.ref.includes("pstack"))

    expect(cpx).toMatchObject({ health: "healthy", install: "installed", stale: false })
    expect(cldx).toMatchObject({ health: "malformed-output", install: "malformed-output", stale: false })
    expect(cdx).toMatchObject({ health: "unsupported", install: "unsupported" })
  })
})
