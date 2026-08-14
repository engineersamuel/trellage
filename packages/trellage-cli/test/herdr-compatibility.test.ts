import path from "node:path"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  containerHerdrCompatibility,
  loadHerdrCompatibilityLedger,
  nativeHerdrCompatibility,
} from "../src/herdr-compatibility.js"

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))

describe("herdr compatibility ledger", () => {
  it("loads docs/herdr-compatibility.json and reports verified/known-issue container entries", async () => {
    const ledger = await Effect.runPromise(loadHerdrCompatibilityLedger(repositoryRoot))
    expect(containerHerdrCompatibility(ledger, "claude-research")).toEqual({ status: "verified" })
    expect(containerHerdrCompatibility(ledger, "claude-blog")).toMatchObject({ status: "known-issue" })
    expect(containerHerdrCompatibility(ledger, "codex-superpowers")).toMatchObject({ status: "verified" })
  })

  it("reports untested for a container profile absent from the ledger", async () => {
    const ledger = await Effect.runPromise(loadHerdrCompatibilityLedger(repositoryRoot))
    expect(containerHerdrCompatibility(ledger, "does-not-exist")).toEqual({ status: "untested" })
  })

  it("looks up native launcher/profile entries independently of container entries", async () => {
    const ledger = await Effect.runPromise(loadHerdrCompatibilityLedger(repositoryRoot))
    expect(nativeHerdrCompatibility(ledger, "cldx", "default")).toEqual({ status: "verified" })
    expect(nativeHerdrCompatibility(ledger, "prx", "default")).toMatchObject({ status: "known-issue" })
    expect(nativeHerdrCompatibility(ledger, "cpx", "does-not-exist")).toEqual({ status: "untested" })
  })

  it("degrades to an empty ledger instead of failing when the file is missing", async () => {
    const ledger = await Effect.runPromise(loadHerdrCompatibilityLedger(path.join(repositoryRoot, "does-not-exist")))
    expect(containerHerdrCompatibility(ledger, "claude-research")).toEqual({ status: "untested" })
  })
})
