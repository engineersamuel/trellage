import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createNodeCommandRunner, type CommandRunner } from "../src/guide-launch.ts"
import { defaultGuideModelRouting } from "../src/guide-model-routing.ts"
import { checkGuideOptimization, parseOptimizeCheckArguments } from "../src/guide-optimize-check.ts"
import {
  captureOptimizeEvidence,
  optimizeDigest,
  optimizeEvidenceLimits,
  optimizeEvidenceTools,
} from "../src/guide-optimize-evidence.ts"
import {
  newOptimizeReview,
  optimizeApproval,
  optimizeReviewDocument,
  optimizeReviewersFor,
  parseOptimizeCitations,
  runOptimizeReview,
  type OptimizeModelCall,
  type OptimizeReview,
} from "../src/guide-optimize-review.ts"
import { loadOptimizeArchitecture } from "../src/guide-optimize-skills.ts"
import { OptimizeReviewStore } from "../src/guide-optimize-store.ts"
import { inspectGuideOptimizeTarget } from "../src/guide-optimize-target.ts"
import { array, record } from "../src/guide-text.ts"
import {
  fixtureOptimizeModel,
  fixtureOptimizeModelInfo,
  invokeReviewTool,
  readReviewEvidence,
} from "./fixtures/guide-optimize-model.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const temporary = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "guide-review-")))
  roots.push(root)
  return root
}

const replySchema = (request: Parameters<OptimizeModelCall>[0], key: "responses" | "decisions") => {
  const root = record(request.responseFormat?.jsonSchema.schema, "schema")
  const properties = record(root.properties, "properties")
  const rows = record(properties[key], key)
  const item = record(rows.items, "item")
  const itemProperties = record(item.properties, "item properties")
  return {
    minItems: rows.minItems,
    maxItems: rows.maxItems,
    findingId: record(itemProperties.findingId, "findingId"),
  }
}

const modelWithSecondFinding = async (request: Parameters<OptimizeModelCall>[0]): Promise<string> => {
  const output = record(JSON.parse(await fixtureOptimizeModel(request)), "response")
  if (
    request.responseFormat?.jsonSchema.name === "optimize_report" &&
    request.systemPrompt.includes("Independently review the changed implementation")
  ) {
    output.findings = [
      {
        title: "Preserve selected validation",
        proposal: "Keep the check that rejects an empty selected value.",
        benefit: "The existing input contract remains explicit.",
        risk: "The caller must continue to supply the selected path.",
        verification: "Exercise both empty and populated selections.",
        paths: ["code.ts"],
        citations: [{ source: "code.ts", startLine: 1, endLine: 1 }],
      },
    ]
  }
  return JSON.stringify(output)
}

const fixture = async (content = "return value\n") => {
  const root = await temporary()
  const runner = createNodeCommandRunner()
  const git = async (...args: string[]) => (await runner.run("git", args, { cwd: root })).stdout
  await git("init", "-q", "-b", "main")
  await git("config", "user.name", "Fixture")
  await git("config", "user.email", "fixture@example.invalid")
  await git("config", "commit.gpgsign", "false")
  await git("config", "core.hooksPath", "/dev/null")
  await writeFile(path.join(root, "code.ts"), "return original\n")
  await writeFile(path.join(root, "README.md"), "Related source context.\n")
  await writeFile(path.join(root, ".env"), "SYNTHETIC_TEST_VALUE=not-a-credential\n")
  await writeFile(path.join(root, "image.dat"), Buffer.from([0, 255, 0]))
  await git("add", ".")
  await git("commit", "-qm", "Initial")
  await writeFile(path.join(root, "code.ts"), content)
  await writeFile(path.join(root, "unselected.txt"), "Unselected local notes.\n")
  const signal = new AbortController().signal
  const target = await inspectGuideOptimizeTarget(runner, root, { kind: "uncommitted" }, signal)
  const input = { target, paths: ["code.ts"], reviewerIds: ["first-principles", "behavior-preservation"] }
  const evidence = await captureOptimizeEvidence(runner, target, input.paths, signal)
  const initial = newOptimizeReview(
    input,
    evidence,
    optimizeReviewersFor(defaultGuideModelRouting),
    defaultGuideModelRouting.optimize,
  )
  const store = new OptimizeReviewStore(target.gitDirectory)
  const saved: OptimizeReview[] = []
  const run = async (call: OptimizeModelCall = fixtureOptimizeModel, abort = signal) =>
    runOptimizeReview(
      initial,
      async (review) => {
        saved.push(review)
      },
      abort,
      () => {},
      call,
    )
  return { root, runner, git, signal, target, input, evidence, initial, store, saved, run }
}

type ChallengeRepairMode = "malformed" | "citation" | "both"
type ChallengeFault = "malformed" | "citation"
type ReviewFixture = Awaited<ReturnType<typeof fixture>>

const challengeCorrection = (request: Parameters<OptimizeModelCall>[0]): Record<string, unknown> | undefined => {
  const prompt = record(JSON.parse(request.prompt), "request")
  return prompt.correction === undefined ? undefined : record(prompt.correction, "correction")
}

const challengeReviewerId = (request: Parameters<OptimizeModelCall>[0]): string =>
  request.systemPrompt.includes("Independently review the changed implementation")
    ? "behavior-preservation"
    : "first-principles"

const challengeFaultFor = (mode: ChallengeRepairMode, reviewerId: string): ChallengeFault | undefined => {
  if (reviewerId === "first-principles") {
    if (mode === "citation") return "citation"
    if (mode === "malformed" || mode === "both") return "malformed"
  }
  if (mode === "both" && reviewerId === "behavior-preservation") return "citation"
  return undefined
}

const corruptChallenge = (response: string, fault: ChallengeFault): string => {
  if (fault === "malformed") return '{"responses":['
  const output = record(JSON.parse(response), "challenge")
  const entry = record(array(output.responses, "responses")[0], "response")
  const citation = record(array(entry.citations, "citations")[0], "citation")
  citation.endLine = 99
  return JSON.stringify(output)
}

