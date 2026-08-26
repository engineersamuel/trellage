import { describe, expect, it } from "vitest"

import {
  CommandRunnerError,
  type CommandRunOptions,
  type CommandRunResult,
  type CommandRunner,
} from "../src/guide-launch.js"
import { checkSelectedProfileReadiness, ProfilePreflightError, ProfileReadinessKind } from "../src/guide-preflight.js"

class FakeRunner implements CommandRunner {
  readonly calls: Array<{
    readonly executable: string
    readonly args: ReadonlyArray<string>
    readonly options?: CommandRunOptions
  }> = []

  constructor(private readonly outcome: CommandRunResult | Error) {}

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args, ...(options === undefined ? {} : { options }) })
    if (this.outcome instanceof Error) throw this.outcome
    return this.outcome
  }
}

const ok = (stdout = ""): CommandRunResult => ({ stdout, stderr: "", exitCode: 0 })

describe("selected profile readiness", () => {
  it("uses native inventory and accepts only a matching healthy identity", async () => {
    const runner = new FakeRunner(ok('{"schemaVersion":1,"launcher":"cpx","profile":"hve","readiness":"healthy"}'))

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "native",
          launcher: "cpx",
          commandPath: "/opt/trellage/bin/cpx",
          profile: "hve",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Ready,
      summary: "cpx/hve is healthy",
    })
    expect(runner.calls[0]).toMatchObject({
      executable: "/opt/trellage/bin/cpx",
      args: ["inventory", "hve", "--json"],
      options: { cwd: "/repo", timeoutMs: 30_000 },
    })
  })

  it("blocks native profiles that are not set up", async () => {
    const runner = new FakeRunner(
      ok('{"schemaVersion":1,"launcher":"cpx","profile":"awesome","readiness":"not-setup"}'),
    )

    const result = await checkSelectedProfileReadiness(
      runner,
      {
        surface: "native",
        launcher: "cpx",
        commandPath: "/opt/trellage/bin/cpx",
        profile: "awesome",
        headlessPrompt: false,
      },
      "/repo",
    )

    expect(result).toMatchObject({
      kind: ProfileReadinessKind.Blocked,
      summary: "cpx/awesome is not-setup",
    })
  })

  it("rejects mismatched native inventory output", async () => {
    const runner = new FakeRunner(ok('{"schemaVersion":1,"launcher":"cpx","profile":"other","readiness":"healthy"}'))

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "native",
          launcher: "cpx",
          commandPath: "/opt/trellage/bin/cpx",
          profile: "hve",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).rejects.toThrow(ProfilePreflightError)
  })

  it("runs Sandbox validation and converts command failures to blocked diagnostics", async () => {
    const runner = new FakeRunner(
      new CommandRunnerError({
        kind: "exited",
        executable: "/opt/trellage/bin/trellage",
        args: ["validate", "prime-agent"],
        exitCode: 1,
        stderr: "invalid profile",
        message: "validation failed",
      }),
    )

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "sandbox",
          commandPath: "/opt/trellage/bin/trellage",
          profile: "prime-agent",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Blocked,
      summary: "prime-agent failed validation",
      diagnostic: "invalid profile",
    })
    expect(runner.calls[0]).toMatchObject({
      executable: "/opt/trellage/bin/trellage",
      args: ["validate", "prime-agent"],
    })
  })
})
