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

  constructor(private readonly outcomes: ReadonlyArray<CommandRunResult | Error>) {}

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args, ...(options === undefined ? {} : { options }) })
    const outcome = this.outcomes[this.calls.length - 1]
    if (outcome === undefined) throw new Error(`Unexpected command call ${this.calls.length}`)
    if (outcome instanceof Error) throw outcome
    return outcome
  }
}

const ok = (stdout = ""): CommandRunResult => ({ stdout, stderr: "", exitCode: 0 })
const doctor = (
  developmentResolution: boolean,
  image: "available" | "absent" | "stale" | "error",
  profile = "prime-agent",
): string =>
  `profile: ${profile} (/repo/profiles/${profile}/profile.toml)\ndevelopment resolution: ${developmentResolution}\nimage: test/image (${image})\n`

describe("selected profile readiness", () => {
  it("uses native inventory and accepts only a matching healthy identity", async () => {
    const runner = new FakeRunner([ok('{"schemaVersion":1,"launcher":"cpx","profile":"hve","readiness":"healthy"}')])

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
    const runner = new FakeRunner([
      ok('{"schemaVersion":1,"launcher":"cpx","profile":"awesome","readiness":"not-setup"}'),
    ])

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

  it("blocks busy native profiles with a retry diagnostic", async () => {
    const runner = new FakeRunner([ok('{"schemaVersion":1,"launcher":"prx","profile":"default","readiness":"busy"}')])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "native",
          launcher: "prx",
          commandPath: "/opt/trellage/bin/prx",
          profile: "default",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Blocked,
      summary: "prx/default is busy",
      diagnostic: "Wait for the current prx operation to finish, then retry.",
    })
  })

  it("rejects mismatched native inventory output", async () => {
    const runner = new FakeRunner([ok('{"schemaVersion":1,"launcher":"cpx","profile":"other","readiness":"healthy"}')])

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

  it("accepts a Sandbox profile with a current resolution and image", async () => {
    const runner = new FakeRunner([ok(doctor(true, "available"))])

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
      kind: ProfileReadinessKind.Ready,
      summary: "prime-agent is ready",
    })
    expect(runner.calls).toEqual([
      {
        executable: "/opt/trellage/bin/trellage",
        args: ["doctor", "--profile", "prime-agent"],
        options: { cwd: "/repo", timeoutMs: 300_000 },
      },
    ])
  })

  it("automatically builds and rechecks an unprepared Sandbox profile", async () => {
    const runner = new FakeRunner([
      ok(doctor(false, "absent", "headlong")),
      ok(),
      ok(doctor(true, "available", "headlong")),
    ])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "sandbox",
          commandPath: "/opt/trellage/bin/trellage",
          profile: "headlong",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Ready,
      summary: "headlong was repaired and is ready",
    })
    expect(runner.calls.map(({ args, options }) => ({ args, timeoutMs: options?.timeoutMs }))).toEqual([
      { args: ["doctor", "--profile", "headlong"], timeoutMs: 300_000 },
      { args: ["build", "headlong"], timeoutMs: 1_800_000 },
      { args: ["doctor", "--profile", "headlong"], timeoutMs: 300_000 },
    ])
    expect(runner.calls[1]?.options?.outputOverflow).toBe("truncate")
  })

  it("converts Sandbox automatic build failures to blocked diagnostics", async () => {
    const runner = new FakeRunner([
      ok(doctor(false, "absent")),
      new CommandRunnerError({
        kind: "exited",
        executable: "/opt/trellage/bin/trellage",
        args: ["build", "prime-agent"],
        exitCode: 1,
        stderr: "build failed",
        message: "automatic build failed",
      }),
    ])

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
      summary: "prime-agent automatic repair failed",
      diagnostic: "build failed",
    })
  })

  it("blocks a Sandbox profile that remains stale after automatic repair", async () => {
    const runner = new FakeRunner([
      ok(doctor(true, "stale", "headlong")),
      ok(),
      ok(doctor(true, "stale", "headlong")),
    ])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "sandbox",
          commandPath: "/opt/trellage/bin/trellage",
          profile: "headlong",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Blocked,
      summary: "headlong remains unavailable after automatic repair",
      diagnostic: "Development resolution: true; image: stale.",
    })
  })
})
