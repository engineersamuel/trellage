import { describe, expect, it } from "vitest"

import type { ProfileChoice } from "../src/profile-discovery.js"
import { formatProfileListHuman, toFullList, toSimplifiedList } from "../src/profile-list.js"

const sample = (
  overrides: Partial<ProfileChoice> & Pick<ProfileChoice, "name" | "description" | "value">,
): ProfileChoice => ({
  supported_platforms: ["linux/arm64"],
  harness: { kind: "codex", version: "latest", model: "gpt-5.6-sol" },
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
    expect(toFullList([choice], [true], [{ status: "verified" }])).toEqual({
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
          locked: true,
          herdrCompatibility: { status: "verified" },
        },
      ],
    })
  })

  it("defaults locked to false and herdrCompatibility to untested when not supplied", () => {
    const choice = sample({ name: "bare", description: "Bare blurb", value: "/p/bare/profile.toml" })
    const [entry] = toFullList([choice]).profiles
    expect(entry?.locked).toBe(false)
    expect(entry?.herdrCompatibility).toEqual({ status: "untested" })
  })

  it("formats human list as name-description TSV", () => {
    const choices = [sample({ name: "a", description: "line one\nstill one", value: "/a" })]
    // Collapse description newlines to spaces for single-line rows
    expect(formatProfileListHuman(choices)).toBe("a\tline one still one")
  })
})
