import { guideIntentMaximumLength } from "./guide-api.ts"

export const guideGoalAnswerMaximumLength = 8000

export class GuideGoalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "GuideGoalError"
  }
}

export class GuideGoalCancelledError extends GuideGoalError {
  constructor() {
    super("Goal me was cancelled. The prompt is unchanged.")
    this.name = "GuideGoalCancelledError"
  }
}

export interface GuideGoalQuestion {
  readonly question: string
  readonly choices: ReadonlyArray<string>
  readonly allowFreeform: boolean
}

export interface GuideGoalAnswer {
  readonly answer: string
  readonly wasFreeform: boolean
}

export interface GuideGoalDraft {
  readonly artifact: string
  readonly task: string
  readonly criteria: ReadonlyArray<string>
  readonly inputsAndArtifacts?: string
  readonly constraints?: string
  readonly criterionVerifications?: ReadonlyArray<string>
  readonly requiredChecks?: ReadonlyArray<string>
  readonly actions?: ReadonlyArray<GuideGoalAction>
  readonly maxIterations?: number
  readonly maxConsecutiveNoProgressAttempts?: number
}

export interface GuideGoalAction {
  readonly action: string
  readonly criterionIds: ReadonlyArray<string>
  readonly expectedBenefit: string
  readonly prerequisites: string
  readonly verification: string
}

export interface GuideGoalProposal {
  readonly draft: GuideGoalDraft
  readonly prompt: string
}

export type GuideGoalReviewDecision =
  | { readonly decision: "use" }
  | { readonly decision: "revise"; readonly feedback: string }

export type GuideGoalRequest = (
  | { readonly kind: "question"; readonly question: GuideGoalQuestion }
  | { readonly kind: "review"; readonly proposal: GuideGoalProposal }
) & {
  readonly runId: number
  readonly requestId: number
}

export type GuideGoalResponse =
  | { readonly kind: "answer"; readonly answer: GuideGoalAnswer }
  | { readonly kind: "review"; readonly review: GuideGoalReviewDecision }

export interface GuideGoalTurn {
  readonly request: GuideGoalRequest
  readonly response: GuideGoalResponse
}

export interface GuideGoalInteractions {
  ask(question: unknown): Promise<GuideGoalAnswer>
  review(proposal: GuideGoalProposal): Promise<GuideGoalReviewDecision>
}

export interface GuideGoalAugmentContext {
  readonly signal: AbortSignal
  readonly interactions: GuideGoalInteractions
  readonly onActivity: (line: string) => void
}

export interface GuideGoalAugmentInput {
  readonly intent: string
  /** Explicit recovery only. Healthy interviews keep the same SDK session. */
  readonly history: ReadonlyArray<GuideGoalTurn>
  readonly lastProposal?: GuideGoalProposal
}

export interface GuideGoalAugmentProvider {
  augment(input: GuideGoalAugmentInput, context: GuideGoalAugmentContext): Promise<string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const objectValue = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new GuideGoalError("Goal me returned an invalid interaction.")
  }
  return value
}

const invalidControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

const requiredText = (value: unknown, label: string, maximum: number, singleLine = false): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    [...value].length > maximum ||
    invalidControl.test(value) ||
    (singleLine && /[\r\n]/u.test(value))
  ) {
    throw new GuideGoalError(`${label} must be nonempty text within ${maximum} characters.`)
  }
  return value
}

export const validateGuideGoalQuestion = (value: unknown): GuideGoalQuestion => {
  const record = objectValue(value)
  const question = requiredText(record.question, "The question", guideGoalAnswerMaximumLength)
  if (record.allowFreeform !== undefined && typeof record.allowFreeform !== "boolean") {
    throw new GuideGoalError("Goal me returned an invalid freeform setting.")
  }
  const allowFreeform = record.allowFreeform !== false
  if (record.choices !== undefined && !Array.isArray(record.choices)) {
    throw new GuideGoalError("Goal me returned invalid answer choices.")
  }
  const choices = (record.choices ?? []).map((choice: unknown) =>
    requiredText(choice, "An answer choice", guideGoalAnswerMaximumLength),
  )
  if (choices.length > 32 || new Set(choices).size !== choices.length) {
    throw new GuideGoalError("Goal me must provide at most 32 distinct answer choices.")
  }
  if (!allowFreeform && choices.length === 0) {
    throw new GuideGoalError("Goal me asked a question with no allowed answer.")
  }
  return { question, choices, allowFreeform }
}

