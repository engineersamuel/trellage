import { describe, expect, it } from "vitest"

import { resolveSandboxHeadlessCapabilities } from "../src/headless-capabilities.js"
import type { ProfileChoice } from "../src/profile-discovery.js"
import { formatProfileListHuman, toFullList, toSimplifiedList } from "../src/profile-list.js"

const sample = (
  overrides: Partial<ProfileChoice> & Pick<ProfileChoice, "name" | "description" | "value">,
): ProfileChoice => ({
  supported_platforms: ["linux/arm64"],
  harness: { kind: "codex", version: "latest", model: "gpt-5.6-sol" },
  headlessRuntime: "codex",
  skills: [{ repository: "https://github.com/example/skills.git", ref: "v1", select: ["a"] }],
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
    expect(toSimplifiedList(choices)).toEqual({
      schemaVersion: 1,
      profiles: [
        { name: "beta", description: "Beta blurb", sandbox: true },
        { name: "alpha", description: "Alpha blurb", sandbox: true },
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
    expect(toFullList([choice], [{ locked: true, resolvedVersion: "0.147.0" }], [{ status: "verified" }])).toEqual({
      schemaVersion: 1,
      profiles: [
        {
          name: "detailed",
          description: "Detailed blurb",
          path: "/profiles/detailed/profile.toml",
          supportedPlatforms: ["linux/arm64", "linux/amd64"],
          harness: { kind: "codex", version: "latest", model: "gpt-5.6-sol" },
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
      [{ locked: true, resolvedVersion: "0.147.0" }],
    ).profiles

    expect(entry?.headless).toEqual(resolveSandboxHeadlessCapabilities("codex", "0.147.0"))
  })

  it("defaults locked to false and herdrCompatibility to untested when not supplied", () => {
    const choice = sample({ name: "bare", description: "Bare blurb", value: "/p/bare/profile.toml" })
    const [entry] = toFullList([choice]).profiles
    expect(entry?.locked).toBe(false)
    expect(entry?.headless).toEqual(resolveSandboxHeadlessCapabilities("codex", null))
    expect(entry?.herdrCompatibility).toEqual({ status: "untested" })
  })

  it("fails closed for full-list Claude entries when the resolved version drifted past the verified evidence", () => {
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

    const [entry] = toFullList([choice], [{ locked: true, resolvedVersion: "2.1.233" }]).profiles

    expect(entry?.headless).toMatchObject({
      prompt: false,
      outputFormats: ["text"],
      eventContract: null,
      trellageEventContract: null,
      changedFiles: "none",
      testedHarnessVersion: "2.1.229",
    })
  })

  it("formats human list as name-description TSV", () => {
    const choices = [sample({ name: "a", description: "line one\nstill one", value: "/a" })]
    // Collapse description newlines to spaces for single-line rows
    expect(formatProfileListHuman(choices)).toBe("a\tline one still one")
  })
})
