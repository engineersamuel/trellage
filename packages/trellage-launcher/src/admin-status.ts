/**
 * Accessible, plain-text status labeling and control-availability rules for
 * the Admin diagnostics panel. Every status must have non-empty plain text
 * so status is never communicated by color alone (see plan Non-Functional
 * Requirements). Doctor stdout/stderr is treated as opaque text elsewhere —
 * this module only labels *states*, never parses command output.
 */
import type { AdminRunState } from "./admin-run-manager.js"

/** Union of run-manager states plus the two admin-model-derived states that never have a runnable doctor action. */
export type AdminStatus = AdminRunState | "unsupported" | "malformed-output"

const labels: Record<AdminStatus, string> = {
  idle: "Not yet checked",
  running: "Running…",
  success: "Healthy",
  failure: "Failed — see output",
  cancelled: "Cancelled",
  "timed-out": "Timed out",
  unsupported: "Doctor not supported for this launcher",
  "malformed-output": "Malformed output — could not determine health",
}

/** Returns non-empty plain text for every defined status value; never color-only. */
export const statusLabel = (status: AdminStatus): string => labels[status]

export interface AdminStatusControls {
  readonly canTrigger: boolean
  readonly canCancel: boolean
  readonly canRetry: boolean
}

/** Determines which doctor controls are meaningful for a given status. `unsupported` offers none. */
export const controlsForStatus = (status: AdminStatus): AdminStatusControls => {
  if (status === "unsupported") return { canTrigger: false, canCancel: false, canRetry: false }
  if (status === "running") return { canTrigger: false, canCancel: true, canRetry: false }
  if (status === "idle") return { canTrigger: true, canCancel: false, canRetry: false }
  // success, failure, cancelled, timed-out, malformed-output are all terminal: offer retry, not cancel.
  return { canTrigger: false, canCancel: false, canRetry: true }
}

/** The non-durable, session-scoped wording every history rendering must include (see plan risk C17). */
export const historyScopeLabel = "History for this session only — not saved between runs."
