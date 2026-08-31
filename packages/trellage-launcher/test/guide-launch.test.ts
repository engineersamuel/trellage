import { describe, expect, it } from "vitest"

import {
  buildGuideLaunchCommand,
  buildHerdrGuideLaunch,
  CommandRunnerError,
  createNodeCommandRunner,
  defaultWorktreeBranch,
  getHerdrContext,
  GuideLaunchError,
  handoffToCurrentHerdrWorkspace,
  inspectGitWorktreeIntent,
  isHerdrAvailable,
  launchInHerdrPaneAndPrompt,
  openHerdrWorktree,
  openHerdrWorktreeAndHandoff,
  parseHerdrAgentInfo,
  parseHerdrSplitPaneId,
  parseHerdrWorktreeHandle,
  parseSelectedProfile,
  parseGitWorktreeList,
  posixShellEscape,
  probeHerdrAvailability,
  renderCommandPreview,
  runInteractiveCommand,
  createHerdrWorktree,
  createHerdrWorktreeAndHandoff,
  type CommandRunOptions,
  type CommandRunResult,
  type CommandRunner,
  type CommandSpec,
  type TimeController,
} from "../src/guide-launch.js"

interface PlannedCall {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly result?: CommandRunResult
  readonly error?: Error
}

class FakeRunner implements CommandRunner {
  readonly calls: Array<{
    readonly executable: string
    readonly args: ReadonlyArray<string>
    readonly options?: CommandRunOptions
  }> = []

  private readonly plan: Array<PlannedCall>

  constructor(plan: ReadonlyArray<PlannedCall>) {
    this.plan = [...plan]
  }

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args: [...args], ...(options === undefined ? {} : { options }) })
    const next = this.plan.shift()
    if (next === undefined) throw new Error(`unexpected command: ${executable} ${args.join(" ")}`)
    expect({ executable, args: [...args] }).toEqual({
      executable: next.executable,
      args: [...next.args],
    })
    if (next.error !== undefined) throw next.error
    return next.result ?? { stdout: "", stderr: "", exitCode: 0 }
  }

  expectComplete(): void {
    expect(this.plan).toHaveLength(0)
  }
}

const ok = (stdout = "", stderr = ""): CommandRunResult => ({ stdout, stderr, exitCode: 0 })