export const validateGuideGoalAnswer = (question: GuideGoalQuestion, answer: GuideGoalAnswer): GuideGoalAnswer => {
  requiredText(answer.answer, "Your answer", guideGoalAnswerMaximumLength)
  if (answer.wasFreeform) {
    if (!question.allowFreeform) throw new GuideGoalError("Choose one of the supplied answers.")
  } else if (!question.choices.includes(answer.answer)) {
    throw new GuideGoalError("The selected answer is not one of the supplied choices.")
  }
  return answer
}

export const recommendedGuideGoalAnswer = (question: GuideGoalQuestion): GuideGoalAnswer | undefined => {
  const recommended = question.choices.filter((choice) =>
    /\(\s*recommended(?:\s*[:\-\u2013\u2014]\s*[^)]*)?\s*\)/iu.test(choice),
  )
  const answer = recommended.length === 1 ? recommended[0] : undefined
  return answer === undefined ? undefined : { answer, wasFreeform: false }
}

const positiveInteger = (candidate: unknown, label: string): number => {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > 10_000) {
    throw new GuideGoalError(`${label} must be an integer from 1 through 10000.`)
  }
  return candidate as number
}

const validateGoalActions = (
  value: unknown,
  criteria: ReadonlyArray<string>,
): ReadonlyArray<GuideGoalAction> => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new GuideGoalError("An expanded goal needs 1-32 action catalog entries.")
  }
  const criterionIds = new Set(criteria.map((_criterion, index) => `C${index + 1}`))
  return value.map((entry: unknown): GuideGoalAction => {
    const action = objectValue(entry)
    if (!Array.isArray(action.criterionIds) || action.criterionIds.length < 1) {
      throw new GuideGoalError("Each action must name at least one criterion ID.")
    }
    const ids = action.criterionIds.map((id: unknown) => requiredText(id, "An action criterion ID", 16, true).trim())
    if (new Set(ids).size !== ids.length || ids.some((id) => !criterionIds.has(id))) {
      throw new GuideGoalError("Action criterion IDs must be distinct IDs from this goal.")
    }
    return {
      action: requiredText(action.action, "An action", 4000, true).trim(),
      criterionIds: ids,
      expectedBenefit: requiredText(action.expectedBenefit, "An expected benefit", 4000, true).trim(),
      prerequisites: requiredText(action.prerequisites, "Action prerequisites", 4000, true).trim(),
      verification: requiredText(action.verification, "Action verification", 4000, true).trim(),
    }
  })
}

const validateExpandedGuideGoalDraft = (
  record: Record<string, unknown>,
  base: Pick<GuideGoalDraft, "artifact" | "task" | "criteria">,
): GuideGoalDraft => {
  const inputsAndArtifacts = requiredText(record.inputsAndArtifacts, "INPUTS AND ARTIFACTS", 30_000).trim()
  const constraints = requiredText(record.constraints, "CONSTRAINTS", 30_000).trim()
  if (!Array.isArray(record.criterionVerifications) || record.criterionVerifications.length !== base.criteria.length) {
    throw new GuideGoalError("Each success criterion needs one verification and score mapping.")
  }
  const criterionVerifications = record.criterionVerifications.map((verification: unknown) =>
    requiredText(verification, "A criterion verification", 4000, true).trim(),
  )
  if (!Array.isArray(record.requiredChecks) || record.requiredChecks.length < 1 || record.requiredChecks.length > 32) {
    throw new GuideGoalError("An expanded goal needs 1-32 required-check entries, including an explicit None entry when applicable.")
  }
  const requiredChecks = record.requiredChecks.map((check: unknown) =>
    requiredText(check, "A required check", 4000, true).trim(),
  )
  return {
    ...base,
    inputsAndArtifacts,
    constraints,
    criterionVerifications,
    requiredChecks,
    actions: validateGoalActions(record.actions, base.criteria),
    maxIterations: positiveInteger(record.maxIterations, "Max iterations"),
    maxConsecutiveNoProgressAttempts: positiveInteger(
      record.maxConsecutiveNoProgressAttempts,
      "Max consecutive no-progress attempts",
    ),
  }
}

