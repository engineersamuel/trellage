import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { adapters, nativeHarnessPresets, nativeSharedPresets } from "@trellage/runtime/native-run"
import { GuideEffort, GuideLongPromptVariant, guideIntentMaximumLength } from "../packages/trellage-launcher/src/guide-api.ts"
import { loadGuideCatalogDomain } from "./exhaustive-guide-catalog.ts"
import { argumentForms, type ArgumentForm } from "./exhaustive-argument-syntax.ts"
import { shippedRituals } from "../packages/trellage-launcher/src/ritual-catalog.ts"

export interface DomainValue {
  readonly id: string
  readonly argv: readonly string[]
  readonly form?: ArgumentForm
}

export interface CliDomain {
  readonly name: string
  readonly rationale: string
  readonly values: readonly DomainValue[]
}

const omitted: DomainValue = { id: "omitted", argv: [] }
const choice = (id: string, ...argv: string[]): DomainValue => ({ id, argv })
const boolean = (name: string): CliDomain => ({
  name, rationale: "Every declared boolean state, including omission.",
  values: [omitted, choice("present", name)],
})
const enumeration = (name: string, values: readonly string[]): CliDomain => ({
  name, rationale: "Every registry value, omission, empty value, and unknown value.",
  values: [omitted, ...values.map(value => choice(value, name, value)),
    choice("empty", name, ""), choice("unknown", name, "not-a-declared-value")],
})
const bounded = (name: string, maximum: number, representative: string): CliDomain => ({
  name, rationale: `Omission, ordinary input, character lengths 0, 1, ${maximum - 1}, ${maximum}, ${maximum + 1}; whitespace, controls, supplementary Unicode and unpaired surrogates.`,
  values: [omitted, choice("ordinary", name, representative), choice("empty", name, ""),
    choice("minimum", name, "a"), choice("below-maximum", name, "a".repeat(maximum - 1)),
    choice("maximum", name, "a".repeat(maximum)),
    choice("over-maximum", name, "a".repeat(maximum + 1)), choice("whitespace", name, " \t "),
    choice("control", name, "a\u0001b"), choice("multiline", name, "first\nsecond"),
    choice("unicode-minimum", name, "😀"), choice("unicode-maximum", name, "😀".repeat(maximum)),
    choice("unicode-over-maximum", name, "😀".repeat(maximum + 1)), choice("unpaired-surrogate", name, "a\ud800")],
})

export const assertFlagCoverage = (declared: readonly string[], domains: readonly CliDomain[], aliases: Readonly<Record<string, string>> = {}): void => {
  const represented = new Set(domains.map(domain => aliases[domain.name] ?? domain.name))
  const missing = [...new Set(declared)].filter(flag => !represented.has(flag))
  if (missing.length) throw new Error(`Declared CLI flags lack domains: ${missing.join(", ")}`)
}