const commandFailure = (
  kind: "spawn-failed" | "exited" | "aborted" | "timed-out" | "output-limit",
  executable: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly exitCode?: number | null
    readonly stderr?: string
    readonly stdout?: string
  },
): CommandRunnerError =>
  new CommandRunnerError({
    kind,
    executable,
    args,
    message: `${kind}: ${executable}`,
    ...(options?.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    ...(options?.stderr === undefined ? {} : { stderr: options.stderr }),
    ...(options?.stdout === undefined ? {} : { stdout: options.stdout }),
  })

const clock = (): { readonly time: TimeController; readonly advance: (ms: number) => void } => {
  let now = 0
  return {
    time: {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
    },
    advance: (milliseconds) => {
      now += milliseconds
    },
  }
}

const nativeProfile = parseSelectedProfile({
  surface: "native",
  launcher: "cpx",
  commandPath: "/opt/trellage/bin/cpx",
  profile: "hve-core",
  headlessPrompt: true,
})

const sandboxProfile = parseSelectedProfile({
  surface: "sandbox",
  commandPath: "/opt/trellage/bin/trellage",
  profile: "prime-agent",
  headlessPrompt: false,
})

const bareCommand: CommandSpec = {
  executable: "/opt/trellage/bin/cpx",
  args: ["hve-core"],
}
const automatedBareCommandPreview = "env TRELLAGE_AUTOMATION=1 /opt/trellage/bin/cpx hve-core"

const linkedHead = "1111111111111111111111111111111111111111"
const primaryHead = "2222222222222222222222222222222222222222"

describe("guide launch command building", () => {
  it("builds native and sandbox argv without command text injection", () => {
    expect(buildGuideLaunchCommand(nativeProfile).command).toEqual({
      executable: "/opt/trellage/bin/cpx",
      args: ["hve-core"],
    })
    expect(buildGuideLaunchCommand(sandboxProfile).command).toEqual({
      executable: "/opt/trellage/bin/trellage",
      args: ["--profile", "prime-agent"],
    })
  })

  it("builds trusted Herdr prompt delivery for embedded and agent-delivered profiles", () => {
    expect(buildHerdrGuideLaunch(nativeProfile, "Run /council now")).toEqual({
      command: { executable: "/opt/trellage/bin/cpx", args: ["hve-core", "-i", "Run /council now"] },
      promptDelivery: "command",
    })
    expect(buildHerdrGuideLaunch(sandboxProfile, "Research this")).toEqual({
      command: { executable: "/opt/trellage/bin/trellage", args: ["--profile", "prime-agent"] },
      promptDelivery: "agent",
    })
  })

  it("uses native headless delivery and Sandbox interactive prompt delivery", () => {
    const prompt = "say '$HOME'\nnext line"
    const nativeResult = buildGuideLaunchCommand(nativeProfile, { mode: "argv", prompt })
    const sandboxResult = buildGuideLaunchCommand(sandboxProfile, { mode: "argv", prompt })

    expect(nativeResult.promptHandling).toBe("argv")
    expect(nativeResult.command.executable).toBe("/opt/trellage/bin/cpx")
    expect(nativeResult.command.args).toEqual(["hve-core", "-i", prompt])
    expect(nativeResult.command.args[2]).toBe(prompt)
    expect(sandboxResult.promptHandling).toBe("argv")
    expect(sandboxResult.command.executable).toBe("/opt/trellage/bin/trellage")
    expect(sandboxResult.command.args).toEqual(["--profile", "prime-agent", prompt])
    expect(sandboxResult.command.args[2]).toBe(prompt)
  })

  it("places a validated Copilot agent override before the interactive prompt", () => {
    const profile = parseSelectedProfile({
      surface: "native",
      launcher: "cpx",
      commandPath: "/opt/trellage/bin/cpx",
      profile: "hve",
      headlessPrompt: true,
      agent: "hve-core:rpi-agent",
    })
    const result = buildGuideLaunchCommand(profile, { mode: "argv", prompt: "Run the complete RPI cycle." })

    expect(result.promptHandling).toBe("argv")
    expect(result.command.args).toEqual([
      "hve",
      "--agent",
      "hve-core:rpi-agent",
      "-i",
      "Run the complete RPI cycle.",
    ])
  })

  it("keeps launcher identity and validates absolute command paths", () => {
    expect(nativeProfile).toMatchObject({
      surface: "native",
      launcher: "cpx",
      commandPath: "/opt/trellage/bin/cpx",
    })
    expect(sandboxProfile).toMatchObject({
      surface: "sandbox",
      commandPath: "/opt/trellage/bin/trellage",
    })
    expect(() =>
      parseSelectedProfile({
        surface: "native",
        launcher: "cpx",
        commandPath: "cpx",
        profile: "hve-core",
        headlessPrompt: true,
      }),
    ).toThrow(/absolute path/)
    expect(() =>
      parseSelectedProfile({
        surface: "sandbox",
        commandPath: "trellage",
        profile: "prime-agent",
        headlessPrompt: false,
      }),
    ).toThrow(/absolute path/)
    expect(() =>
      parseSelectedProfile({
        surface: "native",
        launcher: "cdx",
        commandPath: "/opt/trellage/bin/cdx",
        profile: "hve",
        headlessPrompt: true,
        agent: "hve-core:rpi-agent",
      }),
    ).toThrow(/only by the cpx launcher/)
    expect(() =>
      parseSelectedProfile({
        surface: "native",
        launcher: "cpx",
        commandPath: "/opt/trellage/bin/cpx",
        profile: "hve",
        headlessPrompt: true,
        agent: "--unsafe",
      }),
    ).toThrow(/simple agent identifier/)
  })
})

describe("shell preview escaping", () => {
  it("escapes empty, quoted, spaced, dollar, and newline text for display", () => {
    expect(posixShellEscape("")).toBe("''")
    expect(posixShellEscape("simple")).toBe("simple")
    expect(posixShellEscape("two words")).toBe("'two words'")
    expect(posixShellEscape("$HOME")).toBe("'$HOME'")
    expect(posixShellEscape("a'b")).toBe("'a'\"'\"'b'")
    expect(posixShellEscape("line1\nline2")).toBe("'line1\nline2'")
    expect(
      renderCommandPreview({
        executable: "trellage",
        args: ["--profile", "prime-agent", "-p", "say '$HOME'\nnext line", ""],
      }),
    ).toBe("trellage --profile prime-agent -p 'say '\"'\"'$HOME'\"'\"'\nnext line' ''")
  })
})

describe("node command runner regression coverage", () => {
  it("rejects timed-out children that ignore SIGTERM without hanging", async () => {
    const runner = createNodeCommandRunner()
    const startedAt = Date.now()
    const error = await runner
      .run(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
        timeoutMs: 50,
      })
      .then(
        () => new Error("expected timed-out runner error"),
        (rejected: unknown) => rejected,
      )
    const elapsedMs = Date.now() - startedAt

    expect(error).toBeInstanceOf(CommandRunnerError)
    expect(error).toMatchObject({
      kind: "timed-out",
      executable: process.execPath,
      args: ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    })
    expect(elapsedMs).toBeGreaterThanOrEqual(50)
    expect(elapsedMs).toBeLessThan(2_500)
  })

  it("rejects output past the capture cap with bounded stdout", async () => {
    const runner = createNodeCommandRunner()
    const script = [
      'process.on("SIGTERM", () => {})',
      'const chunk = "x".repeat(65536)',
      "const write = () => {",
      "  for (let index = 0; index < 32; index += 1) process.stdout.write(chunk)",
      "  setImmediate(write)",
      "}",
      "write()",
      "setInterval(() => {}, 1000)",
    ].join("\n")
    const error = await runner.run(process.execPath, ["-e", script]).then(
      () => new Error("expected output-limit runner error"),
      (rejected: unknown) => rejected,
    )

    expect(error).toBeInstanceOf(CommandRunnerError)
    expect(error).toMatchObject({
      kind: "output-limit",
      executable: process.execPath,
    })
    if (!(error instanceof CommandRunnerError)) throw error
    expect(Buffer.byteLength(error.stdout, "utf8")).toBeLessThanOrEqual(1024 * 1024)
    expect(Buffer.byteLength(error.stdout, "utf8")).toBeGreaterThanOrEqual(65536)
    expect(error.stderr).toBe("")
  })

  it("runs interactive commands without a shell and reports non-zero exits", async () => {
    await expect(
      runInteractiveCommand({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
      }),
    ).resolves.toBeUndefined()

    await expect(
      runInteractiveCommand({
        executable: process.execPath,
        args: ["-e", "process.exit(7)"],
      }),
    ).rejects.toMatchObject({
      kind: "exited",
      exitCode: 7,
    })
  })
})

