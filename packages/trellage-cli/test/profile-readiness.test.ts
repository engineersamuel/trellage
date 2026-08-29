import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { loadProfile, loadReleaseLock } from "../src/application.js"
import type { ProfileChoice } from "../src/profile-discovery.js"
import {
  resolveProfileLocked,
  resolveProfileReadiness,
  resolveProfilesLocked,
  resolveProfilesReadiness,
} from "../src/profile-readiness.js"
import { writeResolutionReceipt } from "../src/resolution-receipt.js"

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const fixtureProfile = path.join(repositoryRoot, "tests", "fixtures", "headless-live-claude", "profile.toml")

const baseChoice: ProfileChoice = {
  value: fixtureProfile,
  name: "headless-live-claude",
  description: "Exact Claude Code live fixture",
  supported_platforms: ["linux/arm64"],
  harness: { kind: "claude", version: "2.1.229", model: "claude-opus-5" },
  headlessRuntime: "claude-core",
  resolutionPolicy: "floating",
  skills: [],
  plugins: [],
  mcps: [],
}

const cacheWithReceipt = async (): Promise<string> => {
  const cache = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-readiness-"))
  const document = await Effect.runPromise(loadProfile(fixtureProfile))
  const release = await Effect.runPromise(loadReleaseLock(fixtureProfile, "linux/arm64"))
  if (release === undefined) throw new Error("fixture release lock is missing")
  await Effect.runPromise(writeResolutionReceipt(document, cache, release))
  return cache
}

describe("profile readiness", () => {
  it("distinguishes a release snapshot from local development resolution", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-readiness-empty-"))
    await expect(Effect.runPromise(resolveProfileReadiness(baseChoice, cache))).resolves.toEqual({
      resolutionPolicy: "floating",
      locallyResolved: false,
      releaseLockAvailable: true,
      locked: false,
      resolvedVersion: null,
    })
    await expect(Effect.runPromise(resolveProfileLocked(baseChoice, cache))).resolves.toBe(false)
  })

  it("reports the locally resolved harness version from the development receipt", async () => {
    const cache = await cacheWithReceipt()
    await expect(Effect.runPromise(resolveProfileReadiness(baseChoice, cache))).resolves.toEqual({
      resolutionPolicy: "floating",
      locallyResolved: true,
      releaseLockAvailable: true,
      locked: true,
      resolvedVersion: "2.1.229",
    })
  })

  it("reports unavailable when no production platform is supported", async () => {
    const choice = { ...baseChoice, supported_platforms: ["linux/amd64"] as const }
    await expect(Effect.runPromise(resolveProfileReadiness(choice))).resolves.toEqual({
      resolutionPolicy: "floating",
      locallyResolved: false,
      releaseLockAvailable: false,
      locked: false,
      resolvedVersion: null,
    })
  })

  it("degrades to unavailable instead of failing when the profile cannot be read", async () => {
    const choice = { ...baseChoice, value: path.join(repositoryRoot, "profiles", "does-not-exist", "profile.toml") }
    await expect(Effect.runPromise(resolveProfileReadiness(choice))).resolves.toEqual({
      resolutionPolicy: "floating",
      locallyResolved: false,
      releaseLockAvailable: false,
      locked: false,
      resolvedVersion: null,
    })
  })

  it("resolves local and release readiness for every choice in order", async () => {
    const cache = await cacheWithReceipt()
    const unreadable = { ...baseChoice, value: path.join(repositoryRoot, "profiles", "does-not-exist", "profile.toml") }
    const readiness = await Effect.runPromise(resolveProfilesReadiness([baseChoice, unreadable], cache))
    expect(readiness).toEqual([
      {
        resolutionPolicy: "floating",
        locallyResolved: true,
        releaseLockAvailable: true,
        locked: true,
        resolvedVersion: "2.1.229",
      },
      {
        resolutionPolicy: "floating",
        locallyResolved: false,
        releaseLockAvailable: false,
        locked: false,
        resolvedVersion: null,
      },
    ])

    await expect(Effect.runPromise(resolveProfilesLocked([baseChoice, unreadable], cache))).resolves.toEqual([
      true,
      false,
    ])
  })
})
