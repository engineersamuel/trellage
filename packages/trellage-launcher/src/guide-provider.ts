/**
 * Provider-neutral contracts for the `trx guide` model-backed core: the
 * `match` / `generate` / `refine` phases, their strictly validated inputs and
 * outputs, and the `GuideProvider` interface a model adapter (such as
 * `CopilotGuideProvider`) implements.
 *
 * Validation here is the single point of trust between an LLM's raw JSON
 * output and the rest of the launcher: exact keys (no `command` or any other
 * unexpected field can pass through — commands are never derived from the
 * model), numeric bounds, profile/workflow reference checks against the
 * catalog, and uniqueness constraints.
 */
import type { ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import type { GuideMatchCatalogEntry } from "./guide-catalog.js"
import { array, boundedNumber, exactKeys, fail, record, text, uniqueArray } from "./guide-text.js"

export interface GuideMatchCandidate {
  readonly profileRef: string
  readonly workflowId: string
  readonly confidence: number
  readonly reason: string
  readonly tradeoff: string
}

export interface GuideMatchResult {
  readonly candidates: ReadonlyArray<GuideMatchCandidate>
}

export interface GuideGenerateCandidate {
  readonly title: string
  readonly prompt: string
  readonly notes: string
}

export interface GuideGenerateResult {
  readonly candidates: ReadonlyArray<GuideGenerateCandidate>
}

export interface GuideRefineResult {
  readonly candidate: GuideGenerateCandidate
}

export interface GuideOptimizeInput {
  readonly targetTool: string
  readonly profileRef: string
  readonly candidates: ReadonlyArray<GuideGenerateCandidate>
}

export interface GuideOptimizeResult {
  readonly candidates: ReadonlyArray<GuideGenerateCandidate>
}

export interface GuideMatchInput {
  readonly intent: string
  readonly entries: ReadonlyArray<GuideMatchCatalogEntry>
}

export interface GuideGenerateInput {
  readonly intent: string
  readonly profileRef: string
  readonly workflowId: string
  readonly guide: ProfileGuideV1
  /** The selected guide's authored Markdown body, loaded by the caller (never by the provider). Untrusted reference material for the model. */
  readonly guideBody: string
}

export interface GuideRefineInput extends GuideGenerateInput {
  readonly candidate: GuideGenerateCandidate
  readonly feedback: string
}

/** Implemented by model adapters (e.g. `CopilotGuideProvider`). Never exposes commands. */
export interface GuideProvider {
  match(input: GuideMatchInput): Promise<GuideMatchResult>
  generate(input: GuideGenerateInput): Promise<GuideGenerateResult>
  refine(input: GuideRefineInput): Promise<GuideRefineResult>
  optimize(input: GuideOptimizeInput): Promise<GuideOptimizeResult>
}

/** Maximum length for the authored Markdown guide body carried in generate/refine input, mirroring `trellage-guide-core`'s source-document bound. */
export const guideBodyMaximumLength = 128_000

/** Fails closed unless `input` has at least three candidate entries to rank. */
export const assertGuideMatchInput = (input: GuideMatchInput): GuideMatchInput => {
  if (input.entries.length < 3) {
    fail("match input.entries", `must contain at least 3 entries to rank: got ${input.entries.length}`)
  }
  return input
}

/**
 * Fails closed unless `input.workflowId` names a workflow that actually
 * exists on `input.guide`, and unless `input.guideBody` is a non-empty,
 * bounded string. Shared by both `generate` and `refine` (which extends
 * `GuideGenerateInput`).
 */
export const assertGuideGenerateInput = <Input extends GuideGenerateInput>(input: Input): Input => {
  const workflow = input.guide.workflows.find(({ id }) => id === input.workflowId)
  if (workflow === undefined) {
    fail("generate input.workflowId", `must reference a known workflow of the supplied guide: ${input.workflowId}`)
  }
  text(input.guideBody, "generate input.guideBody", guideBodyMaximumLength, { multiline: true })
  return input
}

/** Fails closed unless Prompt Master receives one to three complete candidates and a known target label. */
export const assertGuideOptimizeInput = (input: GuideOptimizeInput): GuideOptimizeInput => {
  text(input.targetTool, "optimize input.targetTool", 128)
  text(input.profileRef, "optimize input.profileRef", 256)
  if (input.candidates.length < 1 || input.candidates.length > 3) {
    fail("optimize input.candidates", `must contain 1 to 3 entries: got ${input.candidates.length}`)
  }
  input.candidates.forEach((candidate, index) => validateGenerateCandidate(candidate, `optimize input.candidates[${index}]`))
  return input
}

const validateMatchCandidate = (
  value: unknown,
  path: string,
  workflowIndex: ReadonlyMap<string, ReadonlySet<string>>,
): GuideMatchCandidate => {
  const fields = record(value, path)
  exactKeys(fields, path, ["profileRef", "workflowId", "confidence", "reason", "tradeoff"])
  const profileRef = text(fields.profileRef, `${path}.profileRef`, 256)
  const workflowIds = workflowIndex.get(profileRef)
  if (workflowIds === undefined) return fail(`${path}.profileRef`, `must reference a known profile: ${profileRef}`)
  const workflowId = text(fields.workflowId, `${path}.workflowId`, 128)
  if (!workflowIds.has(workflowId)) {
    fail(`${path}.workflowId`, `must reference a known workflow of ${profileRef}: ${workflowId}`)
  }
  return {
    profileRef,
    workflowId,
    confidence: boundedNumber(fields.confidence, `${path}.confidence`, 0, 1),
    reason: text(fields.reason, `${path}.reason`, 500),
    tradeoff: text(fields.tradeoff, `${path}.tradeoff`, 500),
  }
}

/**
 * Validates a raw model match response against the catalog's known refs and
 * workflow IDs. Requires three to five candidates with unique profile refs,
 * ordered by non-increasing confidence. Three remains accepted for cached
 * responses created before the five-recommendation UI.
 */
export const validateGuideMatchResult = (
  value: unknown,
  workflowIndex: ReadonlyMap<string, ReadonlySet<string>>,
): GuideMatchResult => {
  const fields = record(value, "match result")
  exactKeys(fields, "match result", ["candidates"])
  const rawCandidates = array(fields.candidates, "match result.candidates", { minimum: 3, maximum: 5 })
  const candidates = rawCandidates.map((item, index) =>
    validateMatchCandidate(item, `match result.candidates[${index}]`, workflowIndex),
  )
  uniqueArray(
    candidates.map(({ profileRef }) => profileRef),
    "match result.candidates",
    "profile refs",
  )
  for (let index = 1; index < candidates.length; index += 1) {
    const current = candidates[index]
    const previous = candidates[index - 1]
    if (current !== undefined && previous !== undefined && current.confidence > previous.confidence) {
      fail("match result.candidates", "must be ordered by non-increasing confidence")
    }
  }
  return { candidates }
}

const validateGenerateCandidate = (value: unknown, path: string): GuideGenerateCandidate => {
  const fields = record(value, path)
  exactKeys(fields, path, ["title", "prompt", "notes"])
  return {
    title: text(fields.title, `${path}.title`, 200),
    prompt: text(fields.prompt, `${path}.prompt`, 8000, { multiline: true }),
    notes: text(fields.notes, `${path}.notes`, 1000, { multiline: true }),
  }
}

/** Validates a raw model generate response. Requires exactly three candidates with distinct prompt strings. */
export const validateGuideGenerateResult = (value: unknown): GuideGenerateResult => {
  const fields = record(value, "generate result")
  exactKeys(fields, "generate result", ["candidates"])
  const rawCandidates = array(fields.candidates, "generate result.candidates", { minimum: 3, maximum: 3 })
  const candidates = rawCandidates.map((item, index) =>
    validateGenerateCandidate(item, `generate result.candidates[${index}]`),
  )
  uniqueArray(
    candidates.map(({ prompt }) => prompt),
    "generate result.candidates",
    "prompts",
  )
  return { candidates }
}

/** Validates a raw model refine response. Requires exactly one candidate. */
export const validateGuideRefineResult = (value: unknown): GuideRefineResult => {
  const fields = record(value, "refine result")
  exactKeys(fields, "refine result", ["candidate"])
  return { candidate: validateGenerateCandidate(fields.candidate, "refine result.candidate") }
}

/** Validates a Prompt Master rewrite response and preserves the requested candidate count. */
export const validateGuideOptimizeResult = (value: unknown, expectedCount: number): GuideOptimizeResult => {
  const fields = record(value, "optimize result")
  exactKeys(fields, "optimize result", ["candidates"])
  const rawCandidates = array(fields.candidates, "optimize result.candidates", {
    minimum: expectedCount,
    maximum: expectedCount,
  })
  const candidates = rawCandidates.map((item, index) =>
    validateGenerateCandidate(item, `optimize result.candidates[${index}]`),
  )
  uniqueArray(
    candidates.map(({ prompt }) => prompt),
    "optimize result.candidates",
    "prompts",
  )
  return { candidates }
}
