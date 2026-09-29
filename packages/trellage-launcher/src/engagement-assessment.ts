import { readFile } from "node:fs/promises"
import type { ModelInfo } from "@github/copilot-sdk"
import {
  GuideModelCapabilityError,
  runRestrictedGuideModelRequest,
  type RestrictedGuideModelRequest,
} from "./copilot-guide-provider.ts"
import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import type { GuideModelConfig } from "./guide-model-routing.ts"
import { array, boundedNumber, exactKeys, literal, record, stringArray, text, uniqueArray } from "./guide-text.ts"
import { engagementContextSource, type EngagementSnapshot } from "./engagement-context.ts"

export interface EngagementCitation {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly quote: string
}

export interface EngagementWorkflow {
  readonly profileRef: string
  readonly workflowId: string
}

export interface EngagementAction {
  readonly title: string
  readonly objective: string
  readonly whyNow: string
  readonly expectedOutput: string
  readonly reviewer: string
  readonly citations: ReadonlyArray<EngagementCitation>
  readonly workflow: EngagementWorkflow | null
}

export interface EngagementAssessment {
  readonly schemaVersion: 1
  readonly outcome: "recommendation" | "needs-clarification" | "no-action"
  readonly understanding: ReadonlyArray<{
    readonly text: string
    readonly basis: "documented" | "inferred"
    readonly citations: ReadonlyArray<EngagementCitation>
  }>
  readonly uncertainties: ReadonlyArray<string>
  readonly question: string | null
  readonly actions: ReadonlyArray<EngagementAction>
}

export const engagementWorkflows = (catalog: CombinedGuideCatalog) =>
  catalog.native.flatMap((entry) =>
    entry.guide.workflows
      .filter((workflow) => workflow.interaction?.mode === "interactive")
      .map((workflow) => ({
        profileRef: `native:${entry.launcher}/${entry.name}`,
        workflowId: workflow.id,
        description: workflow.description,
      })),
  )

export const parseEngagementCitations = (
  input: unknown,
  snapshot: EngagementSnapshot,
): ReadonlyArray<EngagementCitation> =>
  array(input, "citations", { minimum: 1, maximum: 5 }).map((value) => {
    const citation = record(value, "citation")
    exactKeys(citation, "citation", ["path", "startLine", "endLine", "quote"])
    const filename = text(citation.path, "citation.path", 1024)
    const evidence =
      filename === engagementContextSource && snapshot.context
        ? { content: snapshot.context }
        : snapshot.sources.find((source) => source.path === filename)
    if (evidence === undefined) throw new Error(`Assessment cited a source that was not shared: ${filename}`)
    const lines = evidence.content.split("\n")
    const startLine = boundedNumber(citation.startLine, "startLine", 1, lines.length)
    const endLine = boundedNumber(citation.endLine, "endLine", startLine, Math.min(lines.length, startLine + 39))
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) throw new Error("Citation lines must be integers")
    const quote = text(citation.quote, "quote", 1000, { multiline: true, preserve: true })
    if (
      !lines
        .slice(startLine - 1, endLine)
        .join("\n")
        .includes(quote)
    ) {
      throw new Error(`Assessment quote does not occur at ${filename}:${startLine}-${endLine}`)
    }
    return { path: filename, startLine, endLine, quote }
  })

export const parseEngagementAction = (
  value: unknown,
  snapshot: EngagementSnapshot,
  workflows: ReadonlyArray<EngagementWorkflow> | null,
): EngagementAction => {
  const action = record(value, "action")
  exactKeys(action, "action", ["title", "objective", "whyNow", "expectedOutput", "reviewer", "citations", "workflow"])
  let workflow: EngagementWorkflow | null = null
  if (action.workflow !== null) {
    const fields = record(action.workflow, "workflow")
    exactKeys(fields, "workflow", ["profileRef", "workflowId"])
    workflow = {
      profileRef: text(fields.profileRef, "profileRef", 256),
      workflowId: text(fields.workflowId, "workflowId", 128),
    }
    if (
      !/^native:[a-z0-9]+\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(workflow.profileRef) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(workflow.workflowId)
    )
      throw new Error("Invalid saved engagement workflow identity")
    if (
      workflows !== null &&
      !workflows.some((entry) => entry.profileRef === workflow?.profileRef && entry.workflowId === workflow.workflowId)
    ) {
      throw new Error("Assessment selected an unavailable engagement workflow")
    }
  }
  const field = (name: string, maximum = 1500) => text(action[name], name, maximum, { multiline: true })
  return {
    title: field("title", 160),
    objective: field("objective"),
    whyNow: field("whyNow"),
    expectedOutput: field("expectedOutput"),
    reviewer: field("reviewer"),
    citations: parseEngagementCitations(action.citations, snapshot),
    workflow,
  }
}

