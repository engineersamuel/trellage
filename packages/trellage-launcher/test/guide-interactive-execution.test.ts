import { describe, expect, it, vi } from "vitest"
import { executeGuideUiResult, type GuideInteractiveExecutionServices } from "../src/guide-interactive-execution.js"
import {
  buildCancelResult,
  buildCurrentHerdrWorkspaceResult,
  buildCurrentTerminalResult,
  buildExistingHerdrWorktreeResult,
  buildNewHerdrWorktreeResult,
  buildPrintResult,
  type GuideUiResult,
} from "../src/guide-ui.js"
import { CommandRunnerError } from "../src/guide-launch.js"
import { createQueuedGuideJob } from "../src/guide-batch.js"
import type {
  CommandRunOptions,
  CommandRunResult,
  CommandRunner,
  CommandSpec,
  SelectedProfile,
} from "../src/guide-launch.js"

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
const agentPromptProfile: SelectedProfile = {
  surface: "native",
  launcher: "grx",
  commandPath: "/opt/trellage/bin/grx",
  profile: "reviewer",
  headlessPrompt: false,
}

const services = (
  runner: CommandRunner,
  writes: string[],
  runInteractive = vi.fn(async () => undefined),
): GuideInteractiveExecutionServices => ({
  runner,
  write: (text) => writes.push(text),
  runInteractive,
})

describe("interactive guide result execution", () => {
  it("returns the batch exit code and prints its ordered summary", async () => {
    const runner = new RecordingRunner([
      {
        stdout: JSON.stringify({ schemaVersion: 1, launcher: "cpx", profile: "hve-core", readiness: "healthy" }),
        stderr: "",
        exitCode: 0,
      },
      { stdout: '{"result":{"pane":{"pane_id":"2-3"}}}', stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ])
    const writes: string[] = []
    const job = createQueuedGuideJob(1, profile(false), "Draft the post.")

    await expect(
      executeGuideUiResult(
        {
          action: "batch",
          batch: {
            jobs: [job],
            policy: {
              kind: "current-herdr-workspace",
              workspaceId: "2",
              cwd: "/repo",
              callerPaneId: "2-1",
              direction: "right",
            },
          },
        },
        services(runner, writes),
      ),
    ).resolves.toBe(0)
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
        "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/cdx pstack 'Run the full workflow.'",
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
      args: ["pane", "run", "3-1", "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/grx reviewer"],
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
      args: ["pane", "run", "4-1", "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/grx reviewer"],
      options: { cwd: "/returned/path" },
    })
    expect(writes).toHaveLength(0)
  })
})