export const validateGuideGoalDraft = (value: unknown): GuideGoalDraft => {
  const record = objectValue(value)
  const artifact = requiredText(record.artifact, "The artifact", 1000, true).trim()
  const task = requiredText(record.task, "TASK", 30_000).trim()
  if (!Array.isArray(record.criteria) || record.criteria.length < 3 || record.criteria.length > 32) {
    throw new GuideGoalError("A goal needs 3-32 independently scoreable success criteria.")
  }
  const criteria = record.criteria.map((criterion: unknown) =>
    requiredText(criterion, "A success criterion", 2000, true).trim(),
  )
  const distinct = new Set(criteria.map((criterion) => criterion.replace(/\s+/gu, " ").toLowerCase()))
  if (distinct.size !== criteria.length) throw new GuideGoalError("Each success criterion must be distinct.")
  if ([artifact, task, ...criteria].some((text) => /^\[(?:criterion \d+|describe exactly what you want produced)\]$/iu.test(text))) {
    throw new GuideGoalError("Fill the goal placeholders before requesting approval.")
  }
  const expandedFields = [
    record.inputsAndArtifacts,
    record.constraints,
    record.criterionVerifications,
    record.requiredChecks,
    record.actions,
    record.maxIterations,
    record.maxConsecutiveNoProgressAttempts,
  ]
  const expanded = expandedFields.some((field) => field !== undefined)
  if (!expanded) return { artifact, task, criteria }
  if (expandedFields.some((field) => field === undefined)) {
    throw new GuideGoalError("An expanded goal proposal must fill every expanded template section.")
  }
  return validateExpandedGuideGoalDraft(record, { artifact, task, criteria })
}

export const validateGuideGoalPrompt = (prompt: string): string =>
  requiredText(prompt, "The complete goal", guideIntentMaximumLength)

const installedGoalTemplate = (skillContent: string): string | undefined =>
  /^## Goal prompt[ \t]*\n+```(?:text|markdown|md)?[ \t]*\n([\s\S]+?)\n```/mu.exec(
    skillContent.replace(/\r\n/gu, "\n"),
  )?.[1]

export const guideGoalTemplateKind = (skillContent: string): "legacy" | "expanded" | undefined => {
  const template = installedGoalTemplate(skillContent)
  if (template?.includes("\nINPUTS AND ARTIFACTS:\n") === true && template.includes("\nACTION CATALOG:\n")) {
    return "expanded"
  }
  return template?.includes("\n\nSUCCESS CRITERIA (be strict):\n") === true ? "legacy" : undefined
}

const replaceTemplateMarker = (template: string, marker: string, replacement: string): string => {
  const offset = template.indexOf(marker)
  if (offset === -1 || template.indexOf(marker, offset + marker.length) !== -1) {
    throw new GuideGoalError("The installed goal-me template has changed. Update the guide before using it.")
  }
  return `${template.slice(0, offset)}${replacement}${template.slice(offset + marker.length)}`
}

const tableCell = (value: string): string => value.replace(/\|/gu, "\\|")

const expandedTemplateHeadings = [
  "TASK",
  "INPUTS AND ARTIFACTS",
  "CONSTRAINTS",
  "SUCCESS CRITERIA",
  "REQUIRED CHECKS",
  "ACTION CATALOG",
  "EXECUTION LIMITS",
  "SCOREBOARD",
  "RECENT ATTEMPTS",
  "LEARNINGS",
] as const

const expandedCriteriaPlaceholder =
  "| C1 | [target] | [command or evidence-based rubric] |\n| C2 | [target] | [command or evidence-based rubric] |\n| C3 | [target] | [command or evidence-based rubric] |"

