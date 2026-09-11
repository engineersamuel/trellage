import { guideIntentMaximumLength } from "./guide-api.js"

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
  return { artifact, task, criteria }
}

export const validateGuideGoalPrompt = (prompt: string): string =>
  requiredText(prompt, "The complete goal", guideIntentMaximumLength)

/** Use the installed skill's template, not a second copy of its fixed protocol. */
export const renderGuideGoalProposal = (skillContent: string, value: unknown): GuideGoalProposal => {
  const draft = validateGuideGoalDraft(value)
  const template = /^## Goal prompt[ \t]*\n+```(?:text|markdown|md)?[ \t]*\n([\s\S]+?)\n```/mu.exec(
    skillContent.replace(/\r\n/gu, "\n"),
  )?.[1]
  if (template === undefined) throw new GuideGoalError("The installed goal-me skill has no supported goal template.")
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
  const prompt = [
    template.slice(0, taskStart),
    `Artifact: ${draft.artifact}\n${draft.task}`,
    template.slice(criteriaStart, criteriaStart + criteriaMarker.length),
    draft.criteria.map((criterion) => `- ${criterion}`).join("\n"),
    template.slice(scoreboardStart, scoreboardStart + scoreboardMarker.length),
    draft.criteria.map((criterion) => `- ${criterion}: _`).join("\n"),
    template.slice(weakestStart),
  ].join("")
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
    if (this.closed !== undefined || current?.request.runId !== runId || current.request.requestId !== requestId) {
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
    this.options.onRequest(this.pending[0]?.request)
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
      if (this.pending.length === 1) this.options.onRequest(request)
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
