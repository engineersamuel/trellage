import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { discoverProfileGuideRelativePaths, loadProfileGuide, parseProfileGuideIdentity } from "@trellage/guide-core"
import { readTrellageConfig } from "../../packages/trellage-runtime/src/native-config.ts"
import { adapters } from "../../packages/trellage-runtime/src/native-run/adapters.ts"
import { nativeHarnessPresets, nativeSharedPresets } from "../../packages/trellage-runtime/src/native-run/presets.ts"

export const runFlags = [
  "--allow-unproven-isolation",
  "--continue",
  "--dry-run",
  "--effort",
  "--model",
  "--no-always",
  "--plan",
  "--require-proven-isolation",
  "--resume",
  "--skill",
] as const
export const guideFlags = [
  "--base",
  "--copy",
  "--effort",
  "--engagement",
  "--help",
  "--intent",
  "--intent-stdin",
  "--json",
  "--model",
  "--next-steps",
  "--optimize",
  "--print",
  "--profile",
  "--review",
  "--prompts",
  "--ui-variant",
] as const

export const discoverFlags = (source: string): string[] =>
  [...new Set([...source.matchAll(/["'](--[a-z][a-z-]*)(?:=)?["']/gu)].map((match) => match[1]!))].sort()

export const assertFlagInventory = (source: string, expected: ReadonlyArray<string>): void => {
  const actual = discoverFlags(source)
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Flag inventory changed: declared=${expected.join(",")} parser=${actual.join(",")}`)
  }
}

export const assertRootOptionInventory = (source: string) => {
  const start = source.indexOf('case "${1-}" in')
  const end = source.indexOf("\nesac", start)
  if (start < 0 || end < 0) throw new Error("Root case structure changed")
  const patterns = [...source.slice(start, end).matchAll(/^  ([^\s)\n][^)\n]*)\)/gm)].map((match) =>
    match[1]!.split("|"),
  )
  const helpAliases = patterns.find((aliases) => aliases.includes("--help"))?.sort()
  if (JSON.stringify(helpAliases) !== JSON.stringify(["-h", "--help", "help"].sort()))
    throw new Error("Root help aliases changed")
  const flags = [
    ...new Set(
      patterns
        .flat()
        .filter((value) => value.startsWith("-"))
        .map((value) => value.split("=")[0]!),
    ),
  ].sort()
  if (JSON.stringify(flags) !== JSON.stringify(["-h", "--help", "--profile", "-i", "--interactive"].sort()))
    throw new Error("Root option inventory changed")
  return { helpAliases, flags, rejectedFlags: ["--profile", "-i", "--interactive"] }
}

const sourcePaths = [
  "tests/exhaustive/inventory.ts",
  "tests/exhaustive/domains.ts",
  "tests/exhaustive/matrix.ts",
  "tests/exhaustive/root-help.ts",
  "tests/exhaustive/root-help.test.ts",
  "tests/exhaustive/root-help-deny-bun.sh",
  "tests/exhaustive/execute.ts",
  "tests/exhaustive/completion.ts",
  "tests/exhaustive/source-identity.ts",
  "tests/helpers/posix-pty.py",
  "packages/trellage-launcher/test/helpers/source-pty.ts",
  "tests/exhaustive/run-executor.ts",
  "tests/exhaustive/run-dispatch.ts",
  "tests/exhaustive/run-dispatch.test.ts",
  "tests/exhaustive/run-dispatch-bun.sh",
  "tests/exhaustive/run-dispatch-capture.ts",
  "tests/exhaustive/run-selector-options.test.ts",
  "tests/exhaustive/guide-executor.ts",
  "tests/exhaustive/guide-case.ts",
  "tests/exhaustive/guide-stdin.ts",
  "tests/exhaustive/guide-stdin-regression.ts",
  "tests/exhaustive/guide-request-overrides.ts",
  "tests/exhaustive/guide-request-context.ts",
  "tests/exhaustive/guide-goal-fixtures.ts",
  "packages/trellage-launcher/src/guide-goal-execution.ts",
  "packages/trellage-launcher/src/guide-goal-generation.ts",
  "packages/trellage-launcher/src/guide-goal-transport.ts",
  "tests/exhaustive/guide-request-fields.ts",
  "tests/exhaustive/guide-request-fields-regression.ts",
  "tests/exhaustive/run-behavior-oracle.ts",
  "tests/exhaustive/native-world.ts",
  "tests/exhaustive/host-fixtures.ts",
  "tests/exhaustive/run-parser-oracle.ts",
  "tests/exhaustive/guide-parser-oracle.ts",
  "tests/exhaustive/guide-model-fixture.ts",
  "tests/exhaustive/guide-world.ts",
  "tests/exhaustive/mock-audit.ts",
  "tests/exhaustive/guide-behavior-regression.ts",
  "tests/exhaustive/router-help-processes.py",
  "tests/exhaustive/guide-process-entry.ts",
  "tests/exhaustive/guide-process.ts",
  "tests/exhaustive/guide-process-regression.ts",
  "tests/exhaustive/conversation-world.ts",
  "tests/exhaustive/controlling-input-child.ts",
  "tests/exhaustive/controlling-input-regression.ts",
  "tests/exhaustive/run-selector-regression.ts",
  "tests/exhaustive/run-main-dependencies.test.ts",
  "tests/exhaustive/run-selector-process.ts",
  "tests/exhaustive/run-selector-preload.ts",
  "tests/exhaustive/run-selector-bun.sh",
  "prototypes/trellage-router/bin/trx",
  "packages/trellage-runtime/src/native-run/run.ts",
  "packages/trellage-runtime/src/native-run/adapters.ts",
  "packages/trellage-runtime/src/native-run/presets.ts",
  "packages/trellage-runtime/src/native-run/models.ts",
  "packages/trellage-runtime/src/native-config.ts",
  "packages/trellage-launcher/src/guide-api.ts",
  "packages/trellage-launcher/src/guide-command.ts",
  "packages/trellage-launcher/src/guide-context.ts",
  "packages/trellage-guide-core/src/index.ts",
  "packages/trellage-guide-core/src/guide-limits.ts",
  "packages/trellage-launcher/src/cli.tsx",
  "packages/trellage-launcher/src/run-select-cli.tsx",
  "packages/trellage-launcher/src/run-select-state.ts",
  "packages/trellage-launcher/src/run-select-ui.tsx",
  "packages/trellage-launcher/src/controlling-terminal-input.ts",
  "packages/trellage-launcher/src/ritual-clipboard.ts",
  "packages/trellage-launcher/src/basket-preview.tsx",
  "packages/trellage-launcher/src/fork-preview.tsx",
  "packages/trellage-launcher/src/ritual-catalog.ts",
  "config.example.toml",
] as const

export const commandInventory = async (root: string) => {
  const files = Object.fromEntries(
    await Promise.all(sourcePaths.map(async (name) => [name, await readFile(path.join(root, name), "utf8")] as const)),
  )
  const rootOptions = assertRootOptionInventory(files["prototypes/trellage-router/bin/trx"]!)
  const runSource = files["packages/trellage-runtime/src/native-run/run.ts"]!
  const runParser = runSource.slice(
    runSource.indexOf("const parseValuedRunArgument"),
    runSource.indexOf("export const parseRunArguments"),
  )
  assertFlagInventory(runParser, runFlags)
  const guideSource = files["packages/trellage-launcher/src/guide-api.ts"]!
  const guideParser = guideSource.slice(
    guideSource.indexOf("const helpFlag ="),
    guideSource.indexOf("interface MutableGuideArgs"),
  )
  assertFlagInventory(guideParser, guideFlags)
  const { config } = await readTrellageConfig({
    environment: { TRELLAGE_CONFIG: path.join(root, "config.example.toml") },
  })
  const profiles = [
    ...new Set([
      ...Object.keys(config.native.profiles),
      ...Object.values(nativeHarnessPresets).flat(),
      ...nativeSharedPresets,
      "clean",
    ]),
  ].sort()
  const guideRoot = path.join(root, "profile-guides")
  const guideSources = await Promise.all(
    (await discoverProfileGuideRelativePaths(guideRoot)).map(async (relative) => {
      const source = await readFile(path.join(guideRoot, relative), "utf8")
      const document = await loadProfileGuide(guideRoot, parseProfileGuideIdentity(relative))
      return { relative, source, document }
    }),
  )
  return {
    hashes: Object.fromEntries(
      Object.entries({
        ...files,
        ...Object.fromEntries(guideSources.map(({ relative, source }) => [`profile-guides/${relative}`, source])),
      }).map(([name, text]) => [name, createHash("sha256").update(text).digest("hex")]),
    ),
    runFlags: [...runFlags],
    guideFlags: [...guideFlags],
    rootOptions,
    harnesses: Object.keys(adapters).sort(),
    efforts: [...new Set(Object.values(adapters).flatMap((adapter) => adapter.efforts))].sort(),
    profiles,
    workflows: [
      ...new Set(guideSources.flatMap(({ document }) => document.guide.workflows.map(({ id }) => id))),
    ].sort(),
    catalog: config.native,
    presets: nativeHarnessPresets,
  }
}
