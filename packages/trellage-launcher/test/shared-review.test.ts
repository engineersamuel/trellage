import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionEvent } from "@github/copilot-sdk"
import type { ReviewClientFactory } from "../src/copilot-review-provider.ts"
import { RestrictedGuideModelError } from "../src/copilot-guide-provider.ts"
import { createNodeCommandRunner, type CommandRunner } from "../src/guide-launch.ts"
import { inspectGuideReviewTarget } from "../src/review-target.ts"
import { assignReviewModels, reviewCheckCatalog } from "../src/review-catalog.ts"
import { reviewSynthesisStatus, type ReviewEvent, type ReviewRequest, type ReviewRun } from "../src/review-contracts.ts"
import { runSharedReview } from "../src/review-coordinator.ts"
import { captureSharedReviewEvidence, planReviewEvidence, reviewExecutionPolicy, reviewIncompatibilities } from "../src/review-evidence.ts"
import { optimizeDigest } from "../src/review-source.ts"
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
  const target = await inspectGuideReviewTarget(runner, repo, { kind: "uncommitted" }, signal)
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
  it("round-trips every catalog selection with its frozen patch projection", async () => {
    const f = await fixture()
    const frozen = await captureSharedReviewEvidence(f.runner, f.request(["ponytail"]), f.signal)
    for (let mask = 1; mask < 2 ** reviewCheckCatalog.length; mask++) {
      const checks = reviewCheckCatalog.filter((_, index) => mask & (1 << index))
      const request = f.request(checks.map((check) => check.id))
      const run: ReviewRun = {
        schemaVersion: 2, id: randomUUID(), createdAt: new Date().toISOString(), request,
        evidence: frozen, policy: reviewExecutionPolicy(checks.map((check) => check.id), frozen.source),
        status: "running", synthesisStatus: "queued", results: [], artifacts: [], challenges: [],
        decisions: [], summary: "Review in progress.", error: null, calls: 0, approvedIds: [], execution: "not-started",
      }
      expect(parseSharedReview(run)).toEqual(run)
      expect(reviewIncompatibilities({ ...request, target: { ...request.target, head: null } }).length > 0).toBe(true)
      for (const check of checks) {
        const plan = planReviewEvidence(request, frozen, check.id)
        expect(plan.requiredSources).toEqual(frozen.patch!.sourceIds)
      }
      const { sourceIds: _ids, primarySourceIds: _primary, ...inline } = frozen.patch!
      const projection = { source: frozen.source, patch: inline }
      expect(parseSharedReview({ ...run, evidence: { ...projection, fingerprint: optimizeDigest(projection) } }))
        .toMatchObject({ evidence: { patch: inline } })
      const missing = { source: frozen.source }
      expect(() => parseSharedReview({ ...run, evidence: { ...missing, fingerprint: optimizeDigest(missing) } }))
        .toThrow()
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
    const target = await inspectGuideReviewTarget(f.runner, f.repo, { kind: "uncommitted" }, f.signal)
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
    "runs a skill check with %s extraction and retains independent synthesis status", async (extraction) => {
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
        await invokeReviewTool(request, "read_review_source", { source: "@diff/unstaged", startLine: 1, lineCount: 200 })
        await invokeReviewTool(request, "read_review_source", { source: "@diff/staged", startLine: 1, lineCount: 200 })
        return JSON.stringify({ complete: true, limitations: [], findings: [{
          title: "Simplify", excerpt: "No removable complexity found.", proposal: "Delete the dead branch.",
          benefit: "Less code.", risk: "Low.", verification: "Run tests.", severity: null, paths: ["code.ts"],
          citations: [{ source: "@diff/unstaged", startLine: 1, endLine: 1 }],
        }] })
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
          if (extraction === "failed" || extraction === "schema-error") expect(prompt).toContain("Finding normalization failed")
          synthesisReturned = true
          const contract = /"decisionSources":(\[[^\]]*\])/u.exec(prompt)?.[1]
          const decisionSources = contract === undefined ? ["ponytail"] : JSON.parse(contract) as string[]
          const findingSources = decisionSources.filter((source) => source !== "ponytail")
          return {
            data: {
              content: JSON.stringify({
                findings: findingSources.length
                  ? [{ title: "Simplify", sources: findingSources, reason: "Small deletion supported." }] : [],
                decisions: decisionSources.map((source) =>
                  ({ source, disposition: "kept", reason: "Frozen evidence supports it." })),
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
      request: f.request(["ponytail"]),
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
      await expect(store.approve(run.id, ["ponytail:batch-1:1"])).rejects.toThrow("complete")
      return
    }
    if (extraction === "failed" || extraction === "schema-error" || extraction === "cancelled") {
      expect(run.status).toBe(extraction === "cancelled" ? "cancelled" : "incomplete")
      expect(run.results.find((result) => result.id === "ponytail")?.status).toBe("failed")
      expect(run.artifacts.find((entry) => entry.id === "ponytail:report")?.content).toContain("No removable complexity found.")
      expect(phases.filter((phase) => phase === "review_extraction")).toHaveLength(extraction === "failed" ? 2 : 1)
      const store = new SharedReviewStore(run.request.target.gitDirectory)
      await expect(store.approve(run.id, ["ponytail:batch-1:1"])).rejects.toThrow("complete")
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
    expect(run.results.map((result) => result.id)).toEqual(["ponytail"])
    expect(events.filter((event) => event.kind === "synthesis")).toHaveLength(2)
    expect(events).toContainEqual({ kind: "text", checkId: "ponytail", source: "Reviewer",
      text: "Independent streamed assessment." })
    const store = new SharedReviewStore(run.request.target.gitDirectory)
    expect(await readdir(store.directory)).toEqual([`${run.id}.json`])
    expect((await store.read(run.id)).request.originalIntent).toBe(f.request(["ponytail"]).originalIntent)
    const approval = await store.approve(run.id, ["ponytail:batch-1:1"])
    await store.beginExecution(approval)
    await expect(store.beginExecution(approval)).rejects.toThrow("unlaunched")
    await store.finishExecution(run.id, "unknown")
    expect((await store.read(run.id)).execution).toBe("unknown")
  })

  it("keeps patch-only evidence narrow and preserves links without following them", async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, "private"), "DO NOT SHARE LINK TARGET")
    await symlink(path.join(f.root, "private"), path.join(f.repo, "link"))
    const target = await inspectGuideReviewTarget(f.runner, f.repo, { kind: "uncommitted" }, f.signal)
    const request = { ...f.request(["ponytail"]), target, paths: ["link"] }
    const evidence = await captureSharedReviewEvidence(f.runner, request, f.signal)
    expect(evidence.source.sources.find((source) => source.id === "@diff/untracked/link")?.content).toContain("120000")
    expect(evidence.patch?.diff).not.toContain("DO NOT SHARE")
    expect(evidence.source.sources.every((source) => source.id.startsWith("@diff/"))).toBe(true)
  })
})
