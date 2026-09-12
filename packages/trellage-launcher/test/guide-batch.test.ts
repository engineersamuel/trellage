import { describe, expect, it } from "vitest"
import { createPrivateContinuationJob } from "../src/continuation-launch.ts"

import {
  createQueuedGuideJob,
  describeJobPlacement,
  emptyGuideQueue,
  enqueueGuideJob,
  replaceQueuedGuideJob,
  findGuideQueueConflict,
  GuideQueueConflictError,
  reservedWorktreeBranches,
  removeQueuedGuideJobById,
  executeGuideBatch,
  removeSelectedQueuedGuideJob,
  replaceQueuedGuideJobPrompt,
  selectQueuedGuideJob,
  startQueuedGuidePromptEdit,
  submitQueuedGuidePromptEdit,
  type GuideBatch,
  type JobPlacement,
} from "../src/guide-batch.ts"
import {
  CommandRunnerError,
  type CommandRunOptions,
  type CommandRunResult,
  type CommandRunner,
  type SelectedProfile,
} from "../src/guide-launch.ts"
import { goalTransportFixture } from "./fixtures/goal-transport.ts"
import { ProfileReadinessKind } from "../src/guide-preflight.ts"
import { guideGoalActivationInput } from "../src/guide-goal-execution.ts"

describe("queued worktree reservations", () => {
  it("releases removed reservations and permits explicit existing-worktree reuse", () => {
    const profile = native("cpx", "hve")
    const placement = { kind: "new-worktree", branch: " branch ", baseRef: "HEAD" } as const
    const queue = enqueueGuideJob(emptyGuideQueue(), profile, "first", placement)
    expect(reservedWorktreeBranches(queue)).toEqual(["branch"])
    expect(reservedWorktreeBranches(queue, 1)).toEqual([])
    const conflict = findGuideQueueConflict(queue, "branch")
    expect(conflict).toBeInstanceOf(GuideQueueConflictError)
    expect(conflict?.job.id).toBe(1)
    expect(conflict?.branch).toBe("branch")
    const existing = { kind: "existing-worktree", path: "/repo/branch" } as const
    const reused = enqueueGuideJob(enqueueGuideJob(queue, profile, "two", existing), profile, "three", existing)
    expect(reused.entries).toHaveLength(3)
    expect(reservedWorktreeBranches(removeQueuedGuideJobById(reused, 1))).toEqual([])
    expect(findGuideQueueConflict(queue, "branch", 1)).toBeUndefined()
  })
  it("rejects trimmed duplicates without consuming IDs and permits self replacement", () => {
    const profile = native("cpx", "hve")
    const placement = { kind: "new-worktree", branch: "wt/cpx-hve-review", baseRef: "HEAD" } as const
    const queue = enqueueGuideJob(emptyGuideQueue(), profile, "first", placement)
    expect(() =>
      enqueueGuideJob(queue, native("cdx", "default"), "second", {
        ...placement,
        branch: ` ${placement.branch} `,
        baseRef: "main",
      }),
    ).toThrow("already queued by job 1 (cpx hve)")
    expect(queue.nextId).toBe(2)
    const two = enqueueGuideJob(queue, profile, "second", { ...placement, branch: "other" })
    expect(() => replaceQueuedGuideJob(two, 2, profile, "changed", placement)).toThrow("already queued")
    const replaced = replaceQueuedGuideJob(two, 1, profile, "changed", placement)
    expect(replaced.entries.map((job) => job.id)).toEqual([1, 2])
    expect(replaced.nextId).toBe(3)
    expect(replaced.entries[0]?.prompt).toBe("changed")
    const released = replaceQueuedGuideJob(two, 1, profile, "first", { kind: "new-tab" })
    expect(enqueueGuideJob(released, profile, "third", placement).entries).toHaveLength(3)
  })
})

class BatchRunner implements CommandRunner {
  readonly calls: Array<{
    readonly executable: string
    readonly args: ReadonlyArray<string>
    readonly options?: CommandRunOptions
  }> = []
  private split = 0
  private workspace = 11

  constructor(
    private readonly fail: (executable: string, args: ReadonlyArray<string>) => Error | undefined = () => undefined,
  ) {}

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

