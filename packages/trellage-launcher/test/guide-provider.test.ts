import { describe, expect, it } from "vitest"
import { GuideValidationError } from "../src/guide-text.js"
import {
  assertGuideGenerateInput,
  assertGuideMatchInput,
  validateGuideGenerateResult,
  validateGuideMatchResult,
  validateGuideRefineResult,
  type GuideGenerateInput,
  type GuideMatchInput,
} from "../src/guide-provider.js"
import type { GuideMatchCatalogEntry } from "../src/guide-catalog.js"

const workflowIndex = new Map<string, ReadonlySet<string>>([
  ["native:cpx/plannotator", new Set(["visual-artifact"])],
  ["sandbox:prime-agent", new Set(["review"])],
  ["sandbox:other", new Set(["build"])],
  ["native:cdx/pstack", new Set(["poteto-mode-entry-point"])],
  ["sandbox:headlong", new Set(["persistent-investigation"])],
  ["native:cdx/superpowers", new Set(["systematic-debugging"])],
])

const validMatchCandidate = (overrides: Partial<Record<string, unknown>> = {}) => ({
  profileRef: "native:cpx/plannotator",
  workflowId: "visual-artifact",
  confidence: 0.9,
  reason: "Strong fit for reviewing diffs.",
  tradeoff: "Requires a local git checkout.",
  ...overrides,
})

const validMatchResult = () => ({
  candidates: [
    validMatchCandidate(),
    validMatchCandidate({ profileRef: "sandbox:prime-agent", workflowId: "review" }),
    validMatchCandidate({ profileRef: "sandbox:other", workflowId: "build" }),
  ],
})

const validFiveMatchResult = () => ({
  candidates: [
    validMatchCandidate({ confidence: 0.95 }),
    validMatchCandidate({ profileRef: "sandbox:prime-agent", workflowId: "review", confidence: 0.85 }),
    validMatchCandidate({ profileRef: "sandbox:other", workflowId: "build", confidence: 0.75 }),
    validMatchCandidate({
      profileRef: "native:cdx/pstack",
      workflowId: "poteto-mode-entry-point",
      confidence: 0.65,
    }),
    validMatchCandidate({
      profileRef: "sandbox:headlong",
      workflowId: "persistent-investigation",
      confidence: 0.55,
    }),
  ],
})

describe("validateGuideMatchResult", () => {
  it("accepts three unique, known-reference candidates from an older cached response", () => {
    const result = validateGuideMatchResult(validMatchResult(), workflowIndex)
    expect(result.candidates).toHaveLength(3)
    expect(result.candidates.map((c) => c.profileRef)).toEqual([
      "native:cpx/plannotator",
      "sandbox:prime-agent",
      "sandbox:other",
    ])
  })

  it("accepts five unique, known-reference candidates", () => {
    const result = validateGuideMatchResult(validFiveMatchResult(), workflowIndex)
    expect(result.candidates).toHaveLength(5)
  })

  it("rejects fewer than three candidates", () => {
    const result = { candidates: validMatchResult().candidates.slice(0, 2) }
    expect(() => validateGuideMatchResult(result, workflowIndex)).toThrow(GuideValidationError)
  })

  it("rejects more than five candidates", () => {
    const result = {
      candidates: [
        ...validFiveMatchResult().candidates,
        validMatchCandidate({
          profileRef: "native:cdx/superpowers",
          workflowId: "systematic-debugging",
          confidence: 0.45,
        }),
      ],
    }
    expect(() => validateGuideMatchResult(result, workflowIndex)).toThrow(GuideValidationError)
  })

  it("rejects duplicate profile refs", () => {
    const result = {
      candidates: [
        validMatchCandidate(),
        validMatchCandidate(),
        validMatchCandidate({ profileRef: "sandbox:other", workflowId: "build" }),
      ],
    }
    expect(() => validateGuideMatchResult(result, workflowIndex)).toThrow(GuideValidationError)
  })

  it("rejects an unknown profile ref", () => {
    const result = {
      candidates: [
        validMatchCandidate({ profileRef: "native:unknown/thing" }),
        validMatchCandidate({ profileRef: "sandbox:prime-agent", workflowId: "review" }),
        validMatchCandidate({ profileRef: "sandbox:other", workflowId: "build" }),
      ],
    }
    expect(() => validateGuideMatchResult(result, workflowIndex)).toThrow(GuideValidationError)
  })

  it("rejects an unknown workflow id for a known profile ref", () => {
    const result = {
      candidates: [
        validMatchCandidate({ workflowId: "does-not-exist" }),
        validMatchCandidate({ profileRef: "sandbox:prime-agent", workflowId: "review" }),
        validMatchCandidate({ profileRef: "sandbox:other", workflowId: "build" }),
      ],
    }
    expect(() => validateGuideMatchResult(result, workflowIndex)).toThrow(GuideValidationError)
  })

  it("rejects confidence values outside 0..1", () => {
    const result = { candidates: [validMatchCandidate({ confidence: 1.5 }), ...validMatchResult().candidates.slice(1)] }
    expect(() => validateGuideMatchResult(result, workflowIndex)).toThrow(GuideValidationError)
  })

  it("rejects a candidate with an extra command-like field", () => {
    const result = {
      candidates: [
        validMatchCandidate({ command: "rm -rf /" }),
        validMatchCandidate({ profileRef: "sandbox:prime-agent", workflowId: "review" }),
        validMatchCandidate({ profileRef: "sandbox:other", workflowId: "build" }),
      ],
    }
    expect(() => validateGuideMatchResult(result, workflowIndex)).toThrow(GuideValidationError)
  })

  it("rejects a result with unsupported top-level keys", () => {
    const result = { ...validMatchResult(), commandPath: "/bin/sh" }
    expect(() => validateGuideMatchResult(result, workflowIndex)).toThrow(GuideValidationError)
  })

  it("rejects candidates not ordered by non-increasing confidence", () => {
    const result = {
      candidates: [
        validMatchCandidate({ confidence: 0.3 }),
        validMatchCandidate({ profileRef: "sandbox:prime-agent", workflowId: "review", confidence: 0.9 }),
        validMatchCandidate({ profileRef: "sandbox:other", workflowId: "build", confidence: 0.5 }),
      ],
    }
    expect(() => validateGuideMatchResult(result, workflowIndex)).toThrow(GuideValidationError)
  })

  it("accepts candidates ordered by strictly decreasing confidence", () => {
    const result = {
      candidates: [
        validMatchCandidate({ confidence: 0.9 }),
        validMatchCandidate({ profileRef: "sandbox:prime-agent", workflowId: "review", confidence: 0.6 }),
        validMatchCandidate({ profileRef: "sandbox:other", workflowId: "build", confidence: 0.3 }),
      ],
    }
    const validated = validateGuideMatchResult(result, workflowIndex)
    expect(validated.candidates.map((c) => c.confidence)).toEqual([0.9, 0.6, 0.3])
  })
})

