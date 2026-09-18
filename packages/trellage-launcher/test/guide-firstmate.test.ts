import { describe, expect, it } from "vitest"
import {
  FIRSTMATE_MAX_REQUEST_BYTES,
  FIRSTMATE_MAX_RESPONSE_BYTES,
  GUIDE_MAX_GENERATED_SPEC,
  GUIDE_MAX_ORIGINAL_INTENT,
  canonicalFirstmateJson,
  firstmateSubmissionDigest,
  parseFirstmateOrchestrationV1,
  parseFirstmateReceiptRequestV1,
  parseFirstmateSubmissionReceiptV1,
  parseFirstmateSubmissionRequestV1,
  type FirstmateSubmissionReceiptV1,
  type FirstmateSubmissionRequestV1,
} from "@trellage/guide-core"
import { FirstmateSubmissionClient } from "../src/guide-firstmate.ts"
import {
  CommandRunnerError,
  type CommandRunOptions,
  type CommandRunResult,
  type CommandRunner,
  type NativeSelectedProfile,
} from "../src/guide-launch.ts"

const sourceRevision = "a".repeat(40)
const profile: NativeSelectedProfile = {
  surface: "native",
  launcher: "fmx",
  commandPath: "/opt/trellage/bin/fmx",
  profile: "default",
  headlessPrompt: false,
  orchestration: parseFirstmateOrchestrationV1({
    schemaVersion: 1,
    kind: "firstmate",
    sourceRevision,
    taskIdPrefix: "trellage",
    workerPolicy: null,
    workerHarness: "claude",
    workerEfforts: ["low", "medium", "high", "xhigh", "max"],
    dispatchRules: "claude-single",
    submission: { schemaVersion: 1, maxRequestBytes: FIRSTMATE_MAX_REQUEST_BYTES },
  }),
}
const request = (): FirstmateSubmissionRequestV1 => parseFirstmateSubmissionRequestV1({
  schemaVersion: 1,
  requestId: "10000000-0000-4000-8000-000000000001",
  expectedFleet: {
    profile: "default",
    instanceId: "20000000-0000-4000-8000-000000000002",
    home: "/home/owner/.local/share/trellage/firstmate/default",
    sourceRevision,
  },
  originalIntent: "  Keep the original intent: café 😀\nDo not run $(anything) or expand $HOME.  ",
  generatedSpec: "Implement the approved request without changing its scope.",
  workflowId: "fleet-work",
  projectTarget: null,
})
const receipt = (
  original: FirstmateSubmissionRequestV1,
  overrides: Partial<FirstmateSubmissionReceiptV1> = {},
): FirstmateSubmissionReceiptV1 => parseFirstmateSubmissionReceiptV1({
  schemaVersion: 1,
  requestId: original.requestId,
  digest: firstmateSubmissionDigest(original),
  fleet: original.expectedFleet,
  state: "saved",
  noteId: "note-1",
  announcement: "sent",
  supervisorState: "running",
  error: null,
  ...overrides,
})
const ok = (stdout: string, stderr = ""): CommandRunResult => ({ stdout, stderr, exitCode: 0 })
const failure = (
  kind: CommandRunnerError["kind"],
  stdout = "",
  stderr = "",
): CommandRunnerError => new CommandRunnerError({
  kind,
  executable: profile.commandPath,
  args: ["submit", profile.profile, "--json"],
  message: "The fake transport did not exit successfully.",
  exitCode: 1,
  stdout,
  stderr,
})

class FakeRunner implements CommandRunner {
  readonly calls: Array<{
    readonly executable: string
    readonly args: ReadonlyArray<string>
    readonly options?: CommandRunOptions
  }> = []
  private readonly plan: Array<CommandRunResult | Error>

  constructor(plan: ReadonlyArray<CommandRunResult | Error>) {
    this.plan = [...plan]
  }

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args: [...args], ...(options === undefined ? {} : { options }) })
    const next = this.plan.shift()
    if (next === undefined) throw new Error("An unplanned command was attempted.")
    if (next instanceof Error) throw next
    return next
  }
}

