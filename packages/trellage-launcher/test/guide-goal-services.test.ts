import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { loadProfileGuide, type LoadedProfileGuide, type ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import {
  GuideEffort,
  defaultGuideModelRouting,
  literalGuideMatch,
  parseGuideServiceRequestJson,
  prefilterGuideMatchCatalogEntries,
  runGuideGenerate,
  runGuideMatch,
  templatePromptCandidates,
} from "../src/guide-api.js"
import { parseGuideCatalog, type CombinedGuideCatalog } from "../src/guide-catalog.js"
import {
  composeGuideGoalCandidate,
  guideGoalApproachBudget,
  guideGoalCandidateBody,
  prepareGuideGoal,
  resolveGuideGoalExecution,
  type PreparedGuideGoal,
} from "../src/guide-goal-execution.js"
import { runGuideGoalGeneration, runGuideGoalRefinement } from "../src/guide-goal-generation.js"
import { GuideArtifactCache } from "../src/guide-match-cache.js"
import type {
  GuideGenerateCandidate,
  GuideGenerateInput,
  GuideGenerateResult,
  GuideMatchInput,
  GuideMatchResult,
  GuideOptimizeInput,
  GuideOptimizeResult,
  GuideProvider,
  GuideRefineInput,
  GuideRefineResult,
} from "../src/guide-provider.js"
import { record } from "../src/guide-text.js"
import { workflowPromptFrame } from "../src/guide-workflow-prompt.js"
import { goalDraft } from "./fixtures/goal-me-skill.js"

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const guideRoot = path.join(repositoryRoot, "profile-guides")
let superpowers: LoadedProfileGuide
let graph: LoadedProfileGuide
let claude: LoadedProfileGuide
beforeAll(async () => {
  superpowers = await loadProfileGuide(guideRoot, { surface: "native", launcher: "cdx", profile: "superpowers" })
  graph = await loadProfileGuide(guideRoot, { surface: "sandbox", profile: "claude-graph-of-loops" })
  claude = await loadProfileGuide(guideRoot, { surface: "native", launcher: "cldx", profile: "default" })
})

const goal = (prompt = "The original approved Goal-me document."): PreparedGuideGoal =>
  prepareGuideGoal({ draft: goalDraft, prompt })

const headless = {
  schemaVersion: 1,
  prompt: true,
  outputFormats: [],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "none",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "hard-deny",
  changedFiles: "none",
  usage: false,
  cost: false,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
}

const nativeEntry = (launcher: string, name: string, harness: string, guide: ProfileGuideV1) => ({
  launcher, name, harness, guide, headless,
  description: `${name} profile.`,
  sandbox: false,
  herdrCompatibility: { status: "supported" },
  commandPath: `/private/launchers/${launcher}`,
})

const sandboxEntry = (name: string, guide: ProfileGuideV1) => ({
  name, guide, headless,
  description: `${name} profile.`,
  path: path.join(repositoryRoot, "profiles", name, "profile.toml"),
  supportedPlatforms: ["linux/amd64"],
  harness: { kind: "claude", version: "2.1.190" },
  resolutionPolicy: "floating",
  locallyResolved: false,
  releaseLockAvailable: false,
  skillBundles: ["sandbox-common"],
  skillsMode: "floating",
  finalDigestLocked: false,
  skills: [],
  plugins: [],
  mcps: [],
  sandbox: true,
  locked: false,
  herdrCompatibility: { status: "supported" },
})

const catalog = (): CombinedGuideCatalog => {
  const { goalExecution: _policy, ...unsupported } = superpowers.guide
  return parseGuideCatalog(JSON.stringify({
    schemaVersion: 1,
    sandboxCommandPath: "/private/launchers/trellage",
    native: [
      nativeEntry("cdx", "superpowers", "codex", superpowers.guide),
      nativeEntry("cldx", "default", "claude", claude.guide),
      nativeEntry("cdx", "pstack", "codex", unsupported),
      nativeEntry("cpx", "hve", "copilot", unsupported),
    ],
    sandbox: [
      sandboxEntry("claude-graph-of-loops", graph.guide),
      sandboxEntry("headlong", unsupported),
    ],
  }))
}

const approachCandidates: ReadonlyArray<GuideGenerateCandidate> = [
  { title: "Evidence", prompt: "Start with regression evidence.", notes: "Observe the existing behavior first." },
  { title: "Dependencies", prompt: "Map dependencies before implementation.", notes: "Find the affected boundaries." },
  { title: "Small slices", prompt: "Implement a small complete slice.", notes: "Keep each change bounded." },
]

class OfflineProvider implements GuideProvider {
  readonly matchCalls: GuideMatchInput[] = []
  readonly generateCalls: GuideGenerateInput[] = []
  readonly refineCalls: GuideRefineInput[] = []
  readonly optimizeCalls: GuideOptimizeInput[] = []
  matchResult: GuideMatchResult | undefined
  generateResult: GuideGenerateResult = { candidates: approachCandidates }
  refineResult: GuideRefineResult = {
    candidate: { title: "Refined", prompt: "Reproduce the weakest criterion before changing code.", notes: "Uses direct evidence." },
  }
  optimizeResult: ((input: GuideOptimizeInput) => GuideOptimizeResult) | undefined

  async match(input: GuideMatchInput): Promise<GuideMatchResult> {
    this.matchCalls.push(input)
    if (this.matchResult !== undefined) return this.matchResult
    return {
      candidates: input.entries.slice(0, 5).map((entry, index) => {
        const workflow = entry.guide.workflows[0]
        if (workflow === undefined) throw new Error("The fixture entry has no workflow.")
        return {
          profileRef: entry.ref, workflowId: workflow.id, confidence: 1 - index / 10,
          reason: "The workflow fits the objective.", tradeoff: "Requires its profile prerequisites.",
        }
      }),
    }
  }

  async generate(input: GuideGenerateInput): Promise<GuideGenerateResult> {
    this.generateCalls.push(input)
    return this.generateResult
  }

  async refine(input: GuideRefineInput): Promise<GuideRefineResult> {
    this.refineCalls.push(input)
    return this.refineResult
  }

  async optimize(input: GuideOptimizeInput): Promise<GuideOptimizeResult> {
    this.optimizeCalls.push(input)
    return this.optimizeResult?.(input) ?? {
      candidates: input.candidates.map((candidate) => ({ ...candidate, prompt: `${candidate.prompt} Verify every approved criterion.` })),
    }
  }
}

const generationInput = (
  prepared = goal(),
  guide = superpowers.guide,
  workflowId = "test-driven-development",
) => ({
  intent: prepared.prompt,
  profileRef: "native:cdx/superpowers",
  workflowId,
  guide,
  guideBody: superpowers.body,
  goal: prepared,
  targetTool: "codex",
})

const temporaryRoots: string[] = []
const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-goal-services-"))
  temporaryRoots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const cacheAt = (cwd: string, warnings: string[] = []) => new GuideArtifactCache({
  cwd, routing: defaultGuideModelRouting,
  prompts: { match: "match", generate: "generate", refine: "refine", optimize: "optimize", enrich: "enrich" },
  onWarning: (warning) => warnings.push(warning),
})
const artifacts = async (cwd: string): Promise<ReadonlyArray<string>> => {
  const root = path.join(cwd, ".trx-guide")
  const files: string[] = []
  for (const session of await readdir(root)) {
    for (const file of await readdir(path.join(root, session))) files.push(path.join(root, session, file))
  }
  return files
}

describe("goal-aware matching boundaries", () => {
  it("ranks the structured objective, filters incompatible workflows, and does not fill Headlong or Poteto quotas", async () => {
    const prepared = prepareGuideGoal({
      draft: {
        ...goalDraft,
        task: "Fix the regression with test-driven development and systematic debugging.",
      },
      prompt: "LOOP PROTOCOL SCOREBOARD persistent monitoring ".repeat(500),
    })
    const entries = prefilterGuideMatchCatalogEntries(catalog(), prepared.prompt, prepared)
    expect(entries.map(({ ref }) => ref)).toEqual([
      "native:cdx/superpowers", "native:cldx/default", "sandbox:claude-graph-of-loops",
    ])
    expect(entries.find(({ ref }) => ref === "sandbox:claude-graph-of-loops")?.guide.workflows.map(({ id }) => id))
      .not.toContain("inspect-or-resume-run")
    expect(literalGuideMatch(catalog(), prepared.prompt, prepared)[0]?.profileRef).toBe("native:cdx/superpowers")
    const provider = new OfflineProvider()
    const response = await runGuideMatch(provider, catalog(), { intent: prepared.prompt, goal: prepared, model: "offline", effort: GuideEffort.Medium })
    expect(provider.matchCalls[0]?.goal?.prompt).toBe(prepared.prompt)
    expect(provider.matchCalls[0]?.goal?.draft).toEqual(prepared.draft)
    expect(provider.matchCalls[0]?.goal?.fingerprint).toBe(prepared.fingerprint)
    expect(response.recommendations.map(({ goalExecution }) => goalExecution?.label))
      .toEqual(["Codex /goal", "Claude /goal", "Graph of Loops"])
    expect(JSON.stringify(provider.matchCalls[0]?.entries)).not.toContain("promptTemplate")
  })

  it.each([1, 2])("returns %i compatible profiles without requiring three", async (count) => {
    const all = catalog()
    const small = { ...all, native: all.native.slice(0, count), sandbox: [] }
    const prepared = goal()
    const provider = new OfflineProvider()
    expect((await runGuideMatch(provider, small, { intent: prepared.prompt, goal: prepared, model: "offline", effort: GuideEffort.Medium })).recommendations)
      .toHaveLength(count)
    expect(literalGuideMatch(small, prepared.prompt, prepared)).toHaveLength(count)
  })

  it("prefilters a large goal catalog by objective fields rather than original loop vocabulary", () => {
    const base = catalog().native[0]!
    const prepared = prepareGuideGoal({
      draft: { ...goalDraft, artifact: "Reliable queue retries", task: "Implement idempotent queue retries and migration recovery." },
      prompt: "Persistent monitoring scoreboard loop memory ".repeat(300),
    })
    const focused = {
      ...base,
      name: "queue-retries",
      description: "Idempotent queue retries and migration recovery.",
      guide: {
        ...base.guide,
        bestFor: ["Reliable queue retries", "Migration recovery"],
        capabilities: ["queue-retries", "idempotency", "migration-recovery"],
      },
    }
    const unrelated = {
      ...base,
      name: "pstack",
      description: "Persistent monitoring scoreboard loop memory.",
      guide: {
        ...base.guide,
        bestFor: ["Persistent monitoring", "Loop memory"],
        capabilities: ["monitoring"],
        workflows: base.guide.workflows.map((workflow) => ({
          ...workflow, description: "Persistent monitoring and loop memory.", examples: ["Monitor progress"],
        })),
      },
    }
    const large = {
      ...catalog(), sandbox: [],
      native: [unrelated, ...Array.from({ length: 13 }, (_, index) => ({ ...focused, name: `queue-option-${index}` })), focused],
    }
    const refs = prefilterGuideMatchCatalogEntries(large, prepared.prompt, prepared).map(({ ref }) => ref)
    expect(refs).toHaveLength(12)
    expect(refs).not.toContain("native:cdx/pstack")
    expect(literalGuideMatch(large, prepared.prompt, prepared)[0]?.profileRef).not.toBe("native:cdx/pstack")
  })

  it.each(["native:cpx/hve", "sandbox:headlong", "native:cdx/not-installed"])("diagnoses explicit unavailable selection %s without a model call", async (ref) => {
    const provider = new OfflineProvider()
    const prepared = goal(`Use ${ref}.`)
    await expect(runGuideMatch(provider, catalog(), { intent: prepared.prompt, goal: prepared, model: "offline", effort: GuideEffort.Medium }))
      .rejects.toThrow(/cannot execute this goal|Unknown explicitly requested goal profile/u)
    expect(() => literalGuideMatch(catalog(), prepared.prompt, prepared)).toThrow()
    expect(provider.matchCalls).toHaveLength(0)
  })

  it("fails clearly with no eligible executor and rejects incompatible model selections", async () => {
    const all = catalog()
    const provider = new OfflineProvider()
    const prepared = goal()
    await expect(runGuideMatch(provider, { ...all, native: all.native.slice(2), sandbox: [] }, {
      intent: prepared.prompt, goal: prepared, model: "offline", effort: GuideEffort.Medium,
    })).rejects.toThrow(/No goal-compatible workflows/u)
    expect(provider.matchCalls).toHaveLength(0)
    provider.matchResult = { candidates: [{
      profileRef: "sandbox:claude-graph-of-loops", workflowId: "inspect-or-resume-run", confidence: 1,
      reason: "Resume", tradeoff: "Not a new objective.",
    }] }
    await expect(runGuideMatch(provider, all, { intent: prepared.prompt, goal: prepared, model: "offline", effort: GuideEffort.Medium }))
      .rejects.toThrow(/known workflow/u)
  })

  it("enforces explicit compatible preferences after model ranking", async () => {
    const provider = new OfflineProvider()
    const prepared = goal("Use native:cdx/superpowers.")
    provider.matchResult = { candidates: [{
      profileRef: "native:cldx/default", workflowId: "general-engineering-task", confidence: 1,
      reason: "Generic fit", tradeoff: "A different profile.",
    }] }
    await expect(runGuideMatch(provider, catalog(), { intent: prepared.prompt, goal: prepared, model: "offline", effort: GuideEffort.Medium }))
      .rejects.toThrow(/omitted the explicitly requested compatible profile/u)
    expect(provider.matchCalls[0]?.preferredProfileRefs).toEqual(["native:cdx/superpowers"])
  })

  it("separates plain, goal, revision, and exact workflow-frame cache identities", async () => {
    const cache = cacheAt(await temporaryRoot())
    const provider = new OfflineProvider()
    const all = catalog()
    const prepared = goal("Implement reliable retries.")
    const request = { intent: prepared.prompt, model: "offline", effort: GuideEffort.Medium }
    await runGuideMatch(provider, all, request, cache)
    expect(provider.matchCalls[0]?.entries.every((entry) => entry.goalExecution === undefined)).toBe(true)
    await runGuideMatch(provider, all, { ...request, goal: prepared }, cache)
    await runGuideMatch(provider, all, { ...request, goal: prepared }, cache)
    const revised = prepareGuideGoal({ draft: { ...goalDraft, task: `${goalDraft.task} Keep retry order.` }, prompt: prepared.prompt })
    await runGuideMatch(provider, all, { ...request, goal: revised }, cache)
    const changed = { ...all, native: all.native.map((entry) => entry.name !== "superpowers" ? entry : {
      ...entry,
      guide: { ...entry.guide, workflows: entry.guide.workflows.map((workflow) => ({
        ...workflow, promptTemplate: `Preserve the existing public behavior.\n${workflow.promptTemplate}`,
      })) },
    }) }
    await runGuideMatch(provider, changed, { ...request, goal: revised }, cache)
    expect(provider.matchCalls).toHaveLength(4)
  })
})

describe("protected goal candidate pipeline", () => {
  it.each([true, false])("composes all three Superpowers candidates once with skill=%s", async (withSkill) => {
    const guide = withSkill ? superpowers.guide : {
      ...superpowers.guide,
      workflows: superpowers.guide.workflows.map(({ skill: _skill, ...workflow }) => workflow),
    }
    const input = generationInput(goal(), guide)
    const execution = resolveGuideGoalExecution(input.goal, guide, input.workflowId)
    const frame = workflowPromptFrame(execution.workflow)
    const provider = new OfflineProvider()
    const phases: string[] = []
    provider.generateResult = { candidates: approachCandidates.map((candidate) => ({
      ...candidate, prompt: `${frame.beforeBody}${candidate.prompt}${frame.afterBody}`,
    })) }
    provider.optimizeResult = ({ candidates }) => ({
      candidates: candidates.map((candidate) => ({ ...candidate, prompt: `${frame.beforeBody}${candidate.prompt}${frame.afterBody}` })),
    })
    const result = await runGuideGoalGeneration(provider, input, { onPhase: (phase) => phases.push(phase) })
    expect(phases).toEqual(["generate", "optimize"])
    expect(new Set(result.candidates.map(({ prompt }) => prompt)).size).toBe(3)
    for (const candidate of result.candidates) {
      expect(candidate.prompt.startsWith(`/goal ${frame.beforeBody}`)).toBe(true)
      expect(candidate.prompt.endsWith(frame.afterBody)).toBe(true)
      expect(candidate.prompt.split(frame.beforeBody)).toHaveLength(2)
      expect(candidate.prompt).toContain(input.goal.draft.task)
      for (const criterion of input.goal.draft.criteria) expect(candidate.prompt.split(criterion)).toHaveLength(2)
      expect(candidate.prompt).toContain("at least 8")
      expect(candidate.prompt).not.toMatch(/LOOP PROTOCOL|SCOREBOARD|\/goal-me/u)
    }
    expect(provider.optimizeCalls[0]?.candidates).toEqual(
      approachCandidates.map((candidate) => ({ ...candidate, prompt: candidate.prompt.replace(/\.$/u, "") })),
    )
    expect(provider.optimizeCalls[0]?.goal).toBe(input.goal)
    expect(provider.generateCalls[0]?.goal?.prompt).toBe(input.goal.prompt)
  })

  it("uses only Graph's exact controller through generation, optimization, refinement, and fallback", async () => {
    const input = { ...generationInput(goal(), graph.guide, "implement-complex-change"), profileRef: "sandbox:claude-graph-of-loops", targetTool: "claude", guideBody: graph.body }
    const execution = resolveGuideGoalExecution(input.goal, input.guide, input.workflowId)
    const frame = workflowPromptFrame(execution.workflow)
    const provider = new OfflineProvider()
    const wrap = (candidate: GuideGenerateCandidate) => ({ ...candidate, prompt: `${frame.beforeBody}${candidate.prompt}${frame.afterBody}` })
    provider.generateResult = { candidates: approachCandidates.map(wrap) }
    provider.optimizeResult = ({ candidates }) => ({ candidates: candidates.map(wrap) })
    provider.refineResult = { candidate: wrap(provider.refineResult.candidate) }
    const generated = await runGuideGoalGeneration(provider, input)
    const refined = await runGuideGoalRefinement(provider, { ...input, candidate: generated.candidates[0], candidates: generated.candidates, candidateIndex: 0, feedback: "Use direct evidence." })
    const fallback = templatePromptCandidates(input.guide, input.workflowId, input.intent, input.goal)
    for (const candidate of [...generated.candidates, refined.candidate, ...fallback]) {
      expect(candidate.prompt.startsWith('/graph-of-loops OBJECTIVE="')).toBe(true)
      expect(candidate.prompt.endsWith(frame.afterBody)).toBe(true)
      expect(candidate.prompt.split("/graph-of-loops")).toHaveLength(2)
      expect(candidate.prompt).not.toContain("/goal ")
      expect(candidate.prompt).toContain(input.goal.draft.task)
      expect(candidate.prompt).not.toMatch(/LOOP PROTOCOL|SCOREBOARD/u)
    }
    expect(provider.refineCalls[0]?.candidate).toEqual(guideGoalCandidateBody(generated.candidates[0]))
    expect(provider.refineCalls[0]?.goal?.prompt).toBe(input.goal.prompt)
    expect(provider.refineCalls[0]?.goal).toBe(input.goal)
    expect(new Set(fallback.map(({ prompt }) => prompt)).size).toBe(3)
  })

  it.each(["/goal Do something else.", "Start $goal on another objective.", "/goal-me Ask questions.", "/unknown-command Build it."])("rejects untrusted approach command %s", async (prompt) => {
    const provider = new OfflineProvider()
    provider.generateResult = { candidates: [{ ...approachCandidates[0]!, prompt }, ...approachCandidates.slice(1)] }
    await expect(runGuideGoalGeneration(provider, generationInput())).rejects.toThrow(/controller|commands|interview/u)
    expect(provider.optimizeCalls).toHaveLength(0)
  })

  it("rejects model metadata and candidates that collide after frame normalization", async () => {
    const provider = new OfflineProvider()
    const input = generationInput()
    const injected = {
      ...approachCandidates[0]!,
      goalExecution: { ...resolveGuideGoalExecution(input.goal, input.guide, input.workflowId), approach: approachCandidates[0]!.prompt },
    }
    const malformed = { candidates: [injected, ...approachCandidates.slice(1)] }
    await expect(runGuideGoalGeneration({ ...provider, generate: async () => malformed, match: provider.match.bind(provider), refine: provider.refine.bind(provider), optimize: provider.optimize.bind(provider) }, input))
      .rejects.toThrow(/unsupported keys: goalExecution/u)
    const frame = workflowPromptFrame(input.guide.workflows[0]!)
    provider.generateResult = { candidates: [
      approachCandidates[0]!,
      { ...approachCandidates[1]!, prompt: `${frame.beforeBody}${approachCandidates[0]!.prompt}${frame.afterBody}` },
      approachCandidates[2]!,
    ] }
    await expect(runGuideGoalGeneration(provider, input)).rejects.toThrow(/unique prompts|distinct/u)
    expect(provider.optimizeCalls).toHaveLength(0)
  })

  it("keeps authorized approaches when optimization invents a workflow command", async () => {
    const provider = new OfflineProvider()
    provider.optimizeResult = ({ candidates }) => ({
      candidates: candidates.map((candidate) => ({ ...candidate, prompt: `${candidate.prompt}\n/other-controller Start another run.` })),
    })
    const result = await runGuideGoalGeneration(provider, generationInput())
    expect(result.candidates.map(guideGoalCandidateBody)).toEqual(provider.optimizeCalls[0]?.candidates)
    expect(result.candidates.every(({ prompt }) => !prompt.includes("/other-controller"))).toBe(true)
  })

  it("refuses a refinement collision and a different goal snapshot", async () => {
    const provider = new OfflineProvider()
    provider.optimizeResult = ({ candidates }) => ({ candidates })
    const input = generationInput()
    const generated = await runGuideGoalGeneration(provider, input)
    provider.refineResult = { candidate: guideGoalCandidateBody(generated.candidates[1]) }
    await expect(runGuideGoalRefinement(provider, { ...input, candidate: generated.candidates[0], candidates: generated.candidates, candidateIndex: 0, feedback: "Make it the other approach." }))
      .rejects.toThrow(/distinct/u)
    const revised = prepareGuideGoal({ ...input.goal, draft: { ...input.goal.draft, task: "A different approved task." } })
    await expect(runGuideGoalRefinement(provider, { ...input, goal: revised, candidate: generated.candidates[0], feedback: "Refine it." }))
      .rejects.toThrow(/different goal or workflow/u)
  })

  it("uses Claude's exact remaining condition budget without cutting criteria", async () => {
    const prepared = goal()
    const input = { ...generationInput(prepared, claude.guide, "general-engineering-task"), profileRef: "native:cldx/default", targetTool: "claude", guideBody: claude.body }
    const execution = resolveGuideGoalExecution(prepared, claude.guide, input.workflowId)
    const budget = guideGoalApproachBudget(execution)
    const provider = new OfflineProvider()
    provider.generateResult = { candidates: approachCandidates.map((candidate, index) => ({
      ...candidate, prompt: `${index}${"\u{1f333}".repeat(budget - 1)}`,
    })) }
    provider.optimizeResult = ({ candidates }) => ({ candidates })
    const result = await runGuideGoalGeneration(provider, input)
    for (const candidate of result.candidates) {
      expect([...candidate.prompt.slice("/goal ".length)]).toHaveLength(4000)
      for (const criterion of prepared.draft.criteria) expect(candidate.prompt).toContain(criterion)
    }
    provider.generateResult = { candidates: provider.generateResult.candidates.map((candidate) => ({ ...candidate, prompt: `${candidate.prompt}x` })) }
    await expect(runGuideGoalGeneration(provider, input)).rejects.toThrow(/at most/u)
    const tooLong = prepareGuideGoal({ draft: { ...goalDraft, task: "x".repeat(4000) }, prompt: prepared.prompt })
    const unused = new OfflineProvider()
    await expect(runGuideGoalGeneration(unused, { ...input, goal: tooLong })).rejects.toThrow(/4,000-character/u)
    expect(unused.generateCalls).toHaveLength(0)
    expect(literalGuideMatch(catalog(), tooLong.prompt, tooLong).map(({ profileRef }) => profileRef)).not.toContain("native:cldx/default")
    expect(() => templatePromptCandidates(claude.guide, input.workflowId, tooLong.prompt, tooLong)).toThrow(/4,000-character/u)
  })

  it("preserves full Unicode goals and 8000-code-point approaches through generation and refinement caches", async () => {
    const request = parseGuideServiceRequestJson(JSON.stringify({
      schemaVersion: 1,
      goal: {
        ...goalDraft,
        task: `Produce the complete report.\n${"\u{1f333}".repeat(20_000)}`,
        criteria: Array.from({ length: 20 }, (_, index) => `Criterion ${index}: ${"\u{1f680}".repeat(1900)}`),
      },
      intent: "\u{1f333}".repeat(60_000),
    }))
    const prepared = request.goal!
    const input = generationInput(prepared)
    const cwd = await temporaryRoot()
    const warnings: string[] = []
    const cache = cacheAt(cwd, warnings)
    const provider = new OfflineProvider()
    provider.generateResult = { candidates: approachCandidates.map((candidate, index) => ({
      ...candidate, prompt: `${index}${"\u{1f333}".repeat(7999)}`,
    })) }
    provider.optimizeResult = ({ candidates }) => ({ candidates })
    const generated = await runGuideGoalGeneration(provider, input, { cache })
    expect(await runGuideGoalGeneration(provider, input, { cache })).toEqual(generated)
    const refinement = { ...input, candidate: generated.candidates[0], candidates: generated.candidates, candidateIndex: 0, feedback: "Use direct evidence." }
    const refined = await runGuideGoalRefinement(provider, refinement, { cache })
    expect(await runGuideGoalRefinement(provider, refinement, { cache })).toEqual(refined)
    expect(provider.generateCalls).toHaveLength(1)
    expect(provider.refineCalls).toHaveLength(1)
    expect(provider.generateCalls[0]?.goal?.prompt).toBe(prepared.prompt)
    expect(provider.refineCalls[0]?.goal?.prompt).toBe(prepared.prompt)
    expect([...provider.refineCalls[0]!.candidate.prompt]).toHaveLength(8000)
    for (const candidate of [...generated.candidates, refined.candidate]) {
      expect([...candidate.prompt].length).toBeGreaterThan(8000)
      expect(candidate.prompt).toContain(prepared.draft.task)
      for (const criterion of prepared.draft.criteria) expect(candidate.prompt).toContain(criterion)
    }
    for (const file of await artifacts(cwd)) {
      expect((await stat(file)).size).toBeLessThanOrEqual(256 * 1024)
      const source = await readFile(file, "utf8")
      const header = source.split("\n")[0]!.match(/v1:([A-Za-z0-9_-]+)/u)![1]!
      const envelope = record(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), "artifact")
      expect(JSON.stringify(envelope.result)).not.toContain("goalExecution")
      expect(JSON.stringify(envelope.result)).not.toContain(prepared.draft.task)
    }
    expect(warnings).toEqual([])
    provider.generateResult = { candidates: provider.generateResult.candidates.map((candidate) => ({ ...candidate, prompt: `${candidate.prompt}x` })) }
    await expect(runGuideGoalGeneration(provider, input)).rejects.toThrow(/at most 8000/u)
  })

  it("enforces the 96000-code-point composed bound without trimming the protected contract", async () => {
    const prepared = prepareGuideGoal({
      draft: {
        artifact: "a".repeat(1000),
        task: "t".repeat(30_000),
        criteria: Array.from({ length: 32 }, (_, index) => {
          const prefix = `${index}: `
          return `${prefix}${"c".repeat(2000 - prefix.length)}`
        }),
      },
      prompt: "Explicit caller-authored objective.",
    })
    const input = generationInput(prepared)
    const execution = resolveGuideGoalExecution(prepared, input.guide, input.workflowId)
    const minimum = composeGuideGoalCandidate(execution, { title: "Bound", prompt: "x", notes: "Measure the fixed frame." })
    const remaining = 96_000 - [...minimum.prompt].length + 1
    expect(guideGoalApproachBudget(execution)).toBe(remaining)
    const provider = new OfflineProvider()
    provider.generateResult = { candidates: approachCandidates.map((candidate, index) => ({
      ...candidate, prompt: `${index}${"x".repeat(remaining - 1)}`,
    })) }
    provider.optimizeResult = ({ candidates }) => ({ candidates })
    const result = await runGuideGoalGeneration(provider, input)
    for (const candidate of result.candidates) {
      expect([...candidate.prompt]).toHaveLength(96_000)
      expect(candidate.goalExecution.goal).toEqual(prepared)
      expect(candidate.prompt).toContain(prepared.draft.artifact)
      expect(candidate.prompt).toContain(prepared.draft.task)
      for (const criterion of prepared.draft.criteria) expect(candidate.prompt).toContain(criterion)
    }
    provider.generateResult = { candidates: provider.generateResult.candidates.map((candidate) => ({ ...candidate, prompt: `${candidate.prompt}x` })) }
    await expect(runGuideGoalGeneration(provider, input)).rejects.toThrow(`at most ${remaining} characters`)
    expect(provider.optimizeCalls).toHaveLength(1)
  })

  it("does not reuse plain generation artifacts and repairs an invalid goal cache hit visibly", async () => {
    const input = generationInput()
    const cwd = await temporaryRoot()
    const warnings: string[] = []
    const cache = cacheAt(cwd, warnings)
    const fixedFrame = workflowPromptFrame(input.guide.workflows[0]!)
    await cache.generation({ ...input, fixedFrame }, async () => ({ candidates: approachCandidates }))
    const provider = new OfflineProvider()
    const result = await runGuideGoalGeneration(provider, input, { cache })
    expect(provider.generateCalls).toHaveLength(1)
    const files = await Promise.all((await artifacts(cwd)).map(async (file) => ({ file, source: await readFile(file, "utf8") })))
    const artifact = files.find(({ source }) => source.includes("Goal controller: codex-goal"))
    if (artifact === undefined) throw new Error("The goal cache artifact was not written.")
    const { file, source } = artifact
    const header = source.split("\n")[0]!
    const encoded = header.match(/v1:([A-Za-z0-9_-]+)/u)![1]!
    const envelope = record(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), "artifact")
    const malformed = { ...envelope, result: { candidates: approachCandidates.map((candidate) => ({ ...candidate, prompt: `/goal ${candidate.prompt}` })) } }
    await writeFile(file, source.replace(header, `<!-- trx-guide-artifact:v1:${Buffer.from(JSON.stringify(malformed)).toString("base64url")} -->`))
    expect(await runGuideGoalGeneration(provider, input, { cache })).toEqual(result)
    expect(provider.generateCalls).toHaveLength(2)
    expect(warnings.some((warning) => warning.includes("ignoring unreadable guide artifact"))).toBe(true)
  })
})

