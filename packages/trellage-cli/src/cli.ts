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
  ApplicationError,
  buildProfile,
  loadProfile,
  profileMetadata,
  sanitizeNpmRegistry,
  snapshotProfileReleaseLock,
  upgradeProfile,
  verifyProfile,
} from "./application.js"
import { environmentMetadata } from "./environment.js"
import { discoverProfileChoices } from "./profile-discovery.js"
import { resolveSandboxHeadlessCapabilities } from "./headless-capabilities.js"
import { formatProfileListHuman, toFullList, toSimplifiedList } from "./profile-list.js"
import { loadSandboxProfileGuides } from "./profile-guides.js"
import { resolveProfilesReadiness } from "./profile-readiness.js"
import { containerHerdrCompatibility, loadHerdrCompatibilityLedger } from "./herdr-compatibility.js"
import { selectProfilePath } from "./selection.js"
import { captureDockerTarget, type DockerTarget } from "./docker-target.js"
import { assertProductionPlatform, type Platform } from "./platform.js"
import { resolveProfileReference, type ProfileReferenceMode } from "./profile-reference.js"

const execFilePromise = promisify(execFile)

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const runtimeSupport = {
  codexEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-entry.sh"),
  copilotEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-copilot-entry.sh"),
  headlongEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-headlong-entry.sh"),
  piEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-pi-entry.sh"),
  primeEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-prime-entry.sh"),
  finalizeCopilotSeed: path.join(repositoryRoot, "prototypes", "trellage", "finalize-copilot-seed.mjs"),
  finalizeClaudeSeed: path.join(repositoryRoot, "prototypes", "trellage", "finalize-claude-seed.mjs"),
  claudeEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-claude-entry.sh"),
  claudeBrowserAgent: path.join(
    repositoryRoot,
    "packages",
    "trellage-cli",
    "assets",
    "hyperresearch-browser-fetcher.md",
  ),
  claudeOutputStyleRundown: path.join(repositoryRoot, "prototypes", "trellage", "assets", "rundown", "rundown.md"),
  copilotInstructionRundown: path.join(
    repositoryRoot,
    "prototypes",
    "trellage",
    "assets",
    "rundown",
    "rundown.instructions.md",
  ),
}
const bundledProfile = path.join(repositoryRoot, "profiles", "codex-superpowers", "profile.toml")
const bundledProfiles = path.join(repositoryRoot, "profiles")
const profileArgument = Args.text({ name: "profile" }).pipe(Args.optional)
const update = Options.boolean("update")
const locked = Options.boolean("locked")
const json = Options.boolean("json").pipe(Options.withDefault(false))
const jsonFull = Options.boolean("json-full").pipe(Options.withDefault(false))
const full = Options.boolean("full").pipe(Options.withDefault(false))

const currentGitWorktree = (cwd: string) =>
  Effect.tryPromise({
    try: async () =>
      (await execFilePromise("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" })).stdout.trim(),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))

const profileDiscoveryRoots = (worktree: string | undefined) => ({
  bundled: bundledProfiles,
  ...(worktree === undefined ? {} : { worktree: path.join(worktree, "profiles") }),
})

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

const withDockerTarget = <A, E>(operation: (target: DockerTarget) => Effect.Effect<A, E>) =>
  captureDockerTarget().pipe(
    Effect.flatMap((target) => assertProductionPlatform(target.platform).pipe(Effect.zipRight(operation(target)))),
  )

const selectedResolvedProfile = (
  argument: Option.Option<string>,
  platform: Platform,
  mode: ProfileReferenceMode = "development",
) =>
  selectedProfile(argument).pipe(
    Effect.flatMap((reference) => resolveProfileReference(reference, platform, cacheHome, mode)),
  )

const validate = Command.make("validate", { profile: profileArgument }, ({ profile }) =>
  withDockerTarget((target) =>
    selectedResolvedProfile(profile, target.platform).pipe(
      Effect.flatMap(loadProfile),
      Effect.flatMap((document) => Console.log(`valid: ${document.path}`)),
    ),
  ),
)

const lock = Command.make("lock", { update, profile: profileArgument }, ({ profile, update: updateLock }) =>
  withDockerTarget((target) =>
    selectedResolvedProfile(profile, target.platform).pipe(
      Effect.flatMap((selected) =>
        configuredNpmRegistry.pipe(
          Effect.flatMap((npmRegistry) =>
            snapshotProfileReleaseLock(selected, updateLock, cacheHome, target.platform, npmRegistry),
          ),
        ),
      ),
      Effect.flatMap((result) => Console.log(`release lock: ${result.profile_hash} (${target.platform})`)),
    ),
  ),
)

const build = Command.make("build", { locked, profile: profileArgument }, ({ profile, locked: lockedBuild }) =>
  withDockerTarget((target) =>
    selectedResolvedProfile(profile, target.platform, lockedBuild ? "release" : "development").pipe(
      Effect.flatMap((selected) =>
        configuredNpmRegistry.pipe(
          Effect.flatMap((npmRegistry) =>
            buildProfile(selected, lockedBuild, cacheHome, runtimeSupport, target, undefined, npmRegistry),
          ),
        ),
      ),
      Effect.flatMap((result) => Console.log(`built: ${result.image} (${result.digest})`)),
    ),
  ),
)

const reportUpgradeFallbacks = (fallbacks: ReadonlyArray<string>) =>
  Effect.forEach(fallbacks, (fallback) => Console.log(`upgrade fallback: ${fallback}`), {
    concurrency: 1,
    discard: true,
  })