const validGenerateCandidate = (overrides: Partial<Record<string, unknown>> = {}) => ({
  title: "Focused review",
  prompt: "Review the diff and flag risky changes.",
  notes: "Best for a quick pass.",
  ...overrides,
})

describe("validateGuideGenerateResult", () => {
  it("accepts exactly three candidates with distinct prompts", () => {
    const result = validateGuideGenerateResult({
      candidates: [
        validGenerateCandidate(),
        validGenerateCandidate({ title: "Deep review", prompt: "Perform an exhaustive review of every file changed." }),
        validGenerateCandidate({
          title: "Security review",
          prompt: "Review the diff focusing only on security issues.",
        }),
      ],
    })
    expect(result.candidates).toHaveLength(3)
  })

  it("rejects fewer than three candidates", () => {
    expect(() =>
      validateGuideGenerateResult({ candidates: [validGenerateCandidate(), validGenerateCandidate()] }),
    ).toThrow(GuideValidationError)
  })

  it("rejects a candidate missing a required key", () => {
    const candidate = validGenerateCandidate() as Record<string, unknown>
    delete candidate.notes
    expect(() =>
      validateGuideGenerateResult({ candidates: [candidate, validGenerateCandidate(), validGenerateCandidate()] }),
    ).toThrow(GuideValidationError)
  })

  it("rejects a candidate with a command field", () => {
    expect(() =>
      validateGuideGenerateResult({
        candidates: [
          validGenerateCandidate({ command: "curl evil.example" }),
          validGenerateCandidate(),
          validGenerateCandidate(),
        ],
      }),
    ).toThrow(GuideValidationError)
  })

  it("rejects candidates that share an identical prompt string", () => {
    expect(() =>
      validateGuideGenerateResult({
        candidates: [
          validGenerateCandidate({ title: "A" }),
          validGenerateCandidate({ title: "B" }),
          validGenerateCandidate({ title: "C", prompt: "A genuinely different prompt text." }),
        ],
      }),
    ).toThrow(GuideValidationError)
  })

  it("accepts a multiline generated prompt and notes containing real newlines (item 1 regression)", () => {
    const multilinePrompt = "Review this diff.\n\nFocus on:\n- correctness\n- security"
    const multilineNotes = "Best when:\n- the diff is small\n- tests already exist"
    const result = validateGuideGenerateResult({
      candidates: [
        validGenerateCandidate({ prompt: multilinePrompt, notes: multilineNotes }),
        validGenerateCandidate({ title: "Deep review", prompt: "Perform an exhaustive review of every file changed." }),
        validGenerateCandidate({
          title: "Security review",
          prompt: "Review the diff focusing only on security issues.",
        }),
      ],
    })
    expect(result.candidates[0]?.prompt).toBe(multilinePrompt)
    expect(result.candidates[0]?.notes).toBe(multilineNotes)
  })
})

