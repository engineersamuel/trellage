#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parse, stringify } from "smol-toml";

const fail = (message) => {
  process.stderr.write(`jcx config manager: ${message}\n`);
  process.exit(1);
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value, expected) => {
  if (!isRecord(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

const managedNamedProvider = (model, baseUrl) => ({
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
});

const parseConfig = (path) => parse(readFileSync(path, "utf8"));

const hasManagedProviderDefaults = (config, provider, model, effort) =>
  isRecord(config.provider) &&
  config.provider.default_provider === provider &&
  config.provider.default_model === model &&
  config.provider.openai_reasoning_effort === effort &&
  config.provider.cross_provider_failover === "manual";

const hasManagedNamedProvider = (providers, provider, model, baseUrl) => {
  if (!isRecord(providers) || !hasExactKeys(providers, [provider])) {
    return false;
  }
  const named = providers[provider];
  const expected = managedNamedProvider(model, baseUrl);
  if (!hasExactKeys(named, Object.keys(expected))) {
    return false;
  }
  const scalarValuesMatch = Object.entries(expected)
    .filter(([key]) => key !== "models")
    .every(([key, value]) => named[key] === value);
  return (
    scalarValuesMatch &&
    Array.isArray(named.models) &&
    named.models.length === 1 &&
    hasExactKeys(named.models[0], ["id"]) &&
    named.models[0].id === model
  );
};

const validate = (path, provider, model, effort, baseUrl) => {
  let config;
  try {
    config = parseConfig(path);
  } catch {
    return false;
  }
  return (
    isRecord(config) &&
    hasManagedProviderDefaults(config, provider, model, effort) &&
    hasManagedNamedProvider(config.providers, provider, model, baseUrl)
  );
};

const repair = (path, provider, model, effort, baseUrl) => {
  let config;
  try {
    config = parseConfig(path);
  } catch {
    config = {};
  }
  if (!isRecord(config)) {
    config = {};
  }
  const providerConfig = isRecord(config.provider) ? config.provider : {};
  config.provider = {
    ...providerConfig,
    default_provider: provider,
    default_model: model,
    openai_reasoning_effort: effort,
    cross_provider_failover: "manual",
  };
  config.providers = {
    [provider]: managedNamedProvider(model, baseUrl),
  };
  process.stdout.write(`${stringify(config).trimEnd()}\n`);
};

const [command, path, provider, model, effort, baseUrl] = process.argv.slice(2);
if (!command || !path || !provider || !model || !effort || !baseUrl) {
  fail("usage: config-manager.mjs validate|repair PATH PROVIDER MODEL EFFORT BASE_URL");
}

if (command === "validate") {
  process.exit(validate(path, provider, model, effort, baseUrl) ? 0 : 1);
}
if (command === "repair") {
  repair(path, provider, model, effort, baseUrl);
  process.exit(0);
}
fail(`unknown command: ${command}`);
