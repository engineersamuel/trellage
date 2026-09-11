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
  - Human-sounding launch announcements
avoidFor:
  - Long-form engineering design
  - Source-backed technical research
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
    promptTemplate: |
      /social-media-skills:post-writer {{intent}}
---
# Social media

Use the profile for short public content.
`

const withGoalExecution = (policy: unknown, source = validGuide): string =>
  source.replace("schemaVersion: 1\n", `schemaVersion: 1\ngoalExecution: ${JSON.stringify(policy)}\n`)

const graphGuide = validGuide
  .replace("skill: social-media-skills:post-writer", "skill: graph-of-loops")
  .replace(
    "/social-media-skills:post-writer {{intent}}",
    '/graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Preserve the approved criteria and require evidence."',
  )

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
      bestFor: ["Short public posts", "Human-sounding launch announcements"],
      avoidFor: ["Long-form engineering design", "Source-backed technical research"],
      prerequisites: [{ id: "voice-builder", description: "Build the voice files first" }],
      workflows: [
        {
          id: "post-writer",
          description: "Draft a post in the user's voice",
          skill: "social-media-skills:post-writer",
          examples: ["Write a post about agents", "Turn this note into a LinkedIn post"],
          promptTemplate: "/social-media-skills:post-writer {{intent}}",
        },
      ],
    })
    expect(parsed.body).toContain("# Social media")
  })

  it.each(["hve-core:dt-coach", "custom:DT-Coach", "a".repeat(128)])(
    "preserves a supported launchAgent identifier: %s",
    (agent) => {
      const source = validGuide.replace(
        "    skill: social-media-skills:post-writer\n",
        `    skill: social-media-skills:post-writer\n    launchAgent: ${JSON.stringify(agent)}\n`,
      )

      const parsed = parseProfileGuide("profile-guides/sandbox/social.md", source)

      expect(parsed.guide.workflows[0]?.launchAgent).toBe(agent)
    },
  )

  it.each(["../etc/passwd", "hve-core/dt-coach", "--agent", "dt coach", "a".repeat(129)])(
    "rejects an unsupported launchAgent value: %s",
    (agent) => {
      const source = validGuide.replace(
        "    skill: social-media-skills:post-writer\n",
        `    skill: social-media-skills:post-writer\n    launchAgent: ${JSON.stringify(agent)}\n`,
      )

      expect(() => parseProfileGuide("social.md", source)).toThrow(/launchAgent/)
    },
  )

  it("rejects an empty launchAgent value", () => {
    const source = validGuide.replace(
      "    skill: social-media-skills:post-writer\n",
      "    skill: social-media-skills:post-writer\n    launchAgent: ''\n",
    )

    expect(() => parseProfileGuide("social.md", source)).toThrow("must not be empty")
  })

  it("rejects unsupported frontmatter keys", () => {
    const source = validGuide.replace("schemaVersion: 1", "schemaVersion: 1\nprofile: social")

    expect(() => parseProfileGuide("social.md", source)).toThrowError(ProfileGuideValidationError)
    expect(() => parseProfileGuide("social.md", source)).toThrow("contains unsupported keys: profile")
  })

  it("requires two outcome examples for every workflow", () => {
    const source = validGuide.replace("      - Turn this note into a LinkedIn post\n", "")

    expect(() => parseProfileGuide("social.md", source)).toThrow("must contain at least 2 entries")
  })

  it("accepts one workflow with exactly two outcome examples", () => {
    expect(() => parseProfileGuide("social.md", validGuide)).not.toThrow()
  })

  it("requires two best-fit and two avoid-fit statements", () => {
    const missingBestFit = validGuide.replace("  - Human-sounding launch announcements\n", "")
    const missingAvoidFit = validGuide.replace("  - Source-backed technical research\n", "")

    expect(() => parseProfileGuide("social.md", missingBestFit)).toThrow("must contain at least 2 entries")
    expect(() => parseProfileGuide("social.md", missingAvoidFit)).toThrow("must contain at least 2 entries")
  })

  it("rejects duplicate capability identifiers", () => {
    const source = validGuide.replace(
      "  - social-writing\nbestFor:",
      "  - social-writing\n  - social-writing\nbestFor:",
    )

    expect(() => parseProfileGuide("social.md", source)).toThrow("must contain unique entries")
  })

  it("requires exactly one shared intent placeholder", () => {
    const missing = validGuide.replace("{{intent}}", "Write a post")
    const duplicate = validGuide.replace("{{intent}}", "{{intent}} {{intent}}")

    expect(() => parseProfileGuide("social.md", missing)).toThrow("must contain the {{intent}} placeholder")
    expect(() => parseProfileGuide("social.md", duplicate)).toThrow("must contain exactly one {{intent}} placeholder")
    expect(() => parseProfileGuide("social.md", validGuide)).not.toThrow()
  })

  it("rejects unsupported placeholders alongside the shared intent placeholder", () => {
    const custom = validGuide.replace("{{intent}}", "{{intent}} {{topic}}")

    expect(() => parseProfileGuide("social.md", custom)).toThrow("unsupported placeholder: {{topic}}")
  })
})

describe("profile guide goal execution", () => {
  it.each([
    ["native/cdx/superpowers.md", "codex-goal"],
    ["native/cldx/default.md", "claude-goal"],
    ["sandbox/claude-social-media.md", "claude-goal"],
  ])("preserves an optional policy for %s", (identity, controller) => {
    const policy = { controller, workflowIds: ["post-writer"] }
    const parsed = parseProfileGuide(`profile-guides/${identity}`, withGoalExecution(policy))

    expect(parsed.guide.goalExecution).toEqual(policy)
    expect(parsed.guide.workflows).toEqual(parseProfileGuide(identity, validGuide).guide.workflows)
    expect(parsed.body).toBe(parseProfileGuide(identity, validGuide).body)
  })

  it("requires a known document identity when a policy is authored", () => {
    expect(() =>
      parseProfileGuide("unknown.md", withGoalExecution({ controller: "codex-goal", workflowIds: ["post-writer"] })),
    ).toThrow(/goalExecution.*identity/)
  })

  it.each([
    { name: "null", policy: null, problem: "must be an object" },
    { name: "array", policy: [], problem: "must be an object" },
    {
      name: "missing controller",
      policy: { workflowIds: ["post-writer"] },
      problem: "missing required keys: controller",
    },
    { name: "missing workflows", policy: { controller: "codex-goal" }, problem: "missing required keys: workflowIds" },
    {
      name: "extra invocation template",
      policy: { controller: "codex-goal", workflowIds: ["post-writer"], promptTemplate: "/goal {{intent}}" },
      problem: "contains unsupported keys: promptTemplate",
    },
    {
      name: "unknown controller",
      policy: { controller: "pstack", workflowIds: ["post-writer"] },
      problem: "must be one of: codex-goal, claude-goal, graph-of-loops",
    },
    {
      name: "missing workflow array",
      policy: { controller: "codex-goal", workflowIds: "post-writer" },
      problem: "must be an array",
    },
    {
      name: "empty workflow array",
      policy: { controller: "codex-goal", workflowIds: [] },
      problem: "must contain at least 1 entries",
    },
    {
      name: "duplicate workflow binding",
      policy: { controller: "codex-goal", workflowIds: ["post-writer", "post-writer"] },
      problem: "must contain unique entries",
    },
    {
      name: "unknown workflow",
      policy: { controller: "codex-goal", workflowIds: ["not-authored"] },
      problem: "references unknown workflow: not-authored",
    },
    {
      name: "invalid workflow identifier",
      policy: { controller: "codex-goal", workflowIds: ["Post Writer"] },
      problem: "must be a lowercase kebab-case identifier",
    },
    {
      name: "oversized workflow array",
      policy: { controller: "codex-goal", workflowIds: Array.from({ length: 33 }, (_, index) => `workflow-${index}`) },
      problem: "must contain at most 32 entries",
    },
  ])("rejects $name", ({ policy, problem }) => {
    expect(() => parseProfileGuide("native/cdx/superpowers.md", withGoalExecution(policy))).toThrow(problem)
  })

  it.each([
    ["native/cdx/superpowers.md", "claude-goal"],
    ["native/cldx/default.md", "codex-goal"],
    ["native/cpx/hve.md", "codex-goal"],
    ["native/cpx/hve.md", "claude-goal"],
    ["native/agx/trellage-azure.md", "claude-goal"],
    ["native/fmx/pstack-workers.md", "codex-goal"],
    ["native/picx/default.md", "claude-goal"],
    ["native/cdx/superpowers.md", "graph-of-loops"],
    ["sandbox/codex-superpowers.md", "codex-goal"],
    ["sandbox/headlong.md", "claude-goal"],
    ["sandbox/prime-agent.md", "claude-goal"],
    ["sandbox/claude-blog.md", "graph-of-loops"],
    ["sandbox/claude-graph-of-loops.md", "claude-goal"],
  ])("rejects %s with controller %s", (identity, controller) => {
    expect(() => parseProfileGuide(identity, withGoalExecution({ controller, workflowIds: ["post-writer"] }))).toThrow(
      "is not supported by",
    )
  })

  it.each(["/goal", "$goal", "/goal-me", "$goal-me", "/graph-of-loops"])(
    "rejects a second controller or authoring command in a native workflow: %s",
    (command) => {
      const source = validGuide.replace("/social-media-skills:post-writer {{intent}}", `${command} {{intent}}`)
      expect(() =>
        parseProfileGuide(
          "native/cdx/superpowers.md",
          withGoalExecution({ controller: "codex-goal", workflowIds: ["post-writer"] }, source),
        ),
      ).toThrow("must leave goal invocation to codex-goal")
    },
  )

  it.each(["goal-me", "engineersamuel:goal-me", "graph-of-loops"])(
    "rejects a workflow skill that owns a different protocol: %s",
    (skill) => {
      const source = validGuide.replace("skill: social-media-skills:post-writer", `skill: ${skill}`)
      expect(() =>
        parseProfileGuide(
          "native/cldx/default.md",
          withGoalExecution({ controller: "claude-goal", workflowIds: ["post-writer"] }, source),
        ),
      ).toThrow("must leave goal invocation to claude-goal")
    },
  )

  it("rejects an incompatible launch agent on an eligible workflow", () => {
    const source = validGuide.replace(
      "    skill: social-media-skills:post-writer\n",
      "    launchAgent: hve-core:dt-coach\n",
    )
    expect(() =>
      parseProfileGuide(
        "native/cdx/superpowers.md",
        withGoalExecution({ controller: "codex-goal", workflowIds: ["post-writer"] }, source),
      ),
    ).toThrow("uses launchAgent")
  })

  it("preserves the real Graph goal-start frame", () => {
    const policy = { controller: "graph-of-loops", workflowIds: ["post-writer"] }
    const parsed = parseProfileGuide("sandbox/claude-graph-of-loops.md", withGoalExecution(policy, graphGuide))

    expect(parsed.guide.goalExecution).toEqual(policy)
    expect(parsed.guide.workflows[0]?.promptTemplate).toBe(
      '/graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Preserve the approved criteria and require evidence."',
    )
  })

  it.each([
    "/graph-of-loops {{intent}}. Inspect and resume the existing run.",
    'Use /graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Require evidence."',
    '/graph-of-loops OBJECTIVE="{{intent}}"',
    '/graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS=""',
    '/graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="   "',
    '/graph-of-loops OBJECTIVE="A different task" CONSTRAINTS="{{intent}}"',
    '/graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Require evidence." Then start another run.',
  ])("rejects a Graph workflow without a real goal-start frame: %s", (promptTemplate) => {
    const source = graphGuide.replace(
      '/graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Preserve the approved criteria and require evidence."',
      promptTemplate,
    )
    expect(() =>
      parseProfileGuide(
        "sandbox/claude-graph-of-loops.md",
        withGoalExecution({ controller: "graph-of-loops", workflowIds: ["post-writer"] }, source),
      ),
    ).toThrow("goal-start frame")
  })

  it("rejects Graph frames bound to another skill or a second goal controller", () => {
    for (const source of [
      graphGuide.replace("skill: graph-of-loops", "skill: test-driven-development"),
      graphGuide.replace("Preserve the approved criteria and require evidence.", "Run /goal for completion."),
    ]) {
      expect(() =>
        parseProfileGuide(
          "sandbox/claude-graph-of-loops.md",
          withGoalExecution({ controller: "graph-of-loops", workflowIds: ["post-writer"] }, source),
        ),
      ).toThrow(ProfileGuideValidationError)
    }
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
      await expect(discoverProfileGuideRelativePaths(root)).resolves.toEqual(["native/cpx/hve.md", "sandbox/social.md"])
    })

    it("rejects symlinked guides", async () => {
      const root = await temporaryRoot()
      const outside = path.join(root, "outside.md")
      await mkdir(path.join(root, "native", "cpx"), { recursive: true })
      await mkdir(path.join(root, "sandbox"), { recursive: true })
      await writeFile(outside, validGuide)
      await symlink(outside, path.join(root, "native", "cpx", "hve.md"))

      await expect(loadProfileGuide(root, { surface: "native", launcher: "cpx", profile: "hve" })).rejects.toThrow(
        "non-symlink regular file",
      )
    })
  })
})
