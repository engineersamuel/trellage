import { describe, expect, it } from "vitest"
import {
  initialRunSelectorState,
  runSelectorChoice,
  runSelectorCommand,
  runSelectorReducer,
  type RunSelectorCatalog,
} from "../src/run-select-state.ts"

const catalog: RunSelectorCatalog = {
  harnesses: [
    { harness: "pi", label: "Pi", efforts: ["low", "high"], defaultModel: "m1 (default)", planModel: "none" },
    { harness: "claude", label: "Claude", efforts: ["medium"], defaultModel: "m2 (default)", planModel: "opus" },
  ],
  profiles: ["office", "superpowers"],
  models: ["a", "b"],
}

describe("run selector state", () => {
  it("defaults to harness defaults and no profiles", () => {
    const choice = runSelectorChoice(initialRunSelectorState(catalog), catalog)
    expect(choice).toEqual({ harness: "pi", profiles: [], model: undefined, effort: undefined })
    expect(runSelectorCommand(choice)).toBe("trx run pi")
  })

  it("restores history and drops unknown profiles", () => {
    const state = initialRunSelectorState(catalog, { harness: "claude", profiles: ["office", "gone"], model: "b", effort: "medium" })
    expect(runSelectorChoice(state, catalog)).toEqual({ harness: "claude", profiles: ["office"], model: "b", effort: "medium" })
  })

  it("stacks profiles, cycles model and resets effort on harness change", () => {
    let state = initialRunSelectorState(catalog, { effort: "high" })
    state = runSelectorReducer(state, { kind: "field", delta: 1 }, catalog)
    state = runSelectorReducer(state, { kind: "toggle" }, catalog)
    state = runSelectorReducer(state, { kind: "change", delta: 1 }, catalog)
    state = runSelectorReducer(state, { kind: "toggle" }, catalog)
    state = runSelectorReducer(state, { kind: "field", delta: 1 }, catalog)
    state = runSelectorReducer(state, { kind: "change", delta: -1 }, catalog)
    expect(runSelectorChoice(state, catalog)).toMatchObject({ profiles: ["office", "superpowers"], model: "b", effort: "high" })
    state = runSelectorReducer({ ...state, field: "harness" }, { kind: "change", delta: 1 }, catalog)
    expect(runSelectorChoice(state, catalog)).toMatchObject({ harness: "claude", effort: undefined })
  })

  it("cycles only the leading models inline and picks any model from the panel", () => {
    const wide: RunSelectorCatalog = { ...catalog, models: ["a", "b", "z"], cycleCount: 2 }
    let state = initialRunSelectorState(wide)
    state = { ...state, field: "model" }
    for (let step = 0; step < 3; step += 1) state = runSelectorReducer(state, { kind: "change", delta: 1 }, wide)
    expect(state.modelIndex).toBe(0)
    state = runSelectorReducer(state, { kind: "open-picker" }, wide)
    state = runSelectorReducer(state, { kind: "picker-move", delta: -1 }, wide)
    state = runSelectorReducer(state, { kind: "picker-select" }, wide)
    expect(state.picker).toBeNull()
    expect(runSelectorChoice(state, wide).model).toBe("z")
  })
})