describe("Herdr parsing helpers", () => {
  it("extracts pane and worktree ids from exact JSON paths", () => {
    expect(parseHerdrSplitPaneId('{"result":{"pane":{"pane_id":"wCN:p2"}}}')).toBe("wCN:p2")
    expect(
      parseHerdrWorktreeHandle(
        '{"result":{"workspace":{"workspace_id":"wD1"},"root_pane":{"pane_id":"wD1:p1"},"worktree":{"path":"/repo/.worktrees/fix-add-json-guide"}}}',
        "Herdr worktree create",
      ),
    ).toEqual({
      workspaceId: "wD1",
      rootPaneId: "wD1:p1",
      checkoutPath: "/repo/.worktrees/fix-add-json-guide",
    })
    expect(parseHerdrAgentInfo('{"result":{"agent":{"agent_status":"idle"}}}')).toBe("idle")
  })

  it("rejects malformed Herdr JSON", () => {
    expect(() => parseHerdrSplitPaneId('{"result":{}}')).toThrow(/pane/)
    expect(() => parseHerdrWorktreeHandle('{"result":{"workspace":{}}}', "Herdr worktree open")).toThrow(/root_pane/)
    expect(() =>
      parseHerdrWorktreeHandle(
        '{"result":{"workspace":{"workspace_id":"wD1"},"root_pane":{"pane_id":"wD1:p1"}}}',
        "Herdr worktree open",
      ),
    ).toThrow(/worktree/)
    expect(() => parseHerdrAgentInfo('{"result":{"agent":{"agent_status":"sleeping"}}}')).toThrow(/invalid/)
  })
})

