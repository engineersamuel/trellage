import type {
  ContinuationDraft,
  ConversationSnapshot,
  FirstmateFleetIdentityV1,
  FirstmateFleetReadinessV1,
  FirstmateOrchestrationV1,
  GuideProjectTargetV1,
  ProfileGuideV1,
} from "@trellage/guide-core"
import type { FirstmateInstanceChoice, FirstmateInstanceMenuEvent, FirstmateInstanceMenuState } from "./guide-firstmate-instance-menu.ts"

export interface ContinuationProfileOption {
  readonly ref: string
  readonly name: string
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly description: string }>
  readonly guide?: ProfileGuideV1
  readonly orchestration?: FirstmateOrchestrationV1
}

export type ContinuationProjectSelection =
  | { readonly kind: "current" }
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "registered"; readonly name: string }
  | { readonly kind: "fleet" }

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
  firstmateInstanceNeedsReview?(draft: ContinuationDraft, actionId: string): boolean
  /** Live instance data belongs only to the explicit local instance screen. */
  firstmateInstanceOperation?(
    draft: ContinuationDraft, actionId: string, state: FirstmateInstanceMenuState, signal: AbortSignal,
  ): Promise<FirstmateInstanceMenuEvent>
  confirmFirstmateInstance?(
    draft: ContinuationDraft, actionId: string, choice: FirstmateInstanceChoice, signal?: AbortSignal,
  ): Promise<ContinuationDraft>
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
  resolveProjectTarget?(
    draft: ContinuationDraft,
    actionId: string,
    selection: ContinuationProjectSelection,
    signal?: AbortSignal,
  ): Promise<GuideProjectTargetV1 | null>
  /** Private readiness for local confirmation only, never model or cache input. */
  inspectFirstmate?(
    draft: ContinuationDraft,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<FirstmateFleetReadinessV1>
  /** Saves the human-approved request without sending it or starting a supervisor. */
  confirmFirstmateAction?(
    draft: ContinuationDraft,
    actionId: string,
    action: keyof FirstmateFleetReadinessV1["actions"],
    expectedFleet: FirstmateFleetIdentityV1,
    signal?: AbortSignal,
  ): Promise<ContinuationDraft>
  checkSource(draft: ContinuationDraft, signal?: AbortSignal): Promise<ContinuationSourceStatus>
  launch(draft: ContinuationDraft, acknowledgeAdvanced: boolean): Promise<ContinuationDraft>
  latest(draft: ContinuationDraft, signal?: AbortSignal): Promise<ContinuationDraft>
  discard(draft: ContinuationDraft): Promise<void>
}
