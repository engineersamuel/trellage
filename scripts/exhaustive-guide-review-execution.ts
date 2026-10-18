import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { reviewCatalog, type ReviewDefinition } from "../packages/trellage-launcher/src/review-catalog.ts"
import { exerciseReviewWorkers, reviewFixtureText, type ReviewFixtureEvent } from "./exhaustive-guide-review-workers.ts"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import type { ReviewClientFactory } from "../packages/trellage-launcher/src/copilot-review-provider.ts"
import { resolveGuideModelRouting, type GuideHeadlessArgs } from "../packages/trellage-launcher/src/guide-api.ts"
import type { CommandRunner, HerdrContext } from "../packages/trellage-launcher/src/guide-launch.ts"
import { createGuideReviewServices } from "../packages/trellage-launcher/src/review-services.ts"
import type { GuideReviewTarget } from "../packages/trellage-launcher/src/review-target.ts"
import { SharedReviewStore } from "../packages/trellage-launcher/src/review-store.ts"
import type { ReviewEvent } from "../packages/trellage-launcher/src/review-contracts.ts"
import { fixtureOptimizeModelInfo, invokeReviewTool } from "../packages/trellage-launcher/test/fixtures/guide-optimize-model.ts"
import { assertGuideReviewHandoff } from "./exhaustive-guide-review-handoff.ts"
import type { createGuideWorld } from "./exhaustive-guide-world.ts"