describe("validateGuideRefineResult", () => {
  it("accepts exactly one candidate", () => {
    const result = validateGuideRefineResult({ candidate: validGenerateCandidate() })
    expect(result.candidate.title).toBe("Focused review")
  })

  it("rejects a candidates array instead of a single candidate", () => {
    expect(() => validateGuideRefineResult({ candidate: [validGenerateCandidate()] })).toThrow(GuideValidationError)
  })

  it("rejects unsupported top-level keys", () => {
    expect(() => validateGuideRefineResult({ candidate: validGenerateCandidate(), extra: true })).toThrow(
      GuideValidationError,
    )
  })
})

const compactGuide = (): GuideMatchCatalogEntry["guide"] => ({
  schemaVersion: 1,
  capabilities: ["headless"],
  bestFor: ["code review"],
  avoidFor: ["shell access"],
  prerequisites: [],
  workflows: [{ id: "review", description: "Review a diff.", examples: ["Review this PR."] }],
})

const matchCatalogEntry = (overrides: Partial<GuideMatchCatalogEntry> = {}): GuideMatchCatalogEntry => {
  const base: GuideMatchCatalogEntry = {
    ref: "native:cdx/pstack",
    surface: "native",
    name: "pstack",
    launcher: "cdx",
    description: "Code review harness.",
    sandbox: false,
    guide: compactGuide(),
  }
  return { ...base, ...overrides }
}

const sandboxMatchCatalogEntry = (overrides: Partial<GuideMatchCatalogEntry> = {}): GuideMatchCatalogEntry => ({
  ref: "sandbox:prime-agent",
  surface: "sandbox",
  name: "prime-agent",
  description: "Sandboxed coding agent.",
  sandbox: true,
  guide: compactGuide(),
  ...overrides,
})

describe("assertGuideMatchInput", () => {
  const validInput = (): GuideMatchInput => ({
    intent: "Review my open PR",
    entries: [
      matchCatalogEntry(),
      sandboxMatchCatalogEntry(),
      sandboxMatchCatalogEntry({ ref: "sandbox:other", name: "other" }),
    ],
  })

  it("accepts an input with at least three entries", () => {
    expect(() => assertGuideMatchInput(validInput())).not.toThrow()
  })

  it("rejects an input with fewer than three entries", () => {
    const input = { ...validInput(), entries: validInput().entries.slice(0, 2) }
    expect(() => assertGuideMatchInput(input)).toThrow(GuideValidationError)
  })
})

describe("assertGuideGenerateInput", () => {
  const guide = {
    schemaVersion: 1 as const,
    capabilities: ["headless"],
    bestFor: ["code review"],
    avoidFor: ["shell access"],
    prerequisites: [],
    workflows: [
      {
        id: "review",
        description: "Review a diff.",
        examples: ["Review this PR."],
        promptTemplate: "Review: {{intent}}",
      },
    ],
  }

  const validInput = (): GuideGenerateInput => ({
    intent: "Review my open PR",
    profileRef: "native:cdx/pstack",
    workflowId: "review",
    guide,
    guideBody: "# pstack\n\nThis guide describes the review workflow.",
  })

  it("accepts an input whose workflowId exists on the guide and a bounded guideBody", () => {
    expect(() => assertGuideGenerateInput(validInput())).not.toThrow()
  })

  it("rejects an input whose workflowId is not present on the guide", () => {
    const input = { ...validInput(), workflowId: "does-not-exist" }
    expect(() => assertGuideGenerateInput(input)).toThrow(GuideValidationError)
  })

  it("rejects an empty guideBody", () => {
    const input = { ...validInput(), guideBody: "" }
    expect(() => assertGuideGenerateInput(input)).toThrow(GuideValidationError)
  })

  it("rejects a guideBody exceeding the maximum length", () => {
    const input = { ...validInput(), guideBody: "a".repeat(128_001) }
    expect(() => assertGuideGenerateInput(input)).toThrow(GuideValidationError)
  })

  it("allows a multiline guideBody containing real newlines", () => {
    const input = { ...validInput(), guideBody: "# Title\n\nFirst paragraph.\n\nSecond paragraph." }
    expect(() => assertGuideGenerateInput(input)).not.toThrow()
  })
})
