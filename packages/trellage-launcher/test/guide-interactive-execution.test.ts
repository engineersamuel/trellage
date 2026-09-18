import { describe, expect, it, vi } from "vitest"
import { executeGuideUiResult, type GuideInteractiveExecutionServices } from "../src/guide-interactive-execution.ts"
import {
  buildCancelResult,
  buildCurrentHerdrWorkspaceResult,
  buildCurrentTerminalResult,
  buildExistingHerdrWorktreeResult,
  buildNewHerdrWorktreeResult,
  buildNewHerdrTabResult,
  buildPrintResult,
  type GuideUiResult,
} from "../src/guide-ui.tsx"
import { CommandRunnerError } from "../src/guide-launch.ts"
import { goalTransportFixture } from "./fixtures/goal-transport.ts"
import { guideGoalActivationInput } from "../src/guide-goal-execution.ts"
import { ProfileReadinessKind } from "../src/guide-preflight.ts"
import { selectedProfileFromCatalogRef } from "../src/guide-api.ts"
import { completeSinglePromptArtifact, prepareGuidePrompt, type GuideLegacyFirstmateContext } from "../src/guide-context.ts"
import { renderWorkflowBodyCandidate } from "../src/guide-workflow-prompt.ts"
import {
  firstmateGuide, firstmateOriginalIntent, firstmateProjectC, legacyFirstmateCatalog,
} from "./helpers/continuation-firstmate-fixtures.ts"
import { createFirstmateQueuedSubmission, createQueuedGuideJob, type GuideBatchEntryResult } from "../src/guide-batch.ts"
import {
  firstmateSubmissionDigest,
  parseFirstmateOrchestrationV1,
  parseFirstmateSubmissionReceiptV1,
  parseFirstmateSubmissionRequestV1,
  type FirstmateSubmissionReceiptV1,
} from "@trellage/guide-core"
import type {
  CommandRunOptions,
  CommandRunResult,
  CommandRunner,
  CommandSpec,
  SelectedProfile,
} from "../src/guide-launch.ts"

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{
    readonly executable: string
    readonly args: ReadonlyArray<string>
    readonly options?: CommandRunOptions
  }> = []

  constructor(private readonly responses: ReadonlyArray<CommandRunResult | Error> = []) {}

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args, ...(options === undefined ? {} : { options }) })
    const response = this.responses[this.calls.length - 1]
    if (response instanceof Error) throw response
    return response ?? { stdout: "", stderr: "", exitCode: 0 }
  }
}

const command: CommandSpec = {
  executable: "/opt/trellage/bin/cpx",
  args: ["hve-core"],
}
const profile = (headlessPrompt: boolean): SelectedProfile => ({
  surface: "native",
  launcher: "cpx",
  commandPath: command.executable,
  profile: "hve-core",
  headlessPrompt,
})
// jcode is the one harness with no argv prompt at all, so jcx is the only
// launcher still on Herdr's paste path.
const agentPromptProfile: SelectedProfile = {
  surface: "native",
  launcher: "jcx",
  commandPath: "/opt/trellage/bin/jcx",
  profile: "reviewer",
  headlessPrompt: false,
}

const services = (
  runner: CommandRunner,
  writes: string[],
  runInteractive: NonNullable<GuideInteractiveExecutionServices["runInteractive"]> = vi.fn(async () => undefined),
): GuideInteractiveExecutionServices => ({
  runner,
  write: (text) => writes.push(text),
  runInteractive,
})

