import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { parse } from "smol-toml"
import { Data, Effect } from "effect"

import type { Platform } from "./platform.js"
import { discoverPypiIndex, sanitizePypiIndex } from "./package-feeds.js"

const execFilePromise = promisify(execFile)

export type PythonConstraintInput =
  | { readonly kind: "project"; readonly path: string }
  | { readonly kind: "requirements"; readonly requirements: ReadonlyArray<string> }

export class PythonConstraintsError extends Data.TaggedError("PythonConstraintsError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface PythonConstraintServices {
  readonly discoverPypiIndex: typeof discoverPypiIndex
}

const validateRequirement = (requirement: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?$/.test(requirement)

const normalizePackageName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-")

const requirementName = (requirement: string): string | undefined => {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement.trim())
  return match?.[1] === undefined ? undefined : normalizePackageName(match[1])
}

const projectRequirements = async (projectPath: string): Promise<ReadonlyArray<string>> => {
  const value = parse(await readFile(projectPath, "utf8")) as {
    readonly project?: { readonly dependencies?: unknown }
  }
  const dependencies = value.project?.dependencies
  if (!Array.isArray(dependencies) || !dependencies.every((dependency) => typeof dependency === "string")) {
    throw new Error("Python project dependencies are missing")
  }
  const names = dependencies.map(requirementName)
  if (names.some((name) => name === undefined)) throw new Error("Python project dependency is invalid")
  return names as ReadonlyArray<string>
}

const validConstraintDocument = (content: string): boolean =>
  content.endsWith("\n") && !content.includes("file://") && !content.includes(" @ ") && !content.includes("--index-url")

const constraintHeaderName = (line: string): string | undefined => {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)(?:\s*[;\\]|$)/.exec(line)
  return match?.[1] === undefined ? undefined : normalizePackageName(match[1])
}

const constraintBlockHasHash = (lines: ReadonlyArray<string>): boolean =>
  lines.some((line) => /--hash=sha256:[0-9a-f]{64}/.test(line))

interface ConstraintState {
  readonly packages: Set<string>
  current?: Array<string>
}

const acceptConstraintLine = (state: ConstraintState, line: string): boolean => {
  const name = constraintHeaderName(line)
  if (name !== undefined) {
    if (state.current !== undefined && !constraintBlockHasHash(state.current)) return false
    if (state.packages.has(name)) return false
    state.packages.add(name)
    state.current = [line]
    return true
  }
  if (state.current === undefined || !/^\s+--hash=sha256:[0-9a-f]{64}(?:\s*\\)?$/.test(line)) return false
  state.current.push(line)
  return true
}

const constraintPackages = (content: string): ReadonlySet<string> | undefined => {
  if (!validConstraintDocument(content)) return undefined
  const state: ConstraintState = { packages: new Set<string>() }
  for (const line of content.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue
    if (!acceptConstraintLine(state, line)) return undefined
  }
  return state.current !== undefined && constraintBlockHasHash(state.current) && state.packages.size > 0
    ? state.packages
    : undefined
}

const validateConstraints = (content: string, requiredNames: ReadonlyArray<string>): boolean => {
  const packages = constraintPackages(content)
  return packages !== undefined && requiredNames.every((name) => packages.has(name))
}

const cleanIndexEnvironment = (index: string): NodeJS.ProcessEnv => {
  const environment = { ...process.env }
  for (const name of [
    "UV_DEFAULT_INDEX",
    "UV_INDEX",
    "UV_INDEX_URL",
    "UV_EXTRA_INDEX_URL",
    "PIP_INDEX_URL",
    "PIP_EXTRA_INDEX_URL",
    "UV_CONFIG_FILE",
    "PIP_CONFIG_FILE",
  ]) {
    delete environment[name]
  }
  environment.UV_DEFAULT_INDEX = index
  environment.PIP_INDEX_URL = index
  return environment
}

export const compilePythonConstraints = (
  request: {
    readonly cacheHome: string
    readonly input: PythonConstraintInput
    readonly uvVersion: string
    readonly pythonVersion: string
    readonly platform: Platform
    readonly npmRegistry?: string
    readonly pypiIndex?: string
  },
  services: PythonConstraintServices = { discoverPypiIndex },
): Effect.Effect<string, PythonConstraintsError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const parent = path.join(request.cacheHome, "trellage", "constraints", "staging")
        await mkdir(parent, { recursive: true })
        return mkdtemp(path.join(parent, "compile-"))
      },
      catch: (cause) => new PythonConstraintsError({ message: "cannot create Python constraint staging", cause }),
    }),
    (staging) =>
      Effect.tryPromise({
        try: async (signal) => {
          const input = request.input.kind === "project" ? request.input.path : path.join(staging, "requirements.in")
          let requiredNames: ReadonlyArray<string>
          if (request.input.kind === "requirements") {
            const requirements = [...new Set(request.input.requirements)].sort((left, right) =>
              left.localeCompare(right, "en"),
            )
            if (requirements.length === 0 || !requirements.every(validateRequirement)) {
              throw new Error("Python requirement input is invalid")
            }
            await writeFile(input, `${requirements.join("\n")}\n`, { flag: "wx" })
            requiredNames = requirements.map((requirement) => requirementName(requirement)!)
          } else {
            requiredNames = await projectRequirements(input)
          }
          const pypiIndex =
            sanitizePypiIndex(request.pypiIndex ?? "") ??
            (await services.discoverPypiIndex(
              request.npmRegistry === undefined ? {} : { npmRegistry: request.npmRegistry },
            ))
          if (pypiIndex === undefined) throw new Error("approved Python package index is unavailable")
          const output = path.join(staging, "constraints.txt")
          const pythonPlatform = request.platform === "linux/arm64" ? "aarch64-manylinux_2_28" : "x86_64-manylinux_2_28"
          await execFilePromise(
            "mise",
            [
              "x",
              `uv@${request.uvVersion}`,
              "--",
              "uv",
              "--no-config",
              "pip",
              "compile",
              "--prerelease",
              "disallow",
              "--refresh",
              "--generate-hashes",
              "--no-annotate",
              "--no-header",
              "--python-version",
              request.pythonVersion,
              "--python-platform",
              pythonPlatform,
              "--default-index",
              pypiIndex,
              "--output-file",
              output,
              input,
            ],
            {
              encoding: "utf8",
              maxBuffer: 32 * 1024 * 1024,
              signal,
              env: cleanIndexEnvironment(pypiIndex),
            },
          )
          const content = await readFile(output, "utf8")
          if (!validateConstraints(content, requiredNames)) {
            throw new Error("generated Python constraints are invalid")
          }
          return content
        },
        catch: (cause) =>
          new PythonConstraintsError({
            message: `cannot generate Python constraints: ${String(
              (cause as { readonly message?: unknown }).message ?? cause,
            )}`,
            cause,
          }),
      }),
    (staging) => Effect.promise(() => rm(staging, { recursive: true, force: true })).pipe(Effect.orDie),
  )