const root = new URL("../", import.meta.url)
const sources = [
  "scripts/exhaustive-argument-syntax.ts",
  "scripts/exhaustive-guide-dispatch.ts", "scripts/exhaustive-preview-domains.ts", "scripts/exhaustive-guide-previews.ts",
  "scripts/exhaustive-cli-domains.ts", "scripts/exhaustive-guide-catalog.ts",
  "scripts/exhaustive-terminal.py", "packages/trellage-launcher/src/ritual-ui.tsx",
  "scripts/exhaustive-guide-ritual.ts", "scripts/exhaustive-guide-continuation.ts", "scripts/exhaustive-guide-review.ts",
  "scripts/exhaustive-guide-review-execution.ts", "scripts/exhaustive-guide-review-workers.ts",
  "scripts/exhaustive-guide-review-handoff.ts",
  "packages/trellage-launcher/test/fixtures/guide-optimize-model.ts",
  "packages/trellage-launcher/src/review-coordinator.ts", "packages/trellage-launcher/src/review-skills.ts",
  "packages/trellage-launcher/src/copilot-review-provider.ts", "packages/trellage-launcher/src/copilot-guide-provider.ts",
  "packages/trellage-launcher/src/live-clients.ts", "packages/trellage-launcher/src/review-normalize.ts",
  "packages/trellage-launcher/src/review-run.ts", "packages/trellage-launcher/src/review-contracts.ts",
  "packages/trellage-launcher/src/review-artifacts.ts", "packages/trellage-launcher/src/review-context.ts",
  "packages/trellage-launcher/src/review-evidence.ts", "packages/trellage-launcher/src/review-snapshot.ts",
  "packages/trellage-launcher/src/review-source.ts", "packages/trellage-launcher/src/review-findings.ts",
  "packages/trellage-launcher/src/review-store.ts", "packages/trellage-launcher/src/review-records.ts",
  "packages/trellage-launcher/src/review-view-model.ts",
  "packages/trellage-launcher/src/continuation-entry.ts", "packages/trellage-launcher/src/continuation-source-client.ts",
  "packages/trellage-launcher/src/continuation-store.ts",
  "packages/trellage-guide-core/src/conversation.ts",
  "scripts/exhaustive-continuation-assessment.ts", "packages/trellage-launcher/src/continuation-runtime.ts",
  "packages/trellage-launcher/src/continuation-provider.ts", "packages/trellage-launcher/src/jev-decisions.ts",
  "packages/trellage-launcher/src/continuation-ui-state.ts",
  "scripts/exhaustive-continuation-preparation.ts", "packages/trellage-launcher/src/guide-context.ts",
  "scripts/exhaustive-continuation-launch.ts", "packages/trellage-launcher/src/continuation-launch.ts",
  "packages/trellage-launcher/src/guide-batch.ts", "packages/trellage-launcher/src/guide-preflight.ts",
  "packages/trellage-launcher/src/review-services.ts", "packages/trellage-launcher/src/review-target.ts",
  "packages/trellage-launcher/src/review-catalog.ts", "packages/trellage-launcher/src/cli.tsx",
  "packages/trellage-launcher/src/ritual-clipboard.ts",
  "scripts/exhaustive-guide-world.ts", "scripts/exhaustive-guide-json.ts",
  "scripts/exhaustive-guide-interactive.ts", "packages/trellage-launcher/src/guide-interactive-intent.ts",
  "packages/trellage-launcher/src/guide-workflow-prompt.ts", "packages/trellage-launcher/src/guide-launch.ts",
  "packages/trellage-launcher/src/guide-catalog.ts", "packages/trellage-launcher/src/guide-provider.ts",
  "scripts/exhaustive-guide-oracle.ts", "scripts/exhaustive-guide-request.ts",
  "packages/trellage-launcher/src/guide-command.ts", "packages/trellage-launcher/src/guide-model-routing.ts",
  "scripts/exhaustive-run-arguments.ts", "scripts/exhaustive-run-oracle.ts", "scripts/exhaustive-guide-arguments.ts",
  "scripts/exhaustive-run-dispatch.ts", "scripts/verify-exhaustive-coverage.ts",
  "config.toml", "prototypes/trellage-router/bin/trx",
  "packages/trellage-runtime/src/native-run/run.ts",
  "packages/trellage-runtime/src/native-run/adapters.ts",
  "packages/trellage-runtime/src/native-run/presets.ts",
  "packages/trellage-launcher/src/guide-api.ts",
  "packages/trellage-launcher/src/ritual-catalog.ts",
  "packages/trellage-launcher/src/guide-text.ts",
  "packages/trellage-launcher/src/basket-preview.tsx",
  "packages/trellage-launcher/src/fork-preview.tsx",
] as const

