import { describe, expect, it } from "vitest"
import { tableColumns } from "../src/table-layout.js"
import type { LaunchEntry } from "../src/state.js"

const entries: ReadonlyArray<LaunchEntry> = [
  {
    id: "claude:blog",
    label: "claude-blog / claude",
    profile: "claude-blog",
    harness: "claude",
    description: "Blog profile",
    defaultModel: "claude-opus-5",
    models: ["claude-opus-5"],
    modelOverrideSupported: false,
  },
  {
    id: "codex:superpowers",
    label: "codex-superpowers / codex",
    profile: "codex-superpowers",
    harness: "codex",
    description: "Codex profile",
    defaultModel: "gpt-5.6-sol",
    models: ["gpt-5.6-sol"],
    modelOverrideSupported: false,
  },
]

describe("profile table columns", () => {
  it("omits the sandbox column when no entry declares a sandbox status", () => {
    const columns = tableColumns(entries, 100)

    expect(columns).toEqual({ profile: 19, harness: 10, sandbox: 0, model: 65 })
    expect(columns.profile + columns.harness + columns.sandbox + columns.model + 2).toBeLessThanOrEqual(100)
  })

  it("reserves a sandbox column once any entry declares a sandbox status", () => {
    const withSandbox = [...entries, { ...entries[0]!, id: "cdx:hve", sandbox: true }]
    const columns = tableColumns(withSandbox, 100)

    expect(columns).toEqual({ profile: 19, harness: 10, sandbox: 9, model: 56 })
    expect(columns.profile + columns.harness + columns.sandbox + columns.model + 2).toBeLessThanOrEqual(100)
  })

  it("keeps every column visible in a narrow terminal", () => {
    const withSandbox = [...entries, { ...entries[0]!, id: "cdx:hve", sandbox: true }]
    const columns = tableColumns(withSandbox, 48)

    expect(columns.profile).toBeGreaterThanOrEqual(12)
    expect(columns.harness).toBeGreaterThanOrEqual(10)
    expect(columns.sandbox).toBeGreaterThanOrEqual(9)
    expect(columns.model).toBeGreaterThanOrEqual(8)
    expect(columns.profile + columns.harness + columns.sandbox + columns.model + 2).toBeLessThanOrEqual(48)
  })
})
