#!/usr/bin/env bun
import { constants, openSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import tty from "node:tty"
import React from "react"
import { render } from "ink"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import {
  adapters,
  nativeHarnessRegistry,
  nativeHarness,
  runNativeBackend,
  loadModelCatalog,
  hostDefaults,
  createSelectionHistory,
  main as runMain,
  resolveNativeRunPaths,
  scopeKeysFor,
} from "@trellage/runtime/native-run"
import { RunSelector } from "./run-select-ui.tsx"
import { ThemeProvider } from "./termcn/theme-provider.tsx"
import { trellageTheme } from "./termcn/theme-trellage.ts"
import type { RunSelectorCatalog, RunSelectorChoice } from "./run-select-state.ts"

const harnessOrder = [...new Set([...Object.keys(adapters), ...nativeHarnessRegistry.map(({ id }) => id)])]

const loadCatalog = async (): Promise<RunSelectorCatalog> => {
  const loaded = await readTrellageConfig({})
  const modelCatalog = await loadModelCatalog({
    paths: resolveNativeRunPaths({ environment: process.env }),
    hostModelsPath: path.join(os.homedir(), ".copilot", "models.json"),
    ...(process.env.TRELLAGE_MODELS_URL ? { url: process.env.TRELLAGE_MODELS_URL } : {}),
  })
  const first = modelCatalog.groups[0]
  const profileHarnesses: Record<string, ReadonlyArray<string> | undefined> = {}
  for (const entry of nativeHarnessRegistry) {
    for (const profile of Object.keys(entry.presets)) profileHarnesses[profile] = [...(profileHarnesses[profile] ?? []), entry.id]
  }
  for (const [id, profile] of Object.entries(loaded.config.native.profiles)) {
    const isPresetContent = nativeHarnessRegistry.some((entry) => Object.keys(entry.presets).some((preset) => id === `preset-${entry.id}-${preset}`))
    if (!profile.always && !isPresetContent) profileHarnesses[id] = profile.harnesses
  }
  return {
    harnesses: harnessOrder.map((id) => {
      const adapter = adapters[id]
      const defaults = adapter ? hostDefaults(id) : { model: undefined, effort: undefined }
      return {
        harness: id,
        label: adapter?.label ?? id,
        efforts: adapter?.efforts ?? [],
        defaultModel: defaults.model,
        defaultEffort: defaults.effort,
        planModel: adapter?.effectivePolicy(defaults.model, defaults.effort).plan ?? "managed preset",
        extensions: adapter?.extensions ?? [],
      }
    }),
    profileHarnesses,
    profiles: Object.keys(profileHarnesses).sort(),
    always: Object.entries(loaded.config.native.profiles)
      .filter(([, profile]) => profile.always)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, profile]) => ({
        profile: id,
        harnesses: profile.harnesses,
        skills: profile.skills.flatMap((selection) => selection.names),
        instructions: profile.instructions,
      })),
    models: modelCatalog.groups.flatMap((group) => group.models),
    modelGroups: modelCatalog.groups,
    cycleCount: first?.title === "Frontier" ? first.models.length : 0,
  }
}

const select = async (catalog: RunSelectorCatalog): Promise<RunSelectorChoice | null> => {
  const paths = resolveNativeRunPaths({ environment: process.env })
  const restored = await createSelectionHistory(paths).restore(await scopeKeysFor(process.cwd()))
  const inputFd = openSync("/dev/tty", constants.O_RDONLY)
  const outputFd = openSync("/dev/tty", constants.O_WRONLY)
  const stdin = new tty.ReadStream(inputFd)
  const stdout = new tty.WriteStream(outputFd)
  let result: RunSelectorChoice | null = null
  const instance = render(
    <ThemeProvider theme={trellageTheme}>
      <RunSelector catalog={catalog} initial={restored?.selection} restoredFrom={restored?.scope} onDone={(choice) => (result = choice)} />
    </ThemeProvider>,
    { stdin, stdout },
  )
  await instance.waitUntilExit()
  stdin.destroy()
  stdout.destroy()
  return result
}

const argv = process.argv.slice(2)
const catalog = await loadCatalog().catch((error: unknown) => {
  process.stderr.write(`trx run: ${error instanceof Error ? error.message : String(error)}\n`)
  return null
})
if (!catalog) process.exit(1)
const choice = await select(catalog)
if (!choice) process.exit(0)
const launchArgs = [
  ...choice.profiles,
  ...(choice.model === undefined ? [] : ["--model", choice.model]),
  ...(choice.effort === undefined ? [] : ["--effort", choice.effort]),
  ...argv,
]
process.exitCode = choice.profiles.some((profile) => nativeHarness(choice.harness)?.presets[profile])
  ? await runNativeBackend("run", choice.harness, launchArgs)
  : await runMain([choice.harness, ...launchArgs])
