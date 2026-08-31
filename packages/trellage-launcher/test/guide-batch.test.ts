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
  type JobPlacement,
} from "../src/guide-batch.js"
import { CommandRunnerError, type CommandRunOptions, type CommandRunResult, type CommandRunner, type SelectedProfile } from "../src/guide-launch.js"

class BatchRunner implements CommandRunner {
  readonly calls: Array<{ readonly executable: string; readonly args: ReadonlyArray<string>; readonly options?: CommandRunOptions }> = []
  private split = 0
  private workspace = 11

  constructor(private readonly fail: (executable: string, args: ReadonlyArray<string>) => Error | undefined = () => undefined) {}

  private worktree(name: string): CommandRunResult {
    this.workspace += 1
    return {
      stdout: JSON.stringify({
        result: {
          workspace: { workspace_id: `${this.workspace}` },
          root_pane: { pane_id: `${this.workspace}-1` },
          worktree: { path: `/repo/.worktrees/${name}` },
        },
      }),
      stderr: "",
      exitCode: 0,
    }
  }

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args: [...args], ...(options === undefined ? {} : { options }) })
    const error = this.fail(executable, args)
    if (error !== undefined) throw error
    if (args[0] === "doctor") {
      return {
        stdout: [`profile: ${args[2]} (sandbox)`, "development resolution: true", "image: trellage/sandbox (available)"].join("\n"),
        stderr: "",
        exitCode: 0,
      }
    }
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
    if (args[0] === "worktree" && args[1] === "create") return this.worktree(args[args.indexOf("--branch") + 1] ?? "batch")
    if (args[0] === "worktree" && args[1] === "open") {
      return this.worktree((args[args.indexOf("--path") + 1] ?? "/repo/.worktrees/opened").split("/").at(-1) ?? "opened")
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

const context: GuideBatch["context"] = {
  workspaceId: "9",
  cwd: "/repo",
  callerPaneId: "9-0",
  primaryCheckoutPath: "/repo",
}

const here: JobPlacement = { kind: "current-workspace-pane", direction: "right" }
const fresh = (branch: string): JobPlacement => ({ kind: "new-worktree", branch, baseRef: "main" })

const failure = (message: string): CommandRunnerError =>
  new CommandRunnerError({ kind: "exited", executable: "herdr", args: [], message, exitCode: 1 })

const worktreeCreates = (runner: BatchRunner): ReadonlyArray<string> =>
  runner.calls
    .filter((call) => call.args[0] === "worktree" && call.args[1] === "create")
    .map((call) => call.args[call.args.indexOf("--branch") + 1] ?? "")

describe("guide batch queue", () => {
  it("preserves enqueue order, keeps each placement, and rebuilds prompt delivery per profile", () => {
    let queue = emptyGuideQueue()
    queue = enqueueGuideJob(queue, native("cpx", "council", "claude-council"), "/council First proposal", here)
    queue = enqueueGuideJob(queue, native("cdx", "research"), "Research prior work", fresh("worktree/research"))

    expect(queue.entries.map((job) => job.id)).toEqual([1, 2])
    expect(queue.entries.map((job) => job.placement)).toEqual([here, fresh("worktree/research")])
    expect(queue.entries[0]?.command.args).toEqual(["council", "--agent", "claude-council", "-i", "/council First proposal"])
    expect(queue.entries[1]?.command.args).toEqual(["research", "--", "Research prior work"])
    expect(queue.entries.map((job) => job.promptDelivery)).toEqual(["command", "command"])

    queue = selectQueuedGuideJob(queue, -1)
    queue = startQueuedGuidePromptEdit(queue)
    queue = submitQueuedGuidePromptEdit(queue, "/council Revised proposal")
    expect(queue.entries[0]?.prompt).toBe("/council Revised proposal")
    expect(queue.entries[0]?.command.args.at(-1)).toBe("/council Revised proposal")
    expect(queue.entries[0]?.placement).toEqual(here)

    queue = removeSelectedQueuedGuideJob(queue)
    expect(queue.entries.map((job) => job.id)).toEqual([2])
    expect(queue.selectedIndex).toBe(0)
  })

  it("rejects an empty queue without side effects", async () => {
    const runner = new BatchRunner()
    const writes: string[] = []
    const outcome = await executeGuideBatch({ jobs: [], context }, { runner, write: (text) => writes.push(text) })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.result).toEqual({ entries: [] })
    expect(runner.calls).toEqual([])
    expect(writes).toEqual(["Batch queue is empty.\n"])
  })

  it("launches mixed council and research jobs in queue order in the current workspace", async () => {
    const runner = new BatchRunner()
    const jobs = [
      createQueuedGuideJob(1, sandbox("claude-council"), "/council Compare the designs", here),
      createQueuedGuideJob(2, sandbox("claude-research"), "Research the prior art", here),
    ]
    const outcome = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.result.entries.map((entry) => [entry.job.profile.profile, entry.status])).toEqual([
      ["claude-council", "launched"],
      ["claude-research", "launched"],
    ])
    expect(runner.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "split").map((call) => call.args[3])).toEqual(["9-0", "9-0"])
    expect(runner.calls.some((call) => call.args.includes("/council Compare the designs"))).toBe(true)
    expect(runner.calls.some((call) => call.args.includes("Research the prior art"))).toBe(true)
  })

  it("routes each entry to its own placement in one batch", async () => {
    const runner = new BatchRunner()
    const jobs = [
      createQueuedGuideJob(1, native("cpx", "council"), "Council prompt", here),
      createQueuedGuideJob(2, native("cdx", "research"), "Research prompt", fresh("worktree/research")),
      createQueuedGuideJob(3, native("cpx", "review"), "Review prompt", { kind: "existing-worktree", path: "/repo/.worktrees/review" }),
    ]
    const outcome = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.result.entries.map((entry) => entry.status)).toEqual(["launched", "launched", "launched"])
    expect(outcome.result.entries.map((entry) => (entry.status === "launched" ? entry.cwd : ""))).toEqual([
      "/repo",
      "/repo/.worktrees/worktree/research",
      "/repo/.worktrees/review",
    ])
    expect(outcome.result.entries.map((entry) => (entry.status === "launched" ? entry.workspaceId : ""))).toEqual(["9", "12", "13"])
    expect(runner.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "split")).toHaveLength(1)
    expect(worktreeCreates(runner)).toEqual(["worktree/research"])
    expect(runner.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "open")).toHaveLength(1)
  })

  it("creates one worktree per entry when five profiles fan out", async () => {
    const runner = new BatchRunner()
    const jobs = [1, 2, 3, 4, 5].map((id) =>
      createQueuedGuideJob(id, native("cpx", `worker-${id}`), `Prompt ${id}`, fresh(`worktree/task-${id}`)),
    )
    const outcome = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })

    expect(outcome.exitCode).toBe(0)
    expect(worktreeCreates(runner)).toEqual([
      "worktree/task-1",
      "worktree/task-2",
      "worktree/task-3",
      "worktree/task-4",
      "worktree/task-5",
    ])
    expect(outcome.result.entries.filter((entry) => entry.status === "launched")).toHaveLength(5)
    expect(runner.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "run")).toHaveLength(5)
  })

  it("rejects the second of two entries that would create the same branch", async () => {
    const runner = new BatchRunner()
    const jobs = [
      createQueuedGuideJob(1, native("cpx", "first"), "First prompt", fresh("worktree/shared")),
      createQueuedGuideJob(2, native("cdx", "second"), "Second prompt", fresh("worktree/shared")),
    ]
    const outcome = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.result.entries.map((entry) => entry.status)).toEqual(["launched", "invalid"])
    expect(outcome.result.entries[1]).toMatchObject({ message: "Two queued jobs would both create branch worktree/shared." })
    expect(worktreeCreates(runner)).toEqual(["worktree/shared"])
  })

  it("rejects an entry whose worktree placement is incomplete", async () => {
    const runner = new BatchRunner()
    const jobs = [createQueuedGuideJob(1, native("cpx", "worker"), "Prompt", fresh("   "))]
    const outcome = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })

    expect(outcome.result.entries[0]).toMatchObject({ status: "invalid", message: "Queued worktree branch must not be empty." })
    expect(runner.calls).toEqual([])
  })

  it("reports invalid entries and continues with valid peers", async () => {
    const runner = new BatchRunner()
    const valid = createQueuedGuideJob(2, native("cpx", "worker"), "Keep going", here)
    const invalid = { ...createQueuedGuideJob(1, native("cdx", "reviewer"), "Review", here), command: { executable: "/tmp/model-command", args: [] } }
    const outcome = await executeGuideBatch({ jobs: [invalid, valid], context }, { runner, write: () => undefined })

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
    const blocked = createQueuedGuideJob(1, native("cpx", "blocked"), "Blocked prompt", here)
    const ready = createQueuedGuideJob(2, native("cdx", "ready"), "Ready prompt", here)
    const outcome = await executeGuideBatch({ jobs: [blocked, ready], context }, { runner, write: () => undefined })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.result.entries[0]).toMatchObject({ status: "not-ready", stage: "readiness", job: blocked })
    expect(outcome.result.entries[1]).toMatchObject({ status: "launched", job: ready })
  })

  it("keeps an allocation failure on its own entry and in queue order", async () => {
    let failedSplit = false
    const runner = new BatchRunner((executable, args) => {
      if (executable === "herdr" && args[0] === "pane" && args[1] === "split" && !failedSplit) {
        failedSplit = true
        return failure("split refused")
      }
      return undefined
    })
    const jobs = [1, 2, 3].map((id) => createQueuedGuideJob(id, native("cpx", `worker-${id}`), `Prompt ${id}`, here))
    const outcome = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })

    expect(outcome.result.entries.map((entry) => entry.status)).toEqual(["allocation-failed", "launched", "launched"])
    expect(outcome.result.entries[0]).toMatchObject({ stage: "pane-allocation" })
  })

  it("reports worktree creation and launch failures with their stage and prompt", async () => {
    const job = createQueuedGuideJob(1, native("cpx", "worker"), "Recovery prompt", fresh("worktree/recovery"))
    const creationRunner = new BatchRunner((executable, args) =>
      executable === "herdr" && args[0] === "worktree" ? failure("create refused") : undefined,
    )
    const creationPeer = createQueuedGuideJob(2, native("cdx", "peer"), "Peer recovery prompt", fresh("worktree/peer"))
    const creation = await executeGuideBatch({ jobs: [job, creationPeer], context }, { runner: creationRunner, write: () => undefined })
    expect(creation.result.entries[0]).toMatchObject({ status: "workspace-create-failed", stage: "worktree-create", job })
    expect(creation.result.entries[1]).toMatchObject({ status: "workspace-create-failed", stage: "worktree-create", job: creationPeer })

    const writes: string[] = []
    const launchJob = createQueuedGuideJob(1, native("cpx", "worker"), "Recovery prompt", here)
    const peer = createQueuedGuideJob(2, native("cpx", "peer"), "Peer prompt", here)
    let paneRuns = 0
    const launchRunner = new BatchRunner((executable, args) =>
      executable === "herdr" && args[0] === "pane" && args[1] === "run" && ++paneRuns === 1
        ? failure("launch refused")
        : undefined,
    )
    const launch = await executeGuideBatch({ jobs: [launchJob, peer], context }, { runner: launchRunner, write: (text) => writes.push(text) })
    expect(launch.result.entries[0]).toMatchObject({ status: "launch-failed", stage: "launch", job: launchJob })
    expect(launch.result.entries[1]).toMatchObject({ status: "launched", job: peer })
    expect(writes.join("")).toContain("Recovery prompt")
  })
})
