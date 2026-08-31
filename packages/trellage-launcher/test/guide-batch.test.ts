import { describe, expect, it } from "vitest"

import {
  createQueuedGuideJob,
  emptyGuideQueue,
  enqueueGuideJob,
  executeGuideBatch,
  removeSelectedQueuedGuideJob,
  selectQueuedGuideJob,
  startQueuedGuidePromptEdit,
  submitQueuedGuidePromptEdit,
  type GuideBatch,
} from "../src/guide-batch.js"
import { CommandRunnerError, type CommandRunOptions, type CommandRunResult, type CommandRunner, type SelectedProfile } from "../src/guide-launch.js"

class BatchRunner implements CommandRunner {
  readonly calls: Array<{ readonly executable: string; readonly args: ReadonlyArray<string>; readonly options?: CommandRunOptions }> = []
  private split = 0

  constructor(private readonly fail: (executable: string, args: ReadonlyArray<string>) => Error | undefined = () => undefined) {}

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args: [...args], ...(options === undefined ? {} : { options }) })
    const error = this.fail(executable, args)
    if (error !== undefined) throw error
    if (args[0] === "validate") return { stdout: "", stderr: "", exitCode: 0 }
    if (args[0] === "inventory") {
      return {
        stdout: JSON.stringify({ schemaVersion: 1, launcher: executable.split("/").at(-1), profile: args[1], readiness: "healthy" }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "pane" && args[1] === "split") {
      this.split += 1
      return { stdout: JSON.stringify({ result: { pane: { pane_id: `9-${this.split}` } } }), stderr: "", exitCode: 0 }
    }
    if (args[0] === "worktree" && args[1] === "create") {
      return {
        stdout: JSON.stringify({
          result: {
            workspace: { workspace_id: "12" },
            root_pane: { pane_id: "12-1" },
            worktree: { path: "/repo/.worktrees/batch" },
          },
        }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "agent" && args[1] === "get") {
      return { stdout: JSON.stringify({ result: { agent: { agent_status: "idle" } } }), stderr: "", exitCode: 0 }
    }
    return { stdout: "", stderr: "", exitCode: 0 }
  }
}

const sandbox = (profile: string): SelectedProfile => ({
  surface: "sandbox",
  commandPath: "/opt/trellage/bin/trellage",
  profile,
  headlessPrompt: false,
})

const native = (launcher: "cpx" | "cdx", profile: string, agent?: string): SelectedProfile => ({
  surface: "native",
  launcher,
  commandPath: `/opt/trellage/bin/${launcher}`,
  profile,
  headlessPrompt: false,
  ...(agent === undefined ? {} : { agent }),
})

const currentPolicy: GuideBatch["policy"] = {
  kind: "current-herdr-workspace",
  workspaceId: "9",
  cwd: "/repo",
  callerPaneId: "9-0",
  direction: "right",
}

const failure = (message: string): CommandRunnerError =>
  new CommandRunnerError({ kind: "exited", executable: "herdr", args: [], message, exitCode: 1 })

describe("guide batch queue", () => {
  it("preserves enqueue order and atomically rebuilds profile-specific prompt delivery", () => {
    let queue = emptyGuideQueue()
    queue = enqueueGuideJob(queue, native("cpx", "council", "claude-council"), "/council First proposal")
    queue = enqueueGuideJob(queue, native("cdx", "research"), "Research prior work")

    expect(queue.entries.map((job) => job.id)).toEqual([1, 2])
    expect(queue.entries[0]?.command.args).toEqual(["council", "--agent", "claude-council", "-i", "/council First proposal"])
    expect(queue.entries[1]?.command.args).toEqual(["research", "--", "Research prior work"])
    expect(queue.entries.map((job) => job.promptDelivery)).toEqual(["command", "command"])

    queue = selectQueuedGuideJob(queue, -1)
    queue = startQueuedGuidePromptEdit(queue)
    queue = submitQueuedGuidePromptEdit(queue, "/council Revised proposal")
    expect(queue.entries[0]?.prompt).toBe("/council Revised proposal")
    expect(queue.entries[0]?.command.args.at(-1)).toBe("/council Revised proposal")

    queue = removeSelectedQueuedGuideJob(queue)
    expect(queue.entries.map((job) => job.id)).toEqual([2])
    expect(queue.selectedIndex).toBe(0)
  })

  it("rejects an empty queue without side effects", async () => {
    const runner = new BatchRunner()
    const writes: string[] = []
    const outcome = await executeGuideBatch({ jobs: [], policy: currentPolicy }, { runner, write: (text) => writes.push(text) })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.result).toEqual({ workspace: { status: "not-allocated" }, entries: [] })
    expect(runner.calls).toEqual([])
    expect(writes).toEqual(["Batch queue is empty.\n"])
  })

  it("launches mixed council and research jobs in queue order in the current workspace", async () => {
    const runner = new BatchRunner()
    const jobs = [
      createQueuedGuideJob(1, sandbox("claude-council"), "/council Compare the designs"),
      createQueuedGuideJob(2, sandbox("claude-research"), "Research the prior art"),
    ]
    const outcome = await executeGuideBatch({ jobs, policy: currentPolicy }, { runner, write: () => undefined })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.result.entries.map((entry) => [entry.job.profile.profile, entry.status])).toEqual([
      ["claude-council", "launched"],
      ["claude-research", "launched"],
    ])
    expect(runner.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "split").map((call) => call.args[3])).toEqual(["9-0", "9-0"])
    expect(runner.calls.some((call) => call.args.includes("/council Compare the designs"))).toBe(true)
    expect(runner.calls.some((call) => call.args.includes("Research the prior art"))).toBe(true)
  })

  it("reports invalid entries and continues with valid peers", async () => {
    const runner = new BatchRunner()
    const valid = createQueuedGuideJob(2, native("cpx", "worker"), "Keep going")
    const invalid = { ...createQueuedGuideJob(1, native("cdx", "reviewer"), "Review"), command: { executable: "/tmp/model-command", args: [] } }
    const outcome = await executeGuideBatch({ jobs: [invalid, valid], policy: currentPolicy }, { runner, write: () => undefined })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.result.entries.map((entry) => entry.status)).toEqual(["invalid", "launched"])
    expect(runner.calls.some((call) => call.executable === "/tmp/model-command")).toBe(false)
  })

  it("reports an unready entry and continues with a ready peer", async () => {
    const runner = new BatchRunner((executable, args) =>
      executable.endsWith("/cpx") && args[0] === "inventory" && args[1] === "blocked"
        ? failure("blocked profile")
        : undefined,
    )
    const blocked = createQueuedGuideJob(1, native("cpx", "blocked"), "Blocked prompt")
    const ready = createQueuedGuideJob(2, native("cdx", "ready"), "Ready prompt")
    const outcome = await executeGuideBatch(
      { jobs: [blocked, ready], policy: currentPolicy },
      { runner, write: () => undefined },
    )

    expect(outcome.exitCode).toBe(1)
    expect(outcome.result.entries[0]).toMatchObject({ status: "not-ready", stage: "readiness", job: blocked })
    expect(outcome.result.entries[1]).toMatchObject({ status: "launched", job: ready })
  })

  it("creates one fresh worktree, uses its root pane first, and preserves ordered allocation failures", async () => {
    let failedSplit = false
    const runner = new BatchRunner((executable, args) => {
      if (executable === "herdr" && args[0] === "pane" && args[1] === "split" && !failedSplit) {
        failedSplit = true
        return failure("split refused")
      }
      return undefined
    })
    const jobs = [1, 2, 3].map((id) => createQueuedGuideJob(id, native("cpx", `worker-${id}`), `Prompt ${id}`))
    const outcome = await executeGuideBatch(
      {
        jobs,
        policy: { kind: "fresh-herdr-worktree", primaryCheckoutPath: "/repo", branch: "batch", baseRef: "main" },
      },
      { runner, write: () => undefined },
    )

    expect(outcome.result.workspace).toEqual({ status: "created", workspaceId: "12", checkoutPath: "/repo/.worktrees/batch" })
    expect(outcome.result.entries.map((entry) => entry.status)).toEqual(["launched", "allocation-failed", "launched"])
    expect(runner.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "create")).toHaveLength(1)
  })

  it("reports worktree creation and launch failures with their stage and prompt", async () => {
    const job = createQueuedGuideJob(1, native("cpx", "worker"), "Recovery prompt")
    const creationRunner = new BatchRunner((executable, args) =>
      executable === "herdr" && args[0] === "worktree" ? failure("create refused") : undefined,
    )
    const creationPeer = createQueuedGuideJob(2, native("cdx", "peer"), "Peer recovery prompt")
    const creation = await executeGuideBatch(
      { jobs: [job, creationPeer], policy: { kind: "fresh-herdr-worktree", primaryCheckoutPath: "/repo", branch: "batch", baseRef: "main" } },
      { runner: creationRunner, write: () => undefined },
    )
    expect(creation.result.entries[0]).toMatchObject({ status: "workspace-create-failed", stage: "worktree-create", job })
    expect(creation.result.entries[1]).toMatchObject({ status: "workspace-create-failed", stage: "worktree-create", job: creationPeer })

    const writes: string[] = []
    const peer = createQueuedGuideJob(2, native("cpx", "peer"), "Peer prompt")
    let paneRuns = 0
    const launchRunner = new BatchRunner((executable, args) =>
      executable === "herdr" && args[0] === "pane" && args[1] === "run" && ++paneRuns === 1
        ? failure("launch refused")
        : undefined,
    )
    const launch = await executeGuideBatch({ jobs: [job, peer], policy: currentPolicy }, { runner: launchRunner, write: (text) => writes.push(text) })
    expect(launch.result.entries[0]).toMatchObject({ status: "launch-failed", stage: "launch", job })
    expect(launch.result.entries[1]).toMatchObject({ status: "launched", job: peer })
    expect(writes.join("")).toContain("Recovery prompt")
  })
})
