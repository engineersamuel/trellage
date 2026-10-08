import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionEvent } from "@github/copilot-sdk"
import type { ReviewClientFactory } from "../src/copilot-review-provider.ts"
import { RestrictedGuideModelError } from "../src/copilot-guide-provider.ts"
import { createNodeCommandRunner, type CommandRunner } from "../src/guide-launch.ts"
import { inspectGuideOptimizeTarget } from "../src/guide-optimize-target.ts"
import { assignReviewModels, reviewCheckCatalog } from "../src/review-catalog.ts"
import { reviewSynthesisStatus, type ReviewEvent, type ReviewRequest, type ReviewRun } from "../src/review-contracts.ts"
import { runSharedReview } from "../src/review-coordinator.ts"
import { captureSharedReviewEvidence, planReviewEvidence, reviewExecutionPolicy, reviewIncompatibilities } from "../src/review-evidence.ts"
import { optimizeDigest } from "../src/guide-optimize-evidence.ts"
import { extractReviewFindings } from "../src/review-normalize.ts"
import { SharedReviewStore, parseSharedReview } from "../src/review-store.ts"
import { fixtureOptimizeModel, fixtureOptimizeModelInfo, invokeReviewTool } from "./fixtures/guide-optimize-model.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })))
})

const fixture = async (commit = true) => {
  const root = path.resolve(`.shared-review-${randomUUID()}`)
  roots.push(root)
  const repo = path.join(root, "repo")
  await mkdir(repo, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q")
  git("config", "user.email", "review@example.invalid")
  git("config", "user.name", "Review")
  if (commit) {
    await writeFile(path.join(repo, "code.ts"), "before\n")
    git("add", ".")
    git("commit", "-qm", "Baseline")
  }
  await writeFile(path.join(repo, "code.ts"), "after\n")
  const signal = new AbortController().signal
  const node = createNodeCommandRunner()
  const managerPath = path.join(root, "manager.ts")
  const catalogPath = path.join(root, "skills.json")
  await writeFile(managerPath, "// Fixture manager")
  await writeFile(catalogPath, "{}")
  const runner: CommandRunner = {
    run: async (executable, args, options) => {
      if (!args.includes(managerPath)) return node.run(executable, args, options)
      const target = args[args.indexOf("--target") + 1]!
      await mkdir(path.join(target, "ponytail-review"), { recursive: true })
      await writeFile(
        path.join(target, "ponytail-review/SKILL.md"),
        "---\nname: ponytail-review\n---\nReview removable complexity.",
      )
      return { stdout: "", stderr: "", exitCode: 0 }
    },
  }
  const target = await inspectGuideOptimizeTarget(runner, repo, { kind: "uncommitted" }, signal)
  const request = (ids: string[]): ReviewRequest => ({
    target,
    paths: ["code.ts"],
    checks: assignReviewModels(ids),
    coordinator: { model: "gpt-6-sol", effort: "low" },
    originalIntent: "  Preserve behavior.\r\n  ",
  })
  return { root, repo, git, runner, signal, request, managerPath, catalogPath }
}

describe("shared review coordinator", () => {
  it("round-trips every catalog selection with exactly its declared evidence projections", async () => {
    const f = await fixture()
    const modes = await Promise.all([
      ["first-principles"], ["ponytail"], ["first-principles", "ponytail"],
    ].map((ids) => captureSharedReviewEvidence(f.runner, f.request(ids), f.signal)))
    for (let mask = 1; mask < 2 ** reviewCheckCatalog.length; mask++) {
      const checks = reviewCheckCatalog.filter((_, index) => mask & (1 << index))
      const request = f.request(checks.map((check) => check.id))
      const patch = checks.some((check) => check.evidence === "patch")
      const related = checks.some((check) => check.evidence === "related-source")
      const frozen = modes[patch ? related ? 2 : 1 : 0]!
      const run: ReviewRun = {
        schemaVersion: 2, id: randomUUID(), createdAt: new Date().toISOString(), request,
        evidence: frozen, policy: reviewExecutionPolicy(checks.map((check) => check.id), frozen.source),
        status: "running", synthesisStatus: "queued", results: [], artifacts: [], challenges: [],
        decisions: [], summary: "Review in progress.", error: null, calls: 0, approvedIds: [], execution: "not-started",
      }
      expect(parseSharedReview(run)).toEqual(run)
      expect(reviewIncompatibilities({ ...request, target: { ...request.target, head: null } }).length > 0)
        .toBe(checks.some((check) => check.requiresHead))
      for (const check of checks) {
        const plan = planReviewEvidence(request, frozen, check.id)
        expect(plan.requiredSources).toEqual([
          ...frozen.source.sources.filter((source) => source.id.startsWith("@diff/")).map((source) => source.id),
          ...(check.requiredSkillSources ?? []),
        ])
        expect(plan.evidence.sources.some((source) => !source.id.startsWith("@diff/")))
          .toBe(check.evidence === "related-source")
      }
      if (patch) {
        const { sourceIds: _ids, primarySourceIds: _primary, ...inline } = frozen.patch!
        const projection = { source: frozen.source, patch: inline }
        expect(parseSharedReview({ ...run, evidence: { ...projection, fingerprint: optimizeDigest(projection) } }))
          .toMatchObject({ evidence: { patch: inline } })
        const missing = { source: frozen.source }
        expect(() => parseSharedReview({ ...run, evidence: { ...missing, fingerprint: optimizeDigest(missing) } }))
          .toThrow()
      } else {
        const extra = { source: frozen.source, patch: modes[1]!.patch }
        expect(() => parseSharedReview({ ...run, evidence: { ...extra, fingerprint: optimizeDigest(extra) } }))
          .toThrow("Unselected patch projection")
      }
    }
  })

  it.each([true, false])("repairs unread extraction citations once without weakening coverage: %s", async (repair) => {
    const f = await fixture()
    const request = f.request(["ponytail"])
    const evidence = await captureSharedReviewEvidence(f.runner, request, f.signal)
    const source = evidence.source.sources.find((entry) => entry.id === "@diff/unstaged")!
    const endLine = source.content.split("\n").length
    const prompts: string[] = []
    const call = vi.fn<typeof fixtureOptimizeModel>(async (options) => {
      prompts.push(options.prompt)
      await options.inspectModel?.(fixtureOptimizeModelInfo)
      await invokeReviewTool(options, "read_review_source", {
        source: source.id, startLine: 1, lineCount: repair && prompts.length === 2 ? endLine : 1,
      })
      return JSON.stringify({ complete: true, limitations: [], findings: [{
        title: "Saved finding", excerpt: "Saved finding.", proposal: null, benefit: null, risk: null,
        verification: null, severity: null, paths: ["code.ts"],
        citations: [{ source: source.id, startLine: 1, endLine }],
      }] })
    })
    const result = await extractReviewFindings(
      { id: "ponytail", model: request.checks[0]!.model.model, raw: "Saved finding." },
      request.checks[0]!, request, evidence, f.signal, () => {}, call,
    ).then((value) => value.findings[0]?.grounded, () => false)
    expect(result).toBe(repair)
    expect(call).toHaveBeenCalledTimes(2)
    expect(prompts[1]).toContain("validationError")
    expect(prompts[1]).toContain("Read EVERY line")
  })

  it("captures more than 1 MiB once and retains staged changes undone in the worktree", async () => {
    const f = await fixture()
    await writeFile(path.join(f.repo, "code.ts"), "staged only\n")
    f.git("add", "code.ts")
    await writeFile(path.join(f.repo, "code.ts"), "before\n")
    await writeFile(path.join(f.repo, "large.ts"), "+large value\n".repeat(100_000))
    const target = await inspectGuideOptimizeTarget(f.runner, f.repo, { kind: "uncommitted" }, f.signal)
    const request = { ...f.request(["ponytail"]), target, paths: ["code.ts", "large.ts"] }
    const evidence = await captureSharedReviewEvidence(f.runner, request, f.signal)
    const sources = new Map(evidence.source.sources.map((source) => [source.id, source.content]))
    expect(sources.get("@diff/staged")).toContain("+staged only")
    expect(sources.get("@diff/unstaged")).toContain("-staged only")
    expect(sources.get("@diff/net")).toBe("")
    expect(Buffer.byteLength(sources.get("@diff/untracked/large.ts")!)).toBeGreaterThan(1024 * 1024)
    expect(evidence.patch?.primarySourceIds).toEqual(["@diff/net", "@diff/untracked/large.ts"])
    expect(evidence.patch?.diff.length).toBeLessThan(1000)
    expect(evidence.patch?.sourceIds).toEqual([...sources.keys()])
  })

  it.each(["valid", "critical", "high", "medium", "low", "findings", "limitations", "paths", "citations", "line", "severity", "excerpt"] as const)(
    "uses a portable strict extraction schema and enforces local constraints: %s", async (violation) => {
      const f = await fixture()
      const request = f.request(["ponytail"])
      const evidence = await captureSharedReviewEvidence(f.runner, request, f.signal)
      const severity = ["critical", "high", "medium", "low"].includes(violation) ? violation : null
      const finding = {
        title: "Saved finding", excerpt: violation === "excerpt" ? "Invented" : "Saved report.",
        proposal: null, benefit: null, risk: null, verification: null,
        severity: violation === "severity" ? "invented" : severity,
        paths: violation === "paths" ? Array.from({ length: 17 }, (_, i) => `path-${i}`) : ["code.ts"],
        citations: violation === "line" ? [{ source: "code.ts", startLine: 0, endLine: 1 }]
          : violation === "citations" ? Array(4).fill({ source: "code.ts", startLine: 1, endLine: 1 }) : [],
      }
      const checkSchema = (schema: Record<string, unknown>): void => {
        if (Array.isArray(schema.anyOf)) {
          for (const variant of schema.anyOf) checkSchema(variant as Record<string, unknown>)
          return
        }
        expect(schema.type).toBeDefined()
        const enumValues: unknown[] = Array.isArray(schema.enum) ? schema.enum : []
        expect(enumValues.map((value) => value === null ? "null" : typeof value))
          .toEqual(enumValues.map(() => schema.type))
        for (const key of ["minimum", "maximum", "minItems", "maxItems"]) expect(schema).not.toHaveProperty(key)
        const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
        expect(schema.additionalProperties).toBe(schema.type === "object" ? false : undefined)
        expect(schema.required).toEqual(schema.type === "object" ? Object.keys(properties) : undefined)
        if (schema.type === "object") {
          Object.values(properties).forEach(checkSchema)
        }
        if (schema.type === "array") checkSchema(schema.items as Record<string, unknown>)
      }
      const call = vi.fn<typeof fixtureOptimizeModel>(async (options) => {
        expect(options.responseFormat?.jsonSchema.strict).toBe(true)
        checkSchema(options.responseFormat!.jsonSchema.schema as Record<string, unknown>)
        return JSON.stringify({
          complete: true,
          limitations: violation === "limitations" ? Array(51).fill("Limit") : [],
          findings: violation === "findings" ? Array(51).fill(finding) : [finding],
        })
      })
      const result = extractReviewFindings(
        { id: "ponytail", model: request.checks[0]!.model.model, raw: "Saved report." },
        request.checks[0]!, request, evidence, f.signal, () => {}, call,
      )
      const outcome = await result.then(
        (value) => ({ valid: true, grounded: value.findings[0]?.grounded, severity: value.findings[0]?.severity }),
        (error: unknown) => ({ valid: false, error: error instanceof Error }),
      )
      expect(outcome).toEqual(violation === "valid" || severity !== null
        ? { valid: true, grounded: false, severity: severity ?? undefined } : { valid: false, error: true })
      expect(call).toHaveBeenCalledOnce()
    })

  it.each(["authentication", "cleanup", "invalid-output", "schema-message"] as const)(
    "does not retry %s extraction failures or fall back to unstructured findings", async (failure) => {
      const f = await fixture()
      const request = f.request(["ponytail"])
      const evidence = await captureSharedReviewEvidence(f.runner, request, f.signal)
      const call = vi.fn<typeof fixtureOptimizeModel>(async () => {
        if (failure === "invalid-output") return "Not JSON."
        throw new RestrictedGuideModelError("runtime-error", failure === "cleanup" ? ["abort"] : [],
          { stage: "response", model: request.checks[0]!.model.model,
            errorType: failure === "authentication" ? "authentication" : "unknown",
            ...(failure === "schema-message" ? { validation: "schema-invalid" as const } : {}) })
      })
      await expect(extractReviewFindings(
        { id: "ponytail", model: request.checks[0]!.model.model, raw: "Saved report." },
        request.checks[0]!, request, evidence, f.signal, () => {}, call,
      )).rejects.toThrow()
      expect(call).toHaveBeenCalledOnce()
    })

  it.each(["success", "retry", "failed", "schema-error", "cancelled", "cleanup-failed"] as const)(
    "runs mixed checks with %s extraction and retains independent synthesis status", async (extraction) => {
    const f = await fixture()
    const controller = new AbortController()
    const phases: string[] = []
    const modelCall = vi.fn<typeof fixtureOptimizeModel>(async (request) => {
      const format = request.responseFormat?.jsonSchema.name
      phases.push(format ?? "peer")
      if (format === "review_extraction") {
        request.inspectModel(fixtureOptimizeModelInfo)
        const calls = phases.filter((phase) => phase === "review_extraction").length
        if (extraction === "schema-error") throw new RestrictedGuideModelError("runtime-error", [], {
          stage: "response", model: request.model, errorType: "query", statusCode: 400,
          errorCode: "invalid_json_schema",
        })
        if (extraction === "cancelled") {
          controller.abort(new Error("Cancelled extraction"))
          throw new RestrictedGuideModelError("cancelled")
        }
        if (extraction === "failed" || (extraction === "retry" && calls === 1))
          throw new RestrictedGuideModelError("runtime-error")
        return JSON.stringify({ complete: true, limitations: [], findings: [] })
      }
      return fixtureOptimizeModel(request)
    })
    const sdkCalls: string[] = []
    const skillManifests: string[] = []
    const handlers = new Map<string, (event: SessionEvent) => void>()
    let synthesisReturned = false
    const clientFactory: ReviewClientFactory = () => ({
      start: async () => {},
      listModels: async () => ["claude-opus-5.5", "gpt-6-sol"].map((id) => ({ ...fixtureOptimizeModelInfo, id })),
      deleteSession: async () => {},
      forceStop: async () => {
        if (extraction === "cleanup-failed" && synthesisReturned) throw new Error("Fixture provider cleanup failure")
      },
      createSession: async (config) => ({
        sessionId: config.sessionId!,
        on: (handler) => {
          handlers.set(config.sessionId!, handler)
          return () => { handlers.delete(config.sessionId!) }
        },
        abort: async () => {},
        disconnect: async () => {},
        sendAndWait: async ({ prompt }) => {
          const leaf = Boolean(config.skillDirectories?.length)
          sdkCalls.push(leaf ? "ponytail" : "synthesis")
          if (leaf) {
            handlers.get(config.sessionId!)?.({ type: "assistant.message_delta",
              data: { messageId: "ponytail-message", deltaContent: "Independent streamed assessment." } } as SessionEvent)
            const input = {
              toolName: "builtin:skill",
              toolArgs: { name: "ponytail-review" },
              sessionId: config.sessionId!,
              timestamp: new Date(),
              workingDirectory: f.root,
            }
            const context = { sessionId: config.sessionId! }
            await config.hooks!.onPreToolUse!(input, context)
            await config.hooks!.onPostToolUse!(
              { ...input, toolResult: { resultType: "success", textResultForLlm: "Loaded." } },
              context,
            )
            const snapshotTool = config.tools!.find((tool) => tool.name === "read_snapshot")!
            const manifest = await snapshotTool.handler!({}, {
              sessionId: config.sessionId!, toolName: "read_snapshot", toolCallId: "manifest", arguments: {},
            })
            if (typeof manifest !== "object" || manifest === null || !("textResultForLlm" in manifest) ||
              typeof manifest.textResultForLlm !== "string") throw new Error("Missing skill manifest.")
            skillManifests.push(manifest.textResultForLlm)
            for (const source of ["@diff/staged", "@diff/unstaged"]) {
              const args = { source, offset: 0, length: 16000 }
              await config.tools!.find((tool) => tool.name === "read_snapshot")!.handler!(
                args, { sessionId: config.sessionId!, toolName: "read_snapshot", toolCallId: source, arguments: args },
              )
            }
            return { data: { content: "No removable complexity found." } }
          }
          if (extraction === "failed" || extraction === "schema-error") {
            expect(prompt).toContain("No removable complexity found.")
            expect(prompt).toContain("Finding normalization failed")
          }
          synthesisReturned = true
          return {
            data: {
              content: JSON.stringify({
                findings: [{ title: "Simplify", sources: ["first-principles:1"], reason: "Small deletion supported." }],
                decisions: [
                  { source: "ponytail", disposition: "kept", reason: "No findings." },
                  { source: "first-principles", disposition: "kept", reason: "Independent source." },
                  { source: "first-principles:1", disposition: "kept", reason: "Frozen evidence supports deletion." },
                ],
                disagreements: [],
                questions: [],
                challengeDecisions: [],
              }),
            },
          }
        },
      }),
    })
    const events: ReviewEvent[] = []
    const run = await runSharedReview({
      request: f.request(["first-principles", "ponytail"]),
      confirmed: true,
      runner: f.runner,
      signal: controller.signal,
      modelCall,
      clientFactory,
      onEvent: (event) => events.push(event),
      skills: {
        runner: f.runner,
        managerPath: f.managerPath,
        catalogPath: f.catalogPath,
        cachePath: path.join(f.root, "cache"),
        stagingRoot: path.join(f.root, "staging"),
      },
    })
    expect(skillManifests).toEqual([expect.stringContaining('"id":"@diff/unstaged"')])
    expect(skillManifests.join("")).not.toContain('"id":"code.ts"')
    if (extraction === "cleanup-failed") {
      expect(run.status).toBe("incomplete")
      expect(run.failure).toMatchObject({ phase: "cleanup", kind: "provider-failure" })
      expect(run.error).toContain("Review cleanup failed")
      expect(run.synthesisStatus).toBe("complete")
      expect(run.artifacts.find((entry) => entry.name === "synthesis.json")?.checkId).toBe("synthesis")
      expect(run.artifacts.find((entry) => entry.name === "ponytail-batch-1-ponytail.md")?.checkId).toBe("ponytail")
      const retained = await readdir(path.join(f.root, "staging"))
      expect(retained).toHaveLength(1)
      await chmod(path.join(f.root, "staging", retained[0]!, "skills", "ponytail-review"), 0o700)
      const store = new SharedReviewStore(run.request.target.gitDirectory)
      await expect(store.approve(run.id, ["first-principles:1"])).rejects.toThrow("complete")
      return
    }
    if (extraction === "failed" || extraction === "schema-error" || extraction === "cancelled") {
      expect(run.status).toBe(extraction === "cancelled" ? "cancelled" : "incomplete")
      expect(run.results.find((result) => result.id === "ponytail")?.status).toBe("failed")
      expect(run.artifacts.find((entry) => entry.id === "ponytail:report")?.content).toContain("No removable complexity found.")
      expect(phases.filter((phase) => phase === "review_extraction")).toHaveLength(extraction === "failed" ? 2 : 1)
      const store = new SharedReviewStore(run.request.target.gitDirectory)
      await expect(store.approve(run.id, ["first-principles:1"])).rejects.toThrow("complete")
      if (extraction !== "cancelled") {
        expect(run.synthesisStatus).toBe("complete")
        expect(reviewSynthesisStatus(await store.read(run.id))).toBe("complete")
        expect(run.summary).toContain("Synthesis complete; review incomplete")
        expect(events).toContainEqual({ kind: "synthesis", status: "complete" })
        expect(run.artifacts.find((entry) => entry.name === "ponytail-batch-1-ponytail.md")?.checkId).toBe("ponytail")
        const old = { ...run }
        delete old.synthesisStatus
        expect(reviewSynthesisStatus(parseSharedReview(old))).toBe("complete")
      }
      return
    }
    expect(run.error).toBeNull()
    expect(run.status).toBe("complete")
    expect(phases.filter((phase) => phase === "review_extraction")).toHaveLength(extraction === "retry" ? 2 : 1)
    expect(sdkCalls).toEqual(["ponytail", "synthesis"])
    expect(phases.filter((phase) => phase === "optimize_verdict")).toEqual([])
    expect(phases.filter((phase) => phase === "optimize_challenge")).toHaveLength(1)
    expect(run.results.map((result) => result.id).sort()).toEqual(["first-principles", "ponytail"])
    expect(events.filter((event) => event.kind === "synthesis")).toHaveLength(2)
    expect(events).toContainEqual({ kind: "text", checkId: "ponytail", source: "Reviewer",
      text: "Independent streamed assessment." })
    const store = new SharedReviewStore(run.request.target.gitDirectory)
    expect(await readdir(store.directory)).toEqual([`${run.id}.json`])
    expect((await store.read(run.id)).request.originalIntent).toBe(f.request(["ponytail"]).originalIntent)
    const approval = await store.approve(run.id, ["first-principles:1"])
    await store.beginExecution(approval)
    await expect(store.beginExecution(approval)).rejects.toThrow("unlaunched")
    await store.finishExecution(run.id, "unknown")
    expect((await store.read(run.id)).execution).toBe("unknown")
  })

  it("keeps patch-only evidence narrow and preserves links without following them", async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, "private"), "DO NOT SHARE LINK TARGET")
    await symlink(path.join(f.root, "private"), path.join(f.repo, "link"))
    const target = await inspectGuideOptimizeTarget(f.runner, f.repo, { kind: "uncommitted" }, f.signal)
    const request = { ...f.request(["ponytail"]), target, paths: ["link"] }
    const evidence = await captureSharedReviewEvidence(f.runner, request, f.signal)
    expect(evidence.source.sources.find((source) => source.id === "@diff/untracked/link")?.content).toContain("120000")
    expect(evidence.patch?.diff).not.toContain("DO NOT SHARE")
    expect(evidence.source.sources.every((source) => source.id.startsWith("@diff/"))).toBe(true)
    await expect(
      captureSharedReviewEvidence(
        f.runner,
        { ...request, checks: assignReviewModels(["first-principles", "ponytail"]) },
        f.signal,
      ),
    ).rejects.toThrow("cannot review")
  })

  it("supports initial repositories only for compatible checks", async () => {
    const f = await fixture(false)
    const evidence = await captureSharedReviewEvidence(f.runner, f.request(["first-principles"]), f.signal)
    expect(evidence.patch).toBeUndefined()
    expect(evidence.source.sources.some((source) => source.id === "code.ts")).toBe(true)
    await expect(captureSharedReviewEvidence(f.runner, f.request(["ponytail"]), f.signal)).rejects.toThrow(
      "require HEAD",
    )
  })

  it("saves built-in reports as version 2 and rejects incomplete or altered approvals", async () => {
    const f = await fixture()
    const run = await runSharedReview({
      request: f.request(["first-principles"]),
      runner: f.runner,
      signal: f.signal,
      confirmed: true,
      modelCall: fixtureOptimizeModel,
    })
    expect(run.status).toBe("complete")
    const store = new SharedReviewStore(run.request.target.gitDirectory)
    expect(parseSharedReview(await store.read(run.id)).schemaVersion).toBe(2)
    const record = JSON.parse(await readFile(path.join(store.directory, `${run.id}.json`), "utf8"))
    expect(record.data.approvedIds).toEqual([])
    await expect(store.save({ ...run, summary: "Replace completed evidence." })).rejects.toThrow("cannot be replaced")
    const approval = await store.approve(run.id, ["first-principles:1"])
    await expect(store.approved({ ...approval, findings: [] })).rejects.toThrow("differs")
  })

  it("keeps a no-change run readable without granting implementation authority", async () => {
    const f = await fixture()
    const run = await runSharedReview({
      request: f.request(["behavior-preservation"]),
      runner: f.runner,
      signal: f.signal,
      confirmed: true,
      modelCall: fixtureOptimizeModel,
    })
    expect(run.status).toBe("complete")
    expect(run.decisions).toEqual([])
    expect(run.results[0]?.findings).toEqual([])
    const store = new SharedReviewStore(run.request.target.gitDirectory)
    expect((await store.read(run.id)).summary).toContain("No change")
    await expect(store.approve(run.id, ["behavior-preservation:1"])).rejects.toThrow("cannot authorize")
  })

  it("saves cancellation during execution without permitting approval or hidden retries", async () => {
    const f = await fixture()
    const controller = new AbortController()
    const modelCall = vi.fn<typeof fixtureOptimizeModel>(async () => {
      controller.abort(new Error("Fixture cancellation"))
      throw controller.signal.reason
    })
    const run = await runSharedReview({
      request: f.request(["first-principles"]),
      runner: f.runner,
      signal: controller.signal,
      confirmed: true,
      modelCall,
    })
    expect(run.status).toBe("cancelled")
    expect(run.synthesisStatus).toBe("not-run")
    expect(run.failure).toEqual({
      kind: "user-cancelled",
      phase: "independent-reviews",
      message: "Fixture cancellation",
    })
    expect(modelCall).toHaveBeenCalledTimes(1)
    const store = new SharedReviewStore(run.request.target.gitDirectory)
    expect(await store.read(run.id)).toMatchObject({
      status: "cancelled",
      synthesisStatus: "not-run",
      failure: { kind: "user-cancelled", phase: "independent-reviews" },
    })
    await expect(store.approve(run.id, ["first-principles:1"])).rejects.toThrow("complete")
  })

  it.each([
    {
      label: "request timeout",
      error: new RestrictedGuideModelError("timed-out"),
      kind: "request-timeout",
    },
    {
      label: "provider failure",
      error: new RestrictedGuideModelError("runtime-error", [], {
        stage: "response",
        model: "gpt-5.6-sol",
        errorType: "server_error",
        statusCode: 503,
      }),
      kind: "provider-failure",
    },
  ] as const)("saves a terminal $label diagnostic and does not leave synthesis queued", async ({ error, kind }) => {
    const f = await fixture()
    const events: ReviewEvent[] = []
    const run = await runSharedReview({
      request: f.request(["first-principles"]),
      runner: f.runner,
      signal: f.signal,
      confirmed: true,
      modelCall: async () => { throw error },
      onEvent: (event) => events.push(event),
    })
    expect(run).toMatchObject({
      status: "incomplete",
      synthesisStatus: "not-run",
      failure: { kind, phase: "independent-reviews" },
      approvedIds: [],
      execution: "not-started",
    })
    expect(run.failure?.message).toContain(error.message)
    expect(events).toContainEqual({ kind: "synthesis", status: "not-run" })
    expect(await new SharedReviewStore(run.request.target.gitDirectory).read(run.id)).toMatchObject({
      synthesisStatus: "not-run",
      failure: { kind, phase: "independent-reviews" },
    })
  })

  it("saves validation failure separately from provider failure", async () => {
    const f = await fixture()
    const run = await runSharedReview({
      request: f.request(["first-principles"]),
      runner: f.runner,
      signal: f.signal,
      confirmed: true,
      modelCall: async () => "{",
    })
    expect(run).toMatchObject({
      status: "incomplete",
      synthesisStatus: "not-run",
      failure: { kind: "validation-failure", phase: "independent-reviews" },
    })
  })

  it("classifies an external deadline during final synthesis as an overall timeout", async () => {
    const f = await fixture()
    const controller = new AbortController()
    const modelCall = vi.fn<typeof fixtureOptimizeModel>(async (request) => {
      if (request.responseFormat?.jsonSchema.name === "optimize_verdict") {
        controller.abort(new DOMException("The operation timed out.", "TimeoutError"))
        throw controller.signal.reason
      }
      return fixtureOptimizeModel(request)
    })
    const run = await runSharedReview({
      request: f.request(["first-principles"]),
      runner: f.runner,
      signal: controller.signal,
      confirmed: true,
      modelCall,
    })
    expect(run.results).toHaveLength(1)
    expect(run.results[0]).toMatchObject({ status: "complete" })
    expect(run).toMatchObject({
      status: "incomplete",
      synthesisStatus: "failed",
      failure: { kind: "overall-timeout", phase: "final-synthesis", message: "The operation timed out." },
      approvedIds: [],
      execution: "not-started",
    })
  })

  it("persists completed Architecture batch findings when a later batch times out", async () => {
    const f = await fixture()
    await writeFile(
      path.join(f.repo, "code.ts"),
      Array.from({ length: 1000 }, (_, index) => `export const value${index} = "${"x".repeat(480)}"`).join("\n"),
    )
    const target = await inspectGuideOptimizeTarget(f.runner, f.repo, { kind: "uncommitted" }, f.signal)
    const request = { ...f.request(["improve-codebase-architecture"]), target }
    let evidenceBatch = 0
    const modelCall = vi.fn<typeof fixtureOptimizeModel>(async (modelRequest) => {
      modelRequest.inspectModel({
        ...fixtureOptimizeModelInfo,
        capabilities: {
          ...fixtureOptimizeModelInfo.capabilities,
          limits: { max_context_window_tokens: 200_000 },
        },
      })
      const prompt = JSON.parse(modelRequest.prompt) as {
        data: { batch?: number }
        requiredRanges: Array<{ source: string; startLine: number; endLine: number }>
      }
      if (prompt.data.batch === undefined) throw new Error("Expected Architecture batching.")
      evidenceBatch++
      if (evidenceBatch === 2) throw new RestrictedGuideModelError("timed-out")
      for (const range of prompt.requiredRanges) {
        for (let line = range.startLine; line <= range.endLine; line += 40) {
          await invokeReviewTool(modelRequest, "read_review_source", {
            source: range.source,
            startLine: line,
            lineCount: Math.min(40, range.endLine - line + 1),
          })
        }
      }
      const cited = prompt.requiredRanges.find((range) => !range.source.startsWith("@skill/"))!
      return JSON.stringify({
        summary: "Completed the first assigned Architecture batch.",
        limitations: ["Later evidence batches were not reviewed."],
        findings: [{
          title: "Keep the generated values behind one boundary",
          proposal: "Keep the generated values in one module.",
          benefit: "Callers retain one dependency boundary.",
          risk: "Generation order remains part of the contract.",
          verification: "Run the existing module tests.",
          paths: ["code.ts"],
          citations: [{ source: cited.source, startLine: cited.startLine, endLine: cited.startLine }],
        }],
      })
    })
    const run = await runSharedReview({
      request,
      runner: f.runner,
      signal: f.signal,
      confirmed: true,
      modelCall,
      loadArchitecture: async () => [
        { id: "@skill/improve-codebase-architecture", content: "Review architecture boundaries." },
        { id: "@skill/codebase-design", content: "Prefer cohesive modules." },
      ],
    })
    expect(evidenceBatch, run.error ?? "missing review error").toBe(2)
    expect(run).toMatchObject({
      status: "incomplete",
      synthesisStatus: "not-run",
      failure: { kind: "request-timeout", phase: "independent-reviews" },
      approvedIds: [],
    })
    expect(run.results).toHaveLength(1)
    expect(run.results[0]).toMatchObject({
      id: "improve-codebase-architecture",
      status: "partial",
      findings: [{ title: "Keep the generated values behind one boundary", grounded: true }],
    })
    expect(run.artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([
      "improve-codebase-architecture:batch-evidence-1",
      "improve-codebase-architecture:partial-report",
    ]))
    const store = new SharedReviewStore(run.request.target.gitDirectory)
    await expect(store.approve(run.id, [run.results[0]!.findings[0]!.id])).rejects.toThrow("complete")
    expect(await store.read(run.id)).toMatchObject({ results: [{ status: "partial", findings: [{}] }] })
  })
})
