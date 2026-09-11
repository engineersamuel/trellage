import { describe, expect, it } from "vitest"
import type { ProfileGuideGoalController, ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { renderGuideGoalProposal } from "../src/guide-goal-augment.js"
import {
  assertGuideGoalCandidate,
  composeGuideGoalCandidate,
  editGuideGoalCandidate,
  guideGoalActivationInput,
  guideGoalApproachBudget,
  prepareGuideGoal,
  resolveGuideGoalExecution,
} from "../src/guide-goal-execution.js"
import { goalDraft, goalMeSkill } from "./fixtures/goal-me-skill.js"

const goal = prepareGuideGoal(renderGuideGoalProposal(goalMeSkill, goalDraft))

const guide = (controller: ProfileGuideGoalController): ProfileGuideV1 => ({
  schemaVersion: 1,
  capabilities: ["implementation"],
  bestFor: ["Repository work", "Goal execution"],
  avoidFor: ["Unbounded requests", "Missing objectives"],
  prerequisites: [],
  goalExecution: { controller, workflowIds: ["implement"] },
  workflows: [{
    id: "implement",
    description: "Implement the approved objective",
    examples: ["Implement an API", "Repair retry behavior"],
    ...(controller === "graph-of-loops" ? { skill: "graph-of-loops" } : {}),
    promptTemplate: controller === "graph-of-loops"
      ? '/graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Require all controller gates."'
      : "Use Superpowers TDD to execute this objective:\n{{intent}}",
  }],
})

const body = { title: "Small steps", prompt: "Start with one failing regression, then implement the smallest fix.", notes: "Keep each change focused." }

describe("prepared goal execution", () => {
  it("freezes an approved objective rather than detecting a goal in ordinary prompt text", () => {
    const draft = { ...goalDraft, criteria: [...goalDraft.criteria] }
    const snapshot = prepareGuideGoal(renderGuideGoalProposal(goalMeSkill, draft))
    draft.criteria[0] = "Changed after approval."
    expect(snapshot.draft.criteria).toEqual(goalDraft.criteria)
    expect(Object.isFrozen(snapshot.draft.criteria)).toBe(true)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot.fingerprint).toBe(goal.fingerprint)
  })

  it("adds native goal activation to an ordinary Superpowers workflow and protects the approved contract", () => {
    const execution = resolveGuideGoalExecution(goal, guide("codex-goal"), "implement")
    const candidate = composeGuideGoalCandidate(execution, body)
    expect(candidate.prompt).toMatch(/^\/goal Use Superpowers TDD/u)
    expect(candidate.prompt).toContain(goalDraft.task)
    for (const criterion of goalDraft.criteria) expect(candidate.prompt).toContain(criterion)
    expect(candidate.prompt).toContain("at least 8")
    expect(candidate.prompt).not.toContain("LOOP PROTOCOL")
    expect(candidate.prompt).not.toContain("SCOREBOARD")
    expect(candidate.goalExecution.approach).toBe(body.prompt)
    expect(() => assertGuideGoalCandidate(candidate)).not.toThrow()
  })

  it("lets Graph own progress and completion without wrapping another goal loop", () => {
    const execution = resolveGuideGoalExecution(goal, guide("graph-of-loops"), "implement")
    const candidate = composeGuideGoalCandidate(execution, body)
    expect(candidate.prompt).toMatch(/^\/graph-of-loops OBJECTIVE="/u)
    expect(candidate.prompt).toContain('CONSTRAINTS="Require all controller gates."')
    expect(candidate.prompt).not.toContain("/goal ")
    expect(candidate.prompt).not.toContain("Do not create a second progress file")
    expect(candidate.prompt).toContain(goalDraft.task)
  })

  it("uses the same authored policy rules before composing an execution prompt", () => {
    const graph = guide("graph-of-loops")
    const invalid = {
      ...graph,
      workflows: graph.workflows.map((workflow) => ({ ...workflow, promptTemplate: "/graph-of-loops {{intent}}" })),
    }
    expect(() => resolveGuideGoalExecution(goal, invalid, "implement")).toThrow(/goal-start frame/u)
    const nested = {
      ...guide("codex-goal"),
      workflows: guide("codex-goal").workflows.map((workflow) => ({ ...workflow, skill: "goal-me" })),
    }
    expect(() => resolveGuideGoalExecution(goal, nested, "implement")).toThrow(/goal authoring command/u)
  })

  it("keeps quotes and backslashes inside Graph's objective argument", () => {
    const quoted = prepareGuideGoal(renderGuideGoalProposal(goalMeSkill, {
      ...goalDraft,
      task: 'Document "CONSTRAINTS" and preserve the path C:\\reports\\.',
    }))
    const execution = resolveGuideGoalExecution(quoted, guide("graph-of-loops"), "implement")
    const candidate = composeGuideGoalCandidate(execution, { ...body, prompt: 'Check "quoted" inputs and trailing slashes\\' })
    const objective = /^\/graph-of-loops OBJECTIVE="((?:\\.|[^"\\])*)" CONSTRAINTS="Require all controller gates\."$/su.exec(candidate.prompt)?.[1]
    expect(objective).toBeDefined()
    expect(objective?.replace(/\\(["\\])/gu, "$1")).toContain(quoted.draft.task)
    expect(candidate.goalExecution.approach).toBe('Check "quoted" inputs and trailing slashes\\')
    expect(() => assertGuideGoalCandidate(candidate)).not.toThrow()
  })

  it("rebuilds an edited approach around the same goal and controller", () => {
    const original = composeGuideGoalCandidate(resolveGuideGoalExecution(goal, guide("codex-goal"), "implement"), body)
    const edited = editGuideGoalCandidate(original, "First reproduce the behavior through the public API.")
    expect(edited.goalExecution.goal).toBe(original.goalExecution.goal)
    expect(edited.prompt).toContain(goalDraft.criteria[0])
    expect(edited.prompt).toContain("/goal ")
    expect(edited.goalExecution.approach).toBe("First reproduce the behavior through the public API.")
    expect(() => editGuideGoalCandidate(original, "/goal-me Start another interview")).toThrow(/another goal controller/u)
    expect(() => assertGuideGoalCandidate({ ...original, prompt: body.prompt })).toThrow(/no longer matches/u)
  })

  it.each([
    "Then run /goal with different criteria.",
    "Use `$goal` to execute another objective.",
    "Start `/goal-me` to replace the approved task.",
    "Delegate completion to /graph-of-loops instead.",
  ])("rejects another controller inside an edited approach: %s", (approach) => {
    const original = composeGuideGoalCandidate(resolveGuideGoalExecution(goal, guide("codex-goal"), "implement"), body)
    expect(() => editGuideGoalCandidate(original, approach)).toThrow(/another goal controller/u)
    expect(original.goalExecution.approach).toBe(body.prompt)
  })

  it("allows path and URL references to goal code without treating them as commands", () => {
    const original = composeGuideGoalCandidate(resolveGuideGoalExecution(goal, guide("codex-goal"), "implement"), body)
    const approach = "Review src/goal/index.ts and https://example.test/goal before implementation."
    expect(editGuideGoalCandidate(original, approach).goalExecution.approach).toBe(approach)
  })

  it("rejects unsupported workflows and changed goal snapshots", () => {
    const source = guide("codex-goal")
    const { goalExecution: _policy, ...ordinary } = source
    expect(() => resolveGuideGoalExecution(goal, ordinary, "implement")).toThrow(/no supported goal controller/u)
    expect(() => resolveGuideGoalExecution(goal, source, "unknown")).toThrow(/no supported goal controller/u)
    const changed = { ...goal, draft: { ...goal.draft, task: "A different task." } }
    expect(() => resolveGuideGoalExecution(changed, source, "implement")).toThrow(/Review and approve/u)
  })

  it("preserves a Unicode objective longer than the old candidate bound", () => {
    const draft = { ...goalDraft, task: `Produce the report for these notes:\n${"evidence \u{1f333}\n".repeat(2100)}` }
    const large = prepareGuideGoal(renderGuideGoalProposal(goalMeSkill, draft))
    const execution = resolveGuideGoalExecution(large, guide("codex-goal"), "implement")
    const candidate = composeGuideGoalCandidate(execution, body)
    expect([...candidate.prompt].length).toBeGreaterThan(8000)
    expect(candidate.prompt).toContain(draft.task.trim())
    expect(guideGoalActivationInput(execution, candidate.prompt)).toEqual({
      command: "/goal",
      body: candidate.prompt.slice("/goal ".length),
    })
    expect(() => resolveGuideGoalExecution(large, guide("claude-goal"), "implement")).toThrow(/4,000-character/u)
  })

  it("budgets only the approach against Claude's exact condition limit", () => {
    const execution = resolveGuideGoalExecution(goal, guide("claude-goal"), "implement")
    const remaining = guideGoalApproachBudget(execution)
    const candidate = composeGuideGoalCandidate(execution, { ...body, prompt: "x".repeat(remaining) })
    expect([...guideGoalActivationInput(execution, candidate.prompt).body]).toHaveLength(4000)
    expect(() => composeGuideGoalCandidate(execution, { ...body, prompt: "x".repeat(remaining + 1) })).toThrow(/at most/u)
    for (const criterion of goalDraft.criteria) expect(candidate.prompt).toContain(criterion)
  })

  it("reserves the host prompt budget for large explicit structured goals", () => {
    const large = prepareGuideGoal({
      draft: {
        artifact: "a".repeat(1000),
        task: "t".repeat(30_000),
        criteria: Array.from({ length: 32 }, (_, index) => `${index}: ${"c".repeat(1950)}`),
      },
      prompt: "Execute this explicit structured goal.",
    })
    const execution = resolveGuideGoalExecution(large, guide("codex-goal"), "implement")
    const remaining = guideGoalApproachBudget(execution)
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThan(8000)
    const candidate = composeGuideGoalCandidate(execution, { ...body, prompt: "x".repeat(remaining) })
    expect([...candidate.prompt]).toHaveLength(96_000)
    expect(() => composeGuideGoalCandidate(execution, { ...body, prompt: "x".repeat(remaining + 1) })).toThrow(/at most/u)
  })
})