const repairModelCall =
  (
    f: ReviewFixture,
    mode: ChallengeRepairMode,
    rejected: Map<string, string>,
    originalReadTools: Map<string, unknown>,
    persistedCalls: number[],
  ): OptimizeModelCall =>
  async (request) => {
    if (request.responseFormat?.jsonSchema.name !== "optimize_challenge") return fixtureOptimizeModel(request)
    const reviewerId = challengeReviewerId(request)
    const correction = challengeCorrection(request)
    persistedCalls.push(f.saved.at(-1)?.calls ?? -1)
    const readHandler = request.tools?.find((tool) => tool.name === "read_review_source")?.handler
    if (correction === undefined) originalReadTools.set(reviewerId, readHandler)
    else {
      expect(correction.rejectedResponse).toBe(rejected.get(reviewerId))
      expect(correction.validationDiagnostic).toEqual(expect.any(String))
      expect(request.systemPrompt).toContain("full corrected response")
      expect(request.systemPrompt).toContain("not a patch")
      expect(readHandler).not.toBe(originalReadTools.get(reviewerId))
    }
    const response = await fixtureOptimizeModel(request)
    const fault = correction === undefined ? challengeFaultFor(mode, reviewerId) : undefined
    if (fault === undefined) return response
    const rejectedResponse = corruptChallenge(response, fault)
    rejected.set(reviewerId, rejectedResponse)
    return rejectedResponse
  }

const expectCorrectionPayloads = (call: ReturnType<typeof vi.fn<OptimizeModelCall>>, rejected: Map<string, string>) => {
  for (const [reviewerId, rejectedResponse] of rejected) {
    const repair = call.mock.calls.find(([request]) => {
      const correction = challengeCorrection(request)
      return correction?.rejectedResponse === rejectedResponse && challengeReviewerId(request) === reviewerId
    })?.[0]
    expect(repair).toBeDefined()
    const correction = challengeCorrection(repair!)!
    expect(correction.validationDiagnostic).toEqual(expect.any(String))
    if (rejectedResponse.includes('"endLine":99')) {
      expect(correction.validationDiagnostic).toContain('"code.ts":1-99')
      expect(correction.validationDiagnostic).toContain("between 1 and 2")
    } else {
      expect(correction.validationDiagnostic).toContain("invalid JSON")
    }
    expect(repair?.responseFormat?.jsonSchema.name).toBe("optimize_challenge")
  }
}