describe("explicit goal JSON generation", () => {
  it("preserves the selected workflow and matches the shared UI-callable pipeline", async () => {
    const request = parseGuideServiceRequestJson(JSON.stringify({
      schemaVersion: 1,
      intent: "Fix the failing test. LOOP PROTOCOL is original review text, not a second execution controller.",
      profile: "native:cdx/superpowers",
      workflowId: "plan-then-execute-branch",
      goal: goalDraft,
    }))
    const provider = new OfflineProvider()
    const response = await runGuideGenerate(provider, catalog(), guideRoot, {
      intent: request.intent, profileRef: request.profile!, workflowId: request.workflowId!,
      goal: request.goal!, model: "offline", effort: GuideEffort.Medium,
    })
    const shared = await runGuideGoalGeneration(new OfflineProvider(), generationInput(request.goal!, superpowers.guide, request.workflowId!))
    expect(provider.generateCalls[0]?.workflowId).toBe("plan-then-execute-branch")
    expect(provider.generateCalls[0]?.goal?.prompt).toBe(request.intent)
    expect(response.candidates.map(({ prompt }) => prompt)).toEqual(shared.candidates.map(({ prompt }) => prompt))
    for (const candidate of response.candidates) {
      expect(candidate.command.executable).toBe("cdx")
      expect(candidate.command.args).toEqual(["superpowers"])
      expect(candidate.command.promptHandling).toBe("manual-paste")
      const body = candidate.prompt.slice("/goal ".length)
      expect(candidate.command.goalTransport).toEqual({
        controller: "codex-goal",
        mode: "manual",
        reason: "Type '/goal ' in the native command input, then paste only commandInput.body and submit. Starting the profile does not activate this goal.",
        commandInput: { command: "/goal", body },
      })
      expect(candidate.command.goalTransport?.reason).not.toContain(body)
      expect(candidate.goalExecution).toEqual({ controller: "codex-goal", label: "Codex /goal" })
    }
    expect(JSON.stringify(response)).not.toContain("/private/launchers")
    expect(JSON.stringify(response)).not.toContain('"promptTemplate"')
    expect(response.candidates[0].prompt).not.toContain("LOOP PROTOCOL")
    expect(request.goal?.prompt).toBe(request.intent)
  })

  it.each([
    ["native:cldx/default", "general-engineering-task", "cldx", ["default", "-p"], "/goal ", "claude-goal"],
    ["sandbox:claude-graph-of-loops", "debug-cross-cutting-failure", "trellage", ["--profile", "claude-graph-of-loops"], "/graph-of-loops ", "graph-of-loops"],
  ] as const)("uses goal-aware public delivery for %s", async (profileRef, workflowId, executable, prefix, command, controller) => {
    const prepared = goal()
    const response = await runGuideGenerate(new OfflineProvider(), catalog(), guideRoot, {
      intent: prepared.prompt, goal: prepared, profileRef, workflowId, model: "offline", effort: GuideEffort.Medium,
    })
    for (const candidate of response.candidates) {
      expect(candidate.prompt.startsWith(command)).toBe(true)
      expect(candidate.command.executable).toBe(executable)
      expect(candidate.command.args).toEqual([...prefix, candidate.prompt])
      expect(candidate.command.goalTransport).toEqual({
        controller,
        mode: "argv",
        reason: "The validated goal uses the selected launcher's existing argv prompt route.",
      })
      expect(candidate.command.goalTransport).not.toHaveProperty("commandInput")
    }
  })

  it("provides explicit native Graph input instructions when the goal cannot use argv", async () => {
    const prepared = prepareGuideGoal({
      draft: { ...goalDraft, task: `${goalDraft.task}\n${"\u{1f333}".repeat(20_000)}` },
      prompt: "Approved long Graph objective.",
    })
    const response = await runGuideGenerate(new OfflineProvider(), catalog(), guideRoot, {
      intent: prepared.prompt,
      goal: prepared,
      profileRef: "sandbox:claude-graph-of-loops",
      workflowId: "implement-complex-change",
      model: "offline",
      effort: GuideEffort.Medium,
    })
    for (const candidate of response.candidates) {
      const body = candidate.prompt.slice("/graph-of-loops ".length)
      expect(Buffer.byteLength(candidate.prompt, "utf8")).toBeGreaterThan(64 * 1024)
      expect(candidate.command.args).toEqual(["--profile", "claude-graph-of-loops"])
      expect(candidate.command.promptHandling).toBe("manual-paste")
      expect(candidate.command.goalTransport).toEqual({
        controller: "graph-of-loops",
        mode: "manual",
        reason: "Type '/graph-of-loops ' in the native command input, then paste only commandInput.body and submit. Starting the profile does not activate this goal.",
        commandInput: { command: "/graph-of-loops", body },
      })
      expect(candidate.command.goalTransport?.reason).not.toContain(body)
    }
  })

  it("preserves an explicit ordinary workflow without activating a goal", async () => {
    const provider = new OfflineProvider()
    const response = await runGuideGenerate(provider, catalog(), guideRoot, {
      intent: "Fix the failing test.", profileRef: "native:cdx/superpowers", workflowId: "plan-then-execute-branch",
      model: "offline", effort: GuideEffort.Medium,
    })
    expect(provider.generateCalls[0]?.workflowId).toBe("plan-then-execute-branch")
    expect(provider.generateCalls[0]?.goal).toBeUndefined()
    for (const candidate of response.candidates) {
      expect(candidate.goalExecution).toBeUndefined()
      expect(candidate.command.goalTransport).toBeUndefined()
      expect(candidate.command.args).toEqual(["superpowers", "-p", candidate.prompt])
      expect(candidate.prompt).not.toContain("/goal ")
    }
  })

  it("keeps plain JSON plain and rejects malformed goals and unknown or unsupported workflows", async () => {
    expect(parseGuideServiceRequestJson(JSON.stringify({ schemaVersion: 1, intent: "/goal-me TASK: do work" })).goal).toBeUndefined()
    for (const invalid of [{ ...goalDraft, criteria: ["only one"] }, { ...goalDraft, controller: "invented" }]) {
      expect(() => parseGuideServiceRequestJson(JSON.stringify({ schemaVersion: 1, intent: "Original", goal: invalid }))).toThrow()
    }
    const provider = new OfflineProvider()
    const prepared = goal()
    for (const workflowId of ["inspect-or-resume-run", "unknown-workflow"]) {
      await expect(runGuideGenerate(provider, catalog(), guideRoot, {
        intent: prepared.prompt, goal: prepared, profileRef: "sandbox:claude-graph-of-loops", workflowId,
        model: "offline", effort: GuideEffort.Medium,
      })).rejects.toThrow(/cannot execute this goal|Unknown workflow/u)
    }
    await expect(runGuideGenerate(provider, catalog(), guideRoot, {
      intent: prepared.prompt, goal: prepared, profileRef: "native:cdx/missing", model: "offline", effort: GuideEffort.Medium,
    })).rejects.toThrow(/Unknown profile/u)
    expect(provider.generateCalls).toHaveLength(0)
  })
})
