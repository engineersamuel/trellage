import assert from "node:assert/strict"
import type { ReviewClient, ReviewSession } from "../packages/trellage-launcher/src/copilot-review-provider.ts"
import type { ReviewCheckAssignment, ReviewDefinition } from "../packages/trellage-launcher/src/review-catalog.ts"

export const reviewFixtureText = "Review the changed line while preserving the existing behavior."

type SessionConfig = Parameters<ReviewClient["createSession"]>[0]
export type ReviewFixtureEvent = Parameters<Parameters<ReviewSession["on"]>[0]>[0]

export const exerciseReviewWorkers = async (
  config: SessionConfig,
  emit: (event: ReviewFixtureEvent) => void,
  review: ReviewDefinition,
  assignment: ReviewCheckAssignment,
  snapshot: { readonly base: string; readonly head: string },
  label: string,
): Promise<string> => {
  const sessionId = config.sessionId!
  const invocation = { sessionId }
  const input = (toolName: string, toolArgs: unknown) => ({
    toolName, toolArgs, sessionId, timestamp: new Date(), workingDirectory: config.workingDirectory!,
  })
  const use = async (toolName: string, toolArgs: unknown) => {
    const decision = await config.hooks!.onPreToolUse!(input(toolName, toolArgs), invocation)
    assert.equal(decision?.permissionDecision, "allow", `${label}: ${toolName}`)
    return decision
  }
  const done = async (toolName: string, toolArgs: unknown, content: string) => {
    await config.hooks!.onPostToolUse!({ ...input(toolName, toolArgs),
      toolResult: { resultType: "success", textResultForLlm: content },
    }, invocation)
  }
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const tool = config.tools!.find((tool) => tool.name === name)
    assert(tool?.handler, `${label}: missing ${name}`)
    await use(`custom:${name}`, args)
    return tool.handler(args, { sessionId, toolName: name, toolCallId: `fixture-${name}`, arguments: args })
  }
  await use("builtin:skill", { name: review.skill })
  await done("builtin:skill", { name: review.skill }, "Loaded fixture skill.")
  const manifest = await call("read_snapshot", {})
  assert(manifest !== null && typeof manifest === "object" && "textResultForLlm" in manifest, label)
  assert.equal(typeof manifest.textResultForLlm, "string", label)
  let page = JSON.parse(manifest.textResultForLlm as string)
  let reads = 0
  while (page.remainingRequired.length) {
    assert(reads++ < 100, `${label}: snapshot read did not converge`)
    const range = page.remainingRequired[0]
    const result = await call("read_snapshot", {
      source: range.source, offset: range.start, length: Math.min(16000, range.end - range.start),
    })
    assert(result !== null && typeof result === "object" && "textResultForLlm" in result, label)
    assert.equal(typeof result.textResultForLlm, "string", label)
    page = JSON.parse(result.textResultForLlm as string)
  }
  if (review.kind === "leaf") return reviewFixtureText
  for (const [index, worker] of assignment.workers.entries()) {
    const args = { agent_type: "code-review", mode: "background", description: worker.name,
      prompt: "Review the supplied frozen changes.", model: "unapproved-fixture-model" }
    const decision = await use("builtin:task", args)
    const approved = decision?.modifiedArgs as Record<string, unknown>
    assert.equal(approved.agent_type, "code-review", label)
    assert.equal(approved.mode, "background", label)
    assert.equal(approved.model, worker.model.model, label)
    assert.equal(approved.reasoning_effort, worker.model.effort, label)
    assert.equal(approved.name, review.kind === "fleet" ? `fleet-worker-${index + 1}` : "review-standards", label)
    assert.equal(typeof approved.prompt, "string", label)
    assert((approved.prompt as string).includes("unstaged change"), label)
    const agentId = `fixture-${review.id}-${index}`
    await done("builtin:task", args, agentId)
    emit({ type: "subagent.started", agentId,
      data: { agentType: "code-review", executionMode: "background", agentDescription: worker.name,
        model: worker.model.model },
    } as ReviewFixtureEvent)
    emit({ type: "subagent.completed", agentId,
      data: { firstDispatchedModel: worker.model.model },
    } as ReviewFixtureEvent)
    await use("builtin:read_agent", { agent_id: agentId })
    await done("builtin:read_agent", { agent_id: agentId }, reviewFixtureText)
  }
  if (review.kind === "two-axis") return `## Standards\n${reviewFixtureText}\n\n` +
    "## Spec\nSpec skipped — no spec available; no verified issue or spec source.\n\n" +
    "Summary: Standards 1 finding; Spec unavailable."
  for (const name of ["report-template.md", "review-schema.md"]) {
    assert.equal(await call("read_reference", { name }), `Frozen fixture ${name}.\n`, label)
  }
  const report = {
    schemaVersion: 1, status: "complete", summary: "Frozen change review",
    startedAt: null, completedAt: null, pr: null,
    agents: assignment.workers.map((worker) => ({ name: worker.name, lens: worker.name,
      model: worker.model.model, status: "complete", error: "" })),
    counts: { critical: 0, high: 0, medium: 1, low: 0, confirmedTotal: 1 },
    findings: [{ id: "F-1", severity: "medium", title: "Review the changed line", problem: reviewFixtureText,
      evidence: "Captured unstaged change", path: "unstaged.ts", lineStart: 1, lineEnd: 1,
      currentCode: "unstaged change", suggestedCode: "unstaged change", fixKind: "exact", judgmentNotes: "",
      reportedBy: [`${assignment.workers[0]!.name} / ${assignment.workers[0]!.model.model}`] }],
  }
  const markdown = await call("save_review", { file: "fixture.md", content: `# Frozen review\n\nBase: ${snapshot.base}\nHEAD: ${snapshot.head}\n\n${reviewFixtureText}\n` })
  assert.equal(typeof markdown, "string", label)
  assert.match(markdown as string, /^docs\/review\/.*\.md$/u, label)
  const json = await call("save_review", { file: "fixture.json", content: JSON.stringify(report) })
  assert.equal(json, (markdown as string).replace(/\.md$/u, ".json"), label)
  return "Fleet fixture review complete."
}
