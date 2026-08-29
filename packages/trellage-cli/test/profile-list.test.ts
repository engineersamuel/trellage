import { describe, expect, it } from "vitest"

import { resolveSandboxHeadlessCapabilities } from "../src/headless-capabilities.js"
import type { ProfileChoice } from "../src/profile-discovery.js"
import { formatProfileListHuman, toFullList, toSimplifiedList } from "../src/profile-list.js"

const guide = {
  schemaVersion: 1 as const,
  capabilities: ["delivery"],
  bestFor: ["Repository delivery"],
  avoidFor: ["Unrelated content work"],
  prerequisites: [],
  workflows: [
    {
      id: "deliver",
      description: "Deliver repository work",
      examples: ["Build the feature", "Fix the bug", "Review the change"],
      promptTemplate: "{{intent}}",
    },
  ],
}

const sample = (
  overrides: Partial<ProfileChoice> & Pick<ProfileChoice, "name" | "description" | "value">,
): ProfileChoice => ({
  supported_platforms: ["linux/arm64"],
  harness: { kind: "codex", version: "latest", model: "gpt-5.6-sol" },
  headlessRuntime: "codex",
  skillBundles: ["sandbox-common"],
  skillsMode: "floating",
  skills: [],
  plugins: [
    {
      adapter: "codex-native",
      repository: "https://github.com/example/plugins.git",
      ref: "v2",
      select: ["b"],
    },
  ],
  mcps: [],
  ...overrides,
})

describe("profile list DTOs", () => {
  it("projects simplified JSON with name, description, and sandbox", () => {
    const choices = [
      sample({ name: "beta", description: "Beta blurb", value: "/p/beta/profile.toml" }),
      sample({ name: "alpha", description: "Alpha blurb", value: "/p/alpha/profile.toml" }),
    ]
    expect(toSimplifiedList(choices, [guide, guide])).toEqual({
      schemaVersion: 1,
      profiles: [
        { name: "beta", description: "Beta blurb", guide, sandbox: true },
        { name: "alpha", description: "Alpha blurb", guide, sandbox: true },
      ],
    })
  })

  it("projects full JSON with camelCase inventory keys and path from value", () => {
    const choice = sample({
      name: "detailed",
      description: "Detailed blurb",
      value: "/profiles/detailed/profile.toml",
      supported_platforms: ["linux/arm64", "linux/amd64"],
      mcps: [
        {
          name: "docs",
          transport: "http",
          required: true,
          url: "https://example.test/mcp",
          tools: { allow: ["search"], deny: [] },
        },
      ],
    })
    expect(
      toFullList(
        [choice],
        [guide],
        [
          {
            resolutionPolicy: "floating",
            locallyResolved: true,
            releaseLockAvailable: true,
            locked: true,
            resolvedVersion: "0.147.0",
          },
        ],
        [{ status: "verified" }],
      ),
    ).toEqual({
      schemaVersion: 2,
      profiles: [
        {
          name: "detailed",
          description: "Detailed blurb",
          guide,
          path: "/profiles/detailed/profile.toml",
          supportedPlatforms: ["linux/arm64", "linux/amd64"],
          harness: { kind: "codex", version: "latest", model: "gpt-5.6-sol" },
          resolutionPolicy: "floating",
          locallyResolved: true,
          releaseLockAvailable: true,
          skillBundles: ["sandbox-common"],
          skillsMode: "floating",
          finalDigestLocked: false,
          skills: choice.skills,
          plugins: choice.plugins,
          mcps: choice.mcps,
          sandbox: true,
          headless: resolveSandboxHeadlessCapabilities("codex", "0.147.0"),
          locked: true,
          herdrCompatibility: { status: "verified" },
        },
      ],
    })
  })

  it("keeps current Codex full-list entries conservative despite a resolved lock version", () => {
    const [entry] = toFullList(
      [sample({ name: "codex-superpowers", description: "Codex profile", value: "/profiles/codex/profile.toml" })],
      [guide],
      [
        {
          resolutionPolicy: "floating",
          locallyResolved: true,
          releaseLockAvailable: false,
          locked: false,
          resolvedVersion: "0.147.0",
        },
      ],
    ).profiles

    expect(entry?.headless).toEqual(resolveSandboxHeadlessCapabilities("codex", "0.147.0"))
    expect(entry?.locked).toBe(true)
    expect(entry?.releaseLockAvailable).toBe(false)
  })

  it("defaults locked to false and herdrCompatibility to untested when not supplied", () => {
    const choice = sample({ name: "bare", description: "Bare blurb", value: "/p/bare/profile.toml" })
    const [entry] = toFullList([choice], [guide]).profiles
    expect(entry?.locked).toBe(false)
    expect(entry?.locallyResolved).toBe(false)
    expect(entry?.releaseLockAvailable).toBe(false)
    expect(entry?.headless).toEqual(resolveSandboxHeadlessCapabilities("codex", null))
    expect(entry?.herdrCompatibility).toEqual({ status: "untested" })
  })

  it("keeps the locked compatibility alias tied to local resolution", () => {
    const choice = sample({ name: "release-only", description: "Release only", value: "/p/release/profile.toml" })
    const [entry] = toFullList(
      [choice],
      [guide],
      [
        {
          resolutionPolicy: "floating",
          locallyResolved: false,
          releaseLockAvailable: true,
          locked: false,
          resolvedVersion: null,
        },
      ],
    ).profiles

    expect(entry?.locked).toBe(false)
    expect(entry?.releaseLockAvailable).toBe(true)
  })

  it("publishes the current Claude marketplace contract and fails closed on later drift", () => {
    const choice = sample({
      name: "claude-blog",
      description: "Claude blog",
      value: "/profiles/claude-blog/profile.toml",
      harness: { kind: "claude", version: "latest", model: "claude-opus-5" },
      headlessRuntime: "claude-marketplace",
      plugins: [
        {
          adapter: "claude-marketplace",
          repository: "https://github.com/example/claude-blog.git",
          ref: "main",
          marketplace: "claude-blog",
          select: ["blog"],
        },
      ],
    })

    const [entry] = toFullList(
      [choice],
      [guide],
      [
        {
          resolutionPolicy: "floating",
          locallyResolved: true,
          releaseLockAvailable: false,
          locked: false,
          resolvedVersion: "2.1.251",
        },
      ],
    ).profiles

    expect(entry?.headless).toMatchObject({
      prompt: true,
      outputFormats: ["text", "jsonl"],
      eventContract: "claude-stream-json-v1",
      trellageEventContract: "trellage-headless-v1",
      changedFiles: "git-diff",
      testedHarnessVersion: "2.1.251",
    })

    const [drifted] = toFullList(
      [choice],
      [guide],
      [
        {
          resolutionPolicy: "floating",
          locallyResolved: true,
          releaseLockAvailable: false,
          locked: false,
          resolvedVersion: "2.1.252",
        },
      ],
    ).profiles

    expect(drifted?.headless).toMatchObject({
      prompt: false,
      outputFormats: ["text"],
      eventContract: null,
      trellageEventContract: null,
      changedFiles: "none",
      testedHarnessVersion: "2.1.251",
    })
  })

  it("formats human list as name-description TSV", () => {
    const choices = [sample({ name: "a", description: "line one\nstill one", value: "/a" })]
    // Collapse description newlines to spaces for single-line rows
    expect(formatProfileListHuman(choices)).toBe("a\tline one still one")
  })
})
