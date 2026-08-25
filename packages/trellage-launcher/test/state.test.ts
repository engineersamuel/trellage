import { describe, expect, it } from "vitest"
import {
  createLauncherState,
  cycleSort,
  moveSelection,
  selectModel,
  setQuery,
  visibleEntries,
  type LaunchEntry,
} from "../src/state.js"

const entries: ReadonlyArray<LaunchEntry> = [
  {
    id: "codex:superpowers",
    label: "codex / superpowers",
    harness: "codex",
    profile: "superpowers",
    description: "Codex profile",
    defaultModel: "gpt-default",
    models: ["gpt-default", "gpt-fast"],
    modelOverrideSupported: true,
  },
  {
    id: "claude:council",
    label: "claude / council",
    harness: "claude",
    profile: "council",
    description: "Claude profile",
    defaultModel: "opus",
    models: ["opus"],
    modelOverrideSupported: false,
  },
  {
    id: "codex:hve",
    label: "codex / hve",
    harness: "codex",
    profile: "hve",
    description: "HVE profile",
    defaultModel: "gpt-default",
    models: ["gpt-default"],
    modelOverrideSupported: true,
  },
]

describe("launcher state", () => {
  it("sorts by harness ascending by default and cycles to profile sorting", () => {
    const initial = createLauncherState(entries)
    const cycled = cycleSort(initial)

    expect(initial.sort).toBe("harness")
    expect(visibleEntries(initial).map(({ id }) => id)).toEqual(["claude:council", "codex:hve", "codex:superpowers"])
    expect(initial.selectedId).toBe("claude:council")
    expect(cycled.sort).toBe("profile")
  })

  it("filters across profile, harness, and description while preserving a valid selection", () => {
    const state = setQuery(moveSelection(createLauncherState(entries), 1), "HVE")

    expect(visibleEntries(state).map(({ id }) => id)).toEqual(["codex:hve"])
    expect(state.selectedId).toBe("codex:hve")
  })

  it("moves from the current selection within filtered results", () => {
    const filtered = setQuery(createLauncherState(entries), "codex")
    const moved = moveSelection(filtered, 1)

    expect(visibleEntries(filtered).map(({ id }) => id)).toEqual(["codex:hve", "codex:superpowers"])
    expect(filtered.selectedId).toBe("codex:hve")
    expect(moved.selectedId).toBe("codex:superpowers")
    expect(moveSelection(moved, 1).selectedId).toBe("codex:hve")
  })

  it("selects advertised or custom models only when the entry supports overrides", () => {
    const initial = createLauncherState(entries)
    const advertised = selectModel(initial, "codex:superpowers", "gpt-fast")
    const custom = selectModel(initial, "codex:superpowers", "provider/custom-model")

    expect(advertised.modelByEntry["codex:superpowers"]).toBe("gpt-fast")
    expect(custom.modelByEntry["codex:superpowers"]).toBe("provider/custom-model")
    expect(() => selectModel(initial, "claude:council", "opus")).toThrow(/pinned model/)
    expect(() => selectModel(initial, "codex:superpowers", "")).toThrow(/non-empty printable/)
  })
})
