import { beforeEach, describe, expect, it, vi } from "vitest"

import type { HerdrWorktreeLaunchResult } from "../src/guide-launch.js"

const createHerdrWorktreeAndHandoff = vi.fn()
const probeHerdrAvailability = vi.fn()
const getHerdrContext = vi.fn()
const inspectGitWorktreeIntent = vi.fn()
const defaultWorktreeBranch = vi.fn((intent: string) => `worktree/${intent.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`)

vi.mock("../src/guide-launch.js", async () => {
  const actual = await vi.importActual<typeof import("../src/guide-launch.js")>("../src/guide-launch.js")
  return {
    ...actual,
    createHerdrWorktreeAndHandoff,
    probeHerdrAvailability,
    getHerdrContext,
    inspectGitWorktreeIntent,
    defaultWorktreeBranch,
  }
})

const { forkFailureToHerdrWorktree, isForkToHerdrAvailable } = await import("../src/admin-herdr-fork.js")

const fakeRunner = { run: vi.fn() } as unknown as import("../src/guide-launch.js").CommandRunner
const command = { executable: "/opt/trellage/cpx/bin/cpx", args: ["hve"] }

const readyInspection = {
  kind: "ready" as const,
  currentCheckoutRoot: "/repo",
  primaryCheckoutPath: "/repo",
  currentHeadSha: "abc123",
  baseRef: "HEAD",
  branch: "worktree/fix-hve-doctor-failure",
  dirty: false,
  branchExists: false,
  activeBranchWorktree: null,
  activePathWorktree: null,
}

const launchResult: HerdrWorktreeLaunchResult = {
  workspaceId: "w1",
  rootPaneId: "w1:p1",
  checkoutPath: "/worktrees/fix-hve",
  paneId: "w1:p1",
  commandPreview: "cpx hve",
}

beforeEach(() => {
  createHerdrWorktreeAndHandoff.mockReset()
  probeHerdrAvailability.mockReset()
  getHerdrContext.mockReset()
  inspectGitWorktreeIntent.mockReset()
  defaultWorktreeBranch.mockClear()
})

describe("isForkToHerdrAvailable", () => {
  it("is false when no Herdr context is present in the environment, without probing", async () => {
    getHerdrContext.mockReturnValue(null)
    const available = await isForkToHerdrAvailable(fakeRunner, {}, "/repo")
    expect(available).toBe(false)
    expect(probeHerdrAvailability).not.toHaveBeenCalled()
  })

  it("is true only when both a Herdr context is present and the probe succeeds", async () => {
    getHerdrContext.mockReturnValue({ workspaceId: "w1", paneId: "p1", surface: "pane" })
    probeHerdrAvailability.mockResolvedValue(true)
    expect(await isForkToHerdrAvailable(fakeRunner, {}, "/repo")).toBe(true)
  })

  it("is false, never throws, when the probe rejects", async () => {
    getHerdrContext.mockReturnValue({ workspaceId: "w1", paneId: "p1", surface: "pane" })
    probeHerdrAvailability.mockRejectedValue(new Error("herdr not on PATH"))
    await expect(isForkToHerdrAvailable(fakeRunner, {}, "/repo")).resolves.toBe(false)
  })
})

describe("forkFailureToHerdrWorktree", () => {
  it("builds a branch from the profile name and an argument-vector-only prompt/command, and reports launched", async () => {
    inspectGitWorktreeIntent.mockResolvedValue(readyInspection)
    createHerdrWorktreeAndHandoff.mockResolvedValue(launchResult)
    const outcome = await forkFailureToHerdrWorktree(
      fakeRunner,
      { ref: "native:cpx/hve", name: "hve", capturedOutput: "boom; rm -rf /", diagnosis: { summary: "s", suggestedFix: "f" } },
      { cwd: "/repo", command, promptDelivery: "agent" },
    )
    expect(outcome).toEqual({ kind: "launched", result: launchResult })
    expect(defaultWorktreeBranch).toHaveBeenCalledWith(expect.stringContaining("hve"))
    const call = createHerdrWorktreeAndHandoff.mock.calls[0]?.[1] as Record<string, unknown>
    expect(call.command).toEqual(command)
    expect(call.primaryCheckoutPath).toBe(readyInspection.primaryCheckoutPath)
    expect(call.baseRef).toBe(readyInspection.baseRef)
    expect(typeof call.prompt).toBe("string")
    // The untrusted captured output must appear only as inert prompt text, never used to construct the command.
    expect(command.args).not.toContain("boom; rm -rf /")
    expect((call.prompt as string)).toContain("boom; rm -rf /")
  })

  it("reports a typed not-ready outcome, without creating a worktree, when the git inspection is not ready", async () => {
    const { kind: _readyKind, ...rest } = readyInspection
    inspectGitWorktreeIntent.mockResolvedValue({ ...rest, kind: "collision", collision: { kind: "branch-exists" } })
    const outcome = await forkFailureToHerdrWorktree(
      fakeRunner,
      { ref: "native:cpx/hve", name: "hve", capturedOutput: "boom" },
      { cwd: "/repo", command, promptDelivery: "agent" },
    )
    expect(outcome.kind).toBe("not-ready")
    expect(createHerdrWorktreeAndHandoff).not.toHaveBeenCalled()
  })

  it("reports a typed failed outcome, isolated, when the underlying Herdr call throws", async () => {
    inspectGitWorktreeIntent.mockResolvedValue(readyInspection)
    createHerdrWorktreeAndHandoff.mockRejectedValue(new Error("herdr worktree create failed"))
    const outcome = await forkFailureToHerdrWorktree(
      fakeRunner,
      { ref: "native:cpx/hve", name: "hve", capturedOutput: "boom" },
      { cwd: "/repo", command, promptDelivery: "agent" },
    )
    expect(outcome.kind).toBe("failed")
  })

  it("reports a typed failed outcome when the git inspection itself throws", async () => {
    inspectGitWorktreeIntent.mockRejectedValue(new Error("git worktree list failed"))
    const outcome = await forkFailureToHerdrWorktree(
      fakeRunner,
      { ref: "native:cpx/hve", name: "hve", capturedOutput: "boom" },
      { cwd: "/repo", command, promptDelivery: "agent" },
    )
    expect(outcome.kind).toBe("failed")
    expect(createHerdrWorktreeAndHandoff).not.toHaveBeenCalled()
  })
})
