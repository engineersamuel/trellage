#!/usr/bin/env node
import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Cause, Console, Effect, Option } from "effect"

import {
  buildProfile,
  compileProfileLock,
  loadProfile,
  profileMetadata,
  sanitizeNpmRegistry,
  upgradeProfile,
} from "./application.js"
import { environmentMetadata } from "./environment.js"
import { discoverProfileChoices } from "./profile-discovery.js"
import { selectProfilePath } from "./selection.js"

const execFilePromise = promisify(execFile)

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const runtimeSupport = {
  codexEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-entry.sh"),
  copilotEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-copilot-entry.sh"),
  piEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-pi-entry.sh"),
  finalizeCopilotSeed: path.join(repositoryRoot, "prototypes", "trellage", "finalize-copilot-seed.mjs"),
  finalizeClaudeSeed: path.join(repositoryRoot, "prototypes", "trellage", "finalize-claude-seed.mjs"),
  claudeEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-claude-entry.sh"),
  hyperresearchRequirements: path.join(
    repositoryRoot,
    "packages",
    "trellage-cli",
    "assets",
    "hyperresearch-requirements.lock",
  ),
  claudeBrowserAgent: path.join(
    repositoryRoot,
    "packages",
    "trellage-cli",
    "assets",
    "hyperresearch-browser-fetcher.md",
  ),
}
const bundledProfile = path.join(repositoryRoot, "profiles", "codex-superpowers", "profile.toml")
const bundledProfiles = path.join(repositoryRoot, "profiles")
const profileArgument = Args.text({ name: "profile" }).pipe(Args.optional)
const update = Options.boolean("update")
const locked = Options.boolean("locked")

const currentGitWorktree = (cwd: string) =>
  Effect.tryPromise({
    try: async () =>
      (await execFilePromise("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" })).stdout.trim(),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))

const selectedProfile = (argument: Option.Option<string>) =>
  Effect.gen(function* () {
    const cwd = process.cwd()
    const worktree = (yield* currentGitWorktree(cwd)) ?? cwd
    return yield* selectProfilePath({
      ...(Option.isSome(argument) ? { explicit: argument.value } : {}),
      ...(process.env.TRELLAGE_PROFILE ? { environment: process.env.TRELLAGE_PROFILE } : {}),
      cwd,
      worktree,
      home: os.homedir(),
      bundled: bundledProfile,
      profiles: bundledProfiles,
      exists: (candidate) =>
        Effect.tryPromise({
          try: async () => {
            await access(candidate)
            return true
          },
          catch: (cause) => cause,
        }).pipe(Effect.orElseSucceed(() => false)),
    })
  })

const cacheHome = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")

const configuredNpmRegistry = Effect.tryPromise({
  try: async () =>
    sanitizeNpmRegistry(
      (
        await execFilePromise("npm", ["config", "get", "registry"], {
          encoding: "utf8",
        })
      ).stdout,
    ),
  catch: () => undefined,
}).pipe(Effect.orElseSucceed(() => undefined))

const validate = Command.make("validate", { profile: profileArgument }, ({ profile }) =>
  selectedProfile(profile).pipe(
    Effect.flatMap(loadProfile),
    Effect.flatMap((document) => Console.log(`valid: ${document.path}`)),
  ),
)

const lock = Command.make("lock", { update, profile: profileArgument }, ({ profile, update: updateLock }) =>
  selectedProfile(profile).pipe(
    Effect.flatMap((selected) => compileProfileLock(selected, updateLock, cacheHome)),
    Effect.flatMap((result) => Console.log(`locked: ${result.profile_hash}`)),
  ),
)

const build = Command.make("build", { locked, profile: profileArgument }, ({ profile, locked: lockedBuild }) =>
  selectedProfile(profile).pipe(
    Effect.flatMap((selected) =>
      configuredNpmRegistry.pipe(
        Effect.flatMap((npmRegistry) =>
          buildProfile(selected, lockedBuild, cacheHome, runtimeSupport, undefined, npmRegistry),
        ),
      ),
    ),
    Effect.flatMap((result) => Console.log(`built: ${result.image} (${result.digest})`)),
  ),
)

const upgrade = Command.make("upgrade", { profile: profileArgument }, ({ profile }) =>
  selectedProfile(profile).pipe(
    Effect.flatMap((selected) => upgradeProfile(selected, cacheHome, runtimeSupport)),
    Effect.flatMap((result) => Console.log(`upgraded: ${result.image} (${result.digest})`)),
  ),
)

const metadata = Command.make("metadata", { profile: profileArgument }, ({ profile }) =>
  selectedProfile(profile).pipe(
    Effect.flatMap(profileMetadata),
    Effect.flatMap((result) => Console.log(JSON.stringify(result))),
  ),
)

const environment = Command.make("environment", {}, () =>
  environmentMetadata().pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result)))),
)

const choices = Command.make("choices", {}, () =>
  Effect.gen(function* () {
    const worktree = yield* currentGitWorktree(process.cwd())
    const result = yield* discoverProfileChoices({
      bundled: bundledProfiles,
      ...(worktree === undefined ? {} : { worktree: path.join(worktree, "profiles") }),
    })
    yield* Console.log(JSON.stringify(result))
  }),
)

const root = Command.make("trellage-profile", {}, () =>
  Console.log("Use validate, lock, build, upgrade, metadata, environment, or choices."),
).pipe(Command.withSubcommands([validate, lock, build, upgrade, metadata, environment, choices]))

const cli = Command.run(root, { name: "Trellage profile compiler", version: "0.1.0" })

export const formatCliCause = (cause: Cause.Cause<unknown>): string => {
  const messages = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0)
  return `trellage profile: ${messages.length === 0 ? Cause.pretty(cause) : messages.join("; ")}`
}

cli(process.argv).pipe(
  Effect.catchAllCause((cause) =>
    Console.error(formatCliCause(cause)).pipe(
      Effect.zipRight(
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
  ),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
