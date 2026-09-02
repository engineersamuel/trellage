import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { enrichNativeProfileList } from "../src/native-guide-list.js"

const guide = `---
schemaVersion: 1
capabilities:
  - repository-delivery
bestFor:
  - Repository delivery
  - Focused implementation and review
avoidFor:
  - Unrelated content work
  - Long-running background research
prerequisites: []
workflows:
  - id: deliver
    description: Deliver repository work
    examples:
      - Build this feature
      - Fix this bug
      - Review this change
    promptTemplate: |
      {{intent}}
---
# Delivery

Use this profile for repository delivery.
`

describe("native profile guide list", () => {
  it("adds guide metadata without changing existing profile fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "trellage-native-guides-"))
    await mkdir(path.join(root, "native", "cpx"), { recursive: true })
    await mkdir(path.join(root, "sandbox"), { recursive: true })
    await writeFile(path.join(root, "native", "cpx", "hve.md"), guide)

    const result = JSON.parse(
      await enrichNativeProfileList(
        JSON.stringify({
          schemaVersion: 1,
          profiles: [{ launcher: "cpx", name: "hve", description: "HVE", sandbox: false }],
        }),
        root,
      ),
    ) as {
      readonly profiles: ReadonlyArray<Record<string, unknown>>
    }

    expect(result.profiles).toEqual([
      {
        launcher: "cpx",
        name: "hve",
        description: "HVE",
        sandbox: false,
        guide: {
          schemaVersion: 1,
          capabilities: ["repository-delivery"],
          bestFor: ["Repository delivery", "Focused implementation and review"],
          avoidFor: ["Unrelated content work", "Long-running background research"],
          prerequisites: [],
          workflows: [
            {
              id: "deliver",
              description: "Deliver repository work",
              examples: ["Build this feature", "Fix this bug", "Review this change"],
              promptTemplate: "{{intent}}",
            },
          ],
        },
      },
    ])
  })

  it("skips a native profile whose guide is absent from this checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "trellage-native-guides-"))
    await mkdir(path.join(root, "native", "cpx"), { recursive: true })
    await mkdir(path.join(root, "sandbox"), { recursive: true })
    await writeFile(path.join(root, "native", "cpx", "hve.md"), guide)

    const warnings: Array<string> = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      warnings.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    let result: string
    try {
      result = await enrichNativeProfileList(
        JSON.stringify({
          schemaVersion: 1,
          profiles: [
            { launcher: "cpx", name: "hve" },
            { launcher: "cpx", name: "tufte-vdqi" },
          ],
        }),
        root,
      )
    } finally {
      process.stderr.write = write
    }

    const parsed = JSON.parse(result) as { readonly profiles: ReadonlyArray<{ readonly name: string }> }
    expect(parsed.profiles.map((profile) => profile.name)).toEqual(["hve"])
    expect(warnings.join("")).toContain("skipping native:cpx/tufte-vdqi")
  })

  it("fails when a native profile guide is present but malformed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "trellage-native-guides-"))
    await mkdir(path.join(root, "native", "cpx"), { recursive: true })
    await mkdir(path.join(root, "sandbox"), { recursive: true })
    await writeFile(path.join(root, "native", "cpx", "hve.md"), "# no frontmatter\n")

    await expect(
      enrichNativeProfileList(JSON.stringify({ schemaVersion: 1, profiles: [{ launcher: "cpx", name: "hve" }] }), root),
    ).rejects.toThrow("native/cpx/hve.md")
  })
})