  private launcherResponse(executable: string, args: ReadonlyArray<string>): CommandRunResult | undefined {
    if (args[0] === "doctor") {
      return {
        stdout: [
          `profile: ${args[2]} (sandbox)`,
          "development resolution: true",
          "image: trellage/sandbox (available)",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "inventory") {
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          launcher: executable.split("/").at(-1),
          profile: args[1],
          readiness: "healthy",
        }),
        stderr: "",
        exitCode: 0,
      }
    }
    return undefined
  }

  private herdrResponse(args: ReadonlyArray<string>): CommandRunResult | undefined {
    if (args[0] === "pane" && args[1] === "split") {
      this.split += 1
      return {
        stdout: JSON.stringify({ result: { pane: { pane_id: `9-${this.split}` } } }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "tab" && args[1] === "create") {
      this.split += 1
      return {
        stdout: JSON.stringify({ result: { root_pane: { pane_id: `9-t${this.split}` } } }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "worktree" && args[1] === "create")
      return this.worktree(args[args.indexOf("--branch") + 1] ?? "batch")
    if (args[0] === "worktree" && args[1] === "open") {
      return this.worktree(
        (args[args.indexOf("--path") + 1] ?? "/repo/.worktrees/opened").split("/").at(-1) ?? "opened",
      )
    }
    if (args[0] === "agent" && args[1] === "get") {
      return {
        stdout: JSON.stringify({ result: { agent: { agent_status: "idle" } } }),
        stderr: "",
        exitCode: 0,
      }
    }
    return undefined
  }

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args: [...args], ...(options === undefined ? {} : { options }) })
    const error = this.fail(executable, args)
    if (error !== undefined) throw error
    const response = this.launcherResponse(executable, args) ?? this.herdrResponse(args)
    if (response !== undefined) return response
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
const newTab: JobPlacement = { kind: "new-tab" }

const failure = (message: string): CommandRunnerError =>
  new CommandRunnerError({ kind: "exited", executable: "herdr", args: [], message, exitCode: 1 })

const worktreeCreates = (runner: BatchRunner): ReadonlyArray<string> =>
  runner.calls
    .filter((call) => call.args[0] === "worktree" && call.args[1] === "create")
    .map((call) => call.args[call.args.indexOf("--branch") + 1] ?? "")

describe("guide batch queue", () => {
  it("requires an explicit private launcher and records allocation before prompt submission", async () => {
    const job = createPrivateContinuationJob(1, native("cpx", "default"), "Synthetic private prompt", here)
    const rejectedRunner = new BatchRunner()
    const rejected = await executeGuideBatch(
      { jobs: [job], context },
      { runner: rejectedRunner, write: () => undefined },
    )
    expect(rejected.result.entries[0]?.status).toBe("invalid")
    expect(rejectedRunner.calls).toEqual([])

    const events: string[] = []
    const result = await executeGuideBatch(
      { jobs: [job], context },
      {
        runner: new BatchRunner(),
        write: () => undefined,
        onAllocated: async (_, destination) => {
          events.push(`allocated:${destination.paneId}`)
        },
        launchPrivate: async (_, options) => {
          expect(options.command.args).toEqual(["default"])
          events.push(`submit:${options.paneId}`)
          return { paneId: options.paneId, commandPreview: "cpx default" }
        },
        onResult: async (entry) => {
          events.push(entry.status)
        },
      },
    )
    expect(events).toEqual(["allocated:9-1", "submit:9-1", "launched"])
    expect(result.exitCode).toBe(0)
  })

  it("does not submit a prompt if recording its allocated destination fails", async () => {
    let submissions = 0
    const job = createPrivateContinuationJob(1, native("cpx", "default"), "Synthetic task", here)
    const result = await executeGuideBatch(
      { jobs: [job], context },
      {
        runner: new BatchRunner(),
        write: () => undefined,
        onAllocated: async () => {
          throw new Error("Private store unavailable")
        },
        launchPrivate: async (_, options) => {
          submissions += 1
          return { paneId: options.paneId, commandPreview: "" }
        },
      },
    )
    expect(submissions).toBe(0)
    expect(result.result.entries[0]?.status).toBe("allocation-failed")
  })

  it.each(["codex-goal", "claude-goal"] as const)(
    "rejects private delivery that would bypass the %s transport",
    async (controller) => {
      const { profile, candidate } = goalTransportFixture(controller)
      const job = {
        ...createPrivateContinuationJob(1, profile, candidate.prompt, here),
        goalExecution: candidate.goalExecution,
      }
      const runner = new BatchRunner()
      let submissions = 0
      const outcome = await executeGuideBatch(
        { jobs: [job], context },
        {
          runner,
          write: () => undefined,
          launchPrivate: async (_, options) => {
            submissions += 1
            return { paneId: options.paneId, commandPreview: "" }
          },
        },
      )
      expect(outcome.exitCode).toBe(1)
      expect(outcome.result.entries[0]).toMatchObject({
        status: "invalid",
        message: "Private prompt delivery does not support goal execution.",
      })
      expect(submissions).toBe(0)
      expect(runner.calls).toEqual([])
    },
  )

  it("freezes each goal, workflow, profile, and destination and edits only its stored approach", () => {
    const { profile, candidate } = goalTransportFixture()
    const sourceProfile = { ...profile }
    const sourcePlacement = { ...here }
    const source = {
      ...candidate.goalExecution,
      workflow: { ...candidate.goalExecution.workflow, examples: [...candidate.goalExecution.workflow.examples] },
      goal: {
        ...candidate.goalExecution.goal,
        draft: { ...candidate.goalExecution.goal.draft, criteria: [...candidate.goalExecution.goal.draft.criteria] },
      },
    }
    const job = createQueuedGuideJob(1, sourceProfile, candidate.prompt, sourcePlacement, source)
    source.goal.draft.criteria[0] = "Changed after queueing."
    source.workflow.examples[0] = "Changed workflow."
    sourceProfile.profile = "another-profile"
    sourcePlacement.direction = "down"
    expect(job.profile.profile).toBe("superpowers")
    expect(job.placement).toEqual(here)
    expect(job.goalExecution?.goal.draft.criteria).toEqual(candidate.goalExecution.goal.draft.criteria)
    expect(Object.isFrozen(job.goalExecution?.goal.draft.criteria)).toBe(true)
    expect(Object.isFrozen(job.goalExecution?.workflow.examples)).toBe(true)
    expect(Object.isFrozen(job.command.args)).toBe(true)
    const edited = replaceQueuedGuideJobPrompt(job, "Begin with a focused regression case.")
    expect(edited.goalExecution?.goal.fingerprint).toBe(job.goalExecution?.goal.fingerprint)
    expect(edited.goalExecution?.approach).toBe("Begin with a focused regression case.")
    expect(edited.prompt).toContain("Begin with a focused regression case.")
    expect(edited.prompt).not.toContain(candidate.goalExecution.approach)
    expect(edited.command.args).toEqual(["superpowers"])
    expect(edited.promptDelivery).toBe("manual")
    expect(() => replaceQueuedGuideJobPrompt(job, "/goal-me Start a different interview")).toThrow(/another goal controller/u)
  })

  it("keeps complete Unicode goals above 8000 characters and reports manual jobs as needs-input", async () => {
    const { profile, candidate, execution } = goalTransportFixture("codex-goal", { task: `Complete this evidence:\n${"\u{1f333}".repeat(20_000)}` })
    const queue = enqueueGuideJob(emptyGuideQueue(), profile, candidate.prompt, here, candidate.goalExecution)
    const runner = new BatchRunner()
    const writes: string[] = []
    const progress: string[] = []
    const result = await executeGuideBatch({ jobs: queue.entries, context }, {
      runner,
      write: (value) => writes.push(value),
      onProgress: (event) => progress.push(event.phase),
      checkReadiness: async () => ({ kind: ProfileReadinessKind.Ready, summary: "Fixture runtime checked." }),
    })
    expect(Buffer.byteLength(candidate.prompt, "utf8")).toBeGreaterThan(64 * 1024)
    expect(result.exitCode).toBe(2)
    expect(result.result.entries[0]).toMatchObject({
      status: "needs-input", paneId: "9-1", cwd: "/repo", workspaceId: "9", job: queue.entries[0],
    })
    expect(progress.at(-1)).toBe("needs-input")
    expect(queue.entries[0]?.goalExecution?.goal.prompt).toBe(candidate.goalExecution.goal.prompt)
    expect(runner.calls.some(({ args }) => args[0] === "agent")).toBe(false)
    expect(runner.calls.find(({ args }) => args[0] === "pane" && args[1] === "run")?.args[3]).toBe(
      "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/cdx superpowers",
    )
    expect(writes.join("")).toContain("needs-input in pane 9-1")
    expect(writes.join("")).toContain("Type '/goal '")
    expect(writes.join("")).toContain(guideGoalActivationInput(execution, candidate.prompt).body)
  })

  it.each([false, true])("records mixed private and manual goal results with failure=%s", async (withFailure) => {
    const codex = goalTransportFixture("codex-goal")
    const claude = goalTransportFixture("claude-goal")
    const jobs = [
      createPrivateContinuationJob(1, native("cpx", "default"), "Synthetic private prompt", here),
      createQueuedGuideJob(2, codex.profile, codex.candidate.prompt, here, codex.candidate.goalExecution),
      createQueuedGuideJob(
        3,
        { ...claude.profile, headlessPrompt: false },
        claude.candidate.prompt,
        here,
        claude.candidate.goalExecution,
      ),
    ]
    if (withFailure) jobs.push(createQueuedGuideJob(4, native("cpx", "blocked"), "Blocked prompt", here))
    const runner = new BatchRunner()
    const allocated: number[] = []
    const submissions: string[] = []
    const results: string[] = []
    const outcome = await executeGuideBatch(
      { jobs, context },
      {
        runner,
        write: () => undefined,
        checkReadiness: async (_, profile) => profile.profile === "blocked"
          ? { kind: ProfileReadinessKind.Blocked, summary: "Profile blocked", diagnostic: "Fixture readiness failure." }
          : { kind: ProfileReadinessKind.Ready, summary: "Fixture runtime checked." },
        onAllocated: async (job) => {
          allocated.push(job.id)
        },
        launchPrivate: async (_, options) => {
          expect(allocated).toEqual([1, 2, 3])
          submissions.push(options.paneId)
          return { paneId: options.paneId, commandPreview: "cpx default" }
        },
        onResult: async (entry) => {
          results.push(`${entry.job.id}:${entry.status}`)
        },
      },
    )
    expect(outcome.exitCode).toBe(withFailure ? 1 : 2)
    expect(allocated).toEqual([1, 2, 3])
    expect(submissions).toEqual(["9-1"])
    expect(results).toEqual([
      "1:launched",
      "2:needs-input",
      "3:needs-input",
      ...(withFailure ? ["4:not-ready"] : []),
    ])
    expect(
      runner.calls.filter(({ args }) => args[0] === "pane" && args[1] === "run").map(({ args }) => args[3]),
    ).toEqual([
      "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/cdx superpowers",
      "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/cldx default",
    ])
    expect(runner.calls.some(({ args }) => args[0] === "agent")).toBe(false)
  })

  it("rejects goal prompt, command, controller, and objective tampering before allocation", async () => {
    const { profile, candidate } = goalTransportFixture()
    const source = createQueuedGuideJob(1, profile, candidate.prompt, here, candidate.goalExecution)
    const jobs = [
      { ...source, prompt: "Only an approach." },
      { ...source, command: { ...source.command, args: [...source.command.args, source.prompt] } },
      { ...source, profile: { ...profile, launcher: "cpx", commandPath: "/opt/trellage/bin/cpx" } },
      { ...source, goalExecution: { ...candidate.goalExecution, approach: "An unapproved edit." } },
      { ...source, goalExecution: {
        ...candidate.goalExecution,
        goal: { ...candidate.goalExecution.goal, draft: { ...candidate.goalExecution.goal.draft, task: "A different task." } },
      } },
      { ...source, prompt: "x".repeat(96_001) },
    ].map((job, index) => ({ ...job, id: index + 1 }))
    const runner = new BatchRunner()
    const result = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })
    expect(result.result.entries.map(({ status }) => status)).toEqual(jobs.map(() => "invalid"))
    expect(runner.calls).toEqual([])
  })

  it("keeps the ordinary 8000-character queue limit without applying it to the frozen goal body", async () => {
    const runner = new BatchRunner()
    const job = createQueuedGuideJob(1, native("cdx", "reviewer"), "x".repeat(8001), here)
    const result = await executeGuideBatch({ jobs: [job], context }, { runner, write: () => undefined })
    expect(result.result.entries[0]).toMatchObject({ status: "invalid", message: "Queued prompt exceeds 8000 characters." })
    expect(runner.calls).toEqual([])
    const atLimit = createQueuedGuideJob(2, native("cdx", "reviewer"), "x".repeat(8000), here)
    const valid = await executeGuideBatch({ jobs: [atLimit], context }, { runner: new BatchRunner(), write: () => undefined })
    expect(valid.result.entries[0]).toMatchObject({ status: "launched", job: atLimit })
  })

  it("checks goal readiness at the actual allocated worktree and preserves blocked recovery there", async () => {
    const { profile, candidate } = goalTransportFixture("claude-goal")
    const runner = new BatchRunner()
    const writes: string[] = []
    const directories: string[] = []
    const job = createQueuedGuideJob(1, profile, candidate.prompt, fresh("goal-work"), candidate.goalExecution)
    const result = await executeGuideBatch({ jobs: [job], context }, {
      runner, write: (value) => writes.push(value),
      checkReadiness: async (_runner, _profile, cwd) => {
        directories.push(cwd)
        return cwd === "/repo"
          ? { kind: ProfileReadinessKind.Ready, summary: "Original workspace trusted." }
          : { kind: ProfileReadinessKind.Blocked, summary: "Goal activation is blocked", diagnostic: "New workspace trust is missing." }
      },
    })
    expect(directories).toEqual(["/repo", "/repo/.worktrees/goal-work"])
    expect(result.result.entries[0]).toMatchObject({
      status: "not-ready", stage: "readiness", paneId: "12-1",
      workspaceId: "12", cwd: "/repo/.worktrees/goal-work",
    })
    expect(runner.calls.some(({ args }) => args[0] === "pane" && args[1] === "run")).toBe(false)
    expect(writes.join("")).toContain("Resolve the error before native input.")
    expect(writes.join("")).toContain("Type '/goal '")
    expect(writes.join("")).toContain("/repo/.worktrees/goal-work")
  })

  it("preserves enqueue order, keeps each placement, and rebuilds prompt delivery per profile", () => {
    let queue = emptyGuideQueue()
    queue = enqueueGuideJob(queue, native("cpx", "council", "claude-council"), "/council First proposal", here)
    queue = enqueueGuideJob(queue, native("cdx", "research"), "Research prior work", fresh("worktree/research"))

    expect(queue.entries.map((job) => job.id)).toEqual([1, 2])
    expect(queue.entries.map((job) => job.placement)).toEqual([here, fresh("worktree/research")])
    expect(queue.entries[0]?.command.args).toEqual([
      "council",
      "--agent",
      "claude-council",
      "-i",
      "/council First proposal",
    ])
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

  it("creates one unfocused tab per queued new-tab entry and runs it there", async () => {
    const runner = new BatchRunner()
    const jobs = [
      createQueuedGuideJob(1, sandbox("claude-council"), "/council Compare the designs", newTab),
      createQueuedGuideJob(2, sandbox("claude-research"), "Research the prior art", newTab),
    ]
    const outcome = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.result.entries.map((entry) => entry.status)).toEqual(["launched", "launched"])
    expect(runner.calls.filter((call) => call.args[0] === "tab").map((call) => call.args)).toEqual([
      ["tab", "create", "--workspace", "9", "--cwd", "/repo", "--no-focus"],
      ["tab", "create", "--workspace", "9", "--cwd", "/repo", "--no-focus"],
    ])
    expect(
      runner.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "run").map((call) => call.args[2]),
    ).toEqual(["9-t1", "9-t2"])
  })

  it("names a queued new tab on the review screen", () => {
    expect(describeJobPlacement(newTab)).toBe("new tab in this Herdr worktree")
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
    expect(
      runner.calls.filter((call) => call.args[0] === "pane" && call.args[1] === "split").map((call) => call.args[3]),
    ).toEqual(["9-0", "9-0"])
    const runCommands = runner.calls
      .filter((call) => call.args[0] === "pane" && call.args[1] === "run")
      .map((call) => call.args[3] ?? "")
    expect(runCommands.some((command) => command.includes("/council Compare the designs"))).toBe(true)
    expect(runCommands.some((command) => command.includes("Research the prior art"))).toBe(true)
    expect(runner.calls.some((call) => call.args[0] === "agent" && call.args[1] === "prompt")).toBe(false)
  })

  it.each(["plain", "goal"] as const)("keeps existing-worktree readiness scoped to %s jobs", async (mode) => {
    const { profile, candidate } = goalTransportFixture()
    const placement: JobPlacement = { kind: "existing-worktree", path: "/repo/.worktrees/review" }
    const goalExecution = mode === "goal" ? candidate.goalExecution : undefined
    const prompt = mode === "goal" ? candidate.prompt : "Review the changes."
    const job = createQueuedGuideJob(1, profile, prompt, placement, goalExecution)
    const expectedCwd = mode === "goal" ? placement.path : context.cwd
    const checkedDirectories: string[] = []
    const runner = new BatchRunner()
    const outcome = await executeGuideBatch({ jobs: [job], context }, {
      runner,
      write: () => undefined,
      checkReadiness: async (_runner, _profile, cwd) => {
        checkedDirectories.push(cwd)
        return cwd === expectedCwd
          ? { kind: ProfileReadinessKind.Ready, summary: "Selected checkout is ready." }
          : { kind: ProfileReadinessKind.Blocked, summary: "Unexpected readiness checkout", diagnostic: `Expected ${expectedCwd}.` }
      },
    })
    expect(outcome.exitCode).toBe(mode === "goal" ? 2 : 0)
    expect(checkedDirectories).toEqual(mode === "goal" ? [placement.path, placement.path] : [context.cwd])
    expect(outcome.result.entries[0]).toMatchObject({
      status: mode === "goal" ? "needs-input" : "launched",
      cwd: placement.path,
    })
    expect(runner.calls.find(({ args }) => args[0] === "pane" && args[1] === "run")?.options?.cwd).toBe(placement.path)
  })

  it("routes each entry to its own placement in one batch", async () => {
    const runner = new BatchRunner()
    const jobs = [
      createQueuedGuideJob(1, native("cpx", "council"), "Council prompt", here),
      createQueuedGuideJob(2, native("cdx", "research"), "Research prompt", fresh("worktree/research")),
      createQueuedGuideJob(3, native("cpx", "review"), "Review prompt", {
        kind: "existing-worktree",
        path: "/repo/.worktrees/review",
      }),
    ]
    const outcome = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.result.entries.map((entry) => entry.status)).toEqual(["launched", "launched", "launched"])
    expect(outcome.result.entries.map((entry) => (entry.status === "launched" ? entry.cwd : ""))).toEqual([
      "/repo",
      "/repo/.worktrees/worktree/research",
      "/repo/.worktrees/review",
    ])
    expect(outcome.result.entries.map((entry) => (entry.status === "launched" ? entry.workspaceId : ""))).toEqual([
      "9",
      "12",
      "13",
    ])
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
    expect(outcome.result.entries[1]).toMatchObject({
      message: "Two queued jobs would both create branch worktree/shared.",
    })
    expect(worktreeCreates(runner)).toEqual(["worktree/shared"])
  })

  it("rejects an entry whose worktree placement is incomplete", async () => {
    const runner = new BatchRunner()
    const jobs = [createQueuedGuideJob(1, native("cpx", "worker"), "Prompt", fresh("   "))]
    const outcome = await executeGuideBatch({ jobs, context }, { runner, write: () => undefined })

    expect(outcome.result.entries[0]).toMatchObject({
      status: "invalid",
      message: "Queued worktree branch must not be empty.",
    })
    expect(runner.calls).toEqual([])
  })

  it("reports invalid entries and continues with valid peers", async () => {
    const runner = new BatchRunner()
    const valid = createQueuedGuideJob(2, native("cpx", "worker"), "Keep going", here)
    const invalid = {
      ...createQueuedGuideJob(1, native("cdx", "reviewer"), "Review", here),
      command: { executable: "/tmp/model-command", args: [] },
    }
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
    expect(outcome.result.entries[0]).toMatchObject({
      status: "not-ready",
      stage: "readiness",
      job: blocked,
    })
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
    const creation = await executeGuideBatch(
      { jobs: [job, creationPeer], context },
      { runner: creationRunner, write: () => undefined },
    )
    expect(creation.result.entries[0]).toMatchObject({
      status: "workspace-create-failed",
      stage: "worktree-create",
      job,
    })
    expect(creation.result.entries[1]).toMatchObject({
      status: "workspace-create-failed",
      stage: "worktree-create",
      job: creationPeer,
    })

    const writes: string[] = []
    const launchJob = createQueuedGuideJob(1, native("cpx", "worker"), "Recovery prompt", here)
    const peer = createQueuedGuideJob(2, native("cpx", "peer"), "Peer prompt", here)
    let paneRuns = 0
    const launchRunner = new BatchRunner((executable, args) =>
      executable === "herdr" && args[0] === "pane" && args[1] === "run" && ++paneRuns === 1
        ? failure("launch refused")
        : undefined,
    )
    const launch = await executeGuideBatch(
      { jobs: [launchJob, peer], context },
      { runner: launchRunner, write: (text) => writes.push(text) },
    )
    expect(launch.result.entries[0]).toMatchObject({
      status: "launch-failed",
      stage: "launch",
      job: launchJob,
    })
    expect(launch.result.entries[1]).toMatchObject({ status: "launched", job: peer })
    expect(writes.join("")).toContain("Recovery prompt")
  })
})