describe("bounded read-only Optimize reviews", () => {
  it("captures related tracked text and selected diffs, but excludes secrets, binary data, and other untracked files", async () => {
    const f = await fixture()
    expect(f.evidence.sources.map((entry) => entry.id)).toEqual([
      "README.md",
      "code.ts",
      "@diff/staged",
      "@diff/unstaged",
    ])
    expect(f.evidence.excluded).toEqual([
      { path: ".env", reason: "private or unsafe path" },
      { path: "image.dat", reason: "not supported UTF-8 source text" },
    ])
    expect(f.evidence.sources.at(-1)?.content).toContain("+return value")
    await expect(captureOptimizeEvidence(f.runner, f.target, [".env"], f.signal)).rejects.toThrow("not part")
    await rm(path.join(f.root, ".env"))
    const target = await inspectGuideOptimizeTarget(f.runner, f.root, { kind: "uncommitted" }, f.signal)
    await expect(captureOptimizeEvidence(f.runner, target, [".env"], f.signal)).rejects.toThrow("private or unsafe")
  })

  it("serves immutable text without exposing shell, file writes, or live filesystem access", async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, "code.ts"), "unreviewed content\n")
    const access = optimizeEvidenceTools(f.evidence, f.signal)
    expect(access.tools.map((entry) => entry.name)).toEqual([
      "list_review_sources",
      "read_review_source",
      "search_review_sources",
    ])
    const tool = access.tools[1]!
    const result = await tool.handler!(
      { source: "code.ts", startLine: 1, lineCount: 1 },
      {
        sessionId: "fixture",
        toolName: tool.name,
        toolCallId: "1",
        arguments: {},
      },
    )
    expect(result).toMatchObject({ resultType: "success", textResultForLlm: expect.stringContaining("return value") })
    expect(() =>
      tool.handler!(
        { source: "../outside", startLine: 1, lineCount: 1 },
        {
          sessionId: "fixture",
          toolName: tool.name,
          toolCallId: "2",
          arguments: {},
        },
      ),
    ).toThrow("not in the frozen")
  })

  it("reports absolute line numbers and remaining required ranges after each delivered page", async () => {
    const f = await fixture(Array.from({ length: 430 }, (_, index) => `  value${index + 1}`).join("\n"))
    const required = [
      { source: "code.ts", startLine: 417, endLine: 430 },
      { source: "README.md", startLine: 1, endLine: 1 },
    ]
    const access = optimizeEvidenceTools(f.evidence, f.signal, required)
    const read = async (source: string, startLine: number, lineCount: number) => {
      const args = { source, startLine, lineCount }
      const result = record(
        await access.tools[1]!.handler!(args, {
          sessionId: "fixture",
          toolName: "read_review_source",
          toolCallId: "page",
          arguments: args,
        }),
        "tool result",
      )
      if (typeof result.textResultForLlm !== "string") throw new Error("Missing tool output.")
      return record(JSON.parse(result.textResultForLlm), "page")
    }
    const page = await read("code.ts", 417, 2)
    expect(page.lines).toEqual({ 417: "  value417", 418: "  value418" })
    expect(page.nextLine).toBe(419)
    expect(page.remainingRequired).toEqual([{ source: "code.ts", startLine: 419, endLine: 430 }, required[1]])
    expect(() => access.assertComplete([], required)).toThrow("code.ts:419-430")
    await read("code.ts", 420, 11)
    expect((await read("README.md", 1, 1)).remainingRequired).toEqual([
      { source: "code.ts", startLine: 419, endLine: 419 },
    ])
    expect((await read("code.ts", 419, 1)).remainingRequired).toEqual([])
    expect(() => access.assertComplete([], required)).not.toThrow()
  })

  it.each([
    ["blank.ts", "\n \t\n"],
    ["two  spaces.ts", "return value\n"],
  ])("captures %s without normalizing its name or content", async (name, content) => {
    const f = await fixture()
    await writeFile(path.join(f.root, name), content)
    const target = await inspectGuideOptimizeTarget(f.runner, f.root, { kind: "uncommitted" }, f.signal)
    const evidence = await captureOptimizeEvidence(f.runner, target, [name], f.signal)
    expect(evidence.sources.find((entry) => entry.id === name)?.content).toBe(content)
    const access = optimizeEvidenceTools(evidence, f.signal)
    const tool = access.tools[1]!
    await tool.handler!(
      { source: name, startLine: 1, lineCount: 120 },
      {
        sessionId: "fixture",
        toolName: tool.name,
        toolCallId: "1",
        arguments: {},
      },
    )
    expect(() => access.assertComplete([name])).not.toThrow()
  })

  it("keeps initial reports independent and saves one challenge round before synthesis", async () => {
    const f = await fixture()
    const call = vi.fn<OptimizeModelCall>(fixtureOptimizeModel)
    const completed = await f.run(call)
    expect(completed).toMatchObject({ status: "complete", calls: 5, approvedIds: [], execution: "not-started" })
    expect(completed.reports).toHaveLength(2)
    expect(completed.challenges).toHaveLength(2)
    expect(completed.decisions).toEqual([
      expect.objectContaining({ findingId: "first-principles:1", disposition: "recommended" }),
    ])
    expect(call.mock.calls.slice(0, 2).map(([request]) => record(JSON.parse(request.prompt), "input").data)).toEqual([
      {},
      {},
    ])
    expect(call.mock.calls.map(([request]) => request.responseFormat?.jsonSchema.name)).toEqual([
      "optimize_report",
      "optimize_report",
      "optimize_challenge",
      "optimize_challenge",
      "optimize_verdict",
    ])
    expect(call.mock.calls.every(([request]) => request.responseFormat?.jsonSchema.strict === true)).toBe(true)
    for (const request of call.mock.calls
      .map(([request]) => request)
      .filter((entry) =>
        ["optimize_challenge", "optimize_verdict"].includes(entry.responseFormat?.jsonSchema.name ?? ""),
      )) {
      expect(record(JSON.parse(request.prompt), "prompt").requiredFindingIds).toEqual(["first-principles:1"])
    }
    const challengeRequest = call.mock.calls.find(
      ([request]) => request.responseFormat?.jsonSchema.name === "optimize_challenge",
    )?.[0]
    const verdictRequest = call.mock.calls.find(
      ([request]) => request.responseFormat?.jsonSchema.name === "optimize_verdict",
    )?.[0]
    expect(challengeRequest).toBeDefined()
    expect(verdictRequest).toBeDefined()
    expect(replySchema(challengeRequest!, "responses")).toEqual({
      minItems: 1,
      maxItems: 1,
      findingId: { type: "string", minLength: 1, maxLength: 100, enum: ["first-principles:1"] },
    })
    expect(replySchema(verdictRequest!, "decisions")).toEqual({
      minItems: 1,
      maxItems: 1,
      findingId: { type: "string", minLength: 1, maxLength: 100, enum: ["first-principles:1"] },
    })
    expect(challengeRequest?.systemPrompt).toContain("Use uncertain when evidence is insufficient")
    expect(verdictRequest?.systemPrompt).toContain("Use unresolved when evidence is insufficient")
    expect(f.saved.some((entry) => entry.challenges.length === 2 && entry.status === "running")).toBe(true)
    expect(f.saved.at(-1)).toEqual(completed)
  })

  it.each(["malformed", "citation", "both"] as const)(
    "repairs %s challenge validation failures once with the rejected response and fresh evidence tools",
    async (mode) => {
      const f = await fixture()
      const rejected = new Map<string, string>()
      const persistedCalls: number[] = []
      const call = vi.fn<OptimizeModelCall>(
        repairModelCall(f, mode, rejected, new Map<string, unknown>(), persistedCalls),
      )
      const review = await f.run(call)
      const expectedCorrections = mode === "both" ? 2 : 1
      expect(review).toMatchObject({ status: "complete", calls: 5 + expectedCorrections })
      expect(call).toHaveBeenCalledTimes(5 + expectedCorrections)
      expect(persistedCalls).toEqual([4, 4, ...Array(expectedCorrections).fill(4 + expectedCorrections)])
      expectCorrectionPayloads(call, rejected)
    },
  )

  it("keeps a corrected independent report free of peer findings and citations", async () => {
    const f = await fixture()
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      if (
        request.responseFormat?.jsonSchema.name !== "optimize_report" ||
        !request.systemPrompt.includes("Independently review the changed implementation")
      ) {
        return fixtureOptimizeModel(request)
      }
      const prompt = record(JSON.parse(request.prompt), "request")
      if (prompt.correction === undefined) {
        await readReviewEvidence(request)
        return '{"findings":['
      }
      expect(prompt.data).toEqual({})
      expect(prompt.requiredCitations).toEqual([])
      return fixtureOptimizeModel(request)
    })

    const review = await f.run(call)
    expect(review).toMatchObject({ status: "complete", calls: 6 })
    expect(call).toHaveBeenCalledTimes(6)
  })

  it("repairs semantic finding coverage by returning the complete response again", async () => {
    const f = await fixture()
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      const isChallenge = request.responseFormat?.jsonSchema.name === "optimize_challenge"
      const payload = record(JSON.parse(request.prompt), "request")
      const correction = payload.correction === undefined ? undefined : record(payload.correction, "correction")
      const output = record(JSON.parse(await modelWithSecondFinding(request)), "response")
      if (
        isChallenge &&
        correction === undefined &&
        !request.systemPrompt.includes("Independently review the changed implementation")
      ) {
        output.responses = array(output.responses, "responses").filter(
          (value) => record(value, "response").findingId !== "behavior-preservation:1",
        )
      }
      if (isChallenge && correction !== undefined) {
        expect(correction.validationDiagnostic).toContain("missing: behavior-preservation:1")
      }
      return JSON.stringify(output)
    })

    const review = await f.run(call)
    expect(review).toMatchObject({ status: "complete", calls: 6 })
    expect(review.challenges).toHaveLength(2)
    expect(review.challenges[0]?.responses.map(({ findingId }) => findingId)).toEqual([
      "first-principles:1",
      "behavior-preservation:1",
    ])
    expect(call).toHaveBeenCalledTimes(6)
  })

  it("fails closed when a corrected challenge still fails validation", async () => {
    const f = await fixture()
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      if (
        request.responseFormat?.jsonSchema.name === "optimize_challenge" &&
        !request.systemPrompt.includes("Independently review the changed implementation")
      ) {
        await readReviewEvidence(request)
        return '{"responses":['
      }
      return fixtureOptimizeModel(request)
    })

    const review = await f.run(call)
    expect(review).toMatchObject({ status: "incomplete", calls: 5, decisions: [], approvedIds: [] })
    expect(review.error).toContain("invalid JSON")
    expect(review.summary).toContain("before a final verdict")
    expect(call).toHaveBeenCalledTimes(5)
    expect(() => optimizeApproval(review, ["first-principles:1"])).toThrow("complete")
  })

  it("requires a correction response to reread evidence through its fresh tools", async () => {
    const f = await fixture()
    const tools = new Map<string, unknown>()
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      if (
        request.responseFormat?.jsonSchema.name !== "optimize_challenge" ||
        request.systemPrompt.includes("Independently review the changed implementation")
      ) {
        return fixtureOptimizeModel(request)
      }
      const isCorrection = record(JSON.parse(request.prompt), "request").correction !== undefined
      const readTool = request.tools?.find((tool) => tool.name === "read_review_source")?.handler
      if (!isCorrection) {
        tools.set("first-principles", readTool)
        await readReviewEvidence(request)
        return '{"responses":['
      }
      expect(readTool).not.toBe(tools.get("first-principles"))
      const input = record(JSON.parse(request.prompt), "request")
      const data = record(input.data, "data")
      const reports = array(data.reports, "reports").map((value) => record(value, "report"))
      const responses = reports.flatMap((report) =>
        array(report.findings, "findings").map((value) => ({
          findingId: record(value, "finding").id,
          disposition: "support",
          reason: "The cited source supports this response.",
          citations: [{ source: "code.ts", startLine: 1, endLine: 1 }],
        })),
      )
      return JSON.stringify({ responses })
    })

    const review = await f.run(call)
    expect(review).toMatchObject({ status: "incomplete", calls: 5, decisions: [] })
    expect(review.error).toContain("did not read")
    expect(call).toHaveBeenCalledTimes(5)
  })

  it("accepts no change without forcing a debate or authorizing implementation", async () => {
    const f = await fixture()
    const requests: Parameters<OptimizeModelCall>[0][] = []
    const completed = await f.run(async (request) => {
      requests.push(request)
      if (request.systemPrompt.includes("Reconcile these reports")) return fixtureOptimizeModel(request)
      await readReviewEvidence(request)
      return JSON.stringify({ summary: "Keep the implementation.", limitations: [], findings: [] })
    })
    expect(completed).toMatchObject({ status: "complete", calls: 3, decisions: [], challenges: [] })
    const verdictRequest = requests.find((request) => request.responseFormat?.jsonSchema.name === "optimize_verdict")
    expect(verdictRequest).toBeDefined()
    expect(record(JSON.parse(verdictRequest!.prompt), "prompt").requiredFindingIds).toEqual([])
    expect(replySchema(verdictRequest!, "decisions")).toEqual({
      minItems: 0,
      maxItems: 0,
      findingId: { type: "string", minLength: 1, maxLength: 100 },
    })
    expect(() => optimizeApproval(completed, [])).toThrow("at least 1")
  })

  it("describes saved failures as failed before verdict and interrupted runs as non-resumable", async () => {
    const f = await fixture()
    const failedDocument = optimizeReviewDocument({
      ...f.initial,
      status: "incomplete",
      summary: "Review is incomplete. No findings can be approved for implementation.",
      error: "Challenge round: finding coverage mismatch.",
    })
    expect(failedDocument).toContain("Status: failed.")
    expect(failedDocument).toContain("Review failed before a final verdict.")
    expect(failedDocument).not.toContain("Status: incomplete.")
    expect(failedDocument).not.toContain("Review is incomplete.")

    const interruptedDocument = optimizeReviewDocument({
      ...f.initial,
      status: "running",
      summary: "Review in progress. No implementation is approved.",
    })
    expect(interruptedDocument).toContain("Status: interrupted or still running.")
    expect(interruptedDocument).toContain("It will not resume automatically.")
  })

  it.each([
    ["challenge", "omitted", "missing: behavior-preservation:1"],
    ["challenge", "duplicate", "duplicate: first-principles:1"],
    ["challenge", "unknown", "unknown: mystery:1"],
    ["verdict", "omitted", "missing: behavior-preservation:1"],
    ["verdict", "duplicate", "duplicate: first-principles:1"],
    ["verdict", "unknown", "unknown: mystery:1"],
  ] as const)("fails closed when %s output has %s finding IDs", async (phase, fault, detail) => {
    const f = await fixture()
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      const output = record(JSON.parse(await modelWithSecondFinding(request)), "response")
      const isTarget =
        phase === "challenge"
          ? request.responseFormat?.jsonSchema.name === "optimize_challenge" &&
            request.systemPrompt.includes("Independently review the changed implementation")
          : request.responseFormat?.jsonSchema.name === "optimize_verdict"
      if (isTarget) {
        const key = phase === "challenge" ? "responses" : "decisions"
        const entries = array(output[key], key).map((value) => record(value, key))
        if (fault === "omitted") output[key] = entries.filter((entry) => entry.findingId !== "behavior-preservation:1")
        else if (fault === "duplicate")
          output[key] = entries.map((entry) => ({ ...entry, findingId: "first-principles:1" }))
        else output[key] = entries.map((entry, index) => (index === 1 ? { ...entry, findingId: "mystery:1" } : entry))
      }
      return JSON.stringify(output)
    })

    const review = await f.run(call)
    const expectedCalls = phase === "challenge" ? 5 : 6
    expect(review).toMatchObject({ status: "incomplete", calls: expectedCalls, decisions: [], approvedIds: [] })
    expect(review.error).toContain(phase === "challenge" ? "Challenge round" : "Final synthesis")
    expect(review.summary).toContain("before a final verdict")
    expect(review.error).toContain(detail)
    if (fault === "duplicate") expect(review.error).toContain("missing: behavior-preservation:1")
    expect(call).toHaveBeenCalledTimes(expectedCalls)
    expect(() => optimizeApproval(review, ["first-principles:1"])).toThrow("complete")
  })

  it("copies exact quotes from model-selected frozen ranges instead of asking the model to retype source", async () => {
    const f = await fixture('  return "\\n"\n')
    const completed = await f.run()
    expect(completed.status).toBe("complete")
    const expected = {
      source: "code.ts",
      startLine: 1,
      endLine: 1,
      quote: '  return "\\n"',
    }
    expect(completed.reports[0]?.findings[0]?.citations).toEqual([expected])
    expect(completed.challenges.every((entry) => entry.responses[0]?.citations[0]?.quote === expected.quote)).toBe(true)
    expect(completed.decisions[0]?.citations).toEqual([expected])
  })

  it("retains partial reports after failure, without counting failure as agreement or retrying", async () => {
    const f = await fixture()
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      if (request.systemPrompt.includes("Independently review")) throw new Error("Reviewer unavailable")
      return fixtureOptimizeModel(request)
    })
    const review = await f.run(call)
    expect(review).toMatchObject({ status: "incomplete", calls: 2, challenges: [], decisions: [] })
    expect(review.reports).toHaveLength(1)
    expect(review.error).toContain("Independent reviews")
    expect(review.summary).toContain("before a final verdict")
    expect(review.error).toContain("Reviewer unavailable")
    expect(call).toHaveBeenCalledTimes(2)
    expect(() => optimizeApproval(review, ["first-principles:1"])).toThrow("complete")
  })

  it("requires challengers to read the cited source instead of accepting another report's quote", async () => {
    const f = await fixture()
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      if (!request.systemPrompt.includes("Defend or withdraw")) return fixtureOptimizeModel(request)
      await invokeReviewTool(request, "read_review_source", { source: "README.md", startLine: 1, lineCount: 1 })
      return JSON.stringify({
        responses: [
          {
            findingId: "first-principles:1",
            disposition: "support",
            reason: "Trust the first reviewer.",
            citations: [{ source: "code.ts", startLine: 1, endLine: 1 }],
          },
        ],
      })
    })
    const review = await f.run(call)
    expect(review).toMatchObject({ status: "incomplete", calls: 4, decisions: [] })
    expect(review.error).toContain("did not inspect cited evidence")
    expect(call).toHaveBeenCalledTimes(4)
  })

  it("checks cited related context even when it is outside the selected edit paths", async () => {
    const f = await fixture()
    const review = await f.run(async (request) => {
      const response = record(JSON.parse(await fixtureOptimizeModel(request)), "response")
      if (response.findings === undefined) return JSON.stringify(response)
      const finding = array(response.findings, "findings")[0]
      if (finding !== undefined) {
        await invokeReviewTool(request, "read_review_source", { source: "README.md", startLine: 1, lineCount: 1 })
        record(finding, "finding").citations = [{ source: "README.md", startLine: 1, endLine: 1 }]
      }
      return JSON.stringify(response)
    })
    expect(review.status).toBe("complete")
    expect(review.calls).toBe(5)
  })

  it("rejects newly cited ranges that the reviewer did not read even when required changes were covered", async () => {
    const f = await fixture()
    const review = await f.run(async (request) => {
      const output = record(JSON.parse(await fixtureOptimizeModel(request)), "response")
      if (output.findings !== undefined) {
        const finding = array(output.findings, "findings")[0]
        if (finding !== undefined)
          record(finding, "finding").citations = [{ source: "README.md", startLine: 1, endLine: 1 }]
      }
      return JSON.stringify(output)
    })
    expect(review.status).toBe("incomplete")
    expect(review.error).toContain("did not inspect cited evidence at README.md:1-1")
    expect(review.calls).toBe(2)
    expect(() => optimizeApproval(review, ["first-principles:1"])).toThrow("complete")
  })

  it("rejects invented citations and incomplete source coverage rather than repairing reports", async () => {
    const f = await fixture()
    const incomplete = await f.run(async () =>
      JSON.stringify({ summary: "No work needed.", limitations: [], findings: [] }),
    )
    expect(incomplete).toMatchObject({ status: "incomplete", calls: 2 })
    expect(incomplete.error).toContain("did not read")
    const badQuote = await f.run(async (request) => {
      const output = record(JSON.parse(await fixtureOptimizeModel(request)), "report")
      const finding = array(output.findings, "findings")[0]
      if (finding !== undefined)
        record(array(record(finding, "finding").citations, "citations")[0], "citation").quote = "fabricated quote"
      return JSON.stringify(output)
    })
    expect(badQuote.error).toContain("unsupported keys: quote")
    expect(badQuote.status).toBe("incomplete")
    expect(() =>
      parseOptimizeCitations([{ source: "code.ts", startLine: 1, endLine: 1, quote: "fabricated quote" }], f.evidence),
    ).toThrow("does not occur")
  })

  it("accepts citations longer than forty lines while enforcing actual source bounds", async () => {
    const f = await fixture(`${"return value\n".repeat(500)}`)
    const citation = { source: "code.ts", startLine: 417, endLine: 480, quote: "return value" }
    expect(parseOptimizeCitations([citation], f.evidence)).toEqual([citation])
    for (const [endLine, message] of [
      [416, "must be between"],
      [502, "must be between"],
      [480.5, "must be integers"],
    ] as const) {
      expect(() => parseOptimizeCitations([{ ...citation, endLine }], f.evidence)).toThrow(message)
    }
  })

  it("keeps invalid structured output incomplete after one failed correction request per reviewer", async () => {
    const f = await fixture()
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      await readReviewEvidence(request)
      return '{"summary":"Incomplete JSON","limitations":[],"findings":['
    })
    const review = await f.run(call)
    expect(review).toMatchObject({ status: "incomplete", calls: 4, reports: [], challenges: [], decisions: [] })
    expect(review.error).toContain("First principles: The report model returned invalid JSON")
    expect(review.error).toContain("Behavior preservation: The report model returned invalid JSON")
    expect(call).toHaveBeenCalledTimes(4)
    expect(() => optimizeApproval(review, ["first-principles:1"])).toThrow("complete")
  })

  it("fails the review even if a model ignores an exhausted evidence-tool budget", async () => {
    const f = await fixture()
    const completed = await f.run(async (request) => {
      const output = await fixtureOptimizeModel(request)
      for (let count = 0; count <= optimizeEvidenceLimits.toolCalls; count++) {
        try {
          await invokeReviewTool(request, "read_review_source", { source: "code.ts", startLine: 1, lineCount: 1 })
        } catch {
          break
        }
      }
      return output
    })
    expect(completed.status).toBe("incomplete")
    expect(completed.error).toContain("budget exhausted")
    expect(completed.calls).toBe(2)
  })

  it("rejects undersized model contexts before reading evidence or truncating the request", async () => {
    const f = await fixture()
    const review = await f.run(async (request) => {
      request.inspectModel({
        ...fixtureOptimizeModelInfo,
        capabilities: {
          ...fixtureOptimizeModelInfo.capabilities,
          limits: { max_context_window_tokens: 1024 },
        },
      })
      return fixtureOptimizeModel(request)
    })
    expect(review.status).toBe("incomplete")
    expect(review.error).toContain("nothing was truncated")
    expect(review.calls).toBe(2)
  })

  it("rejects the first response byte beyond the configured output limit", async () => {
    const f = await fixture()
    const review = await f.run(async (request) => {
      await readReviewEvidence(request)
      return " ".repeat(request.maximumResponseBytes + 1)
    })
    expect(review.status).toBe("incomplete")
    expect(review.error).toContain("response exceeded its byte budget")
    expect(review.calls).toBe(2)
  })

  it("preserves unresolved disagreement and blocks it from approval", async () => {
    const f = await fixture()
    const review = await f.run(async (request) => {
      const output = record(JSON.parse(await fixtureOptimizeModel(request)), "response")
      const entries = output.decisions ?? output.responses
      if (entries !== undefined) {
        const entry = record(array(entries, "entries")[0], "entry")
        entry.disposition = output.decisions === undefined ? "uncertain" : "unresolved"
        entry.reason = "The retry contract cannot be established from the source."
      }
      return JSON.stringify(output)
    })
    expect(review.status).toBe("complete")
    expect(review.decisions[0]?.disposition).toBe("unresolved")
    expect(review.challenges.every((entry) => entry.responses[0]?.disposition === "uncertain")).toBe(true)
    expect(() => optimizeApproval(review, ["first-principles:1"])).toThrow("unavailable")
  })

  it("does not start corrections when cancelled after invalid responses are checkpointed", async () => {
    const f = await fixture()
    const controller = new AbortController()
    let checkpoints = 0
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      await readReviewEvidence(request)
      return "{"
    })
    const review = await runOptimizeReview(
      f.initial,
      async () => {
        if (++checkpoints === 2) controller.abort()
      },
      controller.signal,
      () => {},
      call,
    )
    expect(review).toMatchObject({ status: "cancelled", calls: 2, decisions: [] })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("cancels concurrent reviewers and saves cancellation without starting another round", async () => {
    const f = await fixture()
    const controller = new AbortController()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = f.run(async (request) => {
      entered()
      request.signal!.throwIfAborted()
      await new Promise<void>((_resolve, reject) =>
        request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true }),
      )
      return "{}"
    }, controller.signal)
    await started
    controller.abort()
    expect(await pending).toMatchObject({ status: "cancelled", calls: 2, decisions: [] })
    expect(f.saved.at(-1)?.status).toBe("cancelled")
  })
})

