import { describe, expect, it } from "vitest"

import type { ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import type { GuideGenerateCandidate } from "../src/guide-provider.js"
import {
  GuideWorkflowBodyError,
  guideWorkflowCommandTokens,
  renderWorkflowBodyCandidate,
  resolveGeneratedWorkflowBodyCandidate,
  resolveRefinedWorkflowBodyCandidate,
  resolveWorkflowBodyCandidate,
  restoreWorkflowCandidateFrame,
  workflowAuthorizationBody,
  workflowBodyCandidate,
  workflowPromptFrame,
} from "../src/guide-workflow-prompt.js"

const guide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["structured-workflows"],
  bestFor: ["Structured engineering"],
  avoidFor: ["Unrelated prose"],
  prerequisites: [],
  workflows: [
    {
      id: "plan",
      description: "Draft an implementation plan.",
      skill: "writing-plans",
      examples: ["Plan this feature", "Draft a phased plan"],
      promptTemplate: "Use the writing-plans skill:\n{{intent}}",
    },
    {
      id: "compound",
      description: "Capture a verified learning.",
      skill: "ce-compound",
      examples: ["Capture this fix", "Record this solution"],
      promptTemplate: "/ce-compound mode:non-interactive {{intent}}",
    },
    {
      id: "blog",
      description: "Draft a blog post.",
      skill: "blog-write",
      examples: ["Draft a launch post", "Write a technical article"],
      promptTemplate: "/blog write {{intent}}",
    },
    {
      id: "lfg",
      description: "Deliver a change.",
      skill: "lfg",
      examples: ["Ship this feature", "Open a pull request"],
      promptTemplate: "/lfg {{intent}}",
    },
    {
      id: "polish",
      description: "Review and polish.",
      skill: "pstack-for-codex:interrogate",
      examples: ["Review this diff", "Polish this change"],
      promptTemplate:
        "$pstack-for-codex:interrogate {{intent}}\n" + "$pstack-for-codex:no-comments\n" + "$pstack-for-codex:unslop",
    },
    {
      id: "poteto",
      description: "Run Poteto Mode.",
      skill: "pstack-for-codex:poteto-mode",
      examples: ["Implement this feature", "Fix this defect"],
      promptTemplate: "$poteto-mode\n$pstack-for-codex:poteto-mode {{intent}}",
    },
    {
      id: "superpowers",
      description: "Plan, execute, and finish a development branch.",
      skill: "writing-plans",
      examples: ["Plan and implement this feature", "Finish this approved plan"],
      promptTemplate:
        "Use the writing-plans skill to draft a plan for {{intent}}, then\n" +
        "executing-plans to carry it out, and finishing-a-development-branch to\n" +
        "close it out.",
    },
  ],
}

const councilSuffix =
  "\n\nChallenge the assumptions, identify risks and failure modes, compare credible alternatives,\n" +
  "assess feasibility and implementation tradeoffs, and recommend concrete next steps."
const researchSuffix =
  "\n\nFind relevant prior art and source-backed evidence, identify unresolved questions and risks,\n" +
  "compare implementation options, and explain how the findings should change the approach."

const currentCommandProseGuide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["command-prose-workflows"],
  bestFor: ["Council deliberation", "Vault-backed research"],
  avoidFor: ["Unrelated prose", "Direct implementation"],
  prerequisites: [],
  workflows: [
    {
      id: "run-council-deliberation",
      description: "Run the current Council deliberation frame.",
      skill: "council",
      examples: ["Pressure-test this architecture", "Challenge this product decision"],
      promptTemplate:
        "/council Pressure-test this idea and its implementation: {{intent}}" +
        councilSuffix,
    },
    {
      id: "vault-backed-research",
      description: "Run the current Research evidence frame.",
      skill: "hyperresearch",
      examples: ["Research this implementation approach", "Compare these options with sources"],
      promptTemplate:
        "/hyperresearch Research the evidence that should inform this request before implementation: {{intent}}" +
        researchSuffix,
    },
  ],
}

const currentCommandProseCases = [
  {
    name: "Council",
    workflowId: "run-council-deliberation",
    command: "/council",
    body: "Should we adopt event sourcing for billing?",
    suffix: councilSuffix,
    partialSuffix: "\n\nChallenge the assumptions, identify risks and failure modes",
    alteredSuffix: councilSuffix.replace("credible alternatives", "convenient alternatives"),
    ordinaryBody: "Challenge the assumptions and record why the final recommendation ends differently.",
    suffixSignal: "Challenge the assumptions",
  },
  {
    name: "Research",
    workflowId: "vault-backed-research",
    command: "/hyperresearch",
    body: "Compare passkeys with passwords for enterprise support costs.",
    suffix: researchSuffix,
    partialSuffix: "\n\nFind relevant prior art and source-backed evidence",
    alteredSuffix: researchSuffix.replace("unresolved questions", "settled questions"),
    ordinaryBody: "Find relevant prior art, but finish with a source list that ends differently.",
    suffixSignal: "Find relevant prior art",
  },
] as const

const punctuationOnlySuffixGuide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["body-only-generation"],
  bestFor: ["Current punctuation-suffix workflows"],
  avoidFor: ["Unrelated prose"],
  prerequisites: [],
  workflows: [
    {
      id: "visual-artifact",
      description: "Create a self-contained visual artifact.",
      skill: "html",
      examples: ["Create a visual report"],
      promptTemplate: "Use the html skill to create a self-contained visual artifact for\n{{intent}}.",
    },
    {
      id: "test-driven-development",
      description: "Drive an implementation from a failing test.",
      skill: "test-driven-development",
      examples: ["Fix this regression test-first"],
      promptTemplate:
        "Use the test-driven-development and systematic-debugging skills to\naddress {{intent}}.",
    },
    {
      id: "poteto-mode-orchestration",
      description: "Coordinate multi-step work with Poteto Mode.",
      skill: "skill://poteto-mode",
      examples: ["Coordinate this migration"],
      promptTemplate: "Use skill://poteto-mode to plan and coordinate {{intent}}.",
    },
  ],
}

