#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null

import { lstat, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expandTrellagePath, readTrellageConfig } from "@trellage/runtime/native-config"

const schemaOnlyFiles = new Set([".env.schema", ".env.example", ".env.sample", ".env.template"])

function fail(message: string): never {
  throw new Error(message)
}

const isMissing = (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
const isEnvironmentFile = (name: string) => name === ".env" || name.startsWith(".env.")

const assertSafePath = async (
  candidate: string,
  label: string,
  strictPermissions: boolean,
  allowPublicRead: boolean,
) => {
  const stats = await lstat(candidate)
  if (stats.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${candidate}`)
  if (!stats.isFile() && !stats.isDirectory()) fail(`${label} is not a file or directory: ${candidate}`)
  if ((stats.mode & 0o022) !== 0) fail(`${label} must not be writable by group or other users: ${candidate}`)
  if (strictPermissions && !allowPublicRead && (stats.mode & 0o077) !== 0) {
    fail(`${label} must not be accessible by group or other users: ${candidate}`)
  }
}

const inspectEnvironmentSource = async (candidate: string, required: boolean, strictPermissions: boolean) => {
  let stats
  try {
    stats = await lstat(candidate)
  } catch (cause) {
    if (!isMissing(cause)) fail(`cannot inspect Varlock environment path: ${candidate}`)
  }
  if (stats === undefined) {
    if (required) fail(`required Varlock environment path does not exist: ${candidate}`)
    return false
  }

  if (stats.isFile()) {
    await assertSafePath(
      candidate,
      "Varlock environment file",
      strictPermissions,
      schemaOnlyFiles.has(path.basename(candidate)),
    )
    return true
  }
  await assertSafePath(candidate, "Varlock environment directory", strictPermissions, false)

  let entries
  try {
    entries = await readdir(candidate, { withFileTypes: true })
  } catch {
    fail(`cannot read Varlock environment directory: ${candidate}`)
  }
  const environmentFiles = entries.filter((entry) => isEnvironmentFile(entry.name))
  if (environmentFiles.length === 0) {
    if (required) fail(`required Varlock environment directory has no .env files: ${candidate}`)
    return false
  }
  for (const entry of environmentFiles) {
    const entryPath = path.join(candidate, entry.name)
    if (!entry.isFile()) fail(`Varlock environment entry must be a regular file: ${entryPath}`)
    await assertSafePath(entryPath, "Varlock environment file", strictPermissions, schemaOnlyFiles.has(entry.name))
  }
  return true
}

const resolveEnabled = (configured: boolean) => {
  const override = process.env.TRELLAGE_ENVIRONMENT
  if (override !== undefined && override !== "on" && override !== "off") {
    fail("TRELLAGE_ENVIRONMENT must be on or off")
  }
  return override === undefined ? configured : override === "on"
}

export const resolveEnvironment = async () => {
  const home = os.homedir()
  const { path: configPath, present: configPresent, config } = await readTrellageConfig({ home })
  const decoded = config.environment
  const enabled = resolveEnabled(decoded.enabled)
  const configuredPath = decoded.path ?? path.dirname(configPath)
  const environmentPath = expandTrellagePath(configuredPath, home, path.dirname(configPath))
  const sourcePresent = enabled
    ? await inspectEnvironmentSource(environmentPath, decoded.required, decoded.strict_permissions)
    : false

  return {
    config_path: configPath,
    config_present: configPresent,
    provider: decoded.provider,
    enabled,
    path: environmentPath,
    source_present: sourcePresent,
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
