import type { ContinuationDraft, ConversationSnapshot } from "@trellage/guide-core"

export interface ContinuationProfileOption {
  readonly ref: string
  readonly name: string
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly description: string }>
}

export interface ContinuationSourceStatus {
  readonly sameSource: boolean
  readonly advanced: boolean
  readonly revision: string
  readonly message?: string
}

export interface ContinuationCallEstimate {
  readonly summarizationCalls: number
  readonly assessmentCalls: number
  readonly maxCalls: number
}

export interface ContinuationServices {
  readonly profiles: ReadonlyArray<ContinuationProfileOption>
  estimate(snapshot: ConversationSnapshot): ContinuationCallEstimate
  save(draft: ContinuationDraft): Promise<ContinuationDraft>
  reload(draft: ContinuationDraft): Promise<ContinuationDraft>
  analyze(
    draft: ContinuationDraft,
    signal: AbortSignal,
    onProgress: (message: string) => void,
  ): Promise<ContinuationDraft>
  prepare(
    draft: ContinuationDraft,
    actionId: string,
    signal: AbortSignal,
    onProgress: (message: string) => void,
  ): Promise<ContinuationDraft>
  checkSource(draft: ContinuationDraft, signal?: AbortSignal): Promise<ContinuationSourceStatus>
  launch(draft: ContinuationDraft, acknowledgeAdvanced: boolean): Promise<ContinuationDraft>
  latest(draft: ContinuationDraft, signal?: AbortSignal): Promise<ContinuationDraft>
  discard(draft: ContinuationDraft): Promise<void>
}
