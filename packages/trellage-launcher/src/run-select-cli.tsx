#!/usr/bin/env bun
import { constants, openSync } from "node:fs"
import path from "node:path"
import tty from "node:tty"
import { openControllingTerminalInput } from "./controlling-terminal-input.ts"
import React from "react"
import { render } from "ink"
import { createSelectionHistory, main as runMain, resolveNativeRunPaths, scopeKeysFor } from "@trellage/runtime/native-run"
import { herdrPaneCommand } from "./guide-launch.ts"
import { loadRunCatalog } from "./run-catalog.ts"
import { RunSelector } from "./run-select-ui.tsx"
import { ThemeProvider } from "./termcn/theme-provider.tsx"
import { trellageTheme } from "./termcn/theme-trellage.ts"
import type { RunSelectorCatalog, RunSelectorChoice } from "./run-select-state.ts"

type RunSelection =
  | { readonly target: "current"; readonly choice: RunSelectorChoice }
  | { readonly target: "herdr"; readonly choice: RunSelectorChoice }

export const shellQuote = (argument: string): string => `'${argument.replaceAll("'", `'\\''`)}'`

const launchArguments = (choice: RunSelectorChoice, argv: ReadonlyArray<string>): string[] => [
  choice.harness,
  ...choice.profiles,
  ...(choice.model === undefined ? [] : ["--model", choice.model]),
  ...(choice.effort === undefined ? [] : ["--effort", choice.effort]),
  ...argv,
]

// A source checkout router (`mise run trx`) only runs with these set, so the split pane needs them too.
const forwardedEnvironment = ["TRELLAGE_TRX_SOURCE_ROOT", "TRELLAGE_TRX_NATIVE_SOURCE", "TRELLAGE_TRX_GUIDE_ROOT"] as const

export const buildHerdrCommand = (
  routerCommandPath: string,
  choice: RunSelectorChoice,
  argv: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = {},
): string => {
  const assignments = forwardedEnvironment.flatMap((name) => {
    const value = environment[name]
    return value === undefined ? [] : [`${name}=${value}`]
  })
  return [
    ...(assignments.length === 0 ? [] : ["env", ...assignments]),
    path.resolve(routerCommandPath),
    "run",
    ...launchArguments(choice, argv),
  ]
    .map(shellQuote)
    .join(" ")
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const herdrPaneId = (source: string): string => {
  const parsed: unknown = JSON.parse(source)
  if (!isRecord(parsed) || !isRecord(parsed.result) || !isRecord(parsed.result.pane) || typeof parsed.result.pane.pane_id !== "string")
    throw new Error("Herdr did not return a pane ID")
  return parsed.result.pane.pane_id
}

const outputOf = async (arguments_: ReadonlyArray<string>, failure: string): Promise<string> => {
  const child = Bun.spawn([...arguments_], { stdout: "pipe", stderr: "inherit" })
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error(failure)
  return output
}

const launchInHerdr = async (
  routerCommandPath: string,
  choice: RunSelectorChoice,
  argv: ReadonlyArray<string>,
): Promise<void> => {
  if (choice.harness === "codex" && choice.profiles.includes("youtube") && Object.hasOwn(process.env, "TRANSCRIPT_API_KEY"))
    throw new Error("explicit TRANSCRIPT_API_KEY cannot be forwarded securely to Herdr; use the Trellage Varlock source or launch in the current pane")
  const worktree = (await outputOf(["git", "-C", process.cwd(), "rev-parse", "--show-toplevel"], "Herdr launch requires a Git worktree")).trim()
  const split = await outputOf(
    ["herdr", "pane", "split", "--current", "--direction", "right", "--cwd", worktree, "--focus"],
    "could not create a Herdr pane",
  )
  const pane = herdrPaneId(split)
  const child = Bun.spawn(["herdr", "pane", "run", pane, herdrPaneCommand(buildHerdrCommand(routerCommandPath, choice, argv, process.env))], {
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await child.exited) !== 0) throw new Error("could not start the selected profile in Herdr")
}

const select = async (catalog: RunSelectorCatalog, argv: ReadonlyArray<string>): Promise<RunSelection | null> => {
  const paths = resolveNativeRunPaths({ environment: process.env })
  const restored = await createSelectionHistory(paths).restore(await scopeKeysFor(process.cwd()))
  const outputFd = openSync("/dev/tty", constants.O_WRONLY)
  const stdin = openControllingTerminalInput()
  const stdout = new tty.WriteStream(outputFd)
  let result: RunSelection | null = null
  const herdrAvailable = process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID) && Bun.which("herdr") !== null
  const instance = render(
    <ThemeProvider theme={trellageTheme}>
      <RunSelector
        catalog={catalog}
        initial={restored?.selection}
        restoredFrom={restored?.scope}
        modifiers={argv}
        herdrAvailable={herdrAvailable}
        onDone={(choice) => (result = choice === null ? null : { target: "current", choice })}
        onHerdr={(choice) => (result = { target: "herdr", choice })}
      />
    </ThemeProvider>,
    { stdin, stdout },
  )
  try {
    await instance.waitUntilExit()
  } finally {
    stdin.destroy()
    stdout.destroy()
  }
  return result
}

export const main = async (argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> => {
  const catalog = await loadRunCatalog().catch((error: unknown) => {
    process.stderr.write(`trx run: ${error instanceof Error ? error.message : String(error)}\n`)
    return null
  })
  if (!catalog) return 1
  const selection = await select(catalog, argv)
  if (!selection) return 0
  if (selection.target === "herdr") {
    const routerCommandPath = process.env.TRELLAGE_TRX_COMMAND_PATH
    if (!routerCommandPath) throw new Error("TRELLAGE_TRX_COMMAND_PATH is required for a Herdr launch")
    await launchInHerdr(routerCommandPath, selection.choice, argv)
    return 0
  }
  return runMain(launchArguments(selection.choice, argv))
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`trx run: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
