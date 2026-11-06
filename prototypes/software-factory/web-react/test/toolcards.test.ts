import { describe, expect, test } from "bun:test"
import { cardProps } from "../src/chat/ToolCards"

const call = (result?: string) => ({ id: "c1", name: "bash", args: { command: "ls -la\nmore" }, result })

describe("chat/ToolCards cardProps", () => {
  test("no result and no end: running, live from the feed start", () => {
    const p = cardProps(call(), { startedAt: 100 })
    expect([p.status, p.startedAt, p.duration, p.result]).toEqual(["running", 100, undefined, undefined])
    expect(p.summary).toBe("ls -la")
  })

  test("result with timing: success with its duration", () => {
    const p = cardProps(call("ok"), { startedAt: 100, endedAt: 1600, failed: false })
    expect([p.status, p.duration, p.result]).toEqual(["success", 1500, "ok"])
  })

  test("failed in the feed: error with the feed message, no result section", () => {
    const p = cardProps(call("Path does not exist"), { startedAt: 0, endedAt: 5, failed: true, error: "boom" })
    expect([p.status, p.error, p.result]).toEqual(["error", "boom", undefined])
  })

  test("no timing known (old thread): success without a duration", () => {
    const p = cardProps(call("ok"), undefined)
    expect([p.status, p.startedAt, p.duration]).toEqual(["success", undefined, undefined])
  })

  test("error on the AG-UI tool message wins, even without feed timing", () => {
    const p = cardProps({ ...call("Path missing"), error: "Path missing" }, undefined)
    expect([p.status, p.error, p.result]).toEqual(["error", "Path missing", undefined])
  })
})