describe("private review records and approvals", () => {
  it("rejects blank snapshot quotes before publishing reports and saves the failed review", async () => {
    const f = await fixture(" \t\nreturn value\n")
    await f.store.save(f.initial)
    const complete = await runOptimizeReview(
      f.initial,
      (review) => f.store.save(review),
      f.signal,
      () => {},
      fixtureOptimizeModel,
    )
    expect(complete).toMatchObject({ status: "incomplete", calls: 3, decisions: [] })
    expect(complete.error).toContain("quote: must not be empty")
    expect(await f.store.read(complete.id)).toEqual(complete)
    expect(() => optimizeApproval(complete, ["first-principles:1"])).toThrow("complete")
  })

  it.each([false, true])("reopens a review after every step needed correction (no change: %s)", async (noChange) => {
    const f = await fixture()
    await f.store.save(f.initial)
    const call = vi.fn<OptimizeModelCall>(async (request) => {
      const response = record(JSON.parse(await fixtureOptimizeModel(request)), "response")
      if (record(JSON.parse(request.prompt), "request").correction === undefined) return "{"
      if (noChange && response.findings !== undefined) response.findings = []
      return JSON.stringify(response)
    })
    const complete = await runOptimizeReview(
      f.initial,
      (review) => f.store.save(review),
      f.signal,
      () => {},
      call,
    )
    const expectedCalls = noChange ? 6 : 10
    expect(complete).toMatchObject({ status: "complete", calls: expectedCalls, error: null })
    expect(call).toHaveBeenCalledTimes(expectedCalls)
    expect(await new OptimizeReviewStore(f.target.gitDirectory).read(complete.id)).toEqual(complete)
    if (!noChange) {
      const approval = await f.store.approve(complete.id, ["first-principles:1"])
      expect((await f.store.approved(approval)).approvedIds).toEqual(["first-principles:1"])
    }
    await expect(f.store.save({ ...complete, calls: expectedCalls + 1 })).rejects.toThrow(
      noChange ? "invalid model request count" : "must be between",
    )
  })

  it("preserves long quotes and multi-page citation ranges through review, approval, and reopening", async () => {
    const quote = `return "${"source text ".repeat(750)}"`
    expect(quote.length).toBeGreaterThan(800)
    const citedText = `${quote}\n${"return value\n".repeat(240)}`.slice(0, -1)
    const f = await fixture(`${citedText}\n`)
    await f.store.save(f.initial)
    const snapshotPath = path.join(f.store.directory, `${f.initial.id}.snapshot.json`)
    const before = await lstat(snapshotPath)
    const complete = await runOptimizeReview(
      f.initial,
      (review) => f.store.save(review),
      f.signal,
      () => {},
      async (request) => {
        const output = record(JSON.parse(await fixtureOptimizeModel(request)), "response")
        if (output.findings !== undefined) {
          for (let startLine = 1; startLine <= 241; startLine += 120) {
            await invokeReviewTool(request, "read_review_source", {
              source: "code.ts",
              startLine,
              lineCount: Math.min(120, 242 - startLine),
            })
          }
        }
        const entries = output.findings ?? output.responses ?? output.decisions
        for (const entry of array(entries, "entries")) {
          record(entry, "entry").citations = [{ source: "code.ts", startLine: 1, endLine: 241 }]
        }
        return JSON.stringify(output)
      },
    )
    expect(complete.error).toBeNull()
    expect(complete.reports[0]?.findings[0]?.citations[0]?.quote).toBe(citedText)
    for (const challenge of complete.challenges) {
      expect(challenge.responses[0]?.citations[0]).toEqual({
        source: "code.ts",
        startLine: 1,
        endLine: 241,
        quote: citedText,
      })
    }
    expect(complete.decisions[0]?.citations[0]?.quote).toBe(citedText)
    expect(await f.store.read(complete.id)).toEqual(complete)
    expect(await f.store.list()).toEqual([
      { id: complete.id, createdAt: complete.createdAt, status: "complete", summary: complete.summary },
    ])
    expect((await lstat(snapshotPath)).mtimeMs).toBe(before.mtimeMs)
    expect((await lstat(f.store.directory)).mode & 0o777).toBe(0o700)
    expect(before.mode & 0o777).toBe(0o600)
    const approval = await f.store.approve(complete.id, ["first-principles:1"])
    const approved = await f.store.approved(approval)
    expect(approved.approvedIds).toEqual(["first-principles:1"])
    await expect(f.store.save(complete)).rejects.toThrow("cannot be replaced")
  })

  it("reserves approval once and keeps uncertain delivery blocked after reload", async () => {
    const f = await fixture()
    await f.store.save(f.initial)
    const complete = await runOptimizeReview(
      f.initial,
      (review) => f.store.save(review),
      f.signal,
      () => {},
      fixtureOptimizeModel,
    )
    const approval = await f.store.approve(complete.id, ["first-principles:1"])
    const attempts = await Promise.allSettled([f.store.beginExecution(approval), f.store.beginExecution(approval)])
    expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1)
    await f.store.finishExecution(complete.id, "unknown")
    const reopened = new OptimizeReviewStore(f.target.gitDirectory)
    expect((await reopened.read(complete.id)).execution).toBe("unknown")
    await expect(reopened.beginExecution(approval)).rejects.toThrow("unlaunched")
    await expect(reopened.approve(complete.id, ["first-principles:1"])).rejects.toThrow("unlaunched")
  })

  it("preserves interrupted records without approving or resuming them", async () => {
    const f = await fixture()
    await f.store.save(f.initial)
    const reopened = await new OptimizeReviewStore(f.target.gitDirectory).read(f.initial.id)
    expect(reopened).toMatchObject({ status: "running", calls: 0, reports: [] })
    await expect(f.store.approve(reopened.id, ["first-principles:1"])).rejects.toThrow("complete")
  })

  it("rejects damaged records, unsafe modes, and replacement symlinks", async () => {
    const f = await fixture()
    await f.store.save(f.initial)
    const filename = path.join(f.store.directory, `${f.initial.id}.json`)
    const original = await readFile(filename)
    await writeFile(filename, "{}")
    await expect(f.store.read(f.initial.id)).rejects.toThrow("missing required")
    await writeFile(filename, original)
    await chmod(filename, 0o644)
    await expect(f.store.read(f.initial.id)).rejects.toThrow("mode-0600")
    await chmod(filename, 0o600)
    await rename(filename, `${filename}.saved`)
    await symlink(`${filename}.saved`, filename)
    await expect(f.store.read(f.initial.id)).rejects.toMatchObject({ code: "ELOOP" })
    expect((await lstat(filename)).isSymbolicLink()).toBe(true)
    await expect(f.store.read("../../outside")).rejects.toThrow("Invalid review ID")
  })
})

