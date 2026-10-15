import type { RestrictedGuideModelRequest } from "./copilot-guide-provider.ts"
import type { OptimizeEvidence, OptimizeSourceRange } from "./review-source.ts"
import type { GuideReviewTarget } from "./review-target.ts"
import type { GuideModelConfig } from "./guide-model-routing.ts"
import { array, boundedNumber, exactKeys, record, text } from "./guide-text.ts"
import {
  reviewFailureKindLabel,
  reviewFailurePhaseLabel,
  reviewSynthesisStatus,
  type ReviewRun,
} from "./review-contracts.ts"

export interface OptimizeReviewInput {
  readonly target: GuideReviewTarget
  readonly paths: ReadonlyArray<string>
  readonly reviewerIds: ReadonlyArray<string>
  readonly originalIntent?: string
  readonly intent?: string
}

export interface OptimizeReviewer {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly prompt: string
  readonly model: GuideModelConfig
}

export interface OptimizeCitation extends OptimizeSourceRange {
  readonly quote: string
}

export interface OptimizeFinding {
  readonly id: string
  readonly title: string
  readonly proposal: string
  readonly benefit: string
  readonly risk: string
  readonly verification: string
  readonly paths: ReadonlyArray<string>
  readonly citations: ReadonlyArray<OptimizeCitation>
}

export interface OptimizeResponse {
  readonly findingId: string
  readonly disposition: "support" | "reject" | "uncertain"
  readonly reason: string
  readonly citations: ReadonlyArray<OptimizeCitation>
}

export interface OptimizeChallenge {
  readonly reviewerId: string
  readonly responses: ReadonlyArray<OptimizeResponse>
}

export type OptimizeModelCall = (request: RestrictedGuideModelRequest) => Promise<string>

const diagnosticValue = (value: unknown): string => {
  const rendered = JSON.stringify(value) ?? String(value)
  return rendered.length > 80 ? `${rendered.slice(0, 77)}...` : rendered
}

const citationFromSnapshot = (fields: Record<string, unknown>, evidence: OptimizeEvidence): OptimizeCitation => {
  const source = evidence.sources.find((entry) => entry.id === fields.source)
  if (source === undefined)
    throw new Error(`Review cited source ${diagnosticValue(fields.source)} outside its snapshot.`)
  const lines = source.content.split("\n")
  const location = `Citation ${diagnosticValue(source.id)}:${diagnosticValue(fields.startLine)}-${diagnosticValue(fields.endLine)}`
  try {
    const startLine = boundedNumber(fields.startLine, "startLine", 1, lines.length)
    const endLine = boundedNumber(fields.endLine, "endLine", startLine, lines.length)
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) throw new Error("Citation lines must be integers.")
    return { source: source.id, startLine, endLine, quote: lines.slice(startLine - 1, endLine).join("\n") }
  } catch (cause) {
    throw new Error(`${location}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

export const parseOptimizeCitations = (
  input: unknown,
  evidence: OptimizeEvidence,
  mode: "model" | "stored" = "stored",
): ReadonlyArray<OptimizeCitation> =>
  array(input, "citations", { minimum: 1, maximum: 3 }).map((value) => {
    const fields = record(value, "citation")
    exactKeys(
      fields,
      "citation",
      mode === "model" ? ["source", "startLine", "endLine"] : ["source", "startLine", "endLine", "quote"],
    )
    const expected = citationFromSnapshot(fields, evidence)
    const quote = text(mode === "model" ? expected.quote : fields.quote, "quote", Infinity, {
      multiline: true,
      preserve: true,
    })
    if (!expected.quote.includes(quote))
      throw new Error(`Review quote does not occur at ${expected.source}:${expected.startLine}-${expected.endLine}.`)
    return { ...expected, quote }
  })

export const sharedReviewDocument = (run: ReviewRun): string => {
  const failure = run.failure
  return [
    `# Review changes ${run.id}`,
    `Status: ${run.status}. Model calls: ${run.calls}.`,
    `${run.results.map((result) => `${result.id} status: ${result.status}.`).join(" ")} Synthesis status: ${reviewSynthesisStatus(run)}.`,
    ...(failure === undefined ? [] : [
      `Failure phase: ${reviewFailurePhaseLabel(failure.phase)}.`,
      `Failure reason: ${reviewFailureKindLabel(failure.kind)}: ${failure.message}`,
    ]),
    run.summary,
    `## Target\n${JSON.stringify(run.request, null, 2)}`,
    `## Findings and decisions\n${JSON.stringify({ results: run.results, decisions: run.decisions }, null, 2)}`,
    ...run.artifacts.map((artifact) => `## ${artifact.name}\n${artifact.content}`),
    ...(run.error ? [`## Error\n${run.error}`] : []),
  ].join("\n\n")
}
