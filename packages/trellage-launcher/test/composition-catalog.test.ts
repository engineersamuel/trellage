import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { formatCompositionRef, loadCompositionCatalog, parseCompositionRef } from "../src/composition-catalog.ts"

const temporaryDirectories: string[] = []
const originalConfig = process.env.TRELLAGE_CONFIG

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.TRELLAGE_CONFIG
  else process.env.TRELLAGE_CONFIG = originalConfig
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const guide = `---
schemaVersion: 1
capabilities: [repository-delivery]
bestFor: [Repository delivery, Focused implementation]
avoidFor: [Background research, Unrelated content work]
prerequisites: []
workflows:
  - id: deliver
    description: Deliver repository work
    examples: [Build this feature, Fix this bug]
    promptTemplate: "{{intent}}"
---
# Delivery
`

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trellage-composition-catalog-"))
  temporaryDirectories.push(directory)
  const config = path.join(directory, "config.toml")
  await writeFile(config, `
[native.sources.common]
repository = "example/common"

[native.profiles.base]
label = "Shared defaults"
always = true

[native.profiles.tools]
label = "Tool belt"
skills = [{ source = "common", names = ["review", "test"] }]

[native.profiles.claude-only]
label = "Claude tools"
harnesses = ["claude"]

[native.profiles.social-media]
label = "Custom social"
harnesses = ["claude"]
`, { mode: 0o600 })
  await chmod(config, 0o600)
  const guideRoot = path.join(directory, "profile-guides")
  await mkdir(path.join(guideRoot, "native", "claude"), { recursive: true })
  await writeFile(path.join(guideRoot, "native", "claude", "default.md"), guide)
  process.env.TRELLAGE_CONFIG = config
  return { guideRoot, commandPath: path.join(directory, "bin", "trx") }
}

describe("composition catalog", () => {
  it("loads preset, config, shared, and clean rows with harness limits", async () => {
    const catalog = await loadCompositionCatalog(await fixture())
    const byRef = new Map(catalog.entries.map((entry) => [entry.ref, entry]))

    expect(catalog.schemaVersion).toBe(2)
    expect(byRef.get("native:claude/default")).toMatchObject({
      harness: "claude", profiles: ["default"], kind: "preset", canonicalHarness: true,
      lifecycle: { runtime: "cldx", profile: "default" }, guide: { schemaVersion: 1 },
    })
    expect(byRef.get("native:codex/pstack")).toMatchObject({ kind: "preset", lifecycle: null, headless: { prompt: false } })
    expect(byRef.get("native:claude/social-media")).toMatchObject({ kind: "config", description: "Custom social" })
    expect(byRef.get("native:claude/tools")).toMatchObject({ kind: "config", description: "Tool belt (review, test)", lifecycle: null })
    expect(byRef.get("native:grok/tools")).toMatchObject({ kind: "config", guide: null })
    expect(byRef.get("native:claude/claude-only")).toMatchObject({ kind: "config" })
    expect(byRef.has("native:codex/claude-only")).toBe(false)
    expect(byRef.get("native:claude/firstmate")).toMatchObject({ kind: "shared", headless: { prompt: false } })
    expect(byRef.has("native:codex/firstmate")).toBe(false)
    expect(byRef.get("native:codex/superpowers")).toMatchObject({ kind: "preset", lifecycle: null })
    expect(byRef.get("native:codex/youtube")).toMatchObject({ kind: "preset", lifecycle: null })
    expect(byRef.get("native:pi/default")).toMatchObject({ kind: "preset", lifecycle: null, headless: { prompt: true } })
    expect(byRef.get("native:claude/clean")).toMatchObject({ kind: "special", lifecycle: null })
    expect(byRef.has("native:grok/clean")).toBe(false)
    expect(byRef.get("native:fx/default")).toMatchObject({ canonicalHarness: false, kind: "preset" })
    expect(catalog.entries.some((entry) => entry.profiles.includes("base"))).toBe(false)
  })

  it("formats and parses ordered profile stacks", () => {
    expect(formatCompositionRef("copilot", ["hve", "tools"])).toBe("native:copilot/hve+tools")
    expect(parseCompositionRef("native:copilot/hve+tools")).toEqual({ harness: "copilot", profiles: ["hve", "tools"] })
    expect(() => parseCompositionRef("native:copilot/hve+hve")).toThrow("invalid composition ref")
    expect(() => formatCompositionRef("copilot", [])).toThrow("one or more")
  })
})
