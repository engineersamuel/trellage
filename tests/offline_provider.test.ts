import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { assertLiveProviderAllowed } from "../packages/trellage-launcher/src/provider-isolation.ts"
import { createLiveCopilotClient, createLiveTypeSafeClient } from "../packages/trellage-launcher/src/provider-clients.ts"

const originalOffline = process.env.TRELLAGE_TEST_OFFLINE
const originalReceipt = process.env.TRELLAGE_TEST_VIOLATIONS
const directories: string[] = []
afterEach(() => {
  for (const [key, value] of Object.entries({
    TRELLAGE_TEST_OFFLINE: originalOffline,
    TRELLAGE_TEST_VIOLATIONS: originalReceipt,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("unexpected provider construction fails and leaves evidence even if caught", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "provider-isolation-"))
  directories.push(directory)
  const receipt = path.join(directory, "violations")
  process.env.TRELLAGE_TEST_OFFLINE = "1"
  process.env.TRELLAGE_TEST_VIOLATIONS = receipt
  expect(() => assertLiveProviderAllowed("Copilot")).toThrow("Unmocked Copilot provider in offline tests")
  expect(readFileSync(receipt, "utf8")).toContain("Copilot")
  expect(() => createLiveCopilotClient({})).toThrow("Unmocked Copilot provider")
  expect(() => createLiveTypeSafeClient({ apiKey: "canary-never-sent" })).toThrow("Unmocked TypeSafe provider")
  delete process.env.TRELLAGE_TEST_VIOLATIONS
  expect(() => assertLiveProviderAllowed("TypeSafe")).toThrow("Unmocked TypeSafe provider in offline tests")
})

test("normal production configuration is unaffected", () => {
  delete process.env.TRELLAGE_TEST_OFFLINE
  expect(() => assertLiveProviderAllowed("Copilot")).not.toThrow()
})
