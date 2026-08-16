import path from "node:path"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  resolveProfileLocked,
  resolveProfileReadiness,
  resolveProfilesLocked,
  resolveProfilesReadiness,
} from "../src/profile-readiness.js"
import type { ProfileChoice } from "../src/profile-discovery.js"

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))

const baseChoice: ProfileChoice = {
  value: path.join(repositoryRoot, "profiles", "copilot-hve", "profile.toml"),
  name: "copilot-hve",
  description: "GitHub Copilot with Microsoft HVE Core",
  supported_platforms: ["linux/arm64"],
  harness: { kind: "copilot", version: "latest" },
  headlessRuntime: "copilot",
  skills: [],
  plugins: [],
  mcps: [],
}

describe("resolveProfileLocked", () => {
  it("reports locked and the resolved harness version when a committed profile has a current production lock", async () => {
    const readiness = await Effect.runPromise(resolveProfileReadiness(baseChoice))
    expect(readiness).toEqual({ locked: true, resolvedVersion: "1.0.80" })

    const locked = await Effect.runPromise(resolveProfileLocked(baseChoice))
    expect(locked).toBe(true)
  })

  it("reports not locked when no production platform is supported", async () => {
    const choice = { ...baseChoice, supported_platforms: ["linux/amd64"] as const }
    const locked = await Effect.runPromise(resolveProfileLocked(choice))
    expect(locked).toBe(false)
  })

  it("degrades to not locked instead of failing when the profile cannot be read", async () => {
    const choice = { ...baseChoice, value: path.join(repositoryRoot, "profiles", "does-not-exist", "profile.toml") }
    const readiness = await Effect.runPromise(resolveProfileReadiness(choice))
    expect(readiness).toEqual({ locked: false, resolvedVersion: null })

    const locked = await Effect.runPromise(resolveProfileLocked(choice))
    expect(locked).toBe(false)
  })

  it("resolves readiness for every choice in order", async () => {
    const unreadable = { ...baseChoice, value: path.join(repositoryRoot, "profiles", "does-not-exist", "profile.toml") }
    const readiness = await Effect.runPromise(resolveProfilesReadiness([baseChoice, unreadable]))
    expect(readiness).toEqual([
      { locked: true, resolvedVersion: "1.0.80" },
      { locked: false, resolvedVersion: null },
    ])

    const locked = await Effect.runPromise(resolveProfilesLocked([baseChoice, unreadable]))
    expect(locked).toEqual([true, false])
  })
})