const expandedRequiredChecksMarkers = [
  "[Each check's ID, command or inspection method, and pass condition.\nWrite \"None\" explicitly only if no required checks apply.]",
  "[Each check's ID, command or inspection method, and pass condition.]",
] as const

const validateExpandedTemplateStructure = (template: string): string => {
  const boundary = "\nLOOP PROTOCOL:\n"
  const protocolOffset = template.indexOf(boundary)
  if (protocolOffset === -1 || template.indexOf(boundary, protocolOffset + boundary.length) !== -1) {
    throw new GuideGoalError("The installed goal-me template has changed. Update the guide before using it.")
  }
  const authored = template.slice(0, protocolOffset)
  const headings = [...authored.matchAll(/^([A-Z][A-Z ]+):$/gmu)].map((match) => match[1])
  if (headings.length !== expandedTemplateHeadings.length || headings.some((heading, index) => heading !== expandedTemplateHeadings[index])) {
    throw new GuideGoalError("The installed goal-me template has changed. Update the guide before using it.")
  }
  const requiredChecksMarker = expandedRequiredChecksMarkers.find((marker) => authored.includes(marker))
  if (requiredChecksMarker === undefined) {
    throw new GuideGoalError("The installed goal-me template has changed. Update the guide before using it.")
  }
  const authoredWithoutKnownPlaceholders = [
    "[One coherent outcome and its intended use.]",
    "[Input locations, output paths, relevant context, and how to inspect them.]",
    "[Scope, exclusions, project rules, existing authorization, and resources.]",
    expandedCriteriaPlaceholder,
    requiredChecksMarker,
    "| [concrete improvement] | [IDs] | [impact estimate] | [dependencies or none] | [method] |",
  ].reduce((current, marker) => replaceTemplateMarker(current, marker, ""), authored)
  if (/\[[^\]]+\]/u.test(authoredWithoutKnownPlaceholders)) {
    throw new GuideGoalError("The installed goal-me template has changed. Update the guide before using it.")
  }
  return requiredChecksMarker
}

const renderExpandedGuideGoalProposal = (template: string, draft: GuideGoalDraft): string => {
  const {
    inputsAndArtifacts,
    constraints,
    criterionVerifications,
    requiredChecks,
    actions,
    maxIterations,
    maxConsecutiveNoProgressAttempts,
  } = draft
  if (
    inputsAndArtifacts === undefined || constraints === undefined || criterionVerifications === undefined ||
    requiredChecks === undefined || actions === undefined || maxIterations === undefined ||
    maxConsecutiveNoProgressAttempts === undefined
  ) {
    throw new GuideGoalError("The installed goal-me template requires an expanded goal proposal.")
  }
  const criterionRows = draft.criteria.map((criterion, index) =>
    `| C${index + 1} | ${tableCell(criterion)} | ${tableCell(criterionVerifications[index]!)} |`,
  ).join("\n")
  const scoreboardRows = draft.criteria.map((_criterion, index) => `| C${index + 1} | _ | _ | _ |`).join("\n")
  const actionRows = actions.map((action) =>
    `| ${tableCell(action.action)} | ${action.criterionIds.join(", ")} | ${tableCell(action.expectedBenefit)} | ${tableCell(action.prerequisites)} | ${tableCell(action.verification)} |`,
  ).join("\n")
  const requiredChecksMarker = validateExpandedTemplateStructure(template)
  let prompt = template
  prompt = replaceTemplateMarker(prompt, "[One coherent outcome and its intended use.]", `Artifact: ${draft.artifact}\n${draft.task}`)
  prompt = replaceTemplateMarker(
    prompt,
    "[Input locations, output paths, relevant context, and how to inspect them.]",
    inputsAndArtifacts,
  )
  prompt = replaceTemplateMarker(
    prompt,
    "[Scope, exclusions, project rules, existing authorization, and resources.]",
    constraints,
  )
  prompt = replaceTemplateMarker(
    prompt,
    expandedCriteriaPlaceholder,
    criterionRows,
  )
  prompt = replaceTemplateMarker(prompt, requiredChecksMarker, requiredChecks.map((check) => `- ${check}`).join("\n"))
  prompt = replaceTemplateMarker(
    prompt,
    "| [concrete improvement] | [IDs] | [impact estimate] | [dependencies or none] | [method] |",
    actionRows,
  )
  prompt = replaceTemplateMarker(
    prompt,
    "Max iterations: 20\nMax consecutive no-progress attempts: 5",
    `Max iterations: ${maxIterations}\nMax consecutive no-progress attempts: ${maxConsecutiveNoProgressAttempts}`,
  )
  prompt = replaceTemplateMarker(
    prompt,
    "| C1 | _ | _ | _ |\n| C2 | _ | _ | _ |\n| C3 | _ | _ | _ |",
    scoreboardRows,
  )
  return prompt
}

