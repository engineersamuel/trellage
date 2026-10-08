import type { ModelInfo } from "@github/copilot-sdk"

export interface ReviewRange {
  readonly source: string
  readonly start: number
  readonly end: number
}

export const packReviewRanges = (
  segments: Iterable<{ readonly range: ReviewRange; readonly cost: number }>,
  capacity: number,
): ReviewRange[][] => {
  const batches: ReviewRange[][] = []
  let batch: ReviewRange[] = []
  let used = 0
  for (const { range, cost } of segments) {
    if (used + cost > capacity && batch.length) {
      batches.push(batch)
      batch = []
      used = 0
    }
    const previous = batch.at(-1)
    if (previous?.source === range.source && previous.end === range.start)
      batch[batch.length - 1] = { ...previous, end: range.end }
    else batch.push(range)
    used += cost
  }
  if (batch.length) batches.push(batch)
  return batches
}

export class ReviewReadLedger {
  private readonly delivered = new Map<string, Array<{ start: number; end: number }>>()
  private failure: Error | undefined
  private used = 0
  private calls = 0

  constructor(
    private budget: number,
    private readonly signal: AbortSignal,
    private readonly budgetMessage: string,
    private readonly maximumCalls = Number.MAX_SAFE_INTEGER,
  ) {}

  get consumed(): number {
    return this.used
  }
  get hasReads(): boolean {
    return this.delivered.size > 0
  }
  assertHealthy(): void {
    this.signal.throwIfAborted()
    if (this.failure) throw this.failure
  }
  private fail(message: string): never {
    this.failure = new Error(message)
    throw this.failure
  }
  setBudget(value: number, message = this.budgetMessage): void {
    this.budget = Math.min(this.budget, value)
    if (this.used > this.budget) this.fail(message)
  }
  request(cost: number): void {
    this.assertHealthy()
    if (++this.calls > this.maximumCalls) this.fail("Review tool-call budget exhausted. Reduce the selected scope.")
    this.charge(cost)
  }
  charge(cost: number): void {
    this.assertHealthy()
    this.used += cost
    if (this.used > this.budget) this.fail(this.budgetMessage)
  }
  record(range: ReviewRange): void {
    this.assertHealthy()
    const ranges = [...(this.delivered.get(range.source) ?? []), range].sort((a, b) => a.start - b.start)
    const merged: Array<{ start: number; end: number }> = []
    for (const entry of ranges) {
      const last = merged.at(-1)
      if (last && entry.start <= last.end) last.end = Math.max(last.end, entry.end)
      else merged.push({ start: entry.start, end: entry.end })
    }
    this.delivered.set(range.source, merged)
  }
  firstGap(range: ReviewRange, preview?: ReviewRange): ReviewRange | undefined {
    let start = range.start
    const ranges = [
      ...(this.delivered.get(range.source) ?? []),
      ...(preview?.source === range.source ? [preview] : []),
    ].sort((a, b) => a.start - b.start)
    for (const read of ranges) {
      if (read.start > start)
        return start < range.end ? { ...range, start, end: Math.min(read.start, range.end) } : undefined
      start = Math.max(start, read.end)
      if (start >= range.end) return undefined
    }
    return start < range.end ? { ...range, start } : undefined
  }
}

export const reviewSnapshotBytes = 32_000_000

// Byte-fallback tokenizers emit at most one token per UTF-8 byte. This is an
// upper bound, not an average token estimate; protocol tokens are reserved below.
export const reviewTokenUpperBound = (text: string): number => Buffer.byteLength(text, "utf8")

export const reviewContextBudget = (
  model: Pick<ModelInfo, "id" | "capabilities">,
  inputText: string,
  requestedOutputTokens = 8192,
): {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly evidenceBytes: number
} => {
  const limits = model.capabilities?.limits
  const context = limits?.max_context_window_tokens
  const prompt = limits?.max_prompt_tokens ?? context
  const maximumOutput = limits?.max_output_tokens ?? requestedOutputTokens
  if (
    [context, prompt, maximumOutput, requestedOutputTokens].some((value) => !Number.isSafeInteger(value) || value! <= 0)
  )
    throw new Error(`Review model ${model.id} has invalid or missing context metadata.`)
  // The SDK has no session output-token setter. Reserve the advertised maximum,
  // not a smaller requested limit that the server cannot enforce. When metadata
  // omits it, the caller's bounded response allowance is the explicit fallback.
  const outputTokens = maximumOutput
  const inputTokens = reviewTokenUpperBound(inputText)
  const evidenceBytes = Math.min(prompt, context - outputTokens) - inputTokens - 16_384
  if (evidenceBytes < 4096)
    throw new Error(`Review model ${model.id} has inadequate context capacity; nothing was truncated.`)
  return { inputTokens, outputTokens, evidenceBytes }
}