export const loadCliDomains = async () => {
  const files = await Promise.all(sources.map(async name => [name, await readFile(new URL(name, root), "utf8")] as const))
  const contents = new Map(files)
  const runSource = contents.get("packages/trellage-runtime/src/native-run/run.ts")!
  const flagBody = runSource.split("const parseFlagRunArgument =")[1]?.split("export const parseRunArguments")[0]
  if (!flagBody) throw new Error("Cannot locate the run flag registry")
  const runFlags = [...flagBody.matchAll(/"(--[a-z-]+)":/g)].map(match => match[1]!)
  const guideSource = contents.get("packages/trellage-launcher/src/guide-api.ts")!
  const guideNames = new Map([...guideSource.matchAll(/const (\w+Flag) = "(--[a-z-]+)"/g)]
    .map(match => [match[1]!, match[2]!] as const))
  const guideFlagBody = guideSource.match(/const booleanFlags = new Set\(\[([\s\S]*?)\]\)/)?.[1]
  if (!guideFlagBody || runFlags.length === 0) throw new Error("CLI flag registry extraction failed")
  const guideFlags = guideFlagBody.split(",").map(name => name.trim()).filter(Boolean).map(name => {
    const flag = guideNames.get(name)
    if (!flag) throw new Error(`Unmapped guide flag ${name}`)
    return flag
  })
  const guideValueBody = guideSource.match(/const valueFlags = new Set\(\[([\s\S]*?)\]\)/)?.[1]
  if (!guideValueBody) throw new Error("Cannot locate the Guide value flag registry")
  const guideValues = guideValueBody.split(",").map(name => name.trim()).filter(Boolean).map(name => {
    const flag = guideNames.get(name)
    if (!flag) throw new Error(`Unmapped Guide value flag ${name}`)
    return flag
  })
  const runValueBody = runSource.split("const parseValuedRunArgument =")[1]?.split("const parseFlagRunArgument")[0]
  if (!runValueBody) throw new Error("Cannot locate the run value parser")
  const runValues = [...runValueBody.matchAll(/argument(?: === |\.startsWith\()"(--[a-z-]+)=?"/g)]
    .map(match => match[1]!)
  if (runValues.length === 0) throw new Error("Run value flag extraction found no declarations")
  const bound = (name: string): number => {
    const match = guideSource.match(new RegExp(`const ${name} = ([0-9_]+)`))
    if (!match) throw new Error(`Cannot locate ${name}`)
    return Number(match[1]!.replaceAll("_", ""))
  }
  const literalBound = (pattern: RegExp, name: string): number => {
    const match = guideSource.match(pattern)
    if (!match) throw new Error(`Cannot locate ${name}`)
    return Number(match[1]!.replaceAll("_", ""))
  }
  const baseMaximum = literalBound(/text\(value, "--base", ([0-9_]+)\)/, "review base bound")
  const ritualMaximum = literalBound(/id\.length > ([0-9_]+)/, "ritual ID bound")
  const config = await readTrellageConfig({ environment: { TRELLAGE_CONFIG: fileURLToPath(new URL("config.toml", root)) } })
  const guideCatalog = await loadGuideCatalogDomain()
  const harnesses = Object.keys(adapters).sort()
  const profiles = [...new Set([
    ...Object.keys(config.config.native.profiles), ...Object.values(nativeHarnessPresets).flat(),
    ...nativeSharedPresets, "clean", ...guideCatalog.declared.map(identity => identity.split("/")[1]!),
  ])].sort()
  const run: CliDomain[] = [
    { name: "harness", rationale: "Every adapter, omission, and unsupported harness.",
      values: [omitted, ...harnesses.map(name => choice(name, name)), choice("unknown", "unknown-harness")] },
    { name: "profiles", rationale: "Every configured profile and public alias across every harness; no compatibility pruning. Unbounded stacks use empty, singleton, ordered pairs, duplicates, unknown and clean conflicts.",
      values: [omitted, ...profiles.map(name => choice(name, name)), choice("ordered-stack", "base", "office"),
        choice("reversed-stack", "office", "base"), choice("duplicate", "base", "base"),
        choice("unknown", "unknown-profile"), choice("clean-conflict", "clean", "base")] },
    ...runFlags.map(boolean),
    { name: "--model", rationale: "Unbounded model input uses omission, empty, one character, ordinary, whitespace, Unicode and long values.",
      values: [omitted, ...["", "a", "gpt-6-astra", "space value", "模型", "a".repeat(256)]
        .map((value, index) => choice(`value-${index}`, "--model", value))] },
    enumeration("--effort", [...new Set(Object.values(adapters).flatMap(adapter => adapter.efforts))].sort()),
    { name: "--skill", rationale: "Omission, valid minimum and representative selectors, repeated and distinct selectors, malformed syntax.",
      values: [omitted, choice("minimum", "--skill", "a/b:c"), choice("ordinary", "--skill", "owner/repository:skill-name"),
        choice("duplicate", "--skill", "a/b:c", "--skill", "a/b:c"),
        choice("multiple", "--skill", "a/b:c", "--skill", "a/b:d"), choice("invalid", "--skill", "missing-name")] },
    { name: "inline-resume", rationale: "Omission, empty, representative and whitespace IDs. Crossed with both resume boolean flags.",
      values: [omitted, choice("empty", "--resume="), choice("ordinary", "--resume=session-123"), choice("space", "--resume=space value")] },
    { name: "forwarded", rationale: "Omission, explicit empty separator, ordinary arguments, empty and wildcard arguments, and every adapter-managed flag.",
      values: [omitted, choice("separator", "--"), choice("ordinary", "--", "prompt"),
        choice("shell-sensitive", "--", "space value", "", "*"),
        ...[...new Set(Object.values(adapters).flatMap(adapter => adapter.managedFlags))].sort()
          .map(flag => choice(flag, "--", flag, "fixture"))] },
  ]
  const profileDomain = bounded("--profile", bound("profileRefMaximumLength"), "native:codex/pstack")
  const profileInputs = new Set(profileDomain.values.map(value => JSON.stringify(value.argv)))
  const guide: CliDomain[] = [
    ...guideFlags.map(boolean),
    bounded("--intent", guideIntentMaximumLength, "Review this change"),
    { ...profileDomain, rationale: `${profileDomain.rationale} Every harness/profile reference is retained, including unsupported combinations.`,
      values: [...profileDomain.values, ...harnesses.flatMap(harness => profiles.map(profile =>
        choice(`${harness}/${profile}`, "--profile", `native:${harness}/${profile}`)))
        .filter(value => !profileInputs.has(JSON.stringify(value.argv)))] },
    bounded("--model", bound("modelIdentifierMaximumLength"), "gpt-6-astra"),
    enumeration("--effort", Object.values(GuideEffort)),
    enumeration("--ui-variant", Object.values(GuideLongPromptVariant)),
    bounded("--base", baseMaximum, "origin/main"),
    { name: "positionals", rationale: "Omission, ordinary intent/ritual ID, every shipped ritual ID, ritual length boundaries, malformed ritual ID, and multiple arguments.",
      values: [omitted, choice("ordinary", "review-code"), ...shippedRituals.map(ritual => choice(`shipped:${ritual.id}`, ritual.id)), choice("ritual-maximum", "a".repeat(ritualMaximum)),
        choice("ritual-over-maximum", "a".repeat(ritualMaximum + 1)), choice("invalid-ritual", "Not an ID"),
        choice("multiple", "first", "second")] },
  ]
  assertFlagCoverage(runFlags, run)
  assertFlagCoverage(runValues, run.filter(domain => !runFlags.includes(domain.name)), { "inline-resume": "--resume" })
  assertFlagCoverage([...guideFlags, ...guideValues], guide)
  const syntax: CliDomain = {
    name: "syntax",
    rationale: "Every declared input form is crossed with every semantic tuple. Equivalent encodings at omitted options remain separate cases; invalid encodings are asserted as rejections.",
    values: argumentForms.map(form => ({ id: form, argv: [], form })),
  }
  run.push(syntax)
  guide.push(syntax)
  for (const domains of [run, guide]) {
    for (const domain of domains) {
      if (new Set(domain.values.map(value => value.id)).size !== domain.values.length)
        throw new Error(`Duplicate case labels in ${domain.name}`)
      if (new Set(domain.values.map(value => JSON.stringify([value.argv, value.form]))).size !== domain.values.length)
        throw new Error(`Duplicate inputs in ${domain.name}`)
    }
  }
  const sourceHashes = { ...guideCatalog.sourceHashes,
    ...Object.fromEntries(files.map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")])) }
  return { run, guide, sourceHashes }
}

export const assertCliSourcesUnchanged = async (before: Readonly<Record<string, string>>): Promise<void> => {
  assert.deepEqual((await loadCliDomains()).sourceHashes, before, "CLI or verifier sources changed during matrix execution")
}

export const productSize = (domains: readonly CliDomain[]): bigint =>
  domains.reduce((product, domain) => product * BigInt(domain.values.length), 1n)

export const caseAt = (domains: readonly CliDomain[], ordinal: bigint): ReadonlyMap<string, DomainValue> => {
  if (ordinal < 0n) throw new Error("Case ordinal must be nonnegative")
  const selected = new Map<string, DomainValue>()
  for (const domain of domains) {
    const radix = BigInt(domain.values.length)
    selected.set(domain.name, domain.values[Number(ordinal % radix)]!)
    ordinal /= radix
  }
  if (ordinal !== 0n) throw new Error("Case ordinal is outside the declared product")
  return selected
}

if (import.meta.main) {
  const { run, guide, sourceHashes } = await loadCliDomains()
  console.log(JSON.stringify({
    status: "domain-draft-not-executed", sourceHashes,
    matrices: Object.fromEntries((["run", "guide"] as const).map(name => {
      const domains = name === "run" ? run : guide
      return [name, { combinations: productSize(domains).toString(),
        dimensions: domains.map(domain => ({ name: domain.name, count: domain.values.length,
          rationale: domain.rationale, values: domain.values.map(value => ({ id: value.id, argv: value.argv, ...(value.form ? { form: value.form } : {}) })) })) }]
    })),
    remainingDomains: ["root help and selector dispatch", "conflicting duplicate values and missing values for remaining flags",
      "basket and fork preview modes", "stdin and TTY process states"],
    executedCases: 0,
  }, null, 2))
}