const assertGuideReviewSelection = async (
  selected: ReadonlyArray<ReviewDefinition>,
  args: GuideHeadlessArgs,
  world: Awaited<ReturnType<typeof createGuideWorld>>,
  id: string,
  fixture: { readonly root: string; readonly runner: CommandRunner; readonly target: GuideReviewTarget; readonly context: HerdrContext | null },
): Promise<void> => {
  const label = `${id}: service review execution ${selected.map((review) => review.id).join(",")}`
  const { target, context } = fixture
  const managerPath = path.join(fixture.root, "review-manager.ts")
  const catalogPath = path.join(fixture.root, "review-skills.json")
  const cachePath = path.join(fixture.root, "review-staging", "cache")
  await writeFile(managerPath, "// Explicit offline fixture manager.\n", { mode: 0o600 })
  await writeFile(catalogPath, "{}\n", { mode: 0o600 })
  let managerCalls = 0
  const runner: CommandRunner = {
    run: async (executable, argv, options) => {
      if (executable === "git") return fixture.runner.run(executable, argv, options)
      assert.equal(executable, bunExecutable(), label)
      const bundle = argv.at(-1)!
      assert.deepEqual(argv, bunArguments(managerPath, [
        "ensure", "--bundle", "native-common", "--catalog", catalogPath, "--cache", cachePath, "--target", bundle,
      ]), label)
      assert.equal(path.basename(bundle), "bundle", label)
      assert.equal(options?.cwd, path.dirname(bundle), label)
      assert.equal(options?.timeoutMs, 180_000, label)
      managerCalls++
      assert.equal(managerCalls, 1, label)
      for (const review of reviewCatalog) {
        await mkdir(path.join(bundle, review.skill), { recursive: true, mode: 0o700 })
        await writeFile(path.join(bundle, review.skill, "SKILL.md"),
          `---\nname: ${review.skill}\n---\nReview the assigned immutable changes.\n`, { mode: 0o600 })
        if (review.kind === "fleet") {
          await mkdir(path.join(bundle, review.skill, "references"), { mode: 0o700 })
          for (const name of ["report-template.md", "review-schema.md"])
            await writeFile(path.join(bundle, review.skill, "references", name), `Frozen fixture ${name}.\n`, { mode: 0o600 })
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  }
  const routing = resolveGuideModelRouting({
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
  }, {})
  const sdkCalls: string[] = []
  let normalizationCalls = 0
  let unexpectedCalls = 0
  const unexpected = async (): Promise<never> => {
    unexpectedCalls++
    throw new Error(`${label}: unexpected agent or readiness boundary`)
  }
  const clientFactory: ReviewClientFactory = () => ({
    start: async () => {},
    listModels: async () => [...new Set([
      services.coordinator.model,
      ...services.assignments!.flatMap((assignment) => [assignment.model.model, ...assignment.workers.map((worker) => worker.model.model)]),
    ])].map((model) => ({ ...fixtureOptimizeModelInfo, id: model, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] })),
    deleteSession: async () => {},
    forceStop: async () => {},
    createSession: async (config) => {
      assert.equal(typeof config.sessionId, "string", label)
      let sent = false
      let emit: (event: ReviewFixtureEvent) => void = () => { throw new Error(`${label}: missing event listener`) }
      return {
        sessionId: config.sessionId!,
        on: (listener) => { emit = listener; return () => {} },
        abort: async () => {},
        disconnect: async () => {},
        sendAndWait: async ({ prompt }) => {
          assert.equal(sent, false, label)
          sent = true
          if (config.skillDirectories?.length) {
            const review = reviewCatalog.find((entry) => path.basename(config.skillDirectories![0]!) === entry.skill)
            assert(review && selected.some((entry) => entry.id === review.id), label)
            assert.equal(sdkCalls.includes(review.id), false, label)
            sdkCalls.push(review.id)
            const assignment = services.assignments!.find((entry) => entry.id === review.id)!
            assert.equal(config.model, assignment.model.model, label)
            assert(target.head !== null, `${label}: fixture must have a committed HEAD`)
            const content = await exerciseReviewWorkers(config, (event) => emit(event), review, assignment,
              { base: target.base?.mergeBase ?? target.head, head: target.head }, label)
            return { data: { content } }
          }
          sdkCalls.push("synthesis")
          const contract = /"decisionSources":(\[[^\]]*\])/u.exec(prompt)?.[1]
          assert(contract !== undefined, label)
          const sources: string[] = JSON.parse(contract)
          assert(sources.length > 0 && sources.every((source) => reviewCatalog.some((review) =>
            source === review.id || source.startsWith(`${review.id}:`))), label)
          const findingContract = /"findingSources":(\[[^\]]*\])/u.exec(prompt)?.[1]
          assert(findingContract !== undefined, label)
          const findings: string[] = JSON.parse(findingContract)
          return { data: { content: JSON.stringify({
            findings: findings.length ? [{ title: "Review the changed line", sources: findings, reason: "Grounded in the captured diff." }] : [],
            decisions: sources.map((source) => ({ source, disposition: "kept", reason: "Frozen evidence supports this finding." })),
            disagreements: [], questions: [], challengeDecisions: [],
          }) } }
        },
      }
    },
  })
  const services = createGuideReviewServices({
    runner, cwd: target.cwd, context, catalog: world.catalog, routing,
    modelOverrides: {
      ...(args.model === undefined ? {} : { model: routing.optimize.model }),
      ...(args.effort === undefined ? {} : { effort: routing.optimize.effort }),
    },
    env: { TRELLAGE_TEST_OFFLINE: "1", TRELLAGE_GUIDE_SKILLS_MANAGER: managerPath,
      TRELLAGE_GUIDE_SKILLS_CATALOG: catalogPath, TRELLAGE_GUIDE_NATIVE_SKILLS_CACHE: cachePath },
    dependencies: {
      clientFactory, listAgents: unexpected, readiness: unexpected, processReader: unexpected,
      modelCall: async (request) => {
        assert.equal(request.responseFormat?.jsonSchema.name, "review_extraction", label)
        normalizationCalls++
        assert(normalizationCalls <= selected.filter((review) => review.kind !== "fleet").length, label)
        request.inspectModel({ ...fixtureOptimizeModelInfo, id: request.model })
        const input = JSON.parse(request.prompt)
        assert.equal(typeof input.report, "string", label)
        assert(input.report.includes(reviewFixtureText), label)
        assert.deepEqual(input.paths, ["unstaged.ts"], label)
        assert(input.sources.includes("@diff/unstaged"), label)
        await invokeReviewTool(request, "read_review_source", {
          source: "@diff/unstaged", startLine: 1, lineCount: 1,
        })
        return JSON.stringify({ complete: true, limitations: [], findings: [{
          title: "Review the changed line", excerpt: reviewFixtureText,
          proposal: "Keep the changed line and preserve existing behavior.", benefit: "Preserves the requested change.",
          risk: "Check the existing behavior.", verification: "Run the existing contracts.", severity: null,
          paths: ["unstaged.ts"], citations: [{ source: "@diff/unstaged", startLine: 1, endLine: 1 }],
        }] })
      },
    },
  })
  const signal = new AbortController().signal
  const events: ReviewEvent[] = []
  const request = { target, paths: ["unstaged.ts"], reviewerIds: selected.map((review) => review.id),
    originalIntent: "Preserve the existing behavior.", intent: "Review the captured change." }
  if (!selected.length) {
    await assert.rejects(services.review(request, signal, () => undefined, (event) => events.push(event)),
      /Select one or more distinct review checks/, label)
    assert.equal(managerCalls, 0, label)
    assert.deepEqual(sdkCalls, [], label)
    assert.equal(normalizationCalls, 0, label)
    assert.equal(unexpectedCalls, 0, label)
    return
  }
  const run = await services.review(request, signal, () => undefined, (event) => events.push(event))
  assert.equal(run.status, "complete", `${label}: ${JSON.stringify({ error: run.error, results: run.results })}`)
  assert.equal(run.synthesisStatus, "complete", label)
  assert.equal(run.error, null, label)
  assert.equal(sdkCalls.at(-1), "synthesis", label)
  assert.deepEqual(sdkCalls.slice(0, -1).sort(), selected.map((review) => review.id).sort(), label)
  assert.equal(normalizationCalls, selected.filter((review) => review.kind !== "fleet").length, label)
  assert.equal(unexpectedCalls, 0, label)
  assert.equal(managerCalls, 1, label)
  assert.equal(run.results.length, selected.length, label)
  const findings = run.results.flatMap((result) => result.findings)
  for (const result of run.results) {
    assert.equal(result.status, "complete", label)
    assert.equal(result.findings.length, 1, label)
    assert.equal(result.findings[0]!.grounded, true, label)
  }
  assert.deepEqual(await services.readReview(run.id, signal), run, label)
  assert((await services.history(signal)).some((entry) => entry.id === run.id), label)
  await assert.rejects(services.approve(run.id, ["invented-finding"], signal), label)
  const approval = await services.approve(run.id, [findings[0]!.id], signal)
  assert.equal(approval.reviewId, run.id, label)
  const saved = await new SharedReviewStore(target.gitDirectory).read(run.id)
  assert.deepEqual(saved.approvedIds, [findings[0]!.id], label)
  assert.equal(saved.execution, "not-started", label)
  assert(events.some((event) => event.kind === "synthesis" && event.status === "complete"), label)
  await assertGuideReviewHandoff(world, run, fixture.runner, context, id)
}

export const assertGuideReviewExecution = async (
  args: GuideHeadlessArgs,
  world: Awaited<ReturnType<typeof createGuideWorld>>,
  id: string,
  fixture: { readonly root: string; readonly runner: CommandRunner; readonly target: GuideReviewTarget; readonly context: HerdrContext | null },
): Promise<void> => {
  const selections: ReadonlyArray<ReviewDefinition>[] = [[]]
  for (const review of reviewCatalog)
    selections.push(...selections.map((selection) => [...selection, review]))
  assert.equal(selections.length, 2 ** reviewCatalog.length, id)
  for (const selected of selections) {
    await assertGuideReviewSelection(selected, args, world, id, fixture)
  }
}
