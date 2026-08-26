import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  discoverProfileGuideRelativePaths,
  loadProfileGuide,
  loadProfileGuideRegistry,
  parseProfileGuide,
  parseProfileGuideIdentity,
  profileGuideIdentityKey,
  profileGuideRelativePath,
  ProfileGuideValidationError,
  validateProfileGuideCoverage,
} from "../src/index.js"

const validGuide = `---
schemaVersion: 1
capabilities:
  - social-writing
bestFor:
  - Short public posts
avoidFor:
  - Long-form engineering design
prerequisites:
  - id: voice-builder
    description: Build the voice files first
workflows:
  - id: post-writer
    description: Draft a post in the user's voice
    skill: social-media-skills:post-writer
    examples:
      - Write a post about agents
      - Turn this note into a LinkedIn post
      - Draft a launch announcement
    promptTemplate: |
      /social-media-skills:post-writer {{intent}}
---
# Social media

Use the profile for short public content.
`

const temporaryRoots: string[] = []
const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-guides-"))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("profile guide parser", () => {
  it("parses a valid guide and preserves its Markdown body", () => {
    const parsed = parseProfileGuide("profile-guides/sandbox/social.md", validGuide)

    expect(parsed.guide).toEqual({
      schemaVersion: 1,
      capabilities: ["social-writing"],
      bestFor: ["Short public posts"],
      avoidFor: ["Long-form engineering design"],
      prerequisites: [{ id: "voice-builder", description: "Build the voice files first" }],
      workflows: [
        {
          id: "post-writer",
          description: "Draft a post in the user's voice",
          skill: "social-media-skills:post-writer",
          examples: [
            "Write a post about agents",
            "Turn this note into a LinkedIn post",
            "Draft a launch announcement",
          ],
          promptTemplate: "/social-media-skills:post-writer {{intent}}",
        },
      ],
    })
    expect(parsed.body).toContain("# Social media")
  })

  it("rejects unsupported frontmatter keys", () => {
    const source = validGuide.replace("schemaVersion: 1", "schemaVersion: 1\nprofile: social")

    expect(() => parseProfileGuide("social.md", source)).toThrowError(ProfileGuideValidationError)
    expect(() => parseProfileGuide("social.md", source)).toThrow("contains unsupported keys: profile")
  })

  it("requires three example intents across workflows", () => {
    const source = validGuide
      .replace("      - Turn this note into a LinkedIn post\n", "")
      .replace("      - Draft a launch announcement\n", "")

    expect(() => parseProfileGuide("social.md", source)).toThrow("at least three example intents")
  })

  it("rejects duplicate capability identifiers", () => {
    const source = validGuide.replace("  - social-writing\nbestFor:", "  - social-writing\n  - social-writing\nbestFor:")

    expect(() => parseProfileGuide("social.md", source)).toThrow("must contain unique entries")
  })

  it("requires the shared intent placeholder and rejects custom placeholders", () => {
    const missing = validGuide.replace("{{intent}}", "Write a post")
    const custom = validGuide.replace("{{intent}}", "{{intent}} {{topic}}")

    expect(() => parseProfileGuide("social.md", missing)).toThrow("must contain the {{intent}} placeholder")
    expect(() => parseProfileGuide("social.md", custom)).toThrow("unsupported placeholder: {{topic}}")
  })
})

describe("profile guide identities", () => {
  it("round-trips native and Sandbox paths", () => {
    const native = parseProfileGuideIdentity("native/cpx/hve.md")
    const sandbox = parseProfileGuideIdentity("sandbox/claude-social-media.md")

    expect(profileGuideIdentityKey(native)).toBe("native:cpx/hve")
    expect(profileGuideRelativePath(native)).toBe("native/cpx/hve.md")
    expect(profileGuideIdentityKey(sandbox)).toBe("sandbox:claude-social-media")
    expect(profileGuideRelativePath(sandbox)).toBe("sandbox/claude-social-media.md")
  })

  it("reports missing and unexpected guide identities", () => {
    const coverage = validateProfileGuideCoverage(
      [
        { surface: "native", launcher: "cpx", profile: "hve" },
        { surface: "sandbox", profile: "claude-social-media" },
      ],
      ["native/cpx/hve.md", "sandbox/unknown.md"],
    )

    expect(coverage).toEqual({
      missing: ["sandbox:claude-social-media"],
      unexpected: ["sandbox:unknown"],
    })
  })

  describe("profile guide filesystem", () => {
    it("loads exact profile identities and discovers coverage paths", async () => {
      const root = await temporaryRoot()
      await mkdir(path.join(root, "native", "cpx"), { recursive: true })
      await mkdir(path.join(root, "sandbox"), { recursive: true })
      await writeFile(path.join(root, "native", "cpx", "hve.md"), validGuide)
      await writeFile(path.join(root, "sandbox", "social.md"), validGuide)

      const loaded = await loadProfileGuide(root, { surface: "native", launcher: "cpx", profile: "hve" })
      const registry = await loadProfileGuideRegistry(root, [
        { surface: "native", launcher: "cpx", profile: "hve" },
        { surface: "sandbox", profile: "social" },
      ])

      expect(loaded.key).toBe("native:cpx/hve")
      expect(registry.size).toBe(2)
      await expect(discoverProfileGuideRelativePaths(root)).resolves.toEqual([
        "native/cpx/hve.md",
        "sandbox/social.md",
      ])
    })

    it("rejects symlinked guides", async () => {
      const root = await temporaryRoot()
      const outside = path.join(root, "outside.md")
      await mkdir(path.join(root, "native", "cpx"), { recursive: true })
      await mkdir(path.join(root, "sandbox"), { recursive: true })
      await writeFile(outside, validGuide)
      await symlink(outside, path.join(root, "native", "cpx", "hve.md"))

      await expect(
        loadProfileGuide(root, { surface: "native", launcher: "cpx", profile: "hve" }),
      ).rejects.toThrow("non-symlink regular file")
    })
  })
})
