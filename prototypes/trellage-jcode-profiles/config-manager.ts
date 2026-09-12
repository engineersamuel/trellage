#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null

import { readFileSync } from "node:fs"
import { parse, stringify } from "smol-toml"

function fail(message: string): never {
  process.stderr.write(`jcx config manager: ${message}\n`)
  process.exit(1)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const hasExactKeys = (value: unknown, expected: readonly string[]): value is Record<string, unknown> => {
  if (!isRecord(value)) {
    return false
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

const managedNamedProvider = (model: string, baseUrl: string) => ({
  type: "open-ai-compatible",
  base_url: baseUrl,
  auth: "none",
  default_model: model,
  requires_api_key: false,
  provider_routing: false,
  model_catalog: true,
  allow_provider_pinning: false,
  supports_reasoning_effort: true,
  models: [{ id: model }],
})

const parseConfig = (path: string) => parse(readFileSync(path, "utf8"))

const hasManagedProviderDefaults = (config: Record<string, unknown>, provider: string, model: string, effort: string) =>
  isRecord(config.provider) &&
  config.provider.default_provider === provider &&
  config.provider.default_model === model &&
  config.provider.openai_reasoning_effort === effort &&
  config.provider.cross_provider_failover === "manual"

const hasManagedNamedProvider = (providers: unknown, provider: string, model: string, baseUrl: string) => {
  if (!isRecord(providers) || !hasExactKeys(providers, [provider])) {
    return false
  }
  const named = providers[provider]
  const expected = managedNamedProvider(model, baseUrl)
  if (!hasExactKeys(named, Object.keys(expected))) {
    return false
  }
  const scalarValuesMatch = Object.entries(expected)
    .filter(([key]) => key !== "models")
    .every(([key, value]) => named[key] === value)
  return (
    scalarValuesMatch &&
    Array.isArray(named.models) &&
    named.models.length === 1 &&
    hasExactKeys(named.models[0], ["id"]) &&
    named.models[0].id === model
  )
}

const validate = (path: string, provider: string, model: string, effort: string, baseUrl: string) => {
  let config
  try {
    config = parseConfig(path)
  } catch {
    return false
  }
  return (
    isRecord(config) &&
    hasManagedProviderDefaults(config, provider, model, effort) &&
    hasManagedNamedProvider(config.providers, provider, model, baseUrl)
  )
}

const repair = (path: string, provider: string, model: string, effort: string, baseUrl: string) => {
  let config: Record<string, unknown>
  try {
    config = parseConfig(path)
  } catch {
    config = {}
  }
  if (!isRecord(config)) {
    config = {}
  }
  const providerConfig = isRecord(config.provider) ? config.provider : {}
  config.provider = {
    ...providerConfig,
    default_provider: provider,
    default_model: model,
    openai_reasoning_effort: effort,
    cross_provider_failover: "manual",
  }
  config.providers = {
    [provider]: managedNamedProvider(model, baseUrl),
  }
  process.stdout.write(`${stringify(config).trimEnd()}\n`)
}

const main = () => {
  const [command, path, provider, model, effort, baseUrl] = process.argv.slice(2)
  if (!command || !path || !provider || !model || !effort || !baseUrl) {
    fail("usage: config-manager.ts validate|repair PATH PROVIDER MODEL EFFORT BASE_URL")
  }

  if (command === "validate") {
    process.exit(validate(path, provider, model, effort, baseUrl) ? 0 : 1)
  }
  if (command === "repair") {
    repair(path, provider, model, effort, baseUrl)
    process.exit(0)
  }
  fail(`unknown command: ${command}`)
}

if (import.meta.main) {
  main()
}