const firstmateFixture = (name: "default" | "pstack-workers") => {
  const selected: SelectedProfile = {
    surface: "native", launcher: "fmx", commandPath: "/fixture/fmx", profile: name, headlessPrompt: false,
    orchestration: parseFirstmateOrchestrationV1({
      schemaVersion: 1, kind: "firstmate", sourceRevision: "b".repeat(40),
      taskIdPrefix: name === "default" ? "fmd" : "fmp",
      workerPolicy: name === "default" ? null : { name: "pstack-workers", digest: "c".repeat(64) },
      workerHarness: "claude", workerEfforts: ["low", "medium", "high"], dispatchRules: "claude-single",
      submission: { schemaVersion: 1, maxRequestBytes: 512 * 1024 },
    }),
  }
  const job = createQueuedGuideJob(1, selected, "Inspect the fleet. Do not start implementation workers.", { kind: "existing-fleet" }, {
    originalIntent: "  Show the pending fleet decisions.\r\nDo not start workers.  ",
    workflowId: "fleet-status", projectTarget: null,
    workflow: {
      id: "fleet-status", description: "Inspect fleet status.", scope: "fleet", frame: "fixed",
      promptTemplate: "Inspect the fleet.\n{{intent}}\nDo not start workers.", examples: ["Show status", "Read decisions"],
    },
  }, createFirstmateQueuedSubmission("submit"))
  const request = parseFirstmateSubmissionRequestV1({
    schemaVersion: 1, requestId: job.firstmate!.requestId,
    expectedFleet: {
      profile: name, instanceId: "e151a493-9ddb-42bd-a674-0b20d3a56e15",
      home: "/fixture/private-owned-fleet", sourceRevision: "b".repeat(40),
    },
    originalIntent: job.guideContext!.originalIntent, generatedSpec: job.prompt,
    workflowId: "fleet-status", projectTarget: null,
  })
  const receipt = (overrides: Partial<FirstmateSubmissionReceiptV1> = {}) => parseFirstmateSubmissionReceiptV1({
    schemaVersion: 1, requestId: request.requestId, digest: firstmateSubmissionDigest(request),
    fleet: request.expectedFleet, state: "saved", noteId: "captain-note-17",
    announcement: "sent", supervisorState: "running", error: null, ...overrides,
  })
  return { selected, job, request, receipt }
}

const legacyFixture = (name: "default" | "pstack-workers") => {
  const profileRef = `native:fmx/${name}`
  const profile = selectedProfileFromCatalogRef(legacyFirstmateCatalog(), profileRef, "review-project")
  const prepared = prepareGuidePrompt(firstmateGuide, "review-project", profileRef, "Review the change.", {
    originalIntent: firstmateOriginalIntent, projectTarget: firstmateProjectC(),
  })
  const context: GuideLegacyFirstmateContext = {
    originalIntent: firstmateOriginalIntent, projectTarget: firstmateProjectC(), projectTargetConfirmed: true,
    workflowId: "review-project", workflow: prepared.workflow,
  }
  const prompt = completeSinglePromptArtifact(prepared.workflow, renderWorkflowBodyCandidate(prepared.workflow, {
    title: "Review boundaries", prompt: "Review committed error boundaries.", notes: "Focused review.",
  }), prepared.context).prompt
  return { profile, context, prompt }
}

const legacyInventory = (profile: string, readiness = "healthy"): CommandRunResult => ({
  exitCode: 0, stderr: "", stdout: JSON.stringify({ schemaVersion: 1, launcher: "fmx", profile, readiness }),
})

