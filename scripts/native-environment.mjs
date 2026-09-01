#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { parse } from "smol-toml"

const allowedKeys = new Set(["provider", "enabled", "path", "required", "strict_permissions"])
const schemaOnlyFiles = new Set([".env.schema", ".env.example", ".env.sample", ".env.template"])

const fail = (message) => {
  throw new Error(message)
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const isMissing = (cause) => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
const isEnvironmentFile = (name) => name === ".env" || name.startsWith(".env.")

const expandPath = (candidate, home, base) => {
  if (candidate === "~") return home
  if (candidate.startsWith("~/")) return path.join(home, candidate.slice(2))
  return path.resolve(base, candidate)
}

const assertSafePath = async (candidate, label, strictPermissions, allowPublicRead) => {
  const stats = await lstat(candidate)
  if (stats.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${candidate}`)
  if (!stats.isFile() && !stats.isDirectory()) fail(`${label} is not a file or directory: ${candidate}`)
  if ((stats.mode & 0o022) !== 0) fail(`${label} must not be writable by group or other users: ${candidate}`)
  if (strictPermissions && !allowPublicRead && (stats.mode & 0o077) !== 0) {
    fail(`${label} must not be accessible by group or other users: ${candidate}`)
  }
}

const inspectEnvironmentSource = async (candidate, required, strictPermissions) => {
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
    await assertSafePath(
      entryPath,
      "Varlock environment file",
      strictPermissions,
      schemaOnlyFiles.has(entry.name),
    )
  }
  return true
}

const decodeEnvironment = (raw) => {
  if (!isRecord(raw)) fail("invalid [environment] configuration: expected an object")
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`invalid [environment] configuration: unknown key ${key}`)
  }

  const provider = raw.provider ?? "varlock"
  const enabled = raw.enabled ?? true
  const configuredPath = raw.path
  const required = raw.required ?? false
  const strictPermissions = raw.strict_permissions ?? true

  if (provider !== "varlock") fail("invalid [environment] configuration: provider must be varlock")
  if (typeof enabled !== "boolean") fail("invalid [environment] configuration: enabled must be a boolean")
  if (configuredPath !== undefined && (typeof configuredPath !== "string" || configuredPath.length === 0)) {
    fail("invalid [environment] configuration: path must be a nonempty string")
  }
  if (typeof required !== "boolean") fail("invalid [environment] configuration: required must be a boolean")
  if (typeof strictPermissions !== "boolean") {
    fail("invalid [environment] configuration: strict_permissions must be a boolean")
  }

  return { provider, enabled, path: configuredPath, required, strict_permissions: strictPermissions }
}

const loadEnvironmentConfig = async (configPath) => {
  let configStats
  try {
    configStats = await lstat(configPath)
  } catch (cause) {
    if (!isMissing(cause)) fail(`cannot inspect Trellage config: ${configPath}`)
  }
  const configPresent = configStats !== undefined

  if (!configPresent) return { configPresent, decoded: decodeEnvironment({}) }

  await assertSafePath(configPath, "Trellage config", false, true)
  let source
  try {
    source = await readFile(configPath, "utf8")
  } catch {
    fail(`cannot read Trellage config: ${configPath}`)
  }
  let raw
  try {
    raw = parse(source)
  } catch (cause) {
    fail(`invalid Trellage config: ${String(cause)}`)
  }
  const environment = isRecord(raw) && Object.hasOwn(raw, "environment") ? raw.environment : {}
  return { configPresent, decoded: decodeEnvironment(environment) }
}

const resolveEnabled = (configured) => {
  const override = process.env.TRELLAGE_ENVIRONMENT
  if (override !== undefined && override !== "on" && override !== "off") {
    fail("TRELLAGE_ENVIRONMENT must be on or off")
  }
  return override === undefined ? configured : override === "on"
}

const resolveEnvironment = async () => {
  const home = os.homedir()
  const configDirectory = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME, "trellage")
    : path.join(home, ".config", "trellage")
  const configPath = process.env.TRELLAGE_CONFIG
    ? expandPath(process.env.TRELLAGE_CONFIG, home, process.cwd())
    : path.join(configDirectory, "config.toml")
  const { configPresent, decoded } = await loadEnvironmentConfig(configPath)
  const enabled = resolveEnabled(decoded.enabled)
  const configuredPath = decoded.path ?? path.dirname(configPath)
  const environmentPath = expandPath(configuredPath, home, path.dirname(configPath))
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

try {
  process.stdout.write(`${JSON.stringify(await resolveEnvironment())}\n`)
} catch (cause) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  process.stderr.write(`trellage environment: ${detail}\n`)
  process.exitCode = 1
}
