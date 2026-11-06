import { describe, expect, test } from "bun:test"
import type { SettingsDocument } from "../../shared/schemas"
import { Action, feedActions, initial, MAX_TOOL_TIMINGS, reduce, sortedWorkers, type Model } from "../src/state/model"

const w = (id: string, name: string, role = "worker") =>
  ({ id, name, role, status: "idle", model: "m", auth: "native", pid: null, rssKb: null, home: "", task: null, lastMessage: null, eventCount: 0, contextTokens: null, contextLimit: null }) as const

const run = (m: Model, ...as: Action[]) => as.reduce(reduce, m)
const start = initial("t0", 2)

describe("state/model", () => {
  test("workers load, change, stop; coordinator sorts first", () => {
    const m = run(
      start,
      Action.WorkersLoaded({ workers: [w("b", "Beta"), w("coordinator", "Desk", "coordinator")] }),
      Action.WorkerChanged({ worker: w("a", "Alpha") }),
      Action.WorkerStopped({ id: "b" }),
    )
    expect(sortedWorkers(m.workers).map((x) => x.id)).toEqual(["coordinator", "a"])
  })

  test("settings change before the first load is ignored", () => {
    expect(run(start, Action.SettingsChanged({ settings: {} as never, css: "x" })).settings).toBeNull()
  })

  test("thread, report and settings drawer actions", () => {
    let m = run(start, Action.ThreadSelected({ threadId: "t1" }), Action.ReportOpened({ ref: "reports/a.md", agent: "w1" }), Action.SettingsToggled({}))
    expect([m.threadId, m.report, m.settingsOpen]).toEqual(["t1", { ref: "reports/a.md", agent: "w1" }, true])
    m = run(m, Action.ReportClosed(), Action.SettingsToggled({ open: false }))
    expect([m.report, m.settingsOpen]).toEqual([null, false])
  })

  test("a settings load failure is kept until settings load", () => {
    const failed = run(start, Action.SettingsLoadFailed({ error: "HTTP 500" }))
    expect([failed.settings, failed.settingsLoadError]).toEqual([null, "HTTP 500"])
    expect(run(failed, Action.SettingsLoaded({ document: { settings: { focus: "a" } } as never })).settingsLoadError).toBeNull()
  })

  test("a failed worker command is shown until dismissed", () => {
    const failed = run(start, Action.WorkerCommandFailed({ error: "Stop failed: HTTP 404" }))
    expect(failed.workerError).toBe("Stop failed: HTTP 404")
    expect(run(failed, Action.WorkerErrorDismissed()).workerError).toBeNull()
  })

  test("a worker error clears when the focus moves to another worker, not on other settings changes", () => {
    const settings = { focus: "a", theme: "dark" } as never as SettingsDocument["settings"]
    const failed = run(start, Action.SettingsLoaded({ document: { settings, css: "", options: {} } as never }), Action.WorkerCommandFailed({ error: "Stop failed" }))
    expect(run(failed, Action.SettingsChanged({ settings: { ...settings, theme: "nord" }, css: "" })).workerError).toBe("Stop failed")
    expect(run(failed, Action.SettingsChanged({ settings: { ...settings, focus: "b" }, css: "" })).workerError).toBeNull()
  })

  test("tool timing: first start wins, finish records failure and error", () => {
    const m = run(
      start,
      Action.ToolStarted({ id: "c1", at: 100 }),
      Action.ToolStarted({ id: "c1", at: 999 }),
      Action.ToolFinished({ id: "c1", at: 350, failed: true, error: "boom" }),
    )
    expect(m.toolTimings.c1).toEqual({ startedAt: 100, endedAt: 350, failed: true, error: "boom" })
  })

  test("tool timings are capped", () => {
    let m = start
    for (let i = 0; i < MAX_TOOL_TIMINGS + 5; i++) m = reduce(m, Action.ToolStarted({ id: `c${i}`, at: i }))
    expect(Object.keys(m.toolTimings).length).toBe(MAX_TOOL_TIMINGS)
    expect(m.toolTimings.c0).toBeUndefined()
  })

  test("feed events map to actions", () => {
    const at = "2026-11-05T10:00:00.000Z"
    const t = Date.parse(at)
    expect(feedActions({ type: "tool.execution_start", timestamp: at, data: { toolCallId: "x" } })).toEqual([Action.ToolStarted({ id: "x", at: t })])
    expect(feedActions({ type: "tool.execution_complete", timestamp: at, data: { toolCallId: "x", success: false, error: { message: "no" } } })).toEqual([
      Action.ToolFinished({ id: "x", at: t, failed: true, error: "no" }),
    ])
    expect(feedActions({ type: "tool.execution_start", timestamp: "bad", data: { toolCallId: "x" } })).toEqual([])
    expect(feedActions({ type: "factory.worker_stopped", timestamp: at, data: { id: "w" } })).toEqual([Action.WorkerStopped({ id: "w" })])
    expect(feedActions({ type: "factory.ping", timestamp: at, data: {} })).toEqual([])
  })
})