describe("Firstmate native submission transport", () => {
  it.each(["saved", "handled"] as const)("accepts a validated %s receipt without claiming task completion", async (state) => {
    const original = request()
    const saved = receipt(original, { state })
    const runner = new FakeRunner([ok(JSON.stringify(saved))])
    const outcome = await new FirstmateSubmissionClient(runner, profile, "/work/project").submit(original)

    expect(outcome).toMatchObject({ status: "accepted", receipt: saved })
    expect(outcome.message).toContain("does not confirm dispatch or task completion")
    expect(runner.calls).toHaveLength(1)
    const call = runner.calls[0]!
    expect(call.executable).toBe(profile.commandPath)
    expect(call.args).toEqual(["submit", "default", "--json"])
    expect(call.options).toMatchObject({
      cwd: "/work/project",
      stdin: canonicalFirstmateJson(original),
      timeoutMs: 30_000,
      outputOverflow: "terminate",
    })
    expect(JSON.parse(call.options!.stdin!)).toEqual(original)
    expect(call.options!.stdin).toContain("\\u00e9")
    expect(call.options!.stdin).toContain("\\ud83d\\ude00")
  })

  it.each(["sent", "pending"] as const)("reports a stopped supervisor as waiting even when its wake is %s", async (announcement) => {
    const original = request()
    const saved = receipt(original, { announcement, supervisorState: "stopped" })
    const runner = new FakeRunner([ok(JSON.stringify(saved))])
    const outcome = await new FirstmateSubmissionClient(runner, profile, "/work/project").submit(original)
    expect(outcome).toMatchObject({ status: "accepted", receipt: saved })
    expect(outcome.message).toContain("Receipt snapshot: waiting for supervisor start")
    expect(outcome.message).toContain("does not confirm dispatch or task completion")
    expect(outcome.message).not.toContain("supervisor running")
    if (announcement === "sent") expect(outcome.message).toContain("wake was accepted or queued")
    expect(runner.calls).toHaveLength(1)
  })

  it("preserves durable acceptance when the supervisor wake fails with a nonzero exit", async () => {
    const original = request()
    const saved = receipt(original, {
      announcement: "failed",
      supervisorState: "stopped",
      error: { code: "wake-failed", message: "The note is saved, but the supervisor could not be notified." },
    })
    const runner = new FakeRunner([failure("exited", JSON.stringify(saved), "notification failed")])
    const outcome = await new FirstmateSubmissionClient(runner, profile, "/work/project").submit(original)

    expect(outcome).toMatchObject({ status: "accepted", receipt: saved })
    expect(outcome.message).toContain("supervisor announcement failed")
    expect(runner.calls).toHaveLength(1)
  })

  it.each(["timed-out", "aborted"] as const)("preserves complete accepted evidence on a %s transport", async (kind) => {
    const original = request()
    const saved = receipt(original, { announcement: "pending" })
    const runner = new FakeRunner([failure(kind, JSON.stringify(saved))])
    const outcome = await new FirstmateSubmissionClient(runner, profile, "/work/project").submit(original)
    expect(outcome).toMatchObject({ status: "accepted", receipt: saved })
    expect(outcome.message).toContain("pending")
  })

  it("reports an explicit structured refusal even on a nonzero exit", async () => {
    const original = request()
    const refused = receipt(original, {
      state: "rejected",
      fleet: null,
      digest: null,
      noteId: null,
      announcement: "not-needed",
      supervisorState: "unsafe",
      error: { code: "unsafe-fleet", message: "Fleet ownership is unsafe." },
    })
    const runner = new FakeRunner([failure("exited", JSON.stringify(refused))])
    await expect(new FirstmateSubmissionClient(runner, profile, "/work/project").submit(original)).resolves.toMatchObject({
      status: "rejected",
      receipt: refused,
      message: "Firstmate rejected the request: Fleet ownership is unsafe.",
    })
  })

  const wrongEvidence: ReadonlyArray<{
    readonly name: string
    readonly change: (original: FirstmateSubmissionRequestV1) => Partial<FirstmateSubmissionReceiptV1>
  }> = [
    { name: "request ID", change: () => ({ requestId: "30000000-0000-4000-8000-000000000003" }) },
    { name: "digest", change: () => ({ digest: "b".repeat(64) }) },
    { name: "fleet instance", change: (value) => ({ fleet: { ...value.expectedFleet, instanceId: value.requestId } }) },
    { name: "fleet home", change: (value) => ({ fleet: { ...value.expectedFleet, home: "/another/fleet" } }) },
    { name: "fleet profile", change: (value) => ({ fleet: { ...value.expectedFleet, profile: "other" } }) },
    { name: "source revision", change: (value) => ({ fleet: { ...value.expectedFleet, sourceRevision: "b".repeat(40) } }) },
  ]
  it.each(wrongEvidence)("refuses accepted output with a wrong $name", async ({ change }) => {
    const original = request()
    const runner = new FakeRunner([ok(JSON.stringify(receipt(original, change(original))))])
    const outcome = await new FirstmateSubmissionClient(runner, profile, "/work/project").submit(original)
    expect(outcome.status).toBe("unknown")
    expect(outcome.receipt).toBeUndefined()
    expect(outcome.message).toContain("does not match")
  })

  it.each([
    ["plain queued", ok("queued")],
    ["JSON queued", ok('"queued"')],
    ["generic busy", ok('{"busy":true}')],
    ["empty successful output", ok("")],
    ["operational refusal without a receipt", failure("exited", "", "The fleet mutation gate is unavailable.")],
    ["unreconciled producer outcome", failure("exited", "", "The inbox outcome requires reconciliation.")],
    ["malformed JSON", ok('{"state":')],
    ["incomplete saved evidence", ok('{"schemaVersion":1,"state":"saved"}')],
    ["timeout", failure("timed-out")],
    ["spawn failure", failure("spawn-failed")],
    ["oversized output", ok(" ".repeat(FIRSTMATE_MAX_RESPONSE_BYTES + 1))],
  ] as const)("keeps %s unknown and does not perform another command", async (_name, result) => {
    const runner = new FakeRunner([result])
    const outcome = await new FirstmateSubmissionClient(runner, profile, "/work/project").submit(request())
    expect(outcome.status).toBe("unknown")
    expect(outcome.receipt).toBeUndefined()
    expect(runner.calls).toHaveLength(1)
  })

  it("reconciles only through an explicit receipt lookup with the same ID and expected fleet", async () => {
    const original = request()
    const saved = receipt(original)
    const runner = new FakeRunner([failure("timed-out"), ok(JSON.stringify(saved))])
    const client = new FirstmateSubmissionClient(runner, profile, "/work/project")
    expect((await client.submit(original)).status).toBe("unknown")
    expect(runner.calls).toHaveLength(1)
    expect((await client.receipt(original)).status).toBe("accepted")
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["submit", "default", "--json"],
      ["receipt", "default", "--json"],
    ])
    const lookup = parseFirstmateReceiptRequestV1({
      schemaVersion: 1,
      requestId: original.requestId,
      expectedFleet: original.expectedFleet,
    })
    expect(runner.calls[1]!.options!.stdin).toBe(canonicalFirstmateJson(lookup))
    expect(JSON.parse(runner.calls[1]!.options!.stdin!)).toEqual(lookup)
  })

  it("requires a receipt lookup before treating not-found as authoritative absence", async () => {
    const original = request()
    const missing = receipt(original, {
      state: "not-found", digest: null, noteId: null, announcement: "not-needed",
    })
    const runner = new FakeRunner([ok(JSON.stringify(missing)), ok(JSON.stringify(missing))])
    const client = new FirstmateSubmissionClient(runner, profile, "/work/project")
    const submitted = await client.submit(original)
    expect(submitted.status).toBe("unknown")
    expect(submitted.receipt).toBeUndefined()
    expect(runner.calls).toHaveLength(1)
    expect(await client.receipt(original)).toMatchObject({ status: "not-found", receipt: missing })
    expect(runner.calls.map(({ args }) => args[0])).toEqual(["submit", "receipt"])
  })

  it("returns owned not-found evidence without replaying submission", async () => {
    const original = request()
    const missing = receipt(original, {
      state: "not-found",
      digest: null,
      noteId: null,
      announcement: "not-needed",
    })
    const runner = new FakeRunner([ok(JSON.stringify(missing))])
    const outcome = await new FirstmateSubmissionClient(runner, profile, "/work/project").receipt(original)
    expect(outcome).toMatchObject({ status: "not-found", receipt: missing })
    expect(outcome.message).toContain("does not authorize another submission")
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.args[0]).toBe("receipt")
  })

  it.each(["exited", "timed-out", "aborted"] as const)("requires a successful lookup after %s not-found output", async (kind) => {
    const original = request()
    const missing = receipt(original, {
      state: "not-found", digest: null, noteId: null, announcement: "not-needed",
    })
    const runner = new FakeRunner([
      failure(kind, JSON.stringify(missing)),
      ok(JSON.stringify(missing)),
    ])
    const client = new FirstmateSubmissionClient(runner, profile, "/work/project")
    const failed = await client.receipt(original)
    expect(failed.status).toBe("unknown")
    expect(failed.receipt).toBeUndefined()
    expect(runner.calls).toHaveLength(1)
    expect(await client.receipt(original)).toMatchObject({ status: "not-found", receipt: missing })
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["receipt", "default", "--json"],
      ["receipt", "default", "--json"],
    ])
  })

  it("does not trust not-found output without the owned fleet identity", async () => {
    const original = request()
    const missing = receipt(original, {
      state: "not-found",
      digest: null,
      fleet: null,
      noteId: null,
      announcement: "not-needed",
    })
    const runner = new FakeRunner([ok(JSON.stringify(missing))])
    expect((await new FirstmateSubmissionClient(runner, profile, "/work/project").receipt(original)).status).toBe("unknown")
  })

  it("does not accept truncated receipt prefixes or oversized stderr", async () => {
    const original = request()
    const saved = JSON.stringify(receipt(original))
    for (const response of [failure("output-limit", saved), ok(saved, "é".repeat(FIRSTMATE_MAX_RESPONSE_BYTES / 2 + 1))]) {
      const runner = new FakeRunner([response])
      expect((await new FirstmateSubmissionClient(runner, profile, "/work/project").submit(original)).status).toBe("unknown")
    }
  })

  it("stops streaming overflow and refuses even a valid final receipt", async () => {
    const original = request()
    let aborted = false
    const runner: CommandRunner = {
      run: async (_executable, _args, options) => {
        options!.onOutput!("x".repeat(FIRSTMATE_MAX_RESPONSE_BYTES + 1), "stdout")
        aborted = options!.signal!.aborted
        return ok(JSON.stringify(receipt(original)))
      },
    }
    expect((await new FirstmateSubmissionClient(runner, profile, "/work/project").submit(original)).status).toBe("unknown")
    expect(aborted).toBe(true)
  })

  it("passes cancellation into the bounded command", async () => {
    const controller = new AbortController()
    const runner: CommandRunner = {
      run: async (_executable, _args, options) => {
        expect(options!.signal!.aborted).toBe(false)
        controller.abort()
        expect(options!.signal!.aborted).toBe(true)
        throw failure("aborted")
      },
    }
    expect((await new FirstmateSubmissionClient(runner, profile, "/work/project").submit(request(), controller.signal)).status)
      .toBe("unknown")
  })
})