export const parseEngagementAssessment = (
  input: unknown,
  snapshot: EngagementSnapshot,
  workflows: ReadonlyArray<EngagementWorkflow> | null,
): EngagementAssessment => {
  const fields = record(input, "engagement assessment")
  exactKeys(fields, "engagement assessment", [
    "schemaVersion",
    "outcome",
    "understanding",
    "uncertainties",
    "question",
    "actions",
  ])
  if (fields.schemaVersion !== 1) throw new Error("Unsupported engagement assessment version")
  const outcome = literal(fields.outcome, "outcome", ["recommendation", "needs-clarification", "no-action"])
  const understanding = array(fields.understanding, "understanding", {
    minimum: 1,
    maximum: 8,
  }).map((value) => {
    const finding = record(value, "understanding")
    exactKeys(finding, "understanding", ["text", "basis", "citations"])
    return {
      text: text(finding.text, "understanding.text", 1500, { multiline: true }),
      basis: literal(finding.basis, "basis", ["documented", "inferred"]),
      citations: parseEngagementCitations(finding.citations, snapshot),
    }
  })
  const actions = array(fields.actions, "actions", { maximum: 3 }).map((action) =>
    parseEngagementAction(action, snapshot, workflows),
  )
  uniqueArray(
    actions.map((action) => action.title.toLowerCase()),
    "actions",
    "titles",
  )
  const question = fields.question === null ? null : text(fields.question, "question", 1000, { multiline: true })
  if (
    (outcome === "recommendation") !== actions.length > 0 ||
    (outcome === "needs-clarification") !== (question !== null)
  ) {
    throw new Error("Assessment outcome does not match its actions and question")
  }
  return {
    schemaVersion: 1,
    outcome,
    understanding,
    actions,
    question,
    uncertainties: stringArray(fields.uncertainties, "uncertainties", {
      maximumItems: 10,
      itemMaximum: 1500,
    }),
  }
}

const inspectModelBudget = (model: ModelInfo, bytes: number): void => {
  const limits = model.capabilities.limits
  const context = limits.max_context_window_tokens
  const prompt = limits.max_prompt_tokens ?? context
  if (
    ![context, prompt].every((value) => Number.isSafeInteger(value) && value > 0) ||
    bytes > Math.min(prompt, context - 16_000) - 8_000
  ) {
    throw new GuideModelCapabilityError(
      "Selected model cannot hold this engagement evidence with output reserves. Select fewer sources or a larger-context model; nothing was omitted.",
    )
  }
}

export type EngagementAssessor = (
  snapshot: EngagementSnapshot,
  intent: string,
  signal: AbortSignal,
  onProgress?: (message: string) => void,
) => Promise<EngagementAssessment>

export class EngagementAssessmentResponseError extends Error {
  constructor(cause: unknown) {
    super("Model citations were invalid; no recommendation was accepted.", { cause })
    this.name = "EngagementAssessmentResponseError"
  }
}

export const createEngagementAssessor =
  (
    catalog: CombinedGuideCatalog,
    config: GuideModelConfig,
    request: (options: RestrictedGuideModelRequest) => Promise<string> = runRestrictedGuideModelRequest,
  ): EngagementAssessor =>
  async (snapshot, intent, signal, onProgress) => {
    signal.throwIfAborted()
    const workflows = engagementWorkflows(catalog)
    const systemPrompt = await readFile(new URL("../prompts/engagement-assess.md", import.meta.url), "utf8")
    const prompt = JSON.stringify({
      untrustedData: { intent, snapshot, workflows },
      scope: "Only explicitly selected repository evidence. User context is unverified clarification, not approval.",
    })
    const size = Buffer.byteLength(prompt) + Buffer.byteLength(systemPrompt)
    if (size > 240_000)
      throw new Error("Engagement request exceeds 240000 bytes. Select fewer sources; nothing was truncated.")
    const response = await request({
      ...config,
      systemPrompt,
      prompt,
      signal,
      timeoutMs: 120_000,
      cleanupTimeoutMs: 3_000,
      maximumResponseBytes: 24_000,
      clientName: "trellage-trx-engagement",
      inspectModel: (model) => inspectModelBudget(model, size),
      ...(onProgress === undefined ? {} : { onProgress }),
    })
    if (Buffer.byteLength(response) > 24_000) throw new Error("Engagement assessment exceeded its response budget")
    try {
      onProgress?.("Validating JSON, citations, and recommendation")
      const assessment = parseEngagementAssessment(JSON.parse(response), snapshot, workflows)
      onProgress?.("Assessment verified")
      return assessment
    } catch (cause) {
      throw new EngagementAssessmentResponseError(cause)
    }
  }

export const engagementCitationText = (citations: ReadonlyArray<EngagementCitation>): string =>
  citations
    .map(
      (citation) =>
        `${citation.path === engagementContextSource ? "Your clarification" : citation.path}:${citation.startLine}-${citation.endLine}`,
    )
    .join(", ")

export const engagementAssessmentDocument = (assessment: EngagementAssessment): string =>
  [
    "# Engagement assessment",
    "",
    "Advisory assessment, not customer signoff. Documented statements are not independently verified.",
    "",
    ...assessment.understanding.map(
      (finding) =>
        `## ${finding.basis === "documented" ? "Documented" : "Inferred"}\n${finding.text}\n\nSources: ${engagementCitationText(finding.citations)}`,
    ),
    ...(assessment.uncertainties.length === 0
      ? []
      : ["## Unknowns and conflicts", ...assessment.uncertainties.map((value) => `- ${value}`)]),
    ...(assessment.question === null ? [] : ["## One question", assessment.question]),
    ...assessment.actions.map(
      (action, index) =>
        `## ${index === 0 ? "Recommended next action" : `Alternative ${index}`}: ${action.title}\n${action.objective}\n\nWhy now: ${action.whyNow}\n\nExpected result: ${action.expectedOutput}\n\nReview by: ${action.reviewer}\n\nSources: ${engagementCitationText(action.citations)}\n\nSupport: ${action.workflow === null ? "Human action; no agent launch" : `${action.workflow.profileRef} / ${action.workflow.workflowId}`}`,
    ),
    ...(assessment.outcome === "no-action" ? ["## No further action recommended"] : []),
  ].join("\n\n")