describe("headless Optimize acceptance", () => {
  const dependencies = () => ({
    modelCall: vi.fn<OptimizeModelCall>(fixtureOptimizeModel),
    loadArchitecture: vi.fn<typeof loadOptimizeArchitecture>(async () =>
      ["improve-codebase-architecture", "codebase-design"].map((name) => ({
        id: `@skill/${name}`,
        content: "Explore module depth without changing source.\n",
      })),
    ),
  })

  it("requires explicit model consent and rejects ambiguous or unrecognized arguments", () => {
    expect(() => parseOptimizeCheckArguments([])).toThrow("Explicit --live consent")
    expect(() => parseOptimizeCheckArguments(["--live", "--base", "main", "--uncommitted"])).toThrow("not both")
    expect(() => parseOptimizeCheckArguments(["--live", "--approve"])).toThrow("Unknown option")
    expect(parseOptimizeCheckArguments(["--help"])).toBeUndefined()
    expect(parseOptimizeCheckArguments(["--live"])?.scope).toEqual({ kind: "current-branch" })
    expect(parseOptimizeCheckArguments(["--live", "--base", "main"])?.scope).toEqual({
      kind: "branch",
      baseRef: "main",
    })
  })

  it("runs all reviewers on every eligible change and saves an unapproved report without changing the worktree", async () => {
    const f = await fixture()
    const injected = dependencies()
    const before = await f.git("status", "--porcelain=v1", "--untracked-files=all")
    const result = await checkGuideOptimization(
      { cwd: f.root, scope: { kind: "uncommitted" } },
      f.signal,
      () => {},
      injected,
    )
    expect(result).toMatchObject({
      schemaVersion: 1,
      passed: true,
      status: "complete",
      selectedPaths: ["code.ts", "unselected.txt"],
      reports: 3,
      challenges: 3,
      findings: 2,
      decisions: 2,
      calls: 7,
      approvedFindings: 0,
      execution: "not-started",
      worktreeUnchanged: true,
      errors: [],
    })
    expect(result.reviewers.map(({ id }) => id)).toEqual([
      "first-principles",
      "behavior-preservation",
      "improve-codebase-architecture",
    ])
    expect(injected.modelCall).toHaveBeenCalledTimes(7)
    expect(injected.loadArchitecture).toHaveBeenCalledOnce()
    expect(await f.store.read(result.reviewId)).toMatchObject({
      status: "complete",
      approvedIds: [],
      execution: "not-started",
    })
    expect(await f.git("status", "--porcelain=v1", "--untracked-files=all")).toBe(before)
  })

  it("reports incomplete model output as a failure instead of treating a saved report as success", async () => {
    const f = await fixture()
    const injected = dependencies()
    injected.modelCall.mockImplementation(async (request) => {
      await readReviewEvidence(request)
      return '{"findings":['
    })
    const result = await checkGuideOptimization(
      { cwd: f.root, scope: { kind: "uncommitted" } },
      f.signal,
      () => {},
      injected,
    )
    expect(result).toMatchObject({
      passed: false,
      status: "incomplete",
      calls: 6,
      approvedFindings: 0,
      execution: "not-started",
    })
    expect(result.errors.join("\n")).toContain("invalid JSON")
    expect(injected.modelCall).toHaveBeenCalledTimes(6)
  })

  it("passes a complete no-change result without requiring findings or a challenge round", async () => {
    const f = await fixture()
    const injected = dependencies()
    injected.modelCall.mockImplementation(async (request) => {
      if (request.systemPrompt.includes("Reconcile these reports")) return fixtureOptimizeModel(request)
      await readReviewEvidence(request)
      return JSON.stringify({ summary: "Keep the implementation.", limitations: [], findings: [] })
    })
    const result = await checkGuideOptimization(
      { cwd: f.root, scope: { kind: "uncommitted" } },
      f.signal,
      () => {},
      injected,
    )
    expect(result).toMatchObject({
      passed: true,
      status: "complete",
      reports: 3,
      challenges: 0,
      findings: 0,
      decisions: 0,
      calls: 4,
      approvedFindings: 0,
      execution: "not-started",
      worktreeUnchanged: true,
      errors: [],
    })
  })

  it("does not pass if the worktree changes during a complete read-only review", async () => {
    const f = await fixture()
    const injected = dependencies()
    injected.modelCall.mockImplementation(async (request) => {
      const output = await fixtureOptimizeModel(request)
      await writeFile(path.join(f.root, "code.ts"), "An external edit during review.\n")
      return output
    })
    const result = await checkGuideOptimization(
      { cwd: f.root, scope: { kind: "uncommitted" } },
      f.signal,
      () => {},
      injected,
    )
    expect(result).toMatchObject({
      passed: false,
      status: "complete",
      worktreeUnchanged: false,
      approvedFindings: 0,
      execution: "not-started",
    })
    expect(result.errors.join("\n")).toContain("Worktree check failed")
  })

  it("refuses an empty scope before loading skills or calling a model", async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, "code.ts"), "return original\n")
    await rm(path.join(f.root, "unselected.txt"))
    const injected = dependencies()
    await expect(
      checkGuideOptimization({ cwd: f.root, scope: { kind: "uncommitted" } }, f.signal, () => {}, injected),
    ).rejects.toThrow("cannot pass on an empty scope")
    expect(injected.modelCall).not.toHaveBeenCalled()
    expect(injected.loadArchitecture).not.toHaveBeenCalled()
  })
})

