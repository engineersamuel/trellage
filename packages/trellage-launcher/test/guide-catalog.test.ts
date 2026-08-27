import { describe, expect, it } from "vitest"
import type { ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { GuideValidationError } from "../src/guide-text.js"
import {
  compactProfileGuide,
  guideCatalogEntries,
  guideCatalogWorkflowIndex,
  guideMatchCatalogEntries,
  parseGuideCatalog,
} from "../src/guide-catalog.js"

const guide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["code-review", "test-writing"],
  bestFor: ["Reviewing pull requests"],
  avoidFor: ["Long-running background jobs"],
  prerequisites: [{ id: "git-repo", description: "A git repository checkout." }],
  workflows: [
    {
      id: "review",
      description: "Review a diff.",
      examples: ["Review my last commit"],
      promptTemplate: "Review the diff for: {{intent}}.",
    },
  ],
}

const headless = {
  schemaVersion: 1,
  prompt: true,
  outputFormats: ["json"],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "native",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "hard-deny",
  changedFiles: "native",
  usage: true,
  cost: true,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
}

const validCatalog = {
  schemaVersion: 1,
  sandboxCommandPath: "/opt/trellage/bin/trellage",
  native: [
    {
      launcher: "cdx",
      harness: "codex",
      name: "hve",
      description: "Codex host-native launcher.",
      headless,
      sandbox: false,
      herdrCompatibility: { status: "supported", kind: "native", harness: "codex" },
      guide,
      commandPath: "/opt/trellage/cdx/bin/cdx",
    },
  ],
  sandbox: [
    {
      name: "prime-agent",
      description: "Sandboxed prime agent profile.",
      guide,
      path: "/profiles/prime-agent",
      supportedPlatforms: ["linux/amd64"],
      harness: {
        kind: "copilot",
        version: "1.0.0",
        model: "mai-code-1.1-flash",
      },
      skillBundles: ["sandbox-common"],
      skillsMode: "floating",
      finalDigestLocked: false,
      skills: [
        {
          repository: "https://github.com/example/skills.git",
          ref: "main",
          select: ["show-me"],
        },
      ],
      plugins: [
        {
          adapter: "claude-marketplace",
          repository: "https://github.com/example/plugin.git",
          ref: "main",
          select: ["example"],
          marketplace: "example",
        },
      ],
      mcps: [
        {
          name: "example",
          required: false,
          tools: { allow: [], deny: [] },
          transport: "stdio",
          command: "example",
          args: [],
        },
      ],
      sandbox: true,
      headless,
      locked: false,
      herdrCompatibility: { status: "supported" },
    },
  ],
}

describe("parseGuideCatalog", () => {
  it("parses a valid combined catalog into stable refs and entries", () => {
    const catalog = parseGuideCatalog(JSON.stringify(validCatalog))
    const entries = guideCatalogEntries(catalog)

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.ref)).toEqual(["native:cdx/hve", "sandbox:prime-agent"])
    expect(entries[0]).toMatchObject({ surface: "native", launcher: "cdx", harness: "codex", name: "hve" })
    expect(entries[1]).toMatchObject({ surface: "sandbox", harness: "copilot", name: "prime-agent" })
  })

  it("builds a workflow index keyed by ref", () => {
    const catalog = parseGuideCatalog(JSON.stringify(validCatalog))
    const index = guideCatalogWorkflowIndex(catalog)

    expect(index.get("native:cdx/hve")).toEqual(new Set(["review"]))
    expect(index.get("sandbox:prime-agent")).toEqual(new Set(["review"]))
    expect(index.get("sandbox:unknown")).toBeUndefined()
  })

  it("rejects malformed JSON", () => {
    expect(() => parseGuideCatalog("{not json")).toThrow(GuideValidationError)
  })

  it("rejects a catalog with an invalid guide shape", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: { ...guide, workflows: [] },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("rejects a catalog with an invalid headless shape", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          headless: { ...headless, questionToolControl: "sometimes" },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("rejects a catalog with unsupported extra keys on a headless shape", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          headless: { ...headless, unexpected: true },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("rejects duplicate refs within the same surface", () => {
    const withDuplicateNative = {
      ...validCatalog,
      native: [validCatalog.native[0], validCatalog.native[0]],
    }
    expect(() => parseGuideCatalog(JSON.stringify(withDuplicateNative))).toThrow(GuideValidationError)
  })

  it("rejects a non-absolute sandboxCommandPath", () => {
    const broken = { ...validCatalog, sandboxCommandPath: "bin/trellage" }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("rejects a non-absolute native commandPath", () => {
    const broken = {
      ...validCatalog,
      native: [{ ...validCatalog.native[0], commandPath: "cdx/bin/cdx" }],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("rejects a non-absolute sandbox profile path", () => {
    const broken = {
      ...validCatalog,
      sandbox: [{ ...validCatalog.sandbox[0], path: "profiles/prime-agent" }],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("rejects a workflow skill that is not a portable identifier", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: { ...guide, workflows: [{ ...guide.workflows[0], skill: "Not A Valid Skill!" }] },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("accepts a workflow skill that is a portable identifier", () => {
    const withSkill = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: { ...guide, workflows: [{ ...guide.workflows[0], skill: "review-diff" }] },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(withSkill))).not.toThrow()
  })

  it("rejects a promptTemplate missing the {{intent}} placeholder", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: { ...guide, workflows: [{ ...guide.workflows[0], promptTemplate: "Review the diff at {{ref}}." }] },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("rejects a promptTemplate containing an unsupported placeholder alongside {{intent}}", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: {
            ...guide,
            workflows: [{ ...guide.workflows[0], promptTemplate: "Review {{intent}} at {{ref}}." }],
          },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })
})

describe("compactProfileGuide / guideMatchCatalogEntries", () => {
  it("strips promptTemplate from every workflow for the match-phase projection", () => {
    const compact = compactProfileGuide(guide)
    expect(compact.workflows[0]).not.toHaveProperty("promptTemplate")
    expect(compact.workflows[0]).toMatchObject({ id: "review", description: "Review a diff." })
  })

  it("produces compact match entries with no promptTemplate anywhere in the JSON", () => {
    const catalog = parseGuideCatalog(JSON.stringify(validCatalog))
    const matchEntries = guideMatchCatalogEntries(catalog)
    const serialized = JSON.stringify(matchEntries)
    expect(serialized).not.toContain("promptTemplate")
    expect(matchEntries).toHaveLength(2)
    expect(matchEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "native:cdx/hve", harness: "codex" }),
        expect.objectContaining({ ref: "sandbox:prime-agent", harness: "copilot" }),
      ]),
    )
  })

  it("accepts a multiline promptTemplate containing real newlines (item 1 regression)", () => {
    const multilineTemplate = "Review the diff for: {{intent}}.\n\nFocus on:\n- correctness\n- security"
    const withMultilineTemplate = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: { ...guide, workflows: [{ ...guide.workflows[0], promptTemplate: multilineTemplate }] },
        },
      ],
    }
    const catalog = parseGuideCatalog(JSON.stringify(withMultilineTemplate))
    const entries = guideCatalogEntries(catalog)
    expect(entries[0]?.guide.workflows[0]?.promptTemplate).toBe(multilineTemplate)
  })
})
