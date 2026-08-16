import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  conservativeHeadlessCapabilitiesV1,
  decodeHeadlessCapabilitiesV1,
  resolveSandboxHeadlessCapabilities,
  sandboxHeadlessRuntimeAdapter,
} from "../src/headless-capabilities.js"
import { parseProfile } from "../src/profile.js"

const researchProfilePath = fileURLToPath(new URL("../../../profiles/claude-research/profile.toml", import.meta.url))
const marketplaceProfilePath = fileURLToPath(new URL("../../../profiles/claude-blog/profile.toml", import.meta.url))
const qwenProfilePath = fileURLToPath(new URL("../../../profiles/claude-qwen-local/profile.toml", import.meta.url))

describe("headless capability contract", () => {
  it("accepts the canonical V1 capability object with exact keys", async () => {
    const capabilities = resolveSandboxHeadlessCapabilities("claude-hyperresearch", "2.1.229")

    await expect(Effect.runPromise(decodeHeadlessCapabilitiesV1(capabilities))).resolves.toEqual(capabilities)
    expect(Object.keys(capabilities).sort()).toEqual([
      "changedFiles",
      "cost",
      "effortOverride",
      "eventContract",
      "modelOverride",
      "outputFormats",
      "prompt",
      "questionToolControl",
      "resume",
      "resumeWithPrompt",
      "schemaVersion",
      "sessionId",
      "testedHarnessVersion",
      "trellageEventContract",
      "usage",
    ])
  })

  it("rejects duplicate output formats and unexpected keys", async () => {
    const capabilities = resolveSandboxHeadlessCapabilities("claude-marketplace", "2.1.229")

    await expect(
      Effect.runPromise(
        decodeHeadlessCapabilitiesV1({
          ...capabilities,
          outputFormats: ["text", "text"],
        }),
      ),
    ).rejects.toThrow(/outputFormats/i)
    await expect(
      Effect.runPromise(
        decodeHeadlessCapabilitiesV1({
          ...capabilities,
          extra: true,
        }),
      ),
    ).rejects.toThrow(/unexpected|extra|excess/i)
    await expect(
      Effect.runPromise(
        decodeHeadlessCapabilitiesV1({
          ...capabilities,
          eventContract: "",
        }),
      ),
    ).rejects.toThrow(/eventContract|minLength/i)
  })

  it("fails closed on harness version drift while keeping the proven version marker", () => {
    expect(resolveSandboxHeadlessCapabilities("claude-marketplace", "2.1.234")).toEqual({
      ...conservativeHeadlessCapabilitiesV1,
      testedHarnessVersion: "2.1.229",
    })
  })

  it.each([
    ["codex", "0.147.0"],
    ["copilot", "1.0.80"],
    ["pi", "17.3.4"],
    ["prime", "0.7.2"],
  ] as const)("keeps the unverified %s adapter conservative even at current locked version %s", (adapter, version) => {
    expect(resolveSandboxHeadlessCapabilities(adapter, version)).toEqual(conservativeHeadlessCapabilitiesV1)
  })

  it("keeps the unverified Codex adapter conservative when no resolved version is available", () => {
    expect(resolveSandboxHeadlessCapabilities("codex", null)).toEqual(conservativeHeadlessCapabilitiesV1)
  })

  it("publishes the verified Claude bridge contract only for the proven 2.1.229 runtime", () => {
    expect(resolveSandboxHeadlessCapabilities("claude-marketplace", "2.1.229")).toMatchObject({
      outputFormats: ["text", "jsonl"],
      eventContract: "claude-stream-json-v1",
      trellageEventContract: "trellage-headless-v1",
      changedFiles: "git-diff",
      testedHarnessVersion: "2.1.229",
    })
    expect(resolveSandboxHeadlessCapabilities("claude-marketplace", "2.1.233")).toEqual({
      ...conservativeHeadlessCapabilitiesV1,
      testedHarnessVersion: "2.1.229",
    })
  })

  it("maps parsed Sandbox profiles to runtime adapters without a profile-name allowlist", async () => {
    const [researchSource, marketplaceSource, qwenSource] = await Promise.all([
      readFile(researchProfilePath, "utf8"),
      readFile(marketplaceProfilePath, "utf8"),
      readFile(qwenProfilePath, "utf8"),
    ])
    const [research, marketplace, qwen] = await Promise.all([
      Effect.runPromise(parseProfile(researchSource, researchProfilePath)),
      Effect.runPromise(parseProfile(marketplaceSource, marketplaceProfilePath)),
      Effect.runPromise(parseProfile(qwenSource, qwenProfilePath)),
    ])

    expect(sandboxHeadlessRuntimeAdapter(research.profile)).toBe("claude-hyperresearch")
    expect(sandboxHeadlessRuntimeAdapter(marketplace.profile)).toBe("claude-marketplace")
    expect(sandboxHeadlessRuntimeAdapter(qwen.profile)).toBe("claude-core")
    expect(resolveSandboxHeadlessCapabilities("claude-core", "2.1.229").modelOverride).toBe(false)
  })
})
