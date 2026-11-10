import { afterEach, expect, test } from "bun:test"
import { chmod, writeFile } from "node:fs/promises"
import path from "node:path"
import type { EnvironmentConfig } from "@trellage/runtime/native-config"
import {
  CentralEnvironmentError,
  readCentralEnvironment,
  type CentralEnvironmentRequest,
} from "@trellage/runtime/native-environment"
import { cleanupFixtures, tempRoot } from "./native-run/fixtures.ts"

afterEach(cleanupFixtures)

const source = async (files: Record<string, string>, mode = 0o700): Promise<string> => {
  const directory = await tempRoot("central-source")
  await chmod(directory, mode)
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(directory, name), content, { mode: 0o600 })
  return directory
}

const settings = (directory: string, overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig => ({
  provider: "varlock",
  enabled: true,
  path: directory,
  required: false,
  strict_permissions: true,
  inject: [],
  ...overrides,
})

const request = (
  directory: string,
  names: string[],
  overrides: Partial<CentralEnvironmentRequest> = {},
): CentralEnvironmentRequest => ({
  names,
  settings: settings(directory),
  configPath: path.join(directory, "config.toml"),
  home: directory,
  environment: { HOME: directory, PATH: process.env.PATH ?? "" },
  ...overrides,
})

test("resolves only the requested names and ignores everything else in the source", async () => {
  const directory = await source({ ".env.local": "CONTEXT7_API_KEY=fixture-context\nOTHER_SECRET=fixture-other\n" })
  const result = await readCentralEnvironment(request(directory, ["CONTEXT7_API_KEY", "ABSENT_NAME", "bad-name"]))
  expect(result).toEqual({ values: { CONTEXT7_API_KEY: "fixture-context" }, warnings: [] })
})

test("an empty process variable does not hide the central value", async () => {
  const directory = await source({ ".env.local": "CONTEXT7_API_KEY=fixture-context\n" })
  const environment = { HOME: directory, PATH: process.env.PATH ?? "", CONTEXT7_API_KEY: "" }
  const result = await readCentralEnvironment(request(directory, ["CONTEXT7_API_KEY"], { environment }))
  expect(result.values).toEqual({ CONTEXT7_API_KEY: "fixture-context" })
})

test("starts nothing when no name is requested or the central environment is off", async () => {
  const directory = await source({ ".env.local": "CONTEXT7_API_KEY=fixture-context\n" })
  // Starting Varlock from this root would fail and warn, so empty warnings prove it never started.
  const unusable = { sourceRoot: path.join(directory, "missing") }
  const environment = { HOME: directory, PATH: process.env.PATH ?? "", TRELLAGE_ENVIRONMENT: "off" }
  const nothing = { values: {}, warnings: [] }
  const control = await readCentralEnvironment(request(directory, ["CONTEXT7_API_KEY"], unusable))
  expect(control.warnings).toEqual([expect.stringContaining("Central environment unavailable")])
  expect(await readCentralEnvironment(request(directory, [], unusable))).toEqual(nothing)
  expect(
    await readCentralEnvironment(
      request(directory, ["CONTEXT7_API_KEY"], { ...unusable, settings: settings(directory, { enabled: false }) }),
    ),
  ).toEqual(nothing)
  expect(await readCentralEnvironment(request(directory, ["CONTEXT7_API_KEY"], { ...unusable, environment }))).toEqual(
    nothing,
  )
})

test("an unsafe or broken source only warns, without echoing its content, unless it is required", async () => {
  const open = await source({ ".env.local": "CONTEXT7_API_KEY=fixture-context\n" }, 0o755)
  const unsafe = await readCentralEnvironment(request(open, ["CONTEXT7_API_KEY"]))
  expect(unsafe.values).toEqual({})
  expect(unsafe.warnings).toEqual([expect.stringContaining("must not be accessible by group or other users")])
  await expect(
    readCentralEnvironment(request(open, ["CONTEXT7_API_KEY"], { settings: settings(open, { required: true }) })),
  ).rejects.toBeInstanceOf(CentralEnvironmentError)

  const broken = await source({ ".env.local": "CONTEXT7_API_KEY=fixture-context\nnot a valid line (\n" })
  const failed = await readCentralEnvironment(request(broken, ["CONTEXT7_API_KEY"]))
  expect(failed.values).toEqual({})
  expect(failed.warnings).toHaveLength(1)
  expect(failed.warnings[0]).toStartWith("Central environment unavailable: Varlock could not load the environment")
  expect(failed.warnings[0]).not.toContain("fixture-context")
})

test("a required source must exist even when nothing is requested", async () => {
  const directory = await source({})
  const missing = settings(path.join(directory, "absent"), { required: true })
  await expect(readCentralEnvironment(request(directory, [], { settings: missing }))).rejects.toThrow(
    "required Varlock environment path does not exist",
  )
})
