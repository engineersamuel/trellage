import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import type { ProfileChoice } from "../src/profile-discovery.js"
import { loadSandboxProfileGuides } from "../src/profile-guides.js"

const roots: string[] = []

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-profile-guides-"))
  roots.push(root)
  return root
}

const guide = (capability: string) => `---
schemaVersion: 1
capabilities:
  - ${capability}
bestFor:
  - Guided fixture work
avoidFor:
  - Unrelated fixture work
prerequisites: []
workflows:
  - id: deliver
    description: Deliver the fixture
    examples:
      - Build the fixture
      - Test the fixture
      - Review the fixture
    promptTemplate: |
      {{intent}}
---
# Fixture guide
`

const choice = (name: string, value: string): ProfileChoice => ({
  name,
  description: `${name} description`,
  value,
  supported_platforms: ["linux/arm64"],
  harness: { kind: "codex", version: "latest", model: "gpt-5.6-sol" },
  headlessRuntime: "codex",
  skillBundles: ["sandbox-common"],
  skillsMode: "floating",
  skills: [],
  plugins: [],
  mcps: [],
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Sandbox profile guide loading", () => {
  it("uses bundled guides for bundled profiles and local guides for worktree profiles", async () => {
    const repositoryRoot = await temporaryRoot()
    const worktreeRoot = await temporaryRoot()
    await mkdir(path.join(repositoryRoot, "profile-guides", "sandbox"), { recursive: true })
    await mkdir(path.join(worktreeRoot, "profile-guides", "sandbox"), { recursive: true })
    await writeFile(path.join(repositoryRoot, "profile-guides", "sandbox", "bundled.md"), guide("bundled-delivery"))
    await writeFile(path.join(worktreeRoot, "profile-guides", "sandbox", "custom.md"), guide("custom-delivery"))

    const guides = await Effect.runPromise(
      loadSandboxProfileGuides(repositoryRoot, [
        choice("bundled", path.join(repositoryRoot, "profiles", "bundled", "profile.toml")),
        choice("custom", path.join(worktreeRoot, "profiles", "custom", "profile.toml")),
      ]),
    )

    expect(guides.map(({ capabilities }) => capabilities)).toEqual([["bundled-delivery"], ["custom-delivery"]])
  })

  it("reports the exact missing worktree guide path", async () => {
    const repositoryRoot = await temporaryRoot()
    const worktreeRoot = await temporaryRoot()

    await expect(
      Effect.runPromise(
        loadSandboxProfileGuides(repositoryRoot, [
          choice("custom", path.join(worktreeRoot, "profiles", "custom", "profile.toml")),
        ]),
      ),
    ).rejects.toThrow("sandbox:custom")
  })
})
