import React, { useEffect } from "react"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { render } from "ink"
import { RunSelector } from "../../src/run-select-ui.tsx"
import type { RunSelectorCatalog, RunSelectorChoice } from "../../src/run-select-state.ts"
import { ThemeProvider } from "../../src/termcn/theme-provider.tsx"
import { trellageTheme } from "../../src/termcn/theme-trellage.ts"

// Static data only: this entry never loads a catalog, history, or agent launcher.
const [root, scenario = "restored"] = process.argv.slice(2)
const longName = "fixture-profile-with-a-long-name-for-checking-terminal-wrapping-at-eighty-columns"
const models = [
  scenario === "long" ? "fixture-model-with-a-long-name-for-checking-terminal-wrapping-at-eighty-columns" : "fixture-model-alpha",
  "fixture-model-beta",
  ...Array.from({ length: 24 }, (_, i) => `fixture-model-${String(i + 1).padStart(2, "0")}`),
]
const catalog: RunSelectorCatalog = {
  harnesses: [
    {
      harness: "pi", label: "Fixture Pi", efforts: ["low", "high"],
      defaultModel: "fixture-default", defaultEffort: "low", planModel: "fixture-plan",
      extensions: ["fixture-extension"],
    },
    { harness: "codex", label: "Fixture Codex", efforts: ["low", "high"], defaultModel: undefined, planModel: "harness default" },
  ],
  profiles: scenario === "empty" ? [] : [scenario === "long" ? longName : "fixture-review", "fixture-build"],
  always: [
    { profile: "fixture-common", skills: ["fixture-skill"], instructions: ["fixture-style"] },
    { profile: "fixture-pi-only", harnesses: ["pi"], skills: ["fixture-pi-skill"], instructions: [] },
  ],
  models,
  modelGroups: [{ title: "Frontier", models: models.slice(0, 2) }, { title: "Other models", models: models.slice(2) }],
  cycleCount: 2,
}
const callbacks: Array<RunSelectorChoice | null> = []
const Fixture = () => {
  useEffect(() => {
    if (!process.stdin.isRaw) throw new Error("Selector input is not ready")
    if (root) writeFileSync(path.join(root, "ready"), "ready")
  }, [])
  return (
    <ThemeProvider theme={trellageTheme}>
      <RunSelector
        catalog={catalog}
        initial={scenario === "restored" || scenario === "long"
          ? { harness: "pi", profiles: [catalog.profiles[0]!], model: models[0], effort: "high" }
          : undefined}
        restoredFrom={scenario === "restored" ? "worktree" : undefined}
        onDone={(choice) => callbacks.push(choice)}
      />
    </ThemeProvider>
  )
}
const instance = render(<Fixture />)
await instance.waitUntilExit()
if (root) writeFileSync(path.join(root, "result.json"), JSON.stringify(callbacks))
