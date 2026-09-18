import {
  ContinuationActionStatus,
  type ContinuationActionDraft,
} from "@trellage/guide-core"

export const firstmateRejectionNeedsReconciliation = (edit: ContinuationActionDraft): boolean =>
  edit.status === ContinuationActionStatus.SubmissionRejected &&
  edit.firstmateSubmission !== undefined &&
  edit.firstmateSubmission.receipt?.state !== "rejected"

export const firstmateAttemptProtected = (edit: ContinuationActionDraft): boolean =>
  edit.status === ContinuationActionStatus.Submitting ||
  edit.status === ContinuationActionStatus.Accepted ||
  edit.status === ContinuationActionStatus.SubmissionUnknown ||
  firstmateRejectionNeedsReconciliation(edit)