describe("Herdr availability helpers", () => {
  it("requires env ids and a successful probe", async () => {
    const runner = new FakeRunner([{ executable: "herdr", args: ["--help"], result: ok("usage") }])
    const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" }

    await expect(probeHerdrAvailability(runner)).resolves.toBe(true)
    expect(getHerdrContext(env)).toEqual({ workspaceId: "w1", paneId: "w1:p1", surface: "pane" })
    expect(isHerdrAvailable(env, true)).toBe(true)
    expect(isHerdrAvailable({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" }, true)).toBe(false)
    expect(isHerdrAvailable(env, false)).toBe(false)
    runner.expectComplete()
  })

  it("uses validated popup source metadata when the popup has no pane id", () => {
    const env = {
      HERDR_ENV: "1",
      TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify({
        schemaVersion: 1,
        surface: "popup",
        workspaceId: "w1",
        paneId: "w1:p1",
        cwd: "/repo",
        capture: {
          source: "terminal",
          confidence: "snapshot",
          agent: "copilot",
        },
      }),
    }

    expect(getHerdrContext(env)).toEqual({
      workspaceId: "w1",
      paneId: "w1:p1",
      surface: "popup",
      cwd: "/repo",
      capture: {
        source: "terminal",
        confidence: "snapshot",
        agent: "copilot",
      },
    })
    expect(isHerdrAvailable(env, true)).toBe(true)
    expect(
      getHerdrContext({
        HERDR_ENV: "1",
        TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify({
          schemaVersion: 1,
          surface: "popup",
          workspaceId: "w1",
          paneId: "w1:p1",
          cwd: "/repo",
          capture: { source: "capture-queue", confidence: "user-curated" },
        }),
      }),
    ).toMatchObject({ capture: { source: "capture-queue", confidence: "user-curated" } })
  })

  it("rejects malformed or incomplete popup source metadata", () => {
    expect(() =>
      getHerdrContext({
        HERDR_ENV: "1",
        TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify({
          schemaVersion: 1,
          surface: "popup",
          workspaceId: "w1",
          paneId: "w1:p1",
          cwd: "relative",
        }),
      }),
    ).toThrow(GuideLaunchError)
    expect(() =>
      getHerdrContext({
        HERDR_ENV: "1",
        TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify({
          schemaVersion: 1,
          surface: "popup",
          workspaceId: "w1",
          paneId: "w1:p1",
        }),
      }),
    ).toThrow(GuideLaunchError)
    expect(() =>
      getHerdrContext({
        HERDR_ENV: "1",
        TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify({
          schemaVersion: 1,
          surface: "popup",
          workspaceId: "w1",
          paneId: "w1:p1",
          cwd: "/repo",
          capture: {
            source: "guessed",
            confidence: "exact",
          },
        }),
      }),
    ).toThrow(GuideLaunchError)
  })

  it("prefers direct pane context over popup metadata", () => {
    expect(
      getHerdrContext({
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_PANE_ID: "w1:p2",
        TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: "{not-json",
      }),
    ).toEqual({ workspaceId: "w1", paneId: "w1:p2", surface: "pane" })
  })
})

describe("current workspace handoff", () => {
  it("splits from the caller pane, retries recognition, accepts done, and prompts", async () => {
    const testClock = clock()
    const prompt = "Build this safely"
    const runner = new FakeRunner([
      {
        executable: "herdr",
        args: ["pane", "split", "--pane", "wCN:p1", "--cwd", "/repo", "--direction", "right", "--no-focus"],
        result: ok('{"result":{"pane":{"pane_id":"wCN:p2"}}}'),
      },
      {
        executable: "herdr",
        args: ["pane", "run", "wCN:p2", automatedBareCommandPreview],
        result: ok(),
      },
      {
        executable: "herdr",
        args: ["agent", "get", "wCN:p2"],
        error: commandFailure("exited", "herdr", ["agent", "get", "wCN:p2"], {
          exitCode: 1,
          stderr: "agent_not_found",
        }),
      },
      {
        executable: "herdr",
        args: ["agent", "get", "wCN:p2"],
        result: ok('{"result":{"agent":{"agent_status":"done"}}}'),
      },
      {
        executable: "herdr",
        args: ["agent", "prompt", "wCN:p2", prompt, "--wait", "--timeout", "5000"],
        result: ok(),
      },
    ])

    const result = await handoffToCurrentHerdrWorkspace(runner, {
      callerPaneId: "wCN:p1",
      cwd: "/repo",
      direction: "right",
      command: bareCommand,
      prompt,
      promptDelivery: "agent",
      promptTimeoutMs: 5_000,
      timeoutMs: 20,
      pollIntervalMs: 10,
      time: testClock.time,
    })

    expect(result).toEqual({
      paneId: "wCN:p2",
      commandPreview: automatedBareCommandPreview,
    })
    expect(runner.calls[4]?.options?.timeoutMs).toBe(6_000)
    expect(runner.calls.map((call) => call.args.join(" ")).join("\n")).not.toMatch(/close|--force/)
    runner.expectComplete()
  })

  it("surfaces blocked startup state", async () => {
    const runner = new FakeRunner([
      {
        executable: "herdr",
        args: ["pane", "split", "--pane", "wCN:p1", "--cwd", "/repo", "--direction", "down", "--no-focus"],
        result: ok('{"result":{"pane":{"pane_id":"wCN:p3"}}}'),
      },
      {
        executable: "herdr",
        args: ["pane", "run", "wCN:p3", automatedBareCommandPreview],
        result: ok(),
      },
      {
        executable: "herdr",
        args: ["agent", "get", "wCN:p3"],
        result: ok('{"result":{"agent":{"agent_status":"blocked"}}}'),
      },
    ])

    await expect(
      handoffToCurrentHerdrWorkspace(runner, {
        callerPaneId: "wCN:p1",
        cwd: "/repo",
        direction: "down",
        command: bareCommand,
        prompt: "ignored",
        promptDelivery: "agent",
        promptTimeoutMs: 5_000,
        timeoutMs: 20,
        pollIntervalMs: 10,
        time: clock().time,
      }),
    ).rejects.toMatchObject({ kind: "blocked", paneId: "wCN:p3" })
    runner.expectComplete()
  })
})

describe("direct pane prompt delivery", () => {
  it("maps Herdr blocked and timeout prompt failures", async () => {
    const blockedRunner = new FakeRunner([
      {
        executable: "herdr",
        args: ["pane", "run", "w1:p2", automatedBareCommandPreview],
        result: ok(),
      },
      {
        executable: "herdr",
        args: ["agent", "get", "w1:p2"],
        result: ok('{"result":{"agent":{"agent_status":"idle"}}}'),
      },
      {
        executable: "herdr",
        args: ["agent", "prompt", "w1:p2", "prompt", "--wait", "--timeout", "1000"],
        error: commandFailure(
          "exited",
          "herdr",
          ["agent", "prompt", "w1:p2", "prompt", "--wait", "--timeout", "1000"],
          {
            exitCode: 1,
            stderr: "agent_blocked",
          },
        ),
      },
    ])

    await expect(
      launchInHerdrPaneAndPrompt(blockedRunner, {
        paneId: "w1:p2",
        cwd: "/repo",
        command: bareCommand,
        prompt: "prompt",
        promptDelivery: "agent",
        promptTimeoutMs: 1_000,
        timeoutMs: 5,
        pollIntervalMs: 0,
        time: clock().time,
      }),
    ).rejects.toMatchObject({ kind: "blocked", paneId: "w1:p2" })
    blockedRunner.expectComplete()

    const timeoutRunner = new FakeRunner([
      {
        executable: "herdr",
        args: ["pane", "run", "w1:p3", automatedBareCommandPreview],
        result: ok(),
      },
      {
        executable: "herdr",
        args: ["agent", "get", "w1:p3"],
        result: ok('{"result":{"agent":{"agent_status":"idle"}}}'),
      },
      {
        executable: "herdr",
        args: ["agent", "prompt", "w1:p3", "prompt", "--wait", "--timeout", "1000"],
        error: commandFailure(
          "timed-out",
          "herdr",
          ["agent", "prompt", "w1:p3", "prompt", "--wait", "--timeout", "1000"],
          {
            stderr: "timeout",
          },
        ),
      },
    ])

    await expect(
      launchInHerdrPaneAndPrompt(timeoutRunner, {
        paneId: "w1:p3",
        cwd: "/repo",
        command: bareCommand,
        prompt: "prompt",
        promptDelivery: "agent",
        promptTimeoutMs: 1_000,
        timeoutMs: 5,
        pollIntervalMs: 0,
        time: clock().time,
      }),
    ).rejects.toMatchObject({ kind: "timeout", paneId: "w1:p3" })
    timeoutRunner.expectComplete()
  })
})

describe("worktree intent helpers", () => {
  it("sanitizes intent to a slug and default branch name", () => {
    expect(defaultWorktreeBranch("  Fix: Add JSON / Guide  ")).toBe("worktree/fix-add-json-guide")
    expect(defaultWorktreeBranch("***")).toBe("worktree/worktree")
  })

  it("parses linked-checkout state, returns primary checkout data, and uses SHA base", async () => {
    const runner = new FakeRunner([
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo-linked/src", "check-ref-format", "--branch", "worktree/fix-add-json-guide"],
        result: ok("worktree/fix-add-json-guide\n"),
      },
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo-linked/src", "rev-parse", "--show-toplevel"],
        result: ok("/repo-linked\n"),
      },
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo-linked", "status", "--porcelain"],
        result: ok(" M src/file.ts\n"),
      },
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo-linked", "rev-parse", "HEAD"],
        result: ok(`${linkedHead}\n`),
      },
      {
        executable: "git",
        args: [
          "--no-pager",
          "-C",
          "/repo-linked",
          "show-ref",
          "--verify",
          "--quiet",
          "refs/heads/worktree/fix-add-json-guide",
        ],
        result: ok(),
      },
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo-linked", "worktree", "list", "--porcelain"],
        result: ok(
          [
            "worktree /repo-primary",
            `HEAD ${primaryHead}`,
            "branch refs/heads/main",
            "",
            "worktree /repo-linked",
            `HEAD ${linkedHead}`,
            "branch refs/heads/worktree/current-task",
            "",
            "worktree /Users/example/.herdr/worktrees/trellage/worktree-fix-add-json-guide",
            `HEAD ${primaryHead}`,
            "branch refs/heads/worktree/fix-add-json-guide",
            "",
          ].join("\n"),
        ),
      },
    ])

    const result = await inspectGitWorktreeIntent(runner, {
      cwd: "/repo-linked/src",
      branch: "worktree/fix-add-json-guide",
      targetPath: "/Users/example/.herdr/worktrees/trellage/worktree-fix-add-json-guide",
    })

    expect(result).toMatchObject({
      kind: "collision",
      currentCheckoutRoot: "/repo-linked",
      primaryCheckoutPath: "/repo-primary",
      currentHeadSha: linkedHead,
      baseRef: linkedHead,
      dirty: true,
      branchExists: true,
      collision: {
        kind: "path-active",
        path: "/Users/example/.herdr/worktrees/trellage/worktree-fix-add-json-guide",
      },
    })
    runner.expectComplete()
  })

  it("returns branch-exists collision when the branch exists without an active worktree", async () => {
    const runner = new FakeRunner([
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo", "check-ref-format", "--branch", "worktree/fix-add-json-guide"],
        result: ok("worktree/fix-add-json-guide\n"),
      },
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo", "rev-parse", "--show-toplevel"],
        result: ok("/repo\n"),
      },
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo", "status", "--porcelain"],
        result: ok(),
      },
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo", "rev-parse", "HEAD"],
        result: ok(`${primaryHead}\n`),
      },
      {
        executable: "git",
        args: [
          "--no-pager",
          "-C",
          "/repo",
          "show-ref",
          "--verify",
          "--quiet",
          "refs/heads/worktree/fix-add-json-guide",
        ],
        result: ok(),
      },
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo", "worktree", "list", "--porcelain"],
        result: ok(["worktree /repo", `HEAD ${primaryHead}`, "branch refs/heads/main", ""].join("\n")),
      },
    ])

    const result = await inspectGitWorktreeIntent(runner, {
      cwd: "/repo",
      branch: "worktree/fix-add-json-guide",
    })

    expect(result).toMatchObject({
      kind: "collision",
      currentCheckoutRoot: "/repo",
      primaryCheckoutPath: "/repo",
      currentHeadSha: primaryHead,
      baseRef: "HEAD",
      collision: { kind: "branch-exists" },
      branchExists: true,
      dirty: false,
    })
    runner.expectComplete()
  })

  it("returns a typed invalid-branch result for explicit invalid edits", async () => {
    const runner = new FakeRunner([
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo", "check-ref-format", "--branch", "bad..branch"],
        error: commandFailure(
          "exited",
          "git",
          ["--no-pager", "-C", "/repo", "check-ref-format", "--branch", "bad..branch"],
          {
            exitCode: 128,
            stderr: "fatal: 'bad..branch' is not a valid branch name",
          },
        ),
      },
    ])

    await expect(
      inspectGitWorktreeIntent(runner, {
        cwd: "/repo",
        branch: "bad..branch",
      }),
    ).resolves.toEqual({
      kind: "invalid-branch",
      branch: "bad..branch",
    })
    runner.expectComplete()
  })
})