describe("Firstmate submission request validation", () => {
  it("requires an fmx profile with orchestration and public headless disabled", () => {
    const runner = new FakeRunner([])
    const { orchestration: _orchestration, ...noOrchestration } = profile
    for (const invalid of [noOrchestration, { ...profile, launcher: "cpx" }, { ...profile, headlessPrompt: true }]) {
      expect(() => new FirstmateSubmissionClient(runner, invalid, "/work/project")).toThrow()
    }
    expect(() => new FirstmateSubmissionClient(runner, profile, "relative")).toThrow(/absolute/u)
    expect(runner.calls).toHaveLength(0)
  })

  it("refuses an expected profile or revision that differs from the selected profile", async () => {
    const original = request()
    const runner = new FakeRunner([])
    const client = new FirstmateSubmissionClient(runner, profile, "/work/project")
    for (const expectedFleet of [
      { ...original.expectedFleet, profile: "other" },
      { ...original.expectedFleet, sourceRevision: "b".repeat(40) },
    ]) {
      expect((await client.submit({ ...original, expectedFleet })).status).toBe("rejected")
    }
    expect(runner.calls).toHaveLength(0)
  })

  it("measures canonical ASCII bytes at the advertised limit without truncating Unicode", async () => {
    const original = { ...request(), originalIntent: "é".repeat(300) }
    const bytes = Buffer.byteLength(canonicalFirstmateJson(original), "utf8")
    expect(Buffer.byteLength(JSON.stringify(original), "utf8")).toBeLessThan(bytes)
    const limited: NativeSelectedProfile = {
      ...profile,
      orchestration: { ...profile.orchestration!, submission: { schemaVersion: 1, maxRequestBytes: bytes } },
    }
    const runner = new FakeRunner([ok(JSON.stringify(receipt(original)))])
    const client = new FirstmateSubmissionClient(runner, limited, "/work/project")
    expect((await client.submit(original)).status).toBe("accepted")
    expect((await client.submit({ ...original, originalIntent: `${original.originalIntent}é` })).status).toBe("rejected")
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.options!.stdin).toBe(canonicalFirstmateJson(original))
    expect(original.originalIntent).toBe("é".repeat(300))
  })

  it("sizes receipt lookup independently of the full original payload", async () => {
    const original = { ...request(), originalIntent: "é".repeat(300) }
    const limited: NativeSelectedProfile = {
      ...profile,
      orchestration: { ...profile.orchestration!, submission: { schemaVersion: 1, maxRequestBytes: 1024 } },
    }
    const runner = new FakeRunner([ok(JSON.stringify(receipt(original)))])
    expect((await new FirstmateSubmissionClient(runner, limited, "/work/project").receipt(original)).status).toBe("accepted")
    expect(Buffer.byteLength(runner.calls[0]!.options!.stdin!, "utf8")).toBeLessThan(1024)
  })

  it("preserves valid maximum-length intent and specification, and refuses excess or normalized fields", async () => {
    const original = {
      ...request(),
      originalIntent: "意".repeat(GUIDE_MAX_ORIGINAL_INTENT),
      generatedSpec: "仕".repeat(GUIDE_MAX_GENERATED_SPEC),
    }
    const runner = new FakeRunner([ok(JSON.stringify(receipt(original)))])
    const client = new FirstmateSubmissionClient(runner, profile, "/work/project")
    expect((await client.submit(original)).status).toBe("accepted")
    for (const invalid of [
      { ...original, originalIntent: `${original.originalIntent}x` },
      { ...original, generatedSpec: `${original.generatedSpec}x` },
      { ...original, originalIntent: "x".repeat(FIRSTMATE_MAX_REQUEST_BYTES) },
      { ...request(), workflowId: " fleet-work " },
    ]) {
      expect((await client.submit(invalid)).status).toBe("rejected")
    }
    expect(runner.calls).toHaveLength(1)
    expect(JSON.parse(runner.calls[0]!.options!.stdin!)).toEqual(original)
  })
})
