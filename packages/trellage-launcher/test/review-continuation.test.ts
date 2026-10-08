import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  executeReviewContinuation, reviewContinuationProfileFromPath, reviewContinuationPrompt,
} from "../src/review-continuation.ts"
import { createNodeCommandRunner } from "../src/guide-launch.ts"
import type { CommandRunner, CommandSpec, HerdrContext, NativeSelectedProfile } from "../src/guide-launch.ts"
import type { ReviewContinuation } from "../src/review-ui.tsx"

const profile: NativeSelectedProfile = {
  surface: "native", launcher: "copilot", commandPath: "/fixture/trx",
  profile: "hve", headlessPrompt: false,
}
const context: HerdrContext = { workspaceId: "ws-1", paneId: "pane-1", surface: "pane" }
const result: ReviewContinuation = {
  action: "continue", destination: "current-terminal",
  snapshot: {
    branch: "review", baseRef: "refs/remotes/origin/main",
    baseRefSha: "a".repeat(40), baseSha: "a".repeat(40), headSha: "b".repeat(40),
    changedFiles: ["src/a.ts"], workingTreeFiles: ["src/a.ts"], diffBytes: 512,
  },
  outcome: {
    markdown: "# Review", markdownPath: "/private/review/report.md",
    jsonPath: "/private/review/report.json", complete: false,
  },
}

const services = () => {
  const commands: Array<{ executable: string; args: ReadonlyArray<string> }> = []
  const runner: CommandRunner = {
    run: async (executable, args) => {
      commands.push({ executable, args })
      return {
        stdout: executable === "herdr" && args[0] === "tab"
          ? JSON.stringify({ result: { root_pane: { pane_id: "new-pane" } } }) : "",
        stderr: "", exitCode: 0,
      }
    },
  }
  return { runner, commands, runInteractive: vi.fn(async (
    _command: CommandSpec, _options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => {}) }
}

describe("review continuation", () => {
  it("uses the router's verified Copilot path without reading a Guide catalog", () => {
    expect(reviewContinuationProfileFromPath("/fixture/trx")).toEqual(profile)
    expect(() => reviewContinuationProfileFromPath(undefined)).toThrow("launcher is missing")
    expect(() => reviewContinuationProfileFromPath("./trx")).toThrow("launcher is missing")
  })

  it("routes current-terminal Copilot through trx with plan mode and a report handoff", async () => {
    const service = services()
    await executeReviewContinuation(result, profile, "/checkout", null, service)
    expect(service.runInteractive).toHaveBeenCalledOnce()
    const [command, options] = service.runInteractive.mock.calls[0]!
    expect(command.executable).toBe("trx")
    expect(command.args.slice(0, 6)).toEqual(["run", "copilot", "hve", "--", "--plan", "-i"])
    expect(command.args.at(-1)).toContain(result.outcome.markdownPath)
    expect(options.cwd).toBe("/checkout")
    expect(service.commands).toEqual([])
    expect(reviewContinuationPrompt(result)).toContain("Review status: incomplete")
    expect(reviewContinuationPrompt(result)).toContain("Do not edit files, implement changes, or start another review")
    expect(reviewContinuationPrompt(result)).toContain("prioritized fix plan")
  })

  it("uses the worktree mise task so source runtime readiness is repaired before current-pane launch", async () => {
    vi.stubEnv("MISE_PROJECT_ROOT", "/checkout")
    vi.stubEnv("TRELLAGE_TRX_NATIVE_SOURCE", "1")
    try {
      const service = services()
      await executeReviewContinuation(result, profile, "/checkout", null, service)
      const [command] = service.runInteractive.mock.calls[0]!
      expect(command.executable).toBe("mise")
      expect(command.args.slice(0, 9)).toEqual([
        "run", "trx", "--", "run", "copilot", "hve", "--", "--plan", "-i",
      ])
      expect(command.args.at(-1)).toContain(result.outcome.markdownPath)
      const other = services()
      await executeReviewContinuation(result, profile, "/other-worktree", null, other)
      expect(other.runInteractive.mock.calls[0]![0].executable).toBe("trx")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("creates a Herdr tab only for an explicit tab choice", async () => {
    const service = services()
    await executeReviewContinuation({ ...result, destination: "new-herdr-tab" },
      profile, "/checkout", context, service)
    expect(service.runInteractive).not.toHaveBeenCalled()
    expect(service.commands.map((item) => item.args.slice(0, 2))).toEqual([
      ["tab", "create"], ["pane", "run"],
    ])
    expect(service.commands[1]?.args[2]).toBe("new-pane")
    expect(service.commands[1]?.args[3]).toContain("/private/review/report.md")
    expect(service.commands[1]?.args[3]).toContain("hve --plan --mode autopilot --allow-all --no-ask-user -i")
    const tabPrompt = reviewContinuationPrompt({ ...result, destination: "new-herdr-tab" })
    expect(tabPrompt).toContain("Implement only verified fixes")
    expect(tabPrompt).toContain("stop before editing")
    expect(tabPrompt).not.toContain("Do not edit files")
    expect(service.commands[1]?.args[3]).toContain("Implement verified fixes")
  })

  it("blocks missing Herdr and uncommitted new-worktree changes without any launch", async () => {
    const service = services()
    await expect(executeReviewContinuation({ ...result, destination: "new-herdr-tab" },
      profile, "/checkout", null, service)).rejects.toThrow("Herdr is unavailable")
    await expect(executeReviewContinuation({ ...result, destination: "new-herdr-worktree" },
      profile, "/checkout", context, service)).rejects.toThrow("cannot carry uncommitted")
    expect(service.commands).toEqual([])
  })

  it("starts a clean new worktree from the reviewed HEAD only", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "review-continuation-")))
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
    try {
      git("init", "-q", "-b", "main")
      git("config", "user.name", "Fixture")
      git("config", "user.email", "fixture@example.invalid")
      await writeFile(path.join(root, "a.ts"), "original\n")
      git("add", "a.ts")
      git("commit", "-qm", "original")
      const head = git("rev-parse", "HEAD")
      const commands: Array<{ executable: string; args: ReadonlyArray<string> }> = []
      const gitRunner = createNodeCommandRunner()
      const runner: CommandRunner = {
        run: async (executable, args, options) => {
          commands.push({ executable, args })
          if (executable === "git") return gitRunner.run(executable, args, options)
          return { stdout: args[0] === "worktree" ? JSON.stringify({ result: {
            workspace: { workspace_id: "ws-1" },
            root_pane: { pane_id: "pane-2" },
            worktree: { path: path.join(root, "review-copy") },
          } }) : "", stderr: "", exitCode: 0 }
        },
      }
      const clean = { ...result, destination: "new-herdr-worktree" as const,
        snapshot: { ...result.snapshot, headSha: head, workingTreeFiles: [] } }
      await executeReviewContinuation(clean, profile, root, context, {
        runner, runInteractive: async () => { throw new Error("unexpected interactive launch") },
      })
      const creation = commands.find((command) => command.executable === "herdr" && command.args[0] === "worktree")
      expect(creation?.args).toContain(head)
      expect(commands.at(-1)?.args.slice(0, 3)).toEqual(["pane", "run", "pane-2"])
      expect(commands.at(-1)?.args[3]).toContain("hve --plan -i")
      await writeFile(path.join(root, "a.ts"), "edited\n")
      await expect(executeReviewContinuation(clean, profile, root, context, {
        runner, runInteractive: async () => {},
      })).rejects.toThrow("Reviewed HEAD or worktree changed")
      expect(commands.filter((command) => command.executable === "herdr" && command.args[0] === "worktree")).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