const punctuationOnlySuffixCases = [
  {
    name: "Plannotator visual-artifact",
    workflowId: "visual-artifact",
    body: "Explain the queue architecture in a browser-ready artifact.",
  },
  {
    name: "Superpowers test-driven-development",
    workflowId: "test-driven-development",
    body: "Fix the retry race from a failing regression test.",
  },
  {
    name: "OMP poteto-mode-orchestration",
    workflowId: "poteto-mode-orchestration",
    body: "Coordinate the migration across the API and worker services.",
  },
] as const

const noSkillGuide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["complete-prompts"],
  bestFor: ["Complete prompt generation"],
  avoidFor: ["Body-only generation"],
  prerequisites: [],
  workflows: [
    {
      id: "complete-review",
      description: "Prepare a complete review prompt.",
      examples: ["Review this change", "Review this design"],
      promptTemplate: "Review the request completely:\n{{intent}}",
    },
    {
      id: "command-delivery",
      description: "Prepare a complete delivery prompt.",
      examples: ["Ship this change", "Deliver this fix"],
      promptTemplate: "/lfg {{intent}}",
    },
  ],
}

const workflow = (id: string) => {
  const selected = guide.workflows.find((candidate) => candidate.id === id)
  if (selected === undefined) throw new Error(`Unknown test workflow: ${id}`)
  return selected
}

const noSkillWorkflow = (id: string) => {
  const selected = noSkillGuide.workflows.find((candidate) => candidate.id === id)
  if (selected === undefined) throw new Error(`Unknown no-skill workflow: ${id}`)
  return selected
}

const currentCommandProseWorkflow = (id: string) => {
  const selected = currentCommandProseGuide.workflows.find((candidate) => candidate.id === id)
  if (selected === undefined) throw new Error(`Unknown current command-prose workflow: ${id}`)
  return selected
}

const punctuationOnlySuffixWorkflow = (id: string) => {
  const selected = punctuationOnlySuffixGuide.workflows.find((candidate) => candidate.id === id)
  if (selected === undefined) throw new Error(`Unknown punctuation-only suffix workflow: ${id}`)
  return selected
}

const candidate = (prompt: string, overrides: Partial<GuideGenerateCandidate> = {}): GuideGenerateCandidate => ({
  title: "Focused",
  prompt,
  notes: "Keeps the request focused.",
  ...overrides,
})

describe("workflow prompt frames", () => {
  it("extracts and renders the exact authored prefix, suffix, and fixed arguments", () => {
    const selected = workflow("compound")
    expect(workflowPromptFrame(selected)).toEqual({
      beforeBody: "/ce-compound mode:non-interactive ",
      afterBody: "",
    })

    const rendered = candidate("/ce-compound mode:non-interactive Capture the retry fix.")
    expect(workflowBodyCandidate(selected, rendered).prompt).toBe("Capture the retry fix.")
    expect(renderWorkflowBodyCandidate(selected, rendered)).toEqual(rendered)
  })

  it("normalizes exact prose frames before comparison and rendering", () => {
    const selected = workflow("plan")
    const authorized = candidate("Plan the retry migration.")
    const optimized = candidate("Use the writing-plans skill:\nPlan the retry migration in phases.", {
      title: "Phased plan",
      notes: "Adds clear phases.",
    })

    expect(renderWorkflowBodyCandidate(selected, optimized)).toEqual(optimized)
    const resolved = resolveWorkflowBodyCandidate(guide, selected, authorized, optimized)
    expect(resolved.prompt).toBe("Plan the retry migration in phases.")
    expect(renderWorkflowBodyCandidate(selected, resolved)).toEqual({
      title: "Phased plan",
      prompt: "Use the writing-plans skill:\nPlan the retry migration in phases.",
      notes: "Adds clear phases.",
    })
  })

  it("treats a non-exact direct edit as the whole body and restores the frame once", () => {
    const selected = workflow("compound")
    const edited = candidate("/ce-compound mode:interactive Capture the retry fix.")

    expect(restoreWorkflowCandidateFrame(selected, edited).prompt).toBe(
      "/ce-compound mode:non-interactive /ce-compound mode:interactive Capture the retry fix.",
    )
  })

  it("keeps whitespace-reflowed direct edits on the exact-only body path", () => {
    const selected = workflow("plan")
    const edited = candidate("Use the writing-plans skill:  Plan the retry fix.")

    expect(workflowBodyCandidate(selected, edited)).toBe(edited)
    expect(restoreWorkflowCandidateFrame(selected, edited).prompt).toBe(
      "Use the writing-plans skill:\nUse the writing-plans skill:  Plan the retry fix.",
    )
  })
})

