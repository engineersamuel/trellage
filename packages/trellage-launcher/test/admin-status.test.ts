import { describe, expect, it } from "vitest"

import { controlsForStatus, historyScopeLabel, statusLabel, type AdminStatus } from "../src/admin-status.ts"

const allStatuses: ReadonlyArray<AdminStatus> = [
  "idle",
  "running",
  "success",
  "failure",
  "cancelled",
  "timed-out",
  "unsupported",
  "malformed-output",
]

describe("statusLabel", () => {
  it("returns distinct, non-empty plain text for every defined status", () => {
    const labels = allStatuses.map(statusLabel)
    expect(labels.every((label) => label.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe("controlsForStatus", () => {
  it("offers no controls at all for unsupported", () => {
    expect(controlsForStatus("unsupported")).toEqual({ canTrigger: false, canCancel: false, canRetry: false })
  })

  it("offers cancel but not trigger/retry while running", () => {
    expect(controlsForStatus("running")).toEqual({ canTrigger: false, canCancel: true, canRetry: false })
  })

  it("offers trigger, not cancel/retry, when idle", () => {
    expect(controlsForStatus("idle")).toEqual({ canTrigger: true, canCancel: false, canRetry: false })
  })

  it("offers retry, not cancel, for every terminal state", () => {
    for (const status of ["success", "failure", "cancelled", "timed-out", "malformed-output"] as const) {
      expect(controlsForStatus(status)).toEqual({ canTrigger: false, canCancel: false, canRetry: true })
    }
  })
})

describe("historyScopeLabel", () => {
  it("states the history is session-scoped, not durable", () => {
    expect(historyScopeLabel.toLocaleLowerCase("en")).toContain("session only")
  })
})