describe("managed architecture reviewer", () => {
  it("loads both allowlisted skills through the floating manager, freezes their content, and cleans its stage", async () => {
    const root = await temporary()
    const manager = path.join(root, "manager.ts")
    const catalog = path.join(root, "skills.json")
    await writeFile(manager, "// fixture manager\n")
    await writeFile(catalog, "{}\n")
    let staging: string | undefined
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      const bundle = args[args.indexOf("--target") + 1]!
      staging = path.dirname(bundle)
      expect(args).toContain("guide-optimize-architecture")
      for (const name of ["improve-codebase-architecture", "codebase-design"]) {
        await mkdir(path.join(bundle, name), { recursive: true, mode: 0o700 })
        await writeFile(
          path.join(bundle, name, "SKILL.md"),
          `---\nname: ${name}\ndisable-model-invocation: true\n---\nExplore deep modules.\n`,
        )
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    })
    const sources = await loadOptimizeArchitecture({ run }, new AbortController().signal, {
      TRELLAGE_GUIDE_SKILLS_MANAGER: manager,
      TRELLAGE_GUIDE_SKILLS_CATALOG: catalog,
      TRELLAGE_GUIDE_OPTIMIZE_SKILLS_CACHE: path.join(root, "cache"),
    })
    expect(run).toHaveBeenCalledOnce()
    expect(sources.map((entry) => entry.id)).toEqual(["@skill/improve-codebase-architecture", "@skill/codebase-design"])
    expect(sources[0]?.content).toContain("disable-model-invocation: true")
    expect(staging).toBeDefined()
    await expect(lstat(staging!)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("uses the architecture skill in the same bounded review without enabling its write or browser workflow", async () => {
    const f = await fixture()
    const sources = [
      ...f.evidence.sources,
      ...["improve-codebase-architecture", "codebase-design"].map((name) => ({
        id: `@skill/${name}`,
        content: "Explore module depth. Do not invent interfaces.\n",
      })),
    ]
    const evidence = { ...f.evidence, sources, fingerprint: optimizeDigest({ sources, excluded: f.evidence.excluded }) }
    const initial = newOptimizeReview(
      { ...f.input, reviewerIds: ["improve-codebase-architecture"] },
      evidence,
      optimizeReviewersFor(defaultGuideModelRouting),
      defaultGuideModelRouting.optimize,
    )
    const call = vi.fn<OptimizeModelCall>(fixtureOptimizeModel)
    const review = await runOptimizeReview(
      initial,
      async () => {},
      f.signal,
      () => {},
      call,
    )
    expect(review).toMatchObject({ status: "complete", calls: 3 })
    expect(call.mock.calls[0]?.[0].systemPrompt).toContain("Guide adapts this skill to a read-only review")
    expect(record(JSON.parse(call.mock.calls[0]![0].prompt), "request").requiredSources).toEqual(
      expect.arrayContaining(["@skill/improve-codebase-architecture", "@skill/codebase-design"]),
    )
    await expect(loadOptimizeArchitecture(f.runner, f.signal, {})).rejects.toThrow("runtime paths are missing")
  })
})
