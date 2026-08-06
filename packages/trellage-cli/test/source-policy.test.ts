import { describe, expect, it } from "vitest"

import { sourceIncludes, sourceInventoryPolicy } from "../src/source-policy.js"

describe("source inclusion policy", () => {
  it("selects only the inputs required by each adapter", () => {
    expect(sourceIncludes({ kind: "skill", select: ["*"] })).toEqual(["skills"])
    expect(sourceIncludes({ kind: "plugin", adapter: "codex-native", select: ["one"] })).toEqual(["plugins/one/.codex"])
    expect(sourceIncludes({ kind: "plugin", adapter: "wshobson-agents", select: ["one"] })).toEqual([
      "plugins/one",
      "plugins/plugin-eval",
      "tools",
    ])
  })

  it("selects the complete repository for Copilot marketplaces", () => {
    const source = {
      kind: "plugin",
      adapter: "copilot-marketplace",
      marketplace: "hve-core",
      select: ["hve-core"],
    } as const

    expect(sourceIncludes(source)).toEqual([])
    expect(sourceInventoryPolicy(source)).toEqual({ allowSymlinks: true })
  })

  it("selects the complete repository and allows in-tree symlinks for Claude marketplaces", () => {
    const source = {
      kind: "plugin",
      adapter: "claude-marketplace",
      marketplace: "social-media-skills",
      select: ["social-media-skills"],
    } as const

    expect(sourceIncludes(source)).toEqual([])
    expect(sourceInventoryPolicy(source)).toEqual({ allowSymlinks: true })
  })

  it("keeps symlinks disabled for every other source", () => {
    expect(sourceInventoryPolicy({ kind: "skill", select: ["*"] })).toEqual({})
    expect(sourceInventoryPolicy({ kind: "plugin", adapter: "codex-native", select: ["one"] })).toEqual({})
    expect(sourceInventoryPolicy({ kind: "plugin", adapter: "wshobson-agents", select: ["one"] })).toEqual({})
  })
})
