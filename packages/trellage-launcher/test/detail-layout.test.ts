import { describe, expect, it } from "vitest"
import { detailRows } from "../src/detail-layout.js"
import type { LaunchEntry } from "../src/state.js"

const entry: LaunchEntry = {
  id: "claude:blog",
  label: "claude-blog / claude",
  profile: "claude-blog",
  harness: "claude",
  harnessVersion: "latest",
  description: "A complete description that must remain readable instead of ending in an ellipsis.",
  details: "Ready after deterministic checks.",
  plugins: ["claude-blog", "editorial-review"],
  skills: ["caveman", "technical-writing"],
  mcps: ["docs", "files"],
  commandAlias: "cpx",
  commandPath: "/opt/trellage/cpx/bin/cpx",
  profileArgument: "copilot",
  passthroughArgs: ["two words", "", "--literal=*"],
  defaultModel: "claude-opus-5",
  models: ["claude-opus-5"],
  modelOverrideSupported: true,
}

const rendered = (row: ReturnType<typeof detailRows>[number]): string =>
  `${row.label === undefined ? "  " : `${row.label}: `}${row.text}`

describe("profile detail layout", () => {
  it("wraps every metadata field without truncating its content", () => {
    const rows = detailRows(entry, "provider/a-very-long-selected-model", 42)
    const output = rows.map(rendered).join("\n")

    expect(rows.every((row) => rendered(row).length <= 42)).toBe(true)
    for (const value of [
      "ellipsis.",
      "claude latest",
      "provider/a-very-long-selected-model",
      "claude-blog",
      "editorial-review",
      "caveman",
      "technical-writing",
      "docs",
      "files",
      "deterministic checks.",
    ]) {
      expect(output).toContain(value)
    }
  })

  it("shows the resolved binary and exact forwarded argument vector", () => {
    const rows = detailRows(entry, "gpt-fast", 200, "gpt-fast")
    const fields = Object.fromEntries(rows.filter((row) => row.label !== undefined).map((row) => [row.label, row.text]))

    expect(fields.Run).toBe("trx run cpx copilot")
    expect(fields.Alias).toBe("cpx")
    expect(fields.Binary).toBe("/opt/trellage/cpx/bin/cpx")
    expect(fields.Arguments).toBe('["copilot","--model","gpt-fast","two words","","--literal=*"]')
  })

  it("shows a sandbox row only when the entry declares one", () => {
    const withSandbox = detailRows({ ...entry, sandbox: true }, "claude-opus-5", 200)
    const fields = Object.fromEntries(
      withSandbox.filter((row) => row.label !== undefined).map((row) => [row.label, row.text]),
    )
    expect(fields.Sandbox).toBe("true")

    const withoutSandbox = detailRows(entry, "claude-opus-5", 200)
    expect(withoutSandbox.some((row) => row.label === "Sandbox")).toBe(false)
  })
})
