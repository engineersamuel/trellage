import { expect, test } from "vitest"
import { ago, atList, bucket, createdAt, groups, match, plain, rows, splitEmoji } from "./timeline"
const hex = (ms: number) =>
  Math.floor(ms / 1000)
    .toString(16)
    .padStart(8, "0") + "0000000000000000"
const NOW = new Date(2026, 10, 22, 15, 0).getTime()
const lists = [
  { id: "ai", name: "🧠AI" },
  { id: "ms", name: "🇺🇸Microsoft" },
]
const t = (title: string, ms: number) => ({ id: hex(ms), title })

test("createdAt reads the ObjectId time", () => {
  expect(createdAt("6b01bfd1a0bca70a93dc8327")).toBe(Date.UTC(2026, 10, 21, 15, 59, 13))
  expect(createdAt("zz")).toBe(0)
})

test("rows are newest first across lists, and every query word must match", () => {
  const old = t("Loop library", NOW - 40 * 864e5)
  const fresh = t("Factory loop idea", NOW - 3600e3)
  const other = t("Pfizer loop meeting", NOW - 864e5)
  const tasks = { ai: [old, fresh], ms: [other] }
  expect(rows(lists, tasks, "", "").map((r) => r.task)).toEqual([fresh, other, old])
  expect(rows(lists, tasks, "ms", "").map((r) => r.task)).toEqual([other])
  expect(rows(lists, tasks, "", "loop idea").map((r) => r.task)).toEqual([fresh])
  expect(rows(lists, tasks, "ms", "loop @ai").map((r) => r.task)).toEqual([fresh, old])
  expect(atList(lists, "x @micro")?.id).toBe("ms")
})

test("match returns the highlighted positions", () => {
  expect(match("Loop library", ["lib"])).toEqual([5, 6, 7])
  expect(match("Loop library", ["nope"])).toBeUndefined()
})

test("bucket groups by local day, then by month", () => {
  expect(bucket(NOW - 3600e3, NOW)).toBe("Today")
  expect(bucket(NOW - 864e5, NOW)).toBe("Yesterday")
  expect(bucket(NOW - 3 * 864e5, NOW)).toBe("This week")
  expect(bucket(NOW - 20 * 864e5, NOW)).toBe("This month")
  expect(bucket(new Date(2026, 5, 10).getTime(), NOW)).toBe("June 2026")
  const g = groups(rows(lists, { ai: [t("a", NOW - 1e3), t("b", NOW - 864e5)] }, "", ""), NOW)
  expect(g.map(([name, rs]) => [name, rs.length])).toEqual([
    ["Today", 1],
    ["Yesterday", 1],
  ])
})

test("plain, splitEmoji and ago", () => {
  expect(plain("See [docs](https://x) ![img](a.png) now")).toBe("See docs now")
  expect(splitEmoji("🇺🇸Microsoft")).toEqual(["🇺🇸", "Microsoft"])
  expect(splitEmoji("Inbox")).toEqual(["", "Inbox"])
  expect(ago(NOW - 7 * 3600e3, NOW)).toBe("7h")
  expect(ago(NOW - 3 * 864e5, NOW)).toBe("3d")
})