describe("interactive guide result execution", () => {
  it("prints exact native command-prefix and body recovery without launching a goal", async () => {
    const { candidate, execution } = goalTransportFixture()
    const runner = new RecordingRunner()
    const writes: string[] = []
    await expect(executeGuideUiResult(
      buildPrintResult(candidate.prompt, candidate.goalExecution), services(runner, writes),
    )).resolves.toBe(0)
    expect(writes.join("")).toContain("Selected goal (not launched)")
    expect(writes.join("")).toContain("Type '/goal '")
    expect(writes.join("")).toContain(guideGoalActivationInput(execution, candidate.prompt).body)
    expect(writes.join("")).not.toContain(candidate.prompt)
    expect(runner.calls).toEqual([])
  })

  it("starts Codex without a positional goal and gives native-input instructions before startup", async () => {
    const { profile: selected, candidate } = goalTransportFixture()
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => {
      expect(writes.join("")).toContain("Type '/goal '")
      return undefined
    })
    await expect(executeGuideUiResult(
      buildCurrentTerminalResult(selected, candidate.prompt, "/repo", candidate.goalExecution),
      {
        ...services(runner, writes, runInteractive),
        checkReadiness: async () => ({ kind: ProfileReadinessKind.Ready, summary: "Fixture runtime checked." }),
      },
    )).resolves.toBe(0)
    expect(runInteractive).toHaveBeenCalledWith(
      { executable: selected.commandPath, args: ["superpowers"] },
      { cwd: "/repo", env: expect.objectContaining({ TRELLAGE_AUTOMATION: "1" }) },
    )
    expect(writes.join("")).toContain("Startup does not activate it.")
    expect(runner.calls).toEqual([])
  })

  it("uses Claude's documented print goal dispatch without adding manual instructions", async () => {
    const { profile: selected, candidate } = goalTransportFixture("claude-goal")
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    await expect(executeGuideUiResult(
      buildCurrentTerminalResult(selected, candidate.prompt, "/repo", candidate.goalExecution),
      {
        ...services(runner, writes, runInteractive),
        checkReadiness: async () => ({ kind: ProfileReadinessKind.Ready, summary: "Fixture runtime checked." }),
      },
    )).resolves.toBe(0)
    expect(runInteractive).toHaveBeenCalledWith(
      { executable: selected.commandPath, args: ["default", "-p", candidate.prompt] },
      { cwd: "/repo", env: expect.objectContaining({ TRELLAGE_AUTOMATION: "1" }) },
    )
    expect(writes).toEqual([])
  })

  it("leaves native Claude Herdr interactive and returns needs-input without any agent paste", async () => {
    const { profile: selected, candidate } = goalTransportFixture("claude-goal")
    const runner = new RecordingRunner([
      { stdout: '{"result":{"pane":{"pane_id":"2-3"}}}', stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ])
    const writes: string[] = []
    await expect(executeGuideUiResult(
      buildCurrentHerdrWorkspaceResult(selected, candidate.prompt, "/repo", { workspaceId: "2", paneId: "2-1", surface: "pane" }, "right", candidate.goalExecution),
      {
        ...services(runner, writes),
        checkReadiness: async () => ({ kind: ProfileReadinessKind.Ready, summary: "Fixture runtime checked." }),
      },
    )).resolves.toBe(2)
    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[1]?.args).toEqual(["pane", "run", "2-3", "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/cldx default"])
    expect(writes.join("")).toContain("needs-input in pane 2-3")
    expect(writes.join("")).toContain("The goal has not been activated.")
    expect(writes.join("")).toContain("Type '/goal '")
  })

  it("blocks unknown or prohibited goal readiness and retains exact recovery before any terminal launch", async () => {
    const { profile: selected, candidate } = goalTransportFixture()
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    await expect(executeGuideUiResult(
      buildCurrentTerminalResult(selected, candidate.prompt, "/repo", candidate.goalExecution),
      {
        ...services(runner, writes, runInteractive),
        checkReadiness: async () => ({
          kind: ProfileReadinessKind.Blocked, summary: "Goal activation is blocked",
          diagnostic: "Managed goals are disabled.", goalReadiness: "blocked",
        }),
      },
    )).rejects.toThrow("Managed goals are disabled.")
    expect(runInteractive).not.toHaveBeenCalled()
    expect(writes.join("")).toContain("Resolve the error before native input.")
    expect(writes.join("")).toContain(guideGoalActivationInput(candidate.goalExecution, candidate.prompt).body)
  })

  it("keeps the actual goal pane and directory in recovery when Herdr startup fails", async () => {
    const { profile: selected, candidate } = goalTransportFixture()
    const runner = new RecordingRunner([
      { stdout: '{"result":{"pane":{"pane_id":"2-3"}}}', stderr: "", exitCode: 0 },
      new CommandRunnerError({ kind: "exited", executable: "herdr", args: ["pane", "run"], message: "pane startup failed", exitCode: 1 }),
    ])
    const writes: string[] = []
    await expect(executeGuideUiResult(
      buildCurrentHerdrWorkspaceResult(selected, candidate.prompt, "/exact/checkout", { workspaceId: "2", paneId: "2-1", surface: "pane" }, "right", candidate.goalExecution),
      {
        ...services(runner, writes),
        checkReadiness: async () => ({ kind: ProfileReadinessKind.Ready, summary: "Fixture runtime checked." }),
      },
    )).rejects.toMatchObject({ kind: "startup", paneId: "2-3", cwd: "/exact/checkout", message: "pane startup failed" })
    expect(writes.join("")).toContain("Pane: 2-3. Directory: /exact/checkout.")
    expect(writes.join("")).toContain("Type '/goal '")
    expect(writes.join("")).toContain(guideGoalActivationInput(candidate.goalExecution, candidate.prompt).body)
  })

  it.each(["default", "pstack-workers"] as const)("hands legacy %s a complete confirmed manual-paste artifact without inventing inbox support", async (name) => {
    const { profile, context, prompt } = legacyFixture(name)
    const runner = new RecordingRunner([legacyInventory(name)])
    const writes: string[] = []
    const runInteractive = vi.fn(async () => {
      expect(writes.join("")).toContain(prompt)
      expect(writes.join("")).toContain(firstmateOriginalIntent)
      expect(writes.join("")).toContain('"workflowId": "review-project"')
      expect(writes.join("")).toContain('"entryWorktree": "/fixture/project-c"')
    })
    const result = buildCurrentTerminalResult(profile, prompt, "/fixture/caller-a", context)
    await expect(executeGuideUiResult(result, services(runner, writes, runInteractive))).resolves.toBe(0)
    expect(runInteractive).toHaveBeenCalledExactlyOnceWith(
      { executable: "/profiles/fmx", args: [name] },
      { cwd: "/fixture/caller-a", env: expect.objectContaining({ TRELLAGE_AUTOMATION: "1" }) },
    )
    expect(runner.calls.map(({ args }) => args)).toEqual([["inventory", name, "--json"]])
    expect(writes.join("")).toContain("No inbox receipt or atomic fleet identity guard")
    expect(prompt.length).toBeLessThanOrEqual(8000)
    expect(JSON.stringify(result.command)).not.toContain("expected-fleet")
  })

  it.each(["default", "pstack-workers"] as const)("rejects incomplete legacy %s input and unsupported generic command shapes", async (name) => {
    const { profile, context, prompt } = legacyFixture(name)
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    expect(() => buildCurrentTerminalResult(profile, prompt, "/fixture/source")).toThrow("requires confirmed")
    const valid = buildCurrentTerminalResult(profile, prompt, "/fixture/source", context)
    const { legacyFirstmate: _context, ...unconfirmed } = valid
    for (const result of [
      unconfirmed,
      { ...valid, prompt: "Only the specification, with the original intent discarded." },
      { ...valid, legacyFirstmate: { ...context, originalIntent: "A different original request." } },
      { ...valid, command: { ...valid.command, args: [...valid.command.args, "--fmx-expected-fleet-json", "{}"] } },
      { ...valid, profile: { ...valid.profile, headlessPrompt: true } },
    ]) {
      await expect(executeGuideUiResult(result, services(runner, writes, runInteractive)))
        .rejects.toThrow()
    }
    expect(runner.calls).toEqual([])
    expect(runInteractive).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it.each(["busy", "unhealthy", "not-setup"])("keeps legacy %s readiness conservative before TTY handoff", async (readiness) => {
    const { profile, context, prompt } = legacyFixture("default")
    const runner = new RecordingRunner([legacyInventory("default", readiness)])
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    await expect(executeGuideUiResult(buildCurrentTerminalResult(profile, prompt, "/fixture/source", context),
      services(runner, writes, runInteractive))).rejects.toThrow("No legacy prompt was delivered")
    expect(writes).toEqual([])
    expect(runInteractive).not.toHaveBeenCalled()
  })

  it("prints the complete legacy artifact without claiming inbox acceptance or requiring a runtime", async () => {
    const { profile, context, prompt } = legacyFixture("default")
    const runner = new RecordingRunner()
    const writes: string[] = []
    await expect(executeGuideUiResult(buildPrintResult(prompt, profile, context), services(runner, writes))).resolves.toBe(0)
    expect(writes.join("")).toContain(prompt)
    expect(writes.join("")).toContain("Complete legacy Firstmate manual-paste request")
    expect(writes.join("")).toContain("No inbox acceptance")
    expect(runner.calls).toEqual([])
    expect(() => buildPrintResult(prompt, profile)).toThrow("requires confirmed")
  })

  it("labels a printed Firstmate specification as incomplete rather than a full paste artifact", async () => {
    const { selected, job } = firstmateFixture("default")
    const runner = new RecordingRunner()
    const writes: string[] = []
    const result = buildPrintResult(job.prompt, selected)
    await expect(executeGuideUiResult(result, services(runner, writes))).resolves.toBe(0)
    expect(writes.join("")).toContain("not a complete delivery")
    expect(writes.join("")).toContain("do not paste this specification alone")
    expect(writes.join("")).toContain(job.prompt)
    expect(runner.calls).toEqual([])
  })

  it.each(["default", "pstack-workers"] as const)("rejects every generic %s launch path before printing or delivering its prompt", async (name) => {
    const { selected, job } = firstmateFixture(name)
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    const context = { workspaceId: "4", paneId: "4-2", surface: "pane" as const }
    const results = [
      buildCurrentTerminalResult(selected, job.prompt, "/fixture/source"),
      buildCurrentHerdrWorkspaceResult(selected, job.prompt, "/fixture/source", context),
      buildNewHerdrTabResult(selected, job.prompt, "/fixture/source", context),
      buildNewHerdrWorktreeResult(selected, job.prompt, "/fixture/source", "worktree/captain", "main"),
      buildExistingHerdrWorktreeResult(selected, job.prompt, "/fixture/source", "/fixture/captain"),
    ]
    for (const result of results) {
      await expect(executeGuideUiResult(result, services(runner, writes, runInteractive))).rejects.toThrow("explicit fleet action and the inbox batch path")
    }
    expect(writes).toEqual([])
    expect(runner.calls).toEqual([])
    expect(runInteractive).not.toHaveBeenCalled()
  })

  it.each(["default", "pstack-workers"] as const)("reports a saved %s request without claiming task completion or delivering it again", async (name) => {
    const { job, request, receipt } = firstmateFixture(name)
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    const result: GuideUiResult = {
      action: "batch",
      result: { entries: [{ job, status: "accepted", request, receipt: receipt(), supervisor: "running" }] },
    }
    const frozen = JSON.stringify(result)
    await expect(executeGuideUiResult(result, services(runner, writes, runInteractive))).resolves.toBe(0)
    expect(writes.join("")).toContain("captain-note-17")
    expect(writes.join("")).toContain(request.requestId)
    expect(writes.join("")).toContain("not dispatched or completed")
    expect(writes.join("")).not.toContain(job.prompt)
    expect(writes.join("")).not.toContain(job.guideContext!.originalIntent)
    expect(JSON.stringify(result)).toBe(frozen)
    expect(runner.calls).toEqual([])
    expect(runInteractive).not.toHaveBeenCalled()
  })

  it.each(["stopped", "running"] as const)("uses the latest %s supervisor status instead of treating a sent wake as processing", async (supervisor) => {
    const { job, request, receipt } = firstmateFixture("default")
    const runner = new RecordingRunner()
    const writes: string[] = []
    const entry: GuideBatchEntryResult = {
      job, status: "accepted", request, supervisor,
      receipt: receipt({ announcement: "sent", supervisorState: "stopped" }),
    }
    await expect(executeGuideUiResult({ action: "batch", result: { entries: [entry] } }, services(runner, writes)))
      .resolves.toBe(supervisor === "running" ? 0 : 1)
    const output = writes.join("")
    expect(output).toContain(supervisor === "stopped" ? "waiting for supervisor start" : "Fleet status: supervisor running")
    expect(output).toContain("Acceptance does not confirm dispatch or task completion")
    expect(output).not.toContain(job.prompt)
    if (supervisor === "running") expect(output).not.toContain("waiting for supervisor start")
    expect(runner.calls).toEqual([])
  })

  it.each(["pending", "failed"] as const)("keeps a saved request visible when its inbox wake is %s and supervisor startup is unknown", async (announcement) => {
    const { job, request, receipt } = firstmateFixture("default")
    const runner = new RecordingRunner()
    const writes: string[] = []
    const startupError = "Supervisor startup was not confirmed."
    const entry: GuideBatchEntryResult = {
      job, status: "accepted", request, supervisor: "unknown", startupError,
      receipt: receipt({
        announcement, supervisorState: "stopped",
        error: announcement === "failed" ? { code: "wake-failed", message: "The note is saved but the wake failed." } : null,
      }),
    }
    await expect(executeGuideUiResult({ action: "batch", result: { entries: [entry] } }, services(runner, writes))).resolves.toBe(1)
    expect(writes.join("")).toContain("captain-note-17")
    expect(writes.join("")).toContain(announcement)
    expect(writes.join("")).toContain("unknown")
    expect(writes.join("")).toContain(startupError)
    expect(writes.join("")).not.toContain(job.prompt)
    expect(runner.calls).toEqual([])
  })

  it("keeps an unknown submission immutable and exposes only same-ID reconciliation, not manual prompt recovery", async () => {
    const { job, request } = firstmateFixture("pstack-workers")
    const runner = new RecordingRunner()
    const writes: string[] = []
    const result: GuideUiResult = {
      action: "batch",
      result: { entries: [{ job, request, status: "submission-unknown", stage: "submission", message: "The receipt could not be confirmed." }] },
    }
    const frozen = JSON.stringify(result)
    await expect(executeGuideUiResult(result, services(runner, writes))).resolves.toBe(1)
    expect(writes.join("")).toContain(request.requestId)
    expect(writes.join("")).toContain("reconcile the same request ID and payload")
    expect(writes.join("")).toContain("do not paste or submit a new ID")
    expect(writes.join("")).not.toContain(job.prompt)
    expect(writes.join("")).not.toContain("Use this prompt manually")
    expect(JSON.stringify(result)).toBe(frozen)
    expect(runner.calls).toEqual([])
  })

  it("prints the summary of a batch the guide already launched", async () => {
    const runner = new RecordingRunner()
    const writes: string[] = []
    const job = createQueuedGuideJob(1, profile(false), "Draft the post.", {
      kind: "current-workspace-pane",
      direction: "right",
    })

    await expect(
      executeGuideUiResult(
        {
          action: "batch",
          result: {
            entries: [{ job, status: "launched", paneId: "2-3", workspaceId: "2", cwd: "/repo" }],
          },
        },
        services(runner, writes),
      ),
    ).resolves.toBe(0)
    expect(runner.calls).toHaveLength(0)
    expect(writes.join("")).toContain("Batch launch summary: 1 job")
    expect(writes.join("")).toContain("1. hve-core: launched in pane 2-3")
  })

  it("returns 130 for cancellation without side effects", async () => {
    const runner = new RecordingRunner()
    const writes: string[] = []

    await expect(executeGuideUiResult(buildCancelResult(), services(runner, writes))).resolves.toBe(130)
    expect(runner.calls).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })

  it("prints a selected prompt without launching", async () => {
    const runner = new RecordingRunner()
    const writes: string[] = []

    await expect(executeGuideUiResult(buildPrintResult("Draft the post."), services(runner, writes))).resolves.toBe(0)
    expect(writes).toEqual(["Selected prompt:\n\nDraft the post.\n"])
    expect(runner.calls).toHaveLength(0)
  })

  it("prints manual-paste content before an interactive terminal launch", async () => {
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    const result = buildCurrentTerminalResult(profile(false), "Draft the post.", "/repo")

    await expect(executeGuideUiResult(result, services(runner, writes, runInteractive))).resolves.toBe(0)
    expect(writes).toEqual(["Paste this prompt after the profile starts:\n\nDraft the post.\n"])
    expect(runInteractive).toHaveBeenCalledWith(command, {
      cwd: "/repo",
      env: expect.objectContaining({ TRELLAGE_AUTOMATION: "1" }),
    })
  })

  it("does not print an argv-delivered terminal prompt", async () => {
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    const result = buildCurrentTerminalResult(profile(true), "Draft the post.", "/repo")

    await expect(executeGuideUiResult(result, services(runner, writes, runInteractive))).resolves.toBe(0)
    expect(writes).toHaveLength(0)
    expect(runInteractive).toHaveBeenCalledWith(
      {
        executable: "/opt/trellage/bin/cpx",
        args: ["hve-core", "-i", "Draft the post."],
      },
      {
        cwd: "/repo",
        env: expect.objectContaining({ TRELLAGE_AUTOMATION: "1" }),
      },
    )
  })

  it("passes a cdx prompt positionally without printing manual-paste instructions", async () => {
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    const result = buildCurrentTerminalResult(
      {
        surface: "native",
        launcher: "cdx",
        commandPath: "/opt/trellage/bin/cdx",
        profile: "pstack",
        headlessPrompt: false,
      },
      "Run the full workflow.",
      "/repo",
    )

    await expect(executeGuideUiResult(result, services(runner, writes, runInteractive))).resolves.toBe(0)
    expect(writes).toHaveLength(0)
    expect(runInteractive).toHaveBeenCalledWith(
      {
        executable: "/opt/trellage/bin/cdx",
        args: ["pstack", "--", "Run the full workflow."],
      },
      {
        cwd: "/repo",
        env: expect.objectContaining({ TRELLAGE_AUTOMATION: "1" }),
      },
    )
  })

  it("launches a Sandbox profile with its initial prompt and no paste instruction", async () => {
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)
    const result = buildCurrentTerminalResult(
      {
        surface: "sandbox",
        commandPath: "/opt/trellage/bin/trellage",
        profile: "claude-research",
        headlessPrompt: false,
      },
      "Research the repository.",
      "/repo",
    )

    await expect(executeGuideUiResult(result, services(runner, writes, runInteractive))).resolves.toBe(0)
    expect(writes).toHaveLength(0)
    expect(runInteractive).toHaveBeenCalledWith(
      {
        executable: "/opt/trellage/bin/trellage",
        args: ["--profile", "claude-research", "Research the repository."],
      },
      {
        cwd: "/repo",
        env: expect.objectContaining({ TRELLAGE_AUTOMATION: "1" }),
      },
    )
  })

  it("preserves a non-zero interactive child exit code", async () => {
    const runner = new RecordingRunner()
    const writes: string[] = []
    const result = buildCurrentTerminalResult(profile(true), "Draft the post.", "/repo")
    const runInteractive = vi.fn(async () => {
      throw new CommandRunnerError({
        kind: "exited",
        executable: command.executable,
        args: command.args,
        message: "interactive command exited with status 7",
        exitCode: 7,
      })
    })

    await expect(executeGuideUiResult(result, services(runner, writes, runInteractive))).resolves.toBe(7)
  })

  it("rejects an unknown result action without running a command", async () => {
    const runner = new RecordingRunner()
    const writes: string[] = []
    const runInteractive = vi.fn(async () => undefined)

    await expect(
      executeGuideUiResult(
        { action: "future-action" } as unknown as GuideUiResult,
        services(runner, writes, runInteractive),
      ),
    ).rejects.toThrow("unsupported action: future-action")
    expect(runner.calls).toHaveLength(0)
    expect(runInteractive).not.toHaveBeenCalled()
  })

  it("uses exact current-workspace IDs and bounded handoff timeouts", async () => {
    const runner = new RecordingRunner([
      { stdout: '{"result":{"pane":{"pane_id":"2-3"}}}', stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: '{"result":{"agent":{"agent_status":"idle"}}}', stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ])
    const writes: string[] = []

    await expect(
      executeGuideUiResult(
        buildCurrentHerdrWorkspaceResult(agentPromptProfile, "Draft the post.", "/repo", {
          workspaceId: "2",
          paneId: "2-1",
          surface: "pane",
        }),
        services(runner, writes),
      ),
    ).resolves.toBe(0)

    expect(runner.calls[0]).toMatchObject({
      executable: "herdr",
      args: ["pane", "split", "--pane", "2-1", "--cwd", "/repo", "--direction", "right", "--no-focus"],
    })
    expect(runner.calls[3]).toMatchObject({
      executable: "herdr",
      args: ["agent", "prompt", "2-3", "Draft the post.", "--wait", "--timeout", "60000"],
    })
    expect(writes).toHaveLength(0)
  })

  it("queues cpx prompts in the launch command before a workspace trust decision", async () => {
    const runner = new RecordingRunner([
      { stdout: '{"result":{"pane":{"pane_id":"2-3"}}}', stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ])
    const writes: string[] = []

    await expect(
      executeGuideUiResult(
        buildCurrentHerdrWorkspaceResult(profile(false), "Draft the post.", "/repo", {
          workspaceId: "2",
          paneId: "2-1",
          surface: "pane",
        }),
        services(runner, writes),
      ),
    ).resolves.toBe(0)

    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[1]).toMatchObject({
      executable: "herdr",
      args: ["pane", "run", "2-3", "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/cpx hve-core -i 'Draft the post.'"],
    })
    expect(writes).toHaveLength(0)
  })

  it("queues cdx prompts in the launch command before a hook trust decision", async () => {
    const runner = new RecordingRunner([
      { stdout: '{"result":{"pane":{"pane_id":"2-4"}}}', stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ])
    const writes: string[] = []
    const cdxProfile: SelectedProfile = {
      surface: "native",
      launcher: "cdx",
      commandPath: "/opt/trellage/bin/cdx",
      profile: "pstack",
      headlessPrompt: false,
    }

    await expect(
      executeGuideUiResult(
        buildCurrentHerdrWorkspaceResult(cdxProfile, "Run the full workflow.", "/repo", {
          workspaceId: "2",
          paneId: "2-1",
          surface: "pane",
        }),
        services(runner, writes),
      ),
    ).resolves.toBe(0)

    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[1]).toMatchObject({
      executable: "herdr",
      args: [
        "pane",
        "run",
        "2-4",
        "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/cdx pstack -- 'Run the full workflow.'",
      ],
    })
    expect(writes).toHaveLength(0)
  })

  it("prints a manual recovery prompt when Herdr prompt delivery fails", async () => {
    const runner = new RecordingRunner([
      { stdout: '{"result":{"pane":{"pane_id":"2-3"}}}', stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: '{"result":{"agent":{"agent_status":"idle"}}}', stderr: "", exitCode: 0 },
      new CommandRunnerError({
        kind: "exited",
        executable: "herdr",
        args: ["agent", "prompt"],
        message: "prompt failed",
        exitCode: 1,
        stderr: "agent_blocked",
      }),
    ])
    const writes: string[] = []
    const result = buildCurrentHerdrWorkspaceResult(agentPromptProfile, "Draft the post.", "/repo", {
      workspaceId: "2",
      paneId: "2-1",
      surface: "pane",
    })

    await expect(executeGuideUiResult(result, services(runner, writes))).rejects.toMatchObject({
      kind: "blocked",
      paneId: "2-3",
    })
    expect(writes).toEqual(["Automatic prompt delivery failed. Use this prompt manually:\n\nDraft the post.\n"])
  })

  it("uses Herdr-returned worktree IDs and prints recovery text on handoff failure", async () => {
    const runner = new RecordingRunner([
      { stdout: "", stderr: "", exitCode: 0 },
      {
        stdout:
          '{"result":{"workspace":{"workspace_id":"3"},"root_pane":{"pane_id":"3-1"},"worktree":{"path":"/actual/path"}}}',
        stderr: "",
        exitCode: 0,
      },
      new Error("pane launch failed"),
    ])
    const writes: string[] = []
    const result: GuideUiResult = buildNewHerdrWorktreeResult(
      agentPromptProfile,
      "Draft the post.",
      "/primary",
      "worktree/linkedin-post",
      "abc123",
    )

    await expect(executeGuideUiResult(result, services(runner, writes))).rejects.toThrow("pane launch failed")
    expect(runner.calls[2]).toMatchObject({
      executable: "herdr",
      args: ["pane", "run", "3-1", "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/jcx reviewer"],
      options: { cwd: "/actual/path" },
    })
    expect(writes).toEqual(["Profile launch did not complete. Selected prompt:\n\nDraft the post.\n"])
  })

  it("opens the exact existing worktree path before using the returned root pane", async () => {
    const runner = new RecordingRunner([
      {
        stdout:
          '{"result":{"workspace":{"workspace_id":"4"},"root_pane":{"pane_id":"4-1"},"worktree":{"path":"/returned/path"}}}',
        stderr: "",
        exitCode: 0,
      },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: '{"result":{"agent":{"agent_status":"done"}}}', stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ])
    const writes: string[] = []
    const result = buildExistingHerdrWorktreeResult(
      agentPromptProfile,
      "Draft the post.",
      "/primary",
      "/existing/path",
    )

    await expect(executeGuideUiResult(result, services(runner, writes))).resolves.toBe(0)
    expect(runner.calls[0]).toMatchObject({
      executable: "herdr",
      args: ["worktree", "open", "--cwd", "/primary", "--path", "/existing/path", "--no-focus"],
    })
    expect(runner.calls[1]).toMatchObject({
      executable: "herdr",
      args: ["pane", "run", "4-1", "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/jcx reviewer"],
      options: { cwd: "/returned/path" },
    })
    expect(writes).toHaveLength(0)
  })
})
