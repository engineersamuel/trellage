import { describe, expect, it } from "vitest"
import type { ProfileGuideGoalExecution, ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { GuideValidationError } from "../src/guide-text.js"
import {
  compactProfileGuide,
  guideCatalogEntries,
  guideCatalogWorkflowIndex,
  guideMatchCatalogEntries,
  parseGuideCatalog,
  toGuideMatchCatalogEntry,
} from "../src/guide-catalog.js"

const guide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["code-review", "test-writing"],
  bestFor: ["Reviewing pull requests", "Writing focused regression tests"],
  avoidFor: ["Long-running background jobs", "Unrelated content work"],
  prerequisites: [{ id: "git-repo", description: "A git repository checkout." }],
  workflows: [
    {
      id: "review",
      description: "Review a diff.",
      examples: ["Review my last commit", "Check this pull request"],
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
      name: "pstack",
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
      resolutionPolicy: "floating",
      locallyResolved: false,
      releaseLockAvailable: true,
      resolvedVersion: "1.0.70",
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

const codexPolicy: ProfileGuideGoalExecution = { controller: "codex-goal", workflowIds: ["review"] }
const goalCatalog = {
  ...validCatalog,
  native: [{ ...validCatalog.native[0], guide: { ...guide, goalExecution: codexPolicy } }],
}
const graphGoalGuide: ProfileGuideV1 = {
  ...guide,
  goalExecution: { controller: "graph-of-loops", workflowIds: ["start-run"] },
  workflows: [
    {
      id: "start-run",
      description: "Start a Graph implementation run.",
      skill: "graph-of-loops",
      examples: ["Implement this multi-module change", "Repair and verify the current implementation"],
      promptTemplate:
        '/graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Require evidence and preserve review gates."',
    },
    {
      id: "inspect-or-resume-run",
      description: "Inspect or resume an existing Graph run.",
      skill: "graph-of-loops",
      examples: ["Inspect this run", "Resume this reviewed run"],
      promptTemplate: "/graph-of-loops {{intent}}. Preserve the current run and reviewed plan.",
    },
  ],
}

describe("parseGuideCatalog", () => {
  it("parses a valid combined catalog into stable refs and entries", () => {
    const catalog = parseGuideCatalog(JSON.stringify(validCatalog))
    const entries = guideCatalogEntries(catalog)

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.ref)).toEqual(["native:cdx/pstack", "sandbox:prime-agent"])
    expect(entries[0]).toMatchObject({ surface: "native", launcher: "cdx", harness: "codex", name: "pstack" })
    expect(entries[1]).toMatchObject({
      surface: "sandbox",
      harness: "copilot",
      name: "prime-agent",
      resolvedVersion: "1.0.70",
    })
    expect(catalog.sandbox[0]).toMatchObject({
      resolutionPolicy: "floating",
      locallyResolved: false,
      releaseLockAvailable: true,
      resolvedVersion: "1.0.70",
    })
  })

  it("accepts an older catalog without resolvedVersion and projects no installed version", () => {
    const { resolvedVersion: _resolvedVersion, ...withoutResolvedVersion } = validCatalog.sandbox[0]!
    const catalog = parseGuideCatalog(JSON.stringify({ ...validCatalog, sandbox: [withoutResolvedVersion] }))

    expect(catalog.sandbox[0]?.resolvedVersion).toBeNull()
    expect(guideCatalogEntries(catalog)[1]?.resolvedVersion).toBeUndefined()
  })

  it("rejects a malformed resolvedVersion", () => {
    const broken = {
      ...validCatalog,
      sandbox: [{ ...validCatalog.sandbox[0], resolvedVersion: 42 }],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("builds a workflow index keyed by ref", () => {
    const catalog = parseGuideCatalog(JSON.stringify(validCatalog))
    const index = guideCatalogWorkflowIndex(catalog)

    expect(index.get("native:cdx/pstack")).toEqual(new Set(["review"]))
    expect(index.get("sandbox:prime-agent")).toEqual(new Set(["review"]))
    expect(index.get("sandbox:unknown")).toBeUndefined()
  })

  it("retains the authored launch agent without exposing it as match-model metadata", () => {
    const catalog = parseGuideCatalog(
      JSON.stringify({
        ...validCatalog,
        sandbox: validCatalog.sandbox.map((entry) => ({
          ...entry,
          guide: {
            ...entry.guide,
            workflows: entry.guide.workflows.map((workflow) => ({ ...workflow, launchAgent: "hve-core:dt-coach" })),
          },
        })),
      }),
    )

    expect(catalog.sandbox[0]?.guide.workflows[0]?.launchAgent).toBe("hve-core:dt-coach")
    expect(JSON.stringify(guideMatchCatalogEntries(catalog))).not.toContain("launchAgent")
  })

  it.each(["hve-core/dt-coach", "--agent", "a".repeat(129)])(
    "rejects a launch agent that cannot reach the runtime: %s",
    (agent) => {
      const source = {
        ...validCatalog,
        sandbox: validCatalog.sandbox.map((entry) => ({
          ...entry,
          guide: {
            ...entry.guide,
            workflows: entry.guide.workflows.map((workflow) => ({ ...workflow, launchAgent: agent })),
          },
        })),
      }
      expect(() => parseGuideCatalog(JSON.stringify(source))).toThrow(/launchAgent/)
    },
  )

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

  it("rejects a guide with fewer than two best-fit statements", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: { ...guide, bestFor: guide.bestFor.slice(0, 1) },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("rejects a guide with fewer than two avoid-fit statements", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: { ...guide, avoidFor: guide.avoidFor.slice(0, 1) },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow(GuideValidationError)
  })

  it("rejects a workflow with fewer than two outcome examples", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: {
            ...guide,
            workflows: [{ ...guide.workflows[0], examples: guide.workflows[0]!.examples.slice(0, 1) }],
          },
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

  it("accepts a promptTemplate containing exactly one {{intent}} placeholder", () => {
    expect(() => parseGuideCatalog(JSON.stringify(validCatalog))).not.toThrow()
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
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow("must contain the {{intent}} placeholder")
  })

  it("rejects a promptTemplate containing more than one {{intent}} placeholder", () => {
    const broken = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          guide: {
            ...guide,
            workflows: [{ ...guide.workflows[0], promptTemplate: "Review {{intent}}, then summarize {{intent}}." }],
          },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow("must contain exactly one {{intent}} placeholder")
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
    expect(() => parseGuideCatalog(JSON.stringify(broken))).toThrow("contains unsupported placeholder: {{ref}}")
  })
})

describe("goal execution catalog validation", () => {
  it("preserves declared Native Codex, Native Claude, and Sandbox Claude policies through full JSON projection", () => {
    const claudePolicy: ProfileGuideGoalExecution = { controller: "claude-goal", workflowIds: ["review"] }
    const catalog = parseGuideCatalog(
      JSON.stringify({
        ...goalCatalog,
        native: [
          ...goalCatalog.native,
          {
            ...validCatalog.native[0],
            launcher: "cldx",
            harness: "claude",
            name: "default",
            commandPath: "/opt/trellage/cldx/bin/cldx",
            guide: { ...guide, goalExecution: claudePolicy },
          },
        ],
        sandbox: [
          {
            ...validCatalog.sandbox[0],
            name: "claude-blog",
            harness: { kind: "claude", version: "latest" },
            guide: { ...guide, goalExecution: claudePolicy },
          },
        ],
      }),
    )
    const entries = guideCatalogEntries(catalog)

    expect(entries.map(({ guide }) => guide.goalExecution)).toEqual([codexPolicy, claudePolicy, claudePolicy])
    expect(entries.map(({ guide }) => guide.workflows)).toEqual([guide.workflows, guide.workflows, guide.workflows])
    expect(parseGuideCatalog(JSON.stringify(catalog))).toEqual(catalog)
  })

  it.each([
    null,
    [],
    { controller: "codex-goal" },
    { controller: "codex-goal", workflowIds: [], fallback: true },
    { controller: "codex-goal", workflowIds: [] },
    { controller: "codex-goal", workflowIds: ["review", "review"] },
    { controller: "codex-goal", workflowIds: ["missing"] },
    { controller: "codex-goal", workflowIds: ["not an id"] },
    { controller: "goal-me", workflowIds: ["review"] },
  ])("rejects an invalid projected policy: %j", (goalExecution) => {
    const source = {
      ...validCatalog,
      native: [{ ...validCatalog.native[0], guide: { ...guide, goalExecution } }],
    }
    expect(() => parseGuideCatalog(JSON.stringify(source))).toThrow(GuideValidationError)
  })

  it.each([
    ["cdx", "codex", "claude-goal"],
    ["cldx", "claude", "codex-goal"],
    ["cdx", "claude", "codex-goal"],
    ["cldx", "copilot", "claude-goal"],
    ["cpx", "copilot", "claude-goal"],
    ["agx", "claude", "claude-goal"],
    ["fmx", "firstmate", "codex-goal"],
    ["omp", "pi", "claude-goal"],
  ])("rejects an unsupported Native runtime binding: %s / %s / %s", (launcher, harness, controller) => {
    const source = {
      ...validCatalog,
      native: [
        {
          ...validCatalog.native[0],
          launcher,
          harness,
          guide: { ...guide, goalExecution: { controller, workflowIds: ["review"] } },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(source))).toThrow(/goalExecution/)
  })

  it.each([
    ["claude-blog", "copilot", "claude-goal"],
    ["codex-superpowers", "codex", "codex-goal"],
    ["headlong", "headlong", "claude-goal"],
    ["claude-graph-of-loops", "claude", "claude-goal"],
    ["claude-blog", "claude", "graph-of-loops"],
    ["claude-graph-of-loops", "codex", "graph-of-loops"],
  ])("rejects an unsupported Sandbox runtime binding: %s / %s / %s", (name, harness, controller) => {
    const source = {
      ...validCatalog,
      sandbox: [
        {
          ...validCatalog.sandbox[0],
          name,
          harness: { kind: harness, version: "latest" },
          guide: { ...guide, goalExecution: { controller, workflowIds: ["review"] } },
        },
      ],
    }
    expect(() => parseGuideCatalog(JSON.stringify(source))).toThrow(/goalExecution/)
  })

  it("retains Graph goal-start eligibility without treating resume as a new goal", () => {
    const source = {
      ...validCatalog,
      sandbox: [
        {
          ...validCatalog.sandbox[0],
          name: "claude-graph-of-loops",
          harness: { kind: "claude", version: "latest" },
          guide: graphGoalGuide,
        },
      ],
    }
    const catalog = parseGuideCatalog(JSON.stringify(source))
    expect(catalog.sandbox[0]?.guide).toEqual(graphGoalGuide)
    expect(guideMatchCatalogEntries(catalog, true)[1]?.goalExecution?.workflowIds).toEqual(["start-run"])

    const resumePolicy = {
      ...source,
      sandbox: source.sandbox.map((entry) => ({
        ...entry,
        guide: {
          ...entry.guide,
          goalExecution: { controller: "graph-of-loops", workflowIds: ["inspect-or-resume-run"] },
        },
      })),
    }
    expect(() => parseGuideCatalog(JSON.stringify(resumePolicy))).toThrow("goal-start frame")
  })

  it.each(["/goal", "$goal", "/goal-me", "/graph-of-loops"])(
    "rejects a conflicting controller in a projected native workflow: %s",
    (command) => {
      const source = {
        ...goalCatalog,
        native: goalCatalog.native.map((entry) => ({
          ...entry,
          guide: {
            ...entry.guide,
            workflows: entry.guide.workflows.map((workflow) => ({
              ...workflow,
              promptTemplate: `${command} {{intent}}`,
            })),
          },
        })),
      }
      expect(() => parseGuideCatalog(JSON.stringify(source))).toThrow("must leave goal invocation to codex-goal")
    },
  )
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
        expect.objectContaining({ ref: "native:cdx/pstack", harness: "codex" }),
        expect.objectContaining({ ref: "sandbox:prime-agent", harness: "copilot" }),
      ]),
    )
  })

  it("keeps ordinary matching byte-identical when a guide declares goal support", () => {
    const ordinary = parseGuideCatalog(JSON.stringify(validCatalog))
    const goalCapable = parseGuideCatalog(JSON.stringify(goalCatalog))

    expect(JSON.stringify(guideMatchCatalogEntries(goalCapable))).toBe(
      JSON.stringify(guideMatchCatalogEntries(ordinary)),
    )
    expect(guideMatchCatalogEntries(goalCapable, false)).toEqual(guideMatchCatalogEntries(ordinary))
    expect(compactProfileGuide(goalCapable.native[0]!.guide)).toEqual(compactProfileGuide(guide))
  })

  it("includes policy only on requested goal match entries, without inventing support", () => {
    const catalog = parseGuideCatalog(JSON.stringify(goalCatalog))
    const entry = guideCatalogEntries(catalog)[0]!
    const goalEntries = guideMatchCatalogEntries(catalog, true)

    expect(toGuideMatchCatalogEntry(entry)).not.toHaveProperty("goalExecution")
    expect(toGuideMatchCatalogEntry(entry, true).goalExecution).toEqual(codexPolicy)
    expect(goalEntries[0]?.goalExecution).toEqual(codexPolicy)
    expect(goalEntries[1]).not.toHaveProperty("goalExecution")
    expect(goalEntries[0]?.guide).not.toHaveProperty("goalExecution")
    expect(JSON.stringify(goalEntries)).not.toContain("promptTemplate")
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
