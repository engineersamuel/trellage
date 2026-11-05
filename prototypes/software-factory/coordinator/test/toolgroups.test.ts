import { expect, test } from "bun:test"
import { groupTools } from "../../shared/toolgroups.ts"

const t = (id: string, name: string, ok = true, done = true) => ({ kind: "tool", id, name, ok, done })

test("runs of three or more read-only calls fold; writes, shell and failures break the run", () => {
  const items = [
    { kind: "user", text: "go" },
    t("1", "glob"), t("2", "view"), t("3", "view"), t("4", "view"),
    t("5", "bash"),
    t("6", "view"), t("7", "view"),
    { kind: "assistant", text: "ok" },
    t("8", "view"), t("9", "rg"), t("10", "view", false), t("11", "view"), t("12", "grep"), t("13", "view", true, false),
  ]
  const g = groupTools(items)
  expect(g.map((i: any) => (i.kind === "group" ? `[${i.items.map((x: any) => x.id).join(",")}] ${i.label}` : i.id ?? i.kind))).toEqual([
    "user",
    "[1,2,3,4] Read 3 files, searched 1 time",
    "5",
    "6",
    "7",
    "assistant",
    "8",
    "9",
    "10",
    "[11,12,13] Read 2 files, searched 1 time",
  ])
  expect((g.at(-1) as any).done).toBe(false)
})
