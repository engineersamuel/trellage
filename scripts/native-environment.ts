#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null

import os from "node:os"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { readEnvironmentSource } from "@trellage/runtime/native-environment"

export const resolveEnvironment = async () => {
  const home = os.homedir()
  const { path: configPath, present: configPresent, config } = await readTrellageConfig({ home })
  const decoded = config.environment
  const source = await readEnvironmentSource(decoded, { configPath, home, environment: process.env })

  return {
    config_path: configPath,
    config_present: configPresent,
    provider: decoded.provider,
    enabled: source.enabled,
    path: source.path,
    source_present: source.kind !== undefined,
    required: decoded.required,
    strict_permissions: decoded.strict_permissions,
  }
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await resolveEnvironment())}\n`)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    process.stderr.write(`trellage environment: ${detail}\n`)
    process.exitCode = 1
  }
}
