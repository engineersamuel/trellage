import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createNodeCommandRunner } from "../src/guide-launch.ts"
import { inspectGuideOptimizeTarget } from "../src/guide-optimize-target.ts"
import { type ReviewRun } from "../src/review-contracts.ts"
import { reviewCheckCatalog } from "../src/review-catalog.ts"
import {
  createLiveReviewFixture,
  liveReviewFailures,
  reviewBatchCounts,
  parseLiveReviewArguments,
  runLiveReviewTest,
  runLiveReviewMatrix,
} from "../src/review-live-test.ts"

const roots: string[] = []
const temporary = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-live-contract-"))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const complete = (): Parameters<typeof liveReviewFailures>[0] => ({
  status: "complete",
  synthesisStatus: "complete",
  calls: 3,
  error: null,
  approvedIds: [],
  execution: "not-started",
  results: [{ id: "ponytail", status: "complete", reportId: "ponytail:report", findings: [], limitations: [] }],
  artifacts: [
    { id: "ponytail:report", checkId: "ponytail", name: "ponytail.md", content: "No findings.", digest: "test" },
  ],
})

describe("live review acceptance harness (offline contracts)", () => {
  it("requires consent and an explicit target before any runtime access", () => {
    expect(parseLiveReviewArguments(["--help"])).toBeUndefined()
    expect(() => parseLiveReviewArguments(["--fixture"])).toThrow("Explicit --live")
    expect(() => parseLiveReviewArguments(["--live"])).toThrow("exactly one")
    expect(() => parseLiveReviewArguments(["--live", "--fixture", "--cwd", "."])).toThrow("exactly one")
    expect(parseLiveReviewArguments(["--live", "--fixture"])).toMatchObject({
      checks: ["ponytail"],
      scope: { kind: "uncommitted" },
      timeoutMs: 1_800_000,
    })
  })

  it.each([
    { args: ["--check", "unknown"], error: "Unsupported review check" },
    { args: ["--check", "ponytail", "--check", "ponytail"], error: "distinct review checks" },
    ...["0", "Infinity", "7201", "1.5"].map((value) => ({
      args: ["--timeout-seconds", value],
      error: "--timeout-seconds must be an integer",
    })),
    { args: ["--path", ""], error: "--path values" },
    { args: ["--path", "a", "--path", "a"], error: "--path values" },
    { args: ["--base", "main"], error: "--base cannot be combined" },
    { args: ["--unknown"], error: "Unknown option" },
  ])("rejects invalid fixture options $args", ({ args, error }) => {
    expect(() => parseLiveReviewArguments(["--live", "--fixture", ...args])).toThrow(error)
  })

  it("selects real checks and a Git scope without changing model defaults", () => {
    expect(
      parseLiveReviewArguments([
        "--live",
        "--cwd",
        ".",
        "--base",
        "main",
        "--check",
        "ponytail",
        "--check",
        "fleet",
        "--path",
        "code.ts",
      ]),
    ).toMatchObject({
      cwd: process.cwd(),
      checks: ["ponytail", "fleet"],
      paths: ["code.ts"],
      scope: { kind: "branch", baseRef: "main" },
    })
    expect(() => parseLiveReviewArguments(["--live", "--cwd", ".", "--base", "main", "--uncommitted"])).toThrow(
      "--base cannot be combined",
    )
  })

  it("selects the same complete reviewer catalog for the independent matrix", () => {
    const input = parseLiveReviewArguments(["--live", "--fixture", "--all"])!
    expect(input.all).toBe(true)
    expect(input.checks).toEqual(reviewCheckCatalog.map((check) => check.id))
    expect(() => parseLiveReviewArguments(["--live", "--fixture", "--all", "--check", "ponytail"])).toThrow(
      "Choose --all or --check",
    )
    expect(() => parseLiveReviewArguments(["--fixture", "--all"])).toThrow("Explicit --live")
  })

  it.each(["success", "failure", "cancelled"] as const)(
    "runs isolated matrix cases and persists each outcome: %s",
    async (outcome) => {
      const root = await temporary()
      const input = parseLiveReviewArguments(["--live", "--fixture", "--all"])!
      const controller = new AbortController()
      const runCase = vi.fn<typeof runLiveReviewTest>(async (selected, output) => {
        const passed = outcome !== "failure" || selected.checks[0] !== input.checks[0]
        if (outcome === "cancelled") controller.abort()
        return {
          schemaVersion: 1,
          passed,
          startedAt: "start",
          finishedAt: "finish",
          output,
          cwd: undefined,
          reviewId: "offline",
          status: passed ? "complete" : "incomplete",
          synthesisStatus: "complete",
          checks: [],
          calls: 3,
          batchCounts: {},
          sourceFingerprint: undefined,
          failure: undefined,
          recordPath: undefined,
          worktreeUnchanged: true,
          failures: passed ? [] : ["Fixture failure"],
        }
      })
      const matrix = await runLiveReviewMatrix(input, root, controller.signal, runCase)
      const completed = outcome === "cancelled" ? input.checks.slice(0, 1) : input.checks
      expect(matrix.passed).toBe(outcome === "success")
      expect(matrix.cases.map(({ check }) => check)).toEqual(completed)
      expect(matrix.notRun).toEqual(outcome === "cancelled" ? input.checks.slice(1) : [])
      expect(matrix.calls).toBe(completed.length * 3)
      expect(runCase.mock.calls.map(([selected]) => selected.checks)).toEqual(completed.map((id) => [id]))
      expect(runCase.mock.calls.every(([selected]) => !selected.all)).toBe(true)
      for (const entry of matrix.cases) {
        const summary = path.join(root, entry.check, "summary.json")
        expect(JSON.parse(await readFile(summary, "utf8"))).toMatchObject({
          passed: entry.result.passed,
          output: path.join(root, entry.check),
        })
        expect((await stat(summary)).mode & 0o777).toBe(0o600)
      }
    },
  )

  it("accepts completion without requiring a fixed LLM finding count", () => {
    expect(liveReviewFailures(complete(), ["ponytail"])).toEqual([])
  })

  it("counts persisted evidence batches and can require a multi-batch Architecture fixture", () => {
    const run = {
      ...complete(),
      results: [{
        id: "improve-codebase-architecture" as const,
        status: "complete" as const,
        reportId: "improve-codebase-architecture:report",
        findings: [],
        limitations: [],
      }],
      artifacts: [
        {
          id: "improve-codebase-architecture:batch-evidence-1",
          checkId: "improve-codebase-architecture" as const,
          name: "batch-1.md",
          content: "Batch 1",
          digest: "one",
        },
        {
          id: "improve-codebase-architecture:report",
          checkId: "improve-codebase-architecture" as const,
          name: "report.md",
          content: "Report",
          digest: "report",
        },
      ],
    }
    expect(reviewBatchCounts(run.artifacts)).toEqual({ "improve-codebase-architecture": 1 })
    expect(liveReviewFailures(run, ["improve-codebase-architecture"], { minimumArchitectureBatches: 2 }))
      .toContain("Architecture fixture produced 1 evidence batch; expected at least 2.")
  })

  it("fails when the report exists but structured extraction fails", () => {
    const run = complete()
    const failed = {
      ...run,
      status: "incomplete" as const,
      results: [
        {
          ...run.results[0]!,
          status: "failed" as const,
          error: "Finding normalization failed: validation=schema-invalid; statusCode=400",
        },
      ],
    }
    expect(liveReviewFailures(failed, ["ponytail"])).toContain(
      "ponytail: Finding normalization failed: validation=schema-invalid; statusCode=400.",
    )
    expect(liveReviewFailures(failed, ["ponytail"])).not.toContain("Synthesis did not complete.")
  })

  it.each(["partial", "failed"] as const)("rejects %s checks even if the run claims completion", (status) => {
    const run = complete()
    expect(liveReviewFailures({ ...run, results: [{ ...run.results[0]!, status }] }, ["ponytail"])).not.toEqual([])
  })

  it.each([
    { artifacts: [] },
    { results: [] },
    { calls: 0 },
    { error: "Cleanup failed" },
    { synthesisStatus: "failed" },
    { approvedIds: ["finding"] },
    { execution: "launched" },
  ] satisfies ReadonlyArray<Partial<ReviewRun>>)("rejects missing evidence and unsafe outcomes: %j", (override) => {
    expect(liveReviewFailures({ ...complete(), ...override }, ["ponytail"])).not.toEqual([])
  })

  it("rejects duplicate results and reports attributed to another check", () => {
    const run = complete()
    expect(liveReviewFailures({ ...run, results: [...run.results, ...run.results] }, ["ponytail"])).not.toEqual([])
    expect(
      liveReviewFailures({ ...run, artifacts: [{ ...run.artifacts[0]!, checkId: "fleet" }] }, ["ponytail"]),
    ).not.toEqual([])
  })

  it("creates a real changed Git fixture with HEAD for production evidence capture", async () => {
    const root = await temporary()
    const runner = createNodeCommandRunner()
    const signal = new AbortController().signal
    const cwd = await createLiveReviewFixture(root, runner, signal)
    const target = await inspectGuideOptimizeTarget(runner, cwd, { kind: "uncommitted" }, signal)
    expect(target.head).toMatch(/^[0-9a-f]{40,64}$/u)
    expect(target.changes.map(({ path: name, unstaged, kind }) => ({ name, unstaged, kind }))).toEqual([
      { name: "labels.ts", unstaged: true, kind: "file" },
    ])
  })

  it("builds a large synthetic fixture in bounded files and validates the option", async () => {
    const options = parseLiveReviewArguments(["--live", "--fixture", "--fixture-bytes", "1200000"])!
    expect(options.fixtureBytes).toBe(1_200_000)
    expect(() => parseLiveReviewArguments(["--live", "--cwd", "/tmp", "--fixture-bytes", "1"])).toThrow("--fixture")
    expect(() => parseLiveReviewArguments(["--live", "--fixture", "--fixture-bytes", "8000001"])).toThrow("8000000")
    const root = await temporary()
    const runner = createNodeCommandRunner()
    const signal = new AbortController().signal
    const cwd = await createLiveReviewFixture(root, runner, signal, options.fixtureBytes)
    const target = await inspectGuideOptimizeTarget(runner, cwd, { kind: "uncommitted" }, signal)
    const sizes = await Promise.all(target.changes.filter((change) => change.untracked).map(async (change) =>
      (await stat(path.join(cwd, change.path))).size))
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThanOrEqual(1_200_000)
    expect(sizes.every((size) => size < 1_000_000)).toBe(true)
  })

  it("records cancellation as a failed outcome without calling a model", async () => {
    const root = await temporary()
    const input = parseLiveReviewArguments(["--live", "--fixture"])!
    const controller = new AbortController()
    controller.abort()
    const result = await runLiveReviewTest(input, root, controller.signal)
    expect(result.passed).toBe(false)
    expect(result.calls).toBe(0)
    expect(result.failures).toContain("Live review cancelled.")
    expect(await readFile(path.join(root, "events.ndjson"), "utf8")).toBe("")
    expect((await stat(path.join(root, "events.ndjson"))).mode & 0o777).toBe(0o600)
  })
})