describe("closed guide command tokens", () => {
  it("derives only exact command-led tokens from authored templates", () => {
    expect(guideWorkflowCommandTokens(guide)).toEqual([
      "/ce-compound",
      "/blog",
      "/lfg",
      "$pstack-for-codex:interrogate",
      "$pstack-for-codex:no-comments",
      "$pstack-for-codex:unslop",
      "$poteto-mode",
      "$pstack-for-codex:poteto-mode",
    ])
  })

  it.each([
    ["slash command", "Capture the retry fix.\n/lfg"],
    ["namespaced dollar command", "Capture the retry fix with $pstack-for-codex:unslop."],
    ["standalone dollar command", "Capture the retry fix with $poteto-mode."],
  ])("fails closed when generation adds a guide-known %s", (_kind, prompt) => {
    const generated = candidate(prompt, {
      title: "Generated option",
      notes: "Generated notes.",
    })

    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(guide, workflow("compound"), "Capture the retry fix.", generated),
    ).toThrow(GuideWorkflowBodyError)
  })

  it.each([
    ["case-variant known command", "/LFG"],
    ["hyphenated command", "/evil-command"],
    ["dotted slash command with arguments", "/evil.command run now"],
    ["dotted slash command without arguments", "/evil.command"],
    ["argument-bearing command", "/unknown do work"],
    ["dotted dollar command", "$evil.command"],
  ])("rejects a new executable %s line from no-skill generation", (_kind, command) => {
    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        noSkillGuide,
        noSkillWorkflow("complete-review"),
        "Review the retry fix.",
        candidate(`Review the retry fix completely.\n${command}`),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("preserves bare, dotted, nested, and URL paths in no-skill generation", () => {
    const generated = candidate(
      [
        "Review these repository and API references:",
        "/api",
        "/health",
        "/src",
        "/docs",
        "/README.md",
        "/tmp/output.json",
        "/v1/users.json",
        "https://example.test/login?next=/dashboard",
      ].join("\n"),
    )

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        noSkillGuide,
        noSkillWorkflow("complete-review"),
        "Review repository paths.",
        generated,
      ),
    ).toBe(generated)
  })

  it("preserves authorized template and user commands in no-skill complete prompts", () => {
    const commandWorkflow = noSkillWorkflow("command-delivery")
    const templateCommandCandidate = candidate("/LFG Ship the retry fix with tests.")
    expect(
      resolveGeneratedWorkflowBodyCandidate(
        noSkillGuide,
        commandWorkflow,
        "Ship the retry fix.",
        templateCommandCandidate,
      ),
    ).toBe(templateCommandCandidate)

    const reviewWorkflow = noSkillWorkflow("complete-review")
    const intent = "Review the retry fix.\n/custom-validation --strict"
    const userCommandCandidate = candidate(
      "Review the request completely and report evidence.\n/custom-validation --strict",
    )
    expect(
      resolveGeneratedWorkflowBodyCandidate(
        noSkillGuide,
        reviewWorkflow,
        intent,
        userCommandCandidate,
      ),
    ).toBe(userCommandCandidate)
    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        noSkillGuide,
        commandWorkflow,
        "Ship the retry fix.",
        candidate("Ship the retry fix with tests."),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("keeps safe no-skill complete prompts unchanged without body rendering", () => {
    const selected = noSkillWorkflow("complete-review")
    const generated = candidate("Audit the retry fix, verify evidence, and report concrete findings.")
    const optimized = candidate("Audit the retry fix and report only verified, concrete findings.")

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        noSkillGuide,
        selected,
        "Review the retry fix.",
        generated,
      ),
    ).toBe(generated)
    expect(resolveWorkflowBodyCandidate(noSkillGuide, selected, generated, optimized)).toBe(optimized)
    expect(renderWorkflowBodyCandidate(selected, optimized)).toBe(optimized)
  })

  it("preserves bare single-segment paths through no-skill refinement and optimization", () => {
    const selected = noSkillWorkflow("complete-review")
    const authorized = candidate("Audit the retry fix and report verified findings.")
    const pathLines = ["/api", "/health", "/src", "/docs"].join("\n")
    const refined = candidate(`${authorized.prompt}\n${pathLines}`)
    const optimized = candidate(`Audit the retry fix with concise evidence.\n${pathLines}`)

    expect(
      resolveRefinedWorkflowBodyCandidate(noSkillGuide, selected, authorized, refined),
    ).toBe(refined)
    expect(resolveWorkflowBodyCandidate(noSkillGuide, selected, refined, optimized)).toBe(optimized)
  })

  it("preserves an authorized command through no-skill refinement and optimization", () => {
    const selected = noSkillWorkflow("complete-review")
    const authorized = candidate("/Custom-Validation Audit the retry fix.")
    const refined = candidate("/custom-validation Audit the retry fix and report evidence.")
    const optimized = candidate("/CUSTOM-VALIDATION Audit the retry fix and report verified evidence.")

    expect(
      resolveRefinedWorkflowBodyCandidate(noSkillGuide, selected, authorized, refined),
    ).toBe(refined)
    expect(resolveWorkflowBodyCandidate(noSkillGuide, selected, refined, optimized)).toBe(optimized)
    expect(renderWorkflowBodyCandidate(selected, optimized)).toBe(optimized)
  })

  it.each([
    ["known command", "/lfg"],
    ["hyphenated command", "/evil-command"],
    ["dotted command", "/evil.command"],
    ["argument-bearing command", "/unknown do work"],
  ])(
    "rejects a no-skill refinement with a new %s and retains the authorized prompt after optimization",
    (_kind, command) => {
      const selected = noSkillWorkflow("complete-review")
      const authorized = candidate("Audit the retry fix and report verified findings.")
      const unsafe = candidate(`${authorized.prompt}\n${command}`)

      expect(() =>
        resolveRefinedWorkflowBodyCandidate(noSkillGuide, selected, authorized, unsafe),
      ).toThrow(GuideWorkflowBodyError)
      expect(resolveWorkflowBodyCandidate(noSkillGuide, selected, authorized, unsafe)).toBe(authorized)
    },
  )

  it.each(currentCommandProseCases)(
    "authorizes body-only generation from a documented command-prefixed $name intent",
    ({ workflowId, command, body }) => {
      const selected = currentCommandProseWorkflow(workflowId)

      expect(
        resolveGeneratedWorkflowBodyCandidate(
          currentCommandProseGuide,
          selected,
          `${command} ${body}`,
          candidate(body),
        ).prompt,
      ).toBe(body)
    },
  )

  it("does not reject a user-authored Council intent as unsafe model output while normalizing its command", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const body = "Should we adopt event sourcing for billing?"
    const authoredIntent = `/council ${body}\n\nChallenge the assumptions, identify risks`

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        authoredIntent,
        candidate(body),
      ).prompt,
    ).toBe(body)
  })

  it.each(punctuationOnlySuffixCases)(
    "strips one exact punctuation suffix from a normal sentence-ending body for $name",
    ({ workflowId, body }) => {
      const selected = punctuationOnlySuffixWorkflow(workflowId)
      const generated = candidate(body)
      const resolved = resolveGeneratedWorkflowBodyCandidate(
        punctuationOnlySuffixGuide,
        selected,
        body,
        generated,
      )

      expect(resolved).toEqual({ ...generated, prompt: body.slice(0, -1) })
      expect(renderWorkflowBodyCandidate(selected, resolved).prompt).toBe(
        selected.promptTemplate.replace("{{intent}}", body.slice(0, -1)),
      )
      expect(renderWorkflowBodyCandidate(selected, generated).prompt.endsWith("..")).toBe(false)
    },
  )

  it.each(currentCommandProseCases)(
    "strips an exact command-only $name suffix echo and renders the current frame once",
    ({ workflowId, command, body, suffix, suffixSignal }) => {
      const selected = currentCommandProseWorkflow(workflowId)
      const resolved = resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(`${command} ${body}${suffix}`),
      )

      expect(resolved.prompt).toBe(body)
      const rendered = renderWorkflowBodyCandidate(selected, resolved)
      expect(rendered.prompt).toBe(selected.promptTemplate.replace("{{intent}}", body))
      expect(rendered.prompt.split(suffixSignal)).toHaveLength(2)
    },
  )

  it.each(currentCommandProseCases)(
    "strips a whitespace-reflowed command-only $name suffix echo and renders the current frame once",
    ({ workflowId, command, body, suffix, suffixSignal }) => {
      const selected = currentCommandProseWorkflow(workflowId)
      const reflowedSuffix = ` \n\t${suffix.trim().split(/\s+/u).join("\n  ")}`
      const resolved = resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(`${command}\t${body}${reflowedSuffix}`),
      )

      expect(resolved.prompt).toBe(body)
      const rendered = renderWorkflowBodyCandidate(selected, resolved)
      expect(rendered.prompt).toBe(selected.promptTemplate.replace("{{intent}}", body))
      expect(rendered.prompt.split(suffixSignal)).toHaveLength(2)
    },
  )

  it.each(currentCommandProseCases)(
    "fails closed on partial or materially altered $name suffix echoes after full-prefix and command-only matches",
    ({ workflowId, command, body, partialSuffix, alteredSuffix }) => {
      const selected = currentCommandProseWorkflow(workflowId)
      const frame = workflowPromptFrame(selected)
      for (const proposedPrefix of [frame.beforeBody, `${command} `]) {
        for (const invalidSuffix of [partialSuffix, alteredSuffix]) {
          expect(() =>
            resolveGeneratedWorkflowBodyCandidate(
              currentCommandProseGuide,
              selected,
              body,
              candidate(`${proposedPrefix}${body}${invalidSuffix}`),
            ),
          ).toThrow(GuideWorkflowBodyError)
        }
      }
    },
  )

  it.each(currentCommandProseCases)(
    "accepts a command-only $name echo with no suffix and restores the authored suffix once",
    ({ workflowId, command, body, suffixSignal }) => {
      const selected = currentCommandProseWorkflow(workflowId)
      const resolved = resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(`${command} ${body}`),
      )

      expect(resolved.prompt).toBe(body)
      const rendered = renderWorkflowBodyCandidate(selected, resolved)
      expect(rendered.prompt).toBe(selected.promptTemplate.replace("{{intent}}", body))
      expect(rendered.prompt.split(suffixSignal)).toHaveLength(2)
    },
  )

  it.each(currentCommandProseCases)(
    "preserves ordinary $name body text that ends differently from the authored suffix",
    ({ workflowId, command, ordinaryBody }) => {
      const selected = currentCommandProseWorkflow(workflowId)

      expect(
        resolveGeneratedWorkflowBodyCandidate(
          currentCommandProseGuide,
          selected,
          ordinaryBody,
          candidate(`${command} ${ordinaryBody}`),
        ).prompt,
      ).toBe(ordinaryBody)
    },
  )

  it("rejects the exact Council trailing suffix fragment from body-only generation", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const body = "Should we adopt event sourcing for billing?"
    const trailingFragment =
      "Assess feasibility and implementation tradeoffs, and recommend concrete next steps."

    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(`${body}\n\n${trailingFragment}`),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("rejects a substantial Council suffix-head fragment introduced in the middle of the body", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const body = "Should we adopt event sourcing for billing?"
    const proposed =
      `${body}\n\nChallenge the assumptions, identify risks and failure modes before deciding.\n` +
      "Then summarize the recommendation."

    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(proposed),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("rejects a substantive Council suffix middle window introduced in the body", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const body = "Should we adopt event sourcing for billing?"
    const proposed =
      `${body}\n\nBefore deciding, identify risks and failure modes for the rollout.\n` +
      "Then summarize the recommendation."

    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(proposed),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("preserves an authorized Council suffix middle window without allowing a second occurrence", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const body = "Identify risks and failure modes before choosing a design."
    const proposed = `${body}\nThen compare rollout costs.`

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(proposed),
      ).prompt,
    ).toBe(proposed)
    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(`${proposed}\nIdentify risks and failure modes again.`),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it.each([
    "Identify operational risks and describe likely failure modes.",
    "Identify risks and likely failure modes before deciding.",
    "List risks, failure scenarios, and safe recovery modes.",
  ])("preserves related Council prose without a substantive contiguous suffix window: %s", (body) => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        "Should we adopt event sourcing?",
        candidate(body),
      ).prompt,
    ).toBe(body)
  })
  it("preserves an authorized Council body that already ends with a suffix-tail phrase", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const body = "We need concrete next steps."
    const authorized = candidate(body)

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(body),
      ).prompt,
    ).toBe(body)
    expect(resolveWorkflowBodyCandidate(currentCommandProseGuide, selected, authorized, candidate(body))).toEqual(
      authorized,
    )
  })

  it("normalizes a commandless Council fixed prose prefix before rendering once", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const body = "adopt event sourcing."
    const resolved = resolveGeneratedWorkflowBodyCandidate(
      currentCommandProseGuide,
      selected,
      body,
      candidate(`Pressure-test this idea and its implementation: ${body}`),
    )

    expect(resolved.prompt).toBe(body)
    const rendered = renderWorkflowBodyCandidate(selected, resolved)
    expect(rendered.prompt).toBe(selected.promptTemplate.replace("{{intent}}", body))
    expect(rendered.prompt.match(/Pressure-test this idea and its implementation:/gu)).toHaveLength(1)
  })

  it.each([
    [
      "exact",
      "Pressure-test this idea and its implementation: adopt event sourcing.",
    ],
    [
      "whitespace-flexible",
      "Pressure-test  this idea and its implementation:\n adopt event sourcing.",
    ],
    [
      "case and punctuation normalized",
      "PRESSURE test this IDEA and its IMPLEMENTATION - adopt event sourcing.",
    ],
  ])("normalizes a %s commandless Council prefix from authored intent", (_kind, intent) => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")

    expect(workflowAuthorizationBody(selected, intent)).toBe("adopt event sourcing.")
  })

  it("normalizes a case and punctuation variant of the commandless Council prefix from model output", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const body = "adopt event sourcing."
    const resolved = resolveGeneratedWorkflowBodyCandidate(
      currentCommandProseGuide,
      selected,
      body,
      candidate("PRESSURE test this IDEA and its IMPLEMENTATION: adopt event sourcing."),
    )

    expect(resolved.prompt).toBe(body)
    const rendered = renderWorkflowBodyCandidate(selected, resolved)
    expect(rendered.prompt).toBe(selected.promptTemplate.replace("{{intent}}", body))
    expect(rendered.prompt.match(/Pressure-test this idea and its implementation:/gu)).toHaveLength(1)
  })

  it("normalizes repeated commandless Council prefixes and renders idempotently", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const prefix = "Pressure-test this idea and its implementation: "
    const body = "adopt event sourcing."
    const resolved = resolveGeneratedWorkflowBodyCandidate(
      currentCommandProseGuide,
      selected,
      body,
      candidate(`${prefix}${prefix}${body}`),
    )

    expect(resolved.prompt).toBe(body)
    const renderedOnce = renderWorkflowBodyCandidate(selected, resolved)
    const renderedTwice = renderWorkflowBodyCandidate(selected, renderedOnce)
    expect(renderedTwice).toEqual(renderedOnce)
    expect(renderedOnce.prompt.match(/Pressure-test this idea and its implementation:/gu)).toHaveLength(1)
  })

  it("rejects a newly introduced partial commandless Council fixed prose prefix", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")

    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        "adopt event sourcing.",
        candidate("PRESSURE test this idea before adopting event sourcing."),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("preserves a legitimate commandless Council prefix fragment already authorized by the user", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const body = "Pressure test this idea with the architecture group."

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(body),
      ).prompt,
    ).toBe(body)
  })

  it.each([
    "Keep the final request open to a challenge.",
    "End with actionable steps.",
  ])("preserves a safe Council body ending that shares only one generic suffix word: %s", (body) => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        body,
        candidate(body),
      ).prompt,
    ).toBe(body)
  })

  it("normalizes a leading selected command echo that omits fixed arguments", () => {
    const generated = candidate("/ce-compound Capture the bounded generated fix.", {
      title: "Bounded learning",
      notes: "Describes the generated body.",
    })

    expect(
      resolveGeneratedWorkflowBodyCandidate(guide, workflow("compound"), "Capture the retry fix.", generated),
    ).toEqual({
      title: "Bounded learning",
      prompt: "Capture the bounded generated fix.",
      notes: "Describes the generated body.",
    })
  })

  it("normalizes an exact generated command frame to its body", () => {
    expect(
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        "Capture the retry fix.",
        candidate("/ce-compound mode:non-interactive Capture the generated retry fix."),
      ).prompt,
    ).toBe("Capture the generated retry fix.")
  })

  it("normalizes the complete selected fixed prefix with flexible whitespace", () => {
    const selected = workflow("compound")
    const body = resolveGeneratedWorkflowBodyCandidate(
      guide,
      selected,
      "Capture the retry fix.",
      candidate("/ce-compound  mode:non-interactive Capture the generated retry fix."),
    )

    expect(body.prompt).toBe("Capture the generated retry fix.")
    expect(renderWorkflowBodyCandidate(selected, body).prompt).toBe(
      "/ce-compound mode:non-interactive Capture the generated retry fix.",
    )
  })

  it.each(["--mode=non-interactive", "non-interactive", "mode:non", "mode:interactive"])(
    "fails closed when generation partially or incorrectly echoes the fixed argument as %s",
    (fixedArgument) => {
      expect(() =>
        resolveGeneratedWorkflowBodyCandidate(
          guide,
          workflow("compound"),
          "Capture the retry fix.",
          candidate(`/ce-compound ${fixedArgument} Capture the generated retry fix.`),
        ),
      ).toThrow(/partially or incorrectly echoed/u)
    },
  )

  it.each([
    ["exact whitespace", "/blog write Draft the launch post."],
    ["reflowed whitespace", "/blog  write\nDraft the launch post."],
  ])("normalizes the authored multi-token invocation with %s", (_kind, prompt) => {
    const selected = workflow("blog")
    const body = resolveGeneratedWorkflowBodyCandidate(guide, selected, "Draft the launch post.", candidate(prompt))

    expect(body.prompt).toBe("Draft the launch post.")
    expect(renderWorkflowBodyCandidate(selected, body).prompt).toBe("/blog write Draft the launch post.")
  })

  it("strips the selected command when all authored fixed arguments are omitted", () => {
    const selected = workflow("blog")
    const body = resolveGeneratedWorkflowBodyCandidate(
      guide,
      selected,
      "Draft the launch post.",
      candidate("/blog Draft the launch post."),
    )

    expect(body.prompt).toBe("Draft the launch post.")
    expect(renderWorkflowBodyCandidate(selected, body).prompt).toBe("/blog write Draft the launch post.")
  })

  it.each(["/blog-write", "$blog-write"])(
    "fails closed on workflow-skill alias %s when it differs from the authored invocation",
    (alias) => {
      expect(() =>
        resolveGeneratedWorkflowBodyCandidate(
          guide,
          workflow("blog"),
          "Draft the launch post.",
          candidate(`${alias} Draft the launch post.`),
        ),
      ).toThrow(GuideWorkflowBodyError)
    },
  )

  it("uses the placeholder-line invocation and restores the earlier hook in authored order", () => {
    const selected = workflow("poteto")
    const body = resolveGeneratedWorkflowBodyCandidate(
      guide,
      selected,
      "Implement the queue.",
      candidate("$pstack-for-codex:poteto-mode Implement the queue safely."),
    )

    expect(body.prompt).toBe("Implement the queue safely.")
    expect(renderWorkflowBodyCandidate(selected, body).prompt).toBe(
      "$poteto-mode\n$pstack-for-codex:poteto-mode Implement the queue safely.",
    )
    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        selected,
        "Implement the queue.",
        candidate("$poteto-mode Implement the queue safely."),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("normalizes reflowed pstack suffix commands and restores their exact order", () => {
    const selected = workflow("polish")
    const body = resolveGeneratedWorkflowBodyCandidate(
      guide,
      selected,
      "Review the queue.",
      candidate(
        "$pstack-for-codex:interrogate  Review the queue safely.\n\n" +
          "$pstack-for-codex:no-comments \n$pstack-for-codex:unslop",
      ),
    )

    expect(body.prompt).toBe("Review the queue safely.")
    expect(renderWorkflowBodyCandidate(selected, body).prompt).toBe(
      "$pstack-for-codex:interrogate Review the queue safely.\n" +
        "$pstack-for-codex:no-comments\n$pstack-for-codex:unslop",
    )
  })

  it("normalizes whitespace-only reflow across an authored prose prefix and suffix", () => {
    const selected = workflow("superpowers")
    const body = resolveGeneratedWorkflowBodyCandidate(
      guide,
      selected,
      "Implement the upload feature",
      candidate(
        "Use  the writing-plans skill to draft a plan for\n" +
          "Implement the upload feature, then executing-plans to carry it out, and " +
          "finishing-a-development-branch to close it out.",
      ),
    )

    expect(body.prompt).toBe("Implement the upload feature")
    expect(renderWorkflowBodyCandidate(selected, body).prompt).toBe(
      "Use the writing-plans skill to draft a plan for Implement the upload feature, then\n" +
        "executing-plans to carry it out, and finishing-a-development-branch to\n" +
        "close it out.",
    )
  })

  it("normalizes a case and punctuation variant of the Superpowers prose frame", () => {
    const selected = workflow("superpowers")
    const body = resolveGeneratedWorkflowBodyCandidate(
      guide,
      selected,
      "Implement the upload feature",
      candidate(
        "USE THE WRITING PLANS SKILL TO DRAFT A PLAN FOR Implement the upload feature, then\n" +
          "executing-plans to carry it out, and finishing-a-development-branch to\n" +
          "close it out.",
      ),
    )

    expect(body.prompt).toBe("Implement the upload feature")
    const rendered = renderWorkflowBodyCandidate(selected, body)
    expect(rendered.prompt).toBe(
      "Use the writing-plans skill to draft a plan for Implement the upload feature, then\n" +
        "executing-plans to carry it out, and finishing-a-development-branch to\n" +
        "close it out.",
    )
    expect(rendered.prompt.match(/writing-plans skill to draft a plan/giu)).toHaveLength(1)
  })

  it.each([
    ["trailing spaces", "Fix it. "],
    ["trailing newline", "Fix it.\n"],
  ])("deduplicates a punctuation suffix before %s", (_kind, prompt) => {
    const selected = punctuationOnlySuffixWorkflow("visual-artifact")
    const resolved = resolveGeneratedWorkflowBodyCandidate(
      punctuationOnlySuffixGuide,
      selected,
      "Fix it.",
      candidate(prompt),
    )

    expect(resolved.prompt).toBe("Fix it")
    expect(renderWorkflowBodyCandidate(selected, resolved).prompt).toBe(
      "Use the html skill to create a self-contained visual artifact for\nFix it.",
    )
    expect(renderWorkflowBodyCandidate(selected, candidate(prompt)).prompt).toBe(
      "Use the html skill to create a self-contained visual artifact for\nFix it.",
    )
  })

  it("fails closed on a materially altered authored prose frame", () => {
    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        workflow("superpowers"),
        "Implement the upload feature",
        candidate(
          "Use the writing-plans skill to draft a checklist for " +
            "Implement the upload feature, then executing-plans to carry it out, and " +
            "finishing-a-development-branch to close it out.",
        ),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it.each([
    ["Compound command", "Capture the retry fix.\n  /ce-commit-push-pr"],
    ["case-variant LFG command", "Capture the retry fix.\n/LFG"],
    ["dotted slash command with arguments", "Capture the retry fix.\n/evil.command run now"],
    ["dotted slash command without arguments", "Capture the retry fix.\n/evil.command"],
    ["dotted dollar command", "Capture the retry fix.\n$evil.command"],
  ])("fails closed when generation adds any executable %s", (_kind, prompt) => {
    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        "Capture the retry fix.",
        candidate(prompt),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("allows an unknown command occurrence already authorized by the user, with canonical command casing", () => {
    const intent = "/Custom-Validation Capture the retry fix."
    const proposed = candidate("/custom-validation Capture the retry fix.")

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        intent,
        proposed,
      ),
    ).toBe(proposed)
  })

  it("preserves authorized dotted slash and dollar commands for no-skill and skill workflows", () => {
    const authorizedCommands = "/evil.command\n$evil.command"
    const canonicalizedCommands = "/EVIL.COMMAND\n$EVIL.COMMAND"
    const noSkillCandidate = candidate(
      `Review the request completely and preserve these commands:\n${canonicalizedCommands}`,
    )
    expect(
      resolveGeneratedWorkflowBodyCandidate(
        noSkillGuide,
        noSkillWorkflow("complete-review"),
        authorizedCommands,
        noSkillCandidate,
      ),
    ).toBe(noSkillCandidate)

    const skillCandidate = candidate(canonicalizedCommands)
    expect(
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        authorizedCommands,
        skillCandidate,
      ),
    ).toBe(skillCandidate)
  })

  it("preserves URLs, paths, data examples, code examples, currency, and normal slash text", () => {
    const prompt = [
      "Use https://example.test/login?next=/dashboard and https://example.test/api/v2/items.",
      "Read /README.md and /tmp, then call /api and /api/v2/items.",
      "/README.md is the repository overview.",
      "/api",
      "/health",
      "/src",
      "/docs",
      "/tmp",
      "/tmp/output.json",
      "/v1/users.json",
      "/api/v2/items",
      '{"redirect":"/dashboard","example":"/LFG"}',
      "",
      "```text",
      "/ce-commit-push-pr",
      "$unknown:skill",
      "```",
      "",
      "    /ce-commit-push-pr",
      'Show `/LFG` and `{ "$ref": "#/$defs/item" }`.',
      "Use https://example.test/Products?$filter=Price%20gt%2010&$select=Name.",
      "Read $HOME and $output_dir with a $19.99 budget.",
      "Compare input/output and yes/no examples.",
      "Discuss whether /LFG or /ce-commit-push-pr is appropriate without invoking either.",
    ].join("\n")
    const generated = candidate(prompt)

    expect(
      resolveGeneratedWorkflowBodyCandidate(guide, workflow("compound"), "Capture the retry fix.", generated),
    ).toBe(generated)
  })

  it("does not open a backtick fence whose info string contains a backtick", () => {
    const prompt = ["```bad`info", "/lfg", "```"].join("\n")

    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        "Capture the retry fix.",
        candidate(prompt),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it.each([
    ["valid backtick info", ["```text", "/lfg", "```"]],
    ["tilde info containing a backtick", ["~~~bad`info", "/lfg", "~~~"]],
  ])("keeps command examples masked inside %s fences", (_kind, lines) => {
    const generated = candidate(lines.join("\n"))

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        "Capture the retry fix.",
        generated,
      ),
    ).toBe(generated)
  })

  it("keeps commands masked inside length-aware backtick and tilde fences with reopening", () => {
    const prompt = [
      "````text",
      "~~~",
      "/evil.command run now",
      "~~~",
      "```",
      "/LFG Ship it.",
      "```",
      "`````",
      "~~~text",
      "/evil.command run now",
      "~~~~",
      "```text",
      "/LFG Ship it.",
      "```",
      "Summarize the examples without running them.",
    ].join("\n")
    const generated = candidate(prompt)

    expect(
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        "Capture the retry fix.",
        generated,
      ),
    ).toBe(generated)
  })

  it("resumes slash-command scanning after a longer matching fence closes", () => {
    const prompt = [
      "```text",
      "/evil.command run now",
      "`````",
      "/evil.command run now",
    ].join("\n")

    expect(() =>
      resolveGeneratedWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        "Capture the retry fix.",
        candidate(prompt),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("falls back to the complete authorized body candidate after unsafe optimization", () => {
    const authorized = candidate("Capture the retry fix.", {
      title: "Coherent title",
      notes: "Coherent notes for the retained body.",
    })
    const optimized = candidate("Capture the retry fix.\n/ce-commit-push-pr", {
      title: "Discarded optimization",
      notes: "Notes that describe the discarded command.",
    })

    expect(resolveWorkflowBodyCandidate(guide, workflow("compound"), authorized, optimized)).toBe(authorized)
  })

  it("accepts valid body improvements and normalizes exact frame echoes", () => {
    const selected = workflow("compound")
    const authorized = candidate("Capture the retry fix.")
    const optimized = candidate("Capture the verified retry race and its database fix.", {
      title: "Sharper",
      notes: "Adds the verified cause and solution.",
    })

    const safeBody = resolveWorkflowBodyCandidate(guide, selected, authorized, optimized)
    expect(safeBody.prompt).toBe("Capture the verified retry race and its database fix.")
    expect(renderWorkflowBodyCandidate(selected, safeBody)).toEqual({
      title: "Sharper",
      prompt: "/ce-compound mode:non-interactive Capture the verified retry race and its database fix.",
      notes: "Adds the verified cause and solution.",
    })
    const framedOptimization = candidate(
      "/ce-compound mode:non-interactive Capture the verified retry race and its database fix.",
      {
        title: "Framed optimization",
        notes: "Echoed the exact frame.",
      },
    )
    expect(resolveWorkflowBodyCandidate(guide, selected, authorized, framedOptimization)).toEqual({
      title: "Framed optimization",
      prompt: "Capture the verified retry race and its database fix.",
      notes: "Echoed the exact frame.",
    })
  })

  it("normalizes whitespace-reflowed optimizer frames and falls back on unsupported aliases", () => {
    const proseWorkflow = workflow("superpowers")
    const proseAuthorized = candidate("Implement the upload feature")
    const proseOptimized = candidate(
      "Use the writing-plans skill to draft a plan for\n" +
        "Implement the upload feature safely, then executing-plans to carry it out, and " +
        "finishing-a-development-branch to close it out.",
    )

    expect(resolveWorkflowBodyCandidate(guide, proseWorkflow, proseAuthorized, proseOptimized).prompt).toBe(
      "Implement the upload feature safely",
    )
    expect(
      resolveWorkflowBodyCandidate(
        guide,
        proseWorkflow,
        proseAuthorized,
        candidate(
          "Use the writing-plans skill to draft a checklist for " +
            "Implement the upload feature, then executing-plans to carry it out, and " +
            "finishing-a-development-branch to close it out.",
        ),
      ),
    ).toBe(proseAuthorized)

    const blogAuthorized = candidate("Draft the launch post.")
    expect(
      resolveWorkflowBodyCandidate(
        guide,
        workflow("blog"),
        blogAuthorized,
        candidate("/blog-write Draft a different launch post."),
      ),
    ).toBe(blogAuthorized)

    const compoundAuthorized = candidate("Capture the verified fix.")
    expect(
      resolveWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        compoundAuthorized,
        candidate("/ce-compound --mode=non-interactive Capture a different fix."),
      ),
    ).toBe(compoundAuthorized)
  })

  it("rejects removal or reordering of authorized guide-known body commands", () => {
    const selected = workflow("compound")
    const authorized = candidate("Run these commands in order:\n/lfg\n$pstack-for-codex:unslop")

    expect(
      resolveWorkflowBodyCandidate(
        guide,
        selected,
        authorized,
        candidate("Run these commands in order:\n$pstack-for-codex:unslop\n/lfg"),
      ),
    ).toBe(authorized)
    expect(resolveWorkflowBodyCandidate(guide, selected, authorized, candidate("Capture the retry fix."))).toBe(
      authorized,
    )
  })

  it("normalizes whitespace-reflowed prose frames returned by refinement", () => {
    const selected = workflow("plan")
    const authorized = candidate("Plan the retry migration.")
    const refined = candidate("Use   the writing-plans skill:\n\nPlan the retry migration with rollback steps.", {
      title: "Rollback plan",
      notes: "Adds rollback steps.",
    })

    expect(resolveRefinedWorkflowBodyCandidate(guide, selected, authorized, refined)).toEqual({
      title: "Rollback plan",
      prompt: "Plan the retry migration with rollback steps.",
      notes: "Adds rollback steps.",
    })
  })

  it("fails closed when refinement adds an uncataloged executable command", () => {
    expect(() =>
      resolveRefinedWorkflowBodyCandidate(
        guide,
        workflow("compound"),
        candidate("Capture the retry fix."),
        candidate("Ship the retry fix safely.\n/ce-commit-push-pr"),
      ),
    ).toThrow(GuideWorkflowBodyError)
  })

  it("handles a maximum authorized intent and bounded candidate with linear command and suffix scans", () => {
    const selected = currentCommandProseWorkflow("run-council-deliberation")
    const intent = `Review ${"x ".repeat(29_996)}x`
    const proposed = candidate(`Assess ${"y ".repeat(3_996)}y`)

    expect(intent).toHaveLength(60_000)
    expect(proposed.prompt).toHaveLength(8_000)
    expect(
      resolveGeneratedWorkflowBodyCandidate(
        currentCommandProseGuide,
        selected,
        intent,
        proposed,
      ),
    ).toBe(proposed)
  })
})