const upgradeAllProfiles = (target: DockerTarget, npmRegistry?: string) =>
  Effect.gen(function* () {
    const worktree = yield* currentGitWorktree(process.cwd())
    const profiles = yield* discoverProfileChoices(profileDiscoveryRoots(worktree)).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    if (profiles.length === 0) {
      return yield* Effect.fail(new ApplicationError({ message: "no valid profiles found to upgrade" }))
    }

    const results = yield* Effect.forEach(
      profiles,
      (profile) =>
        upgradeProfile(profile.value, cacheHome, runtimeSupport, target, undefined, npmRegistry).pipe(
          Effect.tap((result) => reportUpgradeFallbacks(result.fallbacks)),
          Effect.tap((result) => Console.log(`upgraded: ${profile.name} (${result.digest})`)),
          Effect.match({
            onFailure: (cause) => ({ profile, cause }),
            onSuccess: () => undefined,
          }),
        ),
      { concurrency: 1 },
    )
    const failures = results.filter((result) => result !== undefined)
    for (const failure of failures) {
      yield* Console.error(`upgrade failed: ${failure.profile.name}: ${failure.cause.message}`)
    }
    if (failures.length > 0) {
      return yield* Effect.fail(
        new ApplicationError({
          message: `${failures.length}/${profiles.length} profile upgrades failed: ${failures
            .map(({ profile }) => profile.name)
            .join(", ")}`,
        }),
      )
    }
    return yield* Effect.void
  })

const upgrade = Command.make("upgrade", { profile: profileArgument }, ({ profile }) =>
  Option.isSome(profile) && profile.value === "all"
    ? withDockerTarget((target) =>
        configuredNpmRegistry.pipe(Effect.flatMap((npmRegistry) => upgradeAllProfiles(target, npmRegistry))),
      )
    : withDockerTarget((target) =>
        selectedResolvedProfile(profile, target.platform).pipe(
          Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
          Effect.flatMap((selected) =>
            configuredNpmRegistry.pipe(
              Effect.flatMap((npmRegistry) =>
                upgradeProfile(selected, cacheHome, runtimeSupport, target, undefined, npmRegistry),
              ),
            ),
          ),
          Effect.tap((result) => reportUpgradeFallbacks(result.fallbacks)),
          Effect.flatMap((result) => Console.log(`upgraded: ${result.image} (${result.digest})`)),
        ),
      ),
)

const list = Command.make("list", { json, jsonFull, full }, ({ json: asJson, jsonFull: asJsonFull, full: asFull }) =>
  Effect.gen(function* () {
    if (asJson && asJsonFull) {
      return yield* Effect.fail(
        new ApplicationError({ message: "list: --json and --json-full are mutually exclusive" }),
      )
    }
    if (asFull && asJsonFull) {
      return yield* Effect.fail(
        new ApplicationError({ message: "list: --full and --json-full are mutually exclusive" }),
      )
    }
    if (asFull && !asJson) {
      return yield* Effect.fail(new ApplicationError({ message: "list: --full requires --json" }))
    }
    const worktree = yield* currentGitWorktree(process.cwd())
    const choices = yield* discoverProfileChoices(profileDiscoveryRoots(worktree)).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    if (asJson && !asFull) {
      const guides = yield* loadSandboxProfileGuides(repositoryRoot, choices).pipe(
        Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
      )
      return yield* Console.log(JSON.stringify(toSimplifiedList(choices, guides)))
    }
    if (asJsonFull || asFull) {
      const guides = yield* loadSandboxProfileGuides(repositoryRoot, choices).pipe(
        Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
      )
      const readiness = yield* resolveProfilesReadiness(choices, cacheHome)
      const ledger = yield* loadHerdrCompatibilityLedger(repositoryRoot)
      const herdrCompatibility = choices.map((choice) => containerHerdrCompatibility(ledger, choice.name))
      return yield* Console.log(JSON.stringify(toFullList(choices, guides, readiness, herdrCompatibility)))
    }
    const human = formatProfileListHuman(choices)
    if (human.length > 0) {
      return yield* Console.log(human)
    }
    return yield* Effect.void
  }),
)

const metadata = Command.make("metadata", { profile: profileArgument }, ({ profile }) =>
  withDockerTarget((target) =>
    selectedResolvedProfile(profile, target.platform).pipe(
      Effect.flatMap((selected) => profileMetadata(selected, target.platform, cacheHome)),
      Effect.flatMap((result) => Console.log(JSON.stringify(result))),
    ),
  ),
)

const ciVerify = Command.make("ci-verify", { profile: profileArgument }, ({ profile }) =>
  withDockerTarget((target) =>
    selectedResolvedProfile(profile, target.platform, "release").pipe(
      Effect.flatMap((selected) => verifyProfile(selected, target.platform)),
      Effect.flatMap((result) =>
        Console.log(
          result.digest === null
            ? `verified: ${result.image} (core lock; floating skills)`
            : `verified: ${result.image} (${result.digest})`,
        ),
      ),
    ),
  ),
)

const environment = Command.make("environment", {}, () =>
  environmentMetadata().pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result)))),
)

const choices = Command.make("choices", {}, () =>
  Effect.gen(function* () {
    const worktree = yield* currentGitWorktree(process.cwd())
    const profiles = yield* discoverProfileChoices(profileDiscoveryRoots(worktree))
    const readiness = yield* resolveProfilesReadiness(profiles, cacheHome)
    const result = profiles.map((profile, index) => ({
      ...profile,
      headless: resolveSandboxHeadlessCapabilities(profile.headlessRuntime, readiness[index]?.resolvedVersion ?? null),
    }))
    yield* Console.log(JSON.stringify(result))
  }),
)

const root = Command.make("trellage-profile", {}, () =>
  Console.log("Use validate, lock, build, upgrade, ci-verify, metadata, environment, choices, or list."),
).pipe(Command.withSubcommands([validate, lock, build, upgrade, ciVerify, list, metadata, environment, choices]))

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