const renderLegacyGuideGoalProposal = (template: string, draft: GuideGoalDraft): string => {
  const markers = [
    "TASK:\n",
    "\n\nSUCCESS CRITERIA (be strict):\n",
    "\n\nSCOREBOARD (overwrite this block after every VERIFY; do not append):\nStatus: ITERATING\nScores:\n",
    "\nWeakest: _\nLast change: _",
    "\n\nLEARNINGS (at most 8 bullets; replace stale ones; no narrative):\n-\n",
    "\nLOOP PROTOCOL, repeat every turn:\n",
    "\nRULES:\n",
  ]
  let previous = -1
  for (const marker of markers) {
    const offset = template.indexOf(marker)
    if (offset <= previous || template.indexOf(marker, offset + marker.length) !== -1) {
      throw new GuideGoalError("The installed goal-me template has changed. Update the guide before using it.")
    }
    previous = offset
  }
  const [taskMarker, criteriaMarker, scoreboardMarker, weakestMarker] = markers
  if (taskMarker === undefined || criteriaMarker === undefined || scoreboardMarker === undefined || weakestMarker === undefined) {
    throw new GuideGoalError("The goal template markers are incomplete.")
  }
  const taskStart = template.indexOf(taskMarker) + taskMarker.length
  const criteriaStart = template.indexOf(criteriaMarker)
  const scoreboardStart = template.indexOf(scoreboardMarker)
  const weakestStart = template.indexOf(weakestMarker)
  return [
    template.slice(0, taskStart),
    `Artifact: ${draft.artifact}\n${draft.task}`,
    template.slice(criteriaStart, criteriaStart + criteriaMarker.length),
    draft.criteria.map((criterion) => `- ${criterion}`).join("\n"),
    template.slice(scoreboardStart, scoreboardStart + scoreboardMarker.length),
    draft.criteria.map((criterion) => `- ${criterion}: _`).join("\n"),
    template.slice(weakestStart),
  ].join("")
}

/** Use the installed skill's template, not a second copy of its fixed protocol. */
export const renderGuideGoalProposal = (skillContent: string, value: unknown): GuideGoalProposal => {
  const draft = validateGuideGoalDraft(value)
  const template = installedGoalTemplate(skillContent)
  if (template === undefined) throw new GuideGoalError("The installed goal-me skill has no supported goal template.")
  const kind = guideGoalTemplateKind(skillContent)
  if (kind === undefined) throw new GuideGoalError("The installed goal-me template has changed. Update the guide before using it.")
  const prompt = kind === "expanded"
    ? renderExpandedGuideGoalProposal(template, draft)
    : renderLegacyGuideGoalProposal(template, draft)
  return { draft, prompt: validateGuideGoalPrompt(prompt) }
}

interface PendingInteraction {
  readonly request: GuideGoalRequest
  readonly resolve: (response: GuideGoalResponse) => void
  readonly reject: (error: unknown) => void
}

export interface GuideGoalInteractionControllerOptions {
  readonly runId: number
  readonly signal: AbortSignal
  readonly onRequest: (request: GuideGoalRequest | undefined) => void
  readonly onTurn: (turn: GuideGoalTurn) => void
}