describe("worktree Herdr helpers", () => {
  it("creates and opens worktrees from exact JSON ids", async () => {
    const createRunner = new FakeRunner([
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo-primary", "check-ref-format", "--branch", "worktree/fix-add-json-guide"],
        result: ok("worktree/fix-add-json-guide\n"),
      },
      {
        executable: "herdr",
        args: [
          "worktree",
          "create",
          "--cwd",
          "/repo-primary",
          "--branch",
          "worktree/fix-add-json-guide",
          "--base",
          primaryHead,
          "--no-focus",
        ],
        result: ok(
          '{"result":{"workspace":{"workspace_id":"wD1"},"root_pane":{"pane_id":"wD1:p1"},"worktree":{"path":"/repo-primary/.worktrees/fix-add-json-guide"}}}',
        ),
      },
    ])
    await expect(
      createHerdrWorktree(createRunner, {
        primaryCheckoutPath: "/repo-primary",
        branch: "worktree/fix-add-json-guide",
        baseRef: primaryHead,
      }),
    ).resolves.toEqual({
      workspaceId: "wD1",
      rootPaneId: "wD1:p1",
      checkoutPath: "/repo-primary/.worktrees/fix-add-json-guide",
    })
    createRunner.expectComplete()

    const openRunner = new FakeRunner([
      {
        executable: "herdr",
        args: [
          "worktree",
          "open",
          "--cwd",
          "/repo-primary",
          "--path",
          "/repo/.worktrees/fix-add-json-guide",
          "--no-focus",
        ],
        result: ok(
          '{"result":{"workspace":{"workspace_id":"wD2"},"root_pane":{"pane_id":"wD2:p1"},"worktree":{"path":"/repo/.worktrees/fix-add-json-guide"}}}',
        ),
      },
    ])
    await expect(
      openHerdrWorktree(openRunner, {
        primaryCheckoutPath: "/repo-primary",
        path: "/repo/.worktrees/fix-add-json-guide",
      }),
    ).resolves.toEqual({
      workspaceId: "wD2",
      rootPaneId: "wD2:p1",
      checkoutPath: "/repo/.worktrees/fix-add-json-guide",
    })
    openRunner.expectComplete()
  })

  it("creates or opens a worktree then launches without close or force commands", async () => {
    const createRunner = new FakeRunner([
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo-primary", "check-ref-format", "--branch", "worktree/fix-add-json-guide"],
        result: ok("worktree/fix-add-json-guide\n"),
      },
      {
        executable: "herdr",
        args: [
          "worktree",
          "create",
          "--cwd",
          "/repo-primary",
          "--branch",
          "worktree/fix-add-json-guide",
          "--base",
          primaryHead,
          "--no-focus",
        ],
        result: ok(
          '{"result":{"workspace":{"workspace_id":"wD3"},"root_pane":{"pane_id":"wD3:p1"},"worktree":{"path":"/actual/worktree-created"}}}',
        ),
      },
      {
        executable: "herdr",
        args: ["pane", "run", "wD3:p1", automatedBareCommandPreview],
        result: ok(),
      },
      {
        executable: "herdr",
        args: ["agent", "get", "wD3:p1"],
        result: ok('{"result":{"agent":{"agent_status":"idle"}}}'),
      },
      {
        executable: "herdr",
        args: ["agent", "prompt", "wD3:p1", "prompt", "--wait", "--timeout", "2000"],
        result: ok(),
      },
    ])

    await expect(
      createHerdrWorktreeAndHandoff(createRunner, {
        primaryCheckoutPath: "/repo-primary",
        branch: "worktree/fix-add-json-guide",
        baseRef: primaryHead,
        command: bareCommand,
        prompt: "prompt",
        promptDelivery: "agent",
        promptTimeoutMs: 2_000,
        timeoutMs: 5,
        pollIntervalMs: 0,
        time: clock().time,
      }),
    ).resolves.toEqual({
      workspaceId: "wD3",
      rootPaneId: "wD3:p1",
      checkoutPath: "/actual/worktree-created",
      paneId: "wD3:p1",
      commandPreview: automatedBareCommandPreview,
    })
    expect(createRunner.calls[2]?.options?.cwd).toBe("/actual/worktree-created")
    expect(createRunner.calls[4]?.options?.cwd).toBe("/actual/worktree-created")
    expect(createRunner.calls.map((call) => call.args.join(" ")).join("\n")).not.toMatch(/close|--force/)
    createRunner.expectComplete()

    const openRunner = new FakeRunner([
      {
        executable: "herdr",
        args: [
          "worktree",
          "open",
          "--cwd",
          "/repo-primary",
          "--path",
          "/repo/.worktrees/fix-add-json-guide",
          "--no-focus",
        ],
        result: ok(
          '{"result":{"workspace":{"workspace_id":"wD4"},"root_pane":{"pane_id":"wD4:p1"},"worktree":{"path":"/actual/worktree-opened"}}}',
        ),
      },
      {
        executable: "herdr",
        args: ["pane", "run", "wD4:p1", automatedBareCommandPreview],
        result: ok(),
      },
      {
        executable: "herdr",
        args: ["agent", "get", "wD4:p1"],
        result: ok('{"result":{"agent":{"agent_status":"idle"}}}'),
      },
      {
        executable: "herdr",
        args: ["agent", "prompt", "wD4:p1", "prompt", "--wait", "--timeout", "2000"],
        result: ok(),
      },
    ])

    await expect(
      openHerdrWorktreeAndHandoff(openRunner, {
        primaryCheckoutPath: "/repo-primary",
        path: "/repo/.worktrees/fix-add-json-guide",
        command: bareCommand,
        prompt: "prompt",
        promptDelivery: "agent",
        promptTimeoutMs: 2_000,
        timeoutMs: 5,
        pollIntervalMs: 0,
        time: clock().time,
      }),
    ).resolves.toEqual({
      workspaceId: "wD4",
      rootPaneId: "wD4:p1",
      checkoutPath: "/actual/worktree-opened",
      paneId: "wD4:p1",
      commandPreview: automatedBareCommandPreview,
    })
    expect(openRunner.calls[1]?.options?.cwd).toBe("/actual/worktree-opened")
    expect(openRunner.calls[3]?.options?.cwd).toBe("/actual/worktree-opened")
    expect(openRunner.calls.map((call) => call.args.join(" ")).join("\n")).not.toMatch(/close|--force/)
    openRunner.expectComplete()
  })

  it("throws a typed invalid-branch error before worktree create", async () => {
    const runner = new FakeRunner([
      {
        executable: "git",
        args: ["--no-pager", "-C", "/repo-primary", "check-ref-format", "--branch", "bad..branch"],
        error: commandFailure(
          "exited",
          "git",
          ["--no-pager", "-C", "/repo-primary", "check-ref-format", "--branch", "bad..branch"],
          {
            exitCode: 128,
            stderr: "fatal: 'bad..branch' is not a valid branch name",
          },
        ),
      },
    ])

    await expect(
      createHerdrWorktree(runner, {
        primaryCheckoutPath: "/repo-primary",
        branch: "bad..branch",
        baseRef: primaryHead,
      }),
    ).rejects.toMatchObject({
      kind: "invalid-branch",
      branch: "bad..branch",
    })
    runner.expectComplete()
  })

  it("parses plain git worktree porcelain blocks", () => {
    expect(parseGitWorktreeList(["worktree /repo", "HEAD abc", "branch refs/heads/main", ""].join("\n"))).toEqual([
      { path: "/repo", branch: "refs/heads/main", head: "abc" },
    ])
  })
})
