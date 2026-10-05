import type { ModelInfo } from "@github/copilot-sdk"
import type { RestrictedGuideModelRequest } from "../../src/copilot-guide-provider.ts"
import { array, boundedNumber, record, text } from "../../src/guide-text.ts"

export const fixtureOptimizeModelInfo: ModelInfo = {
  id: "offline",
  name: "Offline model",
  capabilities: {
    supports: { vision: false, reasoningEffort: true },
    limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 900_000 },
  },
  supportedReasoningEfforts: ["medium", "high"],
}

export const invokeReviewTool = async (
  request: RestrictedGuideModelRequest,
  name: string,
  args: Record<string, unknown>,
) => {
  const tool = request.tools?.find((entry) => entry.name === name)
  if (tool?.handler === undefined) throw new Error(`Missing snapshot tool: ${name}`)
  const result = record(
    await tool.handler(args, { sessionId: "fixture", toolName: name, toolCallId: "read", arguments: args }),
    "tool result",
  )
  return record(JSON.parse(text(result.textResultForLlm, "tool text", 32_000, { multiline: true })), "tool response")
}

export const readReviewEvidence = async (request: RestrictedGuideModelRequest): Promise<void> => {
  const input = record(JSON.parse(request.prompt), "request")
  const sources = array(input.requiredSources, "requiredSources").map((value) =>
    text(value, "source", 4096, { preserve: true }),
  )
  for (const source of sources) {
    let start: unknown = 1
    while (start !== null) {
      const result = await invokeReviewTool(request, "read_review_source", { source, startLine: start, lineCount: 120 })
      start = result.nextLine
    }
  }
  for (const value of array(input.requiredCitations, "requiredCitations")) {
    const entry = record(value, "citation")
    const start = boundedNumber(entry.startLine, "startLine", 1, Number.MAX_SAFE_INTEGER)
    const end = boundedNumber(entry.endLine, "endLine", start, Number.MAX_SAFE_INTEGER)
    for (let line = start; line <= end; line += 120) {
      await invokeReviewTool(request, "read_review_source", {
        source: entry.source,
        startLine: line,
        lineCount: Math.min(120, end - line + 1),
      })
    }
  }
}

export const fixtureOptimizeModel = async (request: RestrictedGuideModelRequest): Promise<string> => {
  request.signal?.throwIfAborted()
  request.inspectModel(fixtureOptimizeModelInfo)
  const input = record(JSON.parse(request.prompt), "request")
  const data = record(input.data, "data")
  const paths = array(input.selectedPaths, "selectedPaths").map((value) =>
    text(value, "path", 4096, { preserve: true }),
  )
  await readReviewEvidence(request)
  const source = paths[0]!
  await invokeReviewTool(request, "read_review_source", { source, startLine: 1, lineCount: 1 })
  const citations = [{ source, startLine: 1, endLine: 1 }]
  if (data.reports === undefined) {
    const behavior = request.systemPrompt.includes("Independently review the changed implementation")
    return JSON.stringify({
      summary: "Reviewed selected changes.",
      limitations: [],
      findings: behavior
        ? []
        : [
            {
              title: "Simplify the selected changes",
              proposal: "Remove the redundant wrapper while preserving behavior.",
              benefit: "One responsibility stays in one place.",
              risk: "Keep error handling and retry bounds.",
              verification: "Run the existing behavior contracts.",
              paths,
              citations,
            },
          ],
    })
  }
  const findings = array(data.reports, "reports").flatMap((report) =>
    array(record(report, "report").findings, "findings").map((entry) => record(entry, "finding")),
  )
  if (data.challenges === undefined) {
    return JSON.stringify({
      responses: findings.map((entry) => ({
        findingId: entry.id,
        disposition: "support",
        reason: "The cited source supports this bounded change.",
        citations,
      })),
    })
  }
  return JSON.stringify({
    summary: findings.length ? "One useful simplification; preserve existing behavior." : "No change is needed.",
    decisions: findings.map((entry, index) => ({
      findingId: entry.id,
      disposition: index === 0 ? "recommended" : "rejected",
      reason: index === 0 ? "Evidence supports a small deletion." : "This duplicates the first recommendation.",
      citations,
    })),
  })
}