/** Owns callbacks outside React state and serializes overlapping SDK requests. */
export class GuideGoalInteractionController implements GuideGoalInteractions {
  private readonly pending: PendingInteraction[] = []
  private nextRequestId = 1
  private closed: Error | undefined
  private autoAcceptRecommended = false
  private acceptingRecommended = false
  private approvalAccepted = false
  private readonly onAbort = (): void => this.close(new GuideGoalCancelledError())

  constructor(private readonly options: GuideGoalInteractionControllerOptions) {
    options.signal.addEventListener("abort", this.onAbort, { once: true })
    if (options.signal.aborted) this.onAbort()
  }

  async ask(value: unknown): Promise<GuideGoalAnswer> {
    const response = await this.enqueue({
      kind: "question",
      question: validateGuideGoalQuestion(value),
      runId: this.options.runId,
      requestId: this.nextRequestId++,
    })
    if (response.kind !== "answer") throw new GuideGoalError("A question received an invalid response.")
    return response.answer
  }

  async review(proposal: GuideGoalProposal): Promise<GuideGoalReviewDecision> {
    const response = await this.enqueue({
      kind: "review",
      proposal: { draft: validateGuideGoalDraft(proposal.draft), prompt: validateGuideGoalPrompt(proposal.prompt) },
      runId: this.options.runId,
      requestId: this.nextRequestId++,
    })
    if (response.kind !== "review") throw new GuideGoalError("A goal review received an invalid response.")
    return response.review
  }

  setAutoAcceptRecommended(runId: number, enabled: boolean): boolean {
    if (this.closed !== undefined || this.approvalAccepted || runId !== this.options.runId) return false
    this.autoAcceptRecommended = enabled
    this.acceptRecommendedAnswers()
    return true
  }

  submit(runId: number, requestId: number, response: GuideGoalResponse): boolean {
    const current = this.pending[0]
    if (this.closed !== undefined || this.approvalAccepted || current?.request.runId !== runId || current.request.requestId !== requestId) {
      return false
    }
    if (current.request.kind === "question" && response.kind === "answer") {
      validateGuideGoalAnswer(current.request.question, response.answer)
    } else if (current.request.kind === "review" && response.kind === "review") {
      if (response.review.decision === "revise") {
        requiredText(response.review.feedback, "Revision feedback", guideGoalAnswerMaximumLength)
      }
    } else {
      throw new GuideGoalError("This answer does not match the pending interaction.")
    }
    this.pending.shift()
    if (response.kind === "review" && response.review.decision === "use") {
      this.autoAcceptRecommended = false
      this.approvalAccepted = true
    }
    this.options.onTurn({ request: current.request, response })
    // The provider must settle approval before it cancels queued callbacks.
    this.options.onRequest(this.approvalAccepted ? undefined : this.pending[0]?.request)
    current.resolve(response)
    this.acceptRecommendedAnswers()
    return true
  }

  close(error: Error = new GuideGoalCancelledError()): void {
    if (this.closed !== undefined) return
    this.closed = error
    this.options.signal.removeEventListener("abort", this.onAbort)
    const pending = this.pending.splice(0)
    for (const interaction of pending) interaction.reject(error)
    this.options.onRequest(undefined)
  }

  private enqueue(request: GuideGoalRequest): Promise<GuideGoalResponse> {
    if (this.closed !== undefined) return Promise.reject(this.closed)
    return new Promise((resolve, reject) => {
      this.pending.push({ request, resolve, reject })
      if (this.pending.length === 1 && !this.approvalAccepted) this.options.onRequest(request)
      this.acceptRecommendedAnswers()
    })
  }

  private acceptRecommendedAnswers(): void {
    if (this.acceptingRecommended) return
    this.acceptingRecommended = true
    try {
      while (this.autoAcceptRecommended && this.closed === undefined) {
        const request = this.pending[0]?.request
        if (request?.kind !== "question") break
        const answer = recommendedGuideGoalAnswer(request.question)
        if (answer === undefined) break
        this.submit(request.runId, request.requestId, { kind: "answer", answer })
      }
    } finally {
      this.acceptingRecommended = false
    }
  }
}
