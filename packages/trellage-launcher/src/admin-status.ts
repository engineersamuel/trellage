/**
 * Accessible, plain-text status labeling and control-availability rules for
 * the Admin diagnostics panel. Every status must have non-empty plain text
 * so status is never communicated by color alone (see plan Non-Functional
 * Requirements). Doctor stdout/stderr is treated as opaque text elsewhere —
 * this module only labels *states*, never parses command output.
 */
import type { TerminalStatus } from "./termcn/terminal-symbols.ts"
import type { AdminRunState } from "./admin-run-manager.ts"
import type { AdminHealthStatus, AdminInstallStatus } from "./admin-model.ts"

/** Union of run-manager states plus the two admin-model-derived states that never have a runnable doctor action. */
export type AdminStatus = AdminRunState | "unsupported" | "malformed-output" | "discovering" | "discovery-failed" | "instance-blocked"

const labels: Record<AdminStatus, string> = {
  idle: "Not yet checked",
  running: "Running…",
  success: "Healthy",
  failure: "Failed — see output",
  cancelled: "Cancelled",
  "timed-out": "Timed out",
  unsupported: "Doctor not supported for this launcher",
  "malformed-output": "Malformed output — could not determine health",
  discovering: "Discovering instances…",
  "discovery-failed": "Instance discovery failed",
  "instance-blocked": "Instance unavailable",
}

/** Returns non-empty plain text for every defined status value; never color-only. */
export const statusLabel = (status: AdminStatus): string => labels[status]

const tones: Record<AdminStatus, TerminalStatus> = {
  idle: "pending",
  running: "info",
  success: "success",
  failure: "error",
  cancelled: "neutral",
  "timed-out": "warning",
  unsupported: "neutral",
  "malformed-output": "warning",
  discovering: "pending",
  "discovery-failed": "error",
  "instance-blocked": "warning",
}

/**
 * Groups a status into the terminal symbol family that precedes its label.
 * The symbol is a third, redundant carrier of the same meaning alongside
 * the plain text and the color, and it degrades to ASCII where the label
 * text already does — it never replaces the label.
 */
export const statusTone = (status: AdminStatus): TerminalStatus => tones[status]

export interface AdminStatusControls {
  readonly canTrigger: boolean
  readonly canCancel: boolean
  readonly canRetry: boolean
}

/** Determines which doctor controls are meaningful for a given status. `unsupported` offers none. */
export const controlsForStatus = (status: AdminStatus): AdminStatusControls => {
  if (status === "unsupported" || status === "discovering" || status === "discovery-failed") {
    return { canTrigger: false, canCancel: false, canRetry: false }
  }
  if (status === "running") return { canTrigger: false, canCancel: true, canRetry: false }
  if (status === "idle") return { canTrigger: true, canCancel: false, canRetry: false }
  // success, failure, cancelled, timed-out, malformed-output are all terminal: offer retry, not cancel.
  return { canTrigger: false, canCancel: false, canRetry: true }
}

/** The non-durable, session-scoped wording every history rendering must include (see plan risk C17). */
export const historyScopeLabel = "History for this session only — not saved between runs."

const healthTones: Record<AdminHealthStatus, TerminalStatus> = {
  healthy: "success",
  unhealthy: "error",
  unsupported: "neutral",
  "malformed-output": "warning",
  unknown: "pending",
}

/** Same redundant-symbol contract as `statusTone`, for the inventory's health column. */
export const healthTone = (health: AdminHealthStatus): TerminalStatus => healthTones[health]

const installTones: Record<AdminInstallStatus, TerminalStatus> = {
  installed: "success",
  // Not installed is a normal, actionable state rather than a fault, so it
  // warns rather than erroring — only malformed output and an unhealthy
  // doctor run are faults.
  "not-installed": "warning",
  unsupported: "neutral",
  "malformed-output": "warning",
  unknown: "pending",
}

/** Same redundant-symbol contract as `statusTone`, for the inventory's install column. */
export const installTone = (install: AdminInstallStatus): TerminalStatus => installTones[install]
