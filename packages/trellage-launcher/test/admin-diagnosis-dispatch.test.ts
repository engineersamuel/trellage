import { describe, expect, it } from "vitest"

import type { AdminRunStatus } from "../src/admin-run-manager.js"
import { selectPendingDiagnosisTargets, selectPendingRepairTargets, shouldStartBatch } from "../src/admin-diagnosis-dispatch.js"

const status = (state: AdminRunStatus["state"]): AdminRunStatus => ({ ref: "r", state, history: [] })

describe("shouldStartBatch", () => {
  it("is false for an empty ref set", () => {
    expect(shouldStartBatch([], undefined)).toBe(false)
  })

  it("is true the first time a non-empty ref set is seen", () => {
    expect(shouldStartBatch(["a", "b"], undefined)).toBe(true)
  })

  it("is false the second time the same ref set is seen", () => {
    expect(shouldStartBatch(["a", "b"], new Set(["a", "b"]))).toBe(false)
  })

  it("is true again if the ref set changes (e.g. a rescan discovers a new profile)", () => {
    expect(shouldStartBatch(["a", "b", "c"], new Set(["a", "b"]))).toBe(true)
  })
})

describe("selectPendingDiagnosisTargets", () => {
  it("selects only refs whose latest status is failure or timed-out", () => {
    const statuses = new Map<string, AdminRunStatus>([
      ["a", status("failure")],
      ["b", status("success")],
      ["c", status("timed-out")],
      ["d", status("cancelled")],
      ["e", status("running")],
      ["f", status("idle")],
    ])
    expect(selectPendingDiagnosisTargets(statuses, new Set())).toEqual(["a", "c"])
  })

  it("excludes refs already recorded in alreadyDiagnosedRefs", () => {
    const statuses = new Map<string, AdminRunStatus>([
      ["a", status("failure")],
      ["c", status("timed-out")],
    ])
    expect(selectPendingDiagnosisTargets(statuses, new Set(["a"]))).toEqual(["c"])
  })

  it("returns nothing new when called twice with an unchanged snapshot and updated bookkeeping (no re-dispatch on re-render)", () => {
    const statuses = new Map<string, AdminRunStatus>([["a", status("failure")]])
    const first = selectPendingDiagnosisTargets(statuses, new Set())
    expect(first).toEqual(["a"])
    const second = selectPendingDiagnosisTargets(statuses, new Set(first))
    expect(second).toEqual([])
  })

  it("isolates per-ref bookkeeping: one ref recorded as diagnosed does not affect selection for other refs", () => {
    const statuses = new Map<string, AdminRunStatus>([
      ["a", status("failure")],
      ["b", status("failure")],
      ["c", status("timed-out")],
    ])
    expect(selectPendingDiagnosisTargets(statuses, new Set(["a"]))).toEqual(["b", "c"])
  })
})

describe("selectPendingRepairTargets", () => {
  it("selects only repair-supported refs whose latest status is failure or timed-out", () => {
    const statuses = new Map<string, AdminRunStatus>([
      ["a", status("failure")],
      ["b", status("success")],
      ["c", status("timed-out")],
      ["d", status("cancelled")],
      ["e", status("running")],
      ["f", status("idle")],
    ])
    expect(selectPendingRepairTargets(statuses, new Set(["a", "b", "c", "d", "e", "f"]), new Set())).toEqual(["a", "c"])
  })

  it("never selects a ref outside repairSupportedRefs, regardless of its doctor status (e.g. sandbox profiles, doctor-unsupported launchers)", () => {
    const statuses = new Map<string, AdminRunStatus>([
      ["a", status("failure")],
      ["b", status("timed-out")],
    ])
    expect(selectPendingRepairTargets(statuses, new Set(["a"]), new Set())).toEqual(["a"])
  })

  it("excludes refs already recorded in alreadyAttemptedRefs (repairs at most once per session)", () => {
    const statuses = new Map<string, AdminRunStatus>([
      ["a", status("failure")],
      ["c", status("timed-out")],
    ])
    expect(selectPendingRepairTargets(statuses, new Set(["a", "c"]), new Set(["a"]))).toEqual(["c"])
  })

  it("returns nothing new when called twice with an unchanged snapshot and updated bookkeeping (no re-repair on re-render)", () => {
    const statuses = new Map<string, AdminRunStatus>([["a", status("failure")]])
    const first = selectPendingRepairTargets(statuses, new Set(["a"]), new Set())
    expect(first).toEqual(["a"])
    const second = selectPendingRepairTargets(statuses, new Set(["a"]), new Set(first))
    expect(second).toEqual([])
  })

  it("isolates per-ref bookkeeping: one ref recorded as attempted does not affect selection for other refs", () => {
    const statuses = new Map<string, AdminRunStatus>([
      ["a", status("failure")],
      ["b", status("failure")],
      ["c", status("timed-out")],
    ])
    expect(selectPendingRepairTargets(statuses, new Set(["a", "b", "c"]), new Set(["a"]))).toEqual(["b", "c"])
  })
})
