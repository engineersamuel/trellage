import {
  Command,
  Mount,
  Subscription,
  change,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  type,
} from "foldkit/scene"
import { Dialog } from "@foldkit/ui"
import { Exit, Schema } from "effect"
import { assert, describe, test } from "vitest"
import { type GoalSpec, type Grade, decodeGoal, draftToSpec, specToDraft } from "../../../shared/goal"
import { FetchCatalog, FetchGoals, SaveGoal } from "./command"
import { GoalDraft, type GoalList, gradeGroups } from "./domain"
import { Message } from "./message"
import { init, update } from "./update"
import { view } from "./view"

const catalog = {
  steps: [
    { id: "implement", description: "Write code", skills: ["ub-mode"] },
    { id: "verify", description: "Check", skills: [] },
    { id: "security", description: "Audit", skills: ["security-audit"] },
    { id: "finish", description: "Ship", skills: [] },
  ],
  folders: [{ id: "cpr", name: "cpr", path: "/r/cpr" }],
}
const goals = { dir: "/d", factoryCommit: "abc123", goals: [] }

const openDialog = [
  Subscription.emit(Message.ClickedOpenGoals()),
  Command.resolveAll(
    [FetchGoals, Message.SucceededFetchGoals({ goals })],
    [FetchCatalog, Message.SucceededFetchCatalog({ catalog })],
  ),
  Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
  Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
] as const

describe("goal dialog", () => {
  test("the form schema preserves hidden benchmark and retry configuration", () => {
    const saved: GoalSpec = {
      ...specOf("latency"),
      expect: {
        steps: {},
        skills: [],
        benchmarks: [{ id: "latency", baseline: 25, higherIsBetter: false, tolerance: 2 }],
      },
      improve: { approval: "human", maxRetries: 0 },
    }
    const draft = Schema.decodeUnknownSync(GoalDraft)(specToDraft(saved))
    assert.deepEqual(draftToSpec({ ...draft, title: "Edited" }), { ok: true, spec: { ...saved, title: "Edited" } })
  })
  test("shows catalog steps and skills, explains problems, then shows the paste line", () => {
    scene(
      { update, view },
      given(init().model),
      ...openDialog,
      expect(role("heading", { name: "Factory goals" })).toExist(),
      expect(label("implement at least")).toHaveValue("1"),
      expect(role("checkbox", { name: "ub-mode" })).toExist(),
      submit(role("form")),
      expect(role("alert")).toContainText("prompt is empty"),
      type(label("Goal id"), "demo"),
      type(label("Prompt"), "Add a thing"),
      click(role("checkbox", { name: "ub-mode" })),
      change(label("Repo"), "/r/cpr"),
      expect(role("checkbox", { name: "ub-mode" })).toBeChecked(),
      submit(role("form")),
      Command.resolve(
        SaveGoal,
        Message.SucceededSaveGoal({ saved: { skill: "/factory-loop demo", prompt: "# Factory loop" } }),
      ),
      Command.resolve(FetchGoals, Message.SucceededFetchGoals({ goals })),
      expect(role("code", { name: "command" })).toHaveText("/factory-loop demo"),
      expect(role("button", { name: "Copy command" })).toExist(),
    )
  })
})

const specOf = (id: string): GoalSpec => {
  const exit = decodeGoal({ id, repo: "/r/cpr", prompt: "p" })
  if (!Exit.isSuccess(exit)) throw new Error("bad spec")
  return exit.value
}
const grade = (at: number, gradingVersion: string, status: Grade["status"], rate: number | null): Grade => ({
  key: `t${at}|c|done|${gradingVersion}`,
  at,
  subject: { kind: "goal", id: "goal-a" },
  threadId: `t${at}`,
  factoryCommit: `f${at}`,
  gradingVersion,
  report: { status: "done", commit: `c${at}` },
  status,
  criteria: { results: {}, passed: 0, evaluated: 0, total: 0, rate },
  prChecks: { required: false, state: "missing", url: null },
  benchmarks: [],
  evidence: [],
  quality: [],
  errors: [],
  proposalId: null,
})
const graded: GoalList = {
  dir: "/d",
  factoryCommit: "abc123",
  goals: [
    {
      spec: specOf("goal-a"),
      runs: 2,
      last: null,
      grades: [grade(30, "g2", "pass", 1), grade(10, "g1", "fail", 0.5), grade(20, "g1", "unknown", null)],
    },
    { spec: specOf("goal-b"), runs: 0, last: null, grades: [] },
  ],
}

describe("gradeGroups", () => {
  test("one group per goal and grading version, points in time order, never merged", () => {
    assert.deepEqual(
      gradeGroups(graded.goals).map((g) => [g.goalId, g.gradingVersion, g.points.map((p) => p.at)]),
      [
        ["goal-a", "g1", [10, 20]],
        ["goal-a", "g2", [30]],
      ],
    )
  })
})

describe("grade history", () => {
  test("goal A at two grading versions renders two separately labelled charts", () => {
    scene(
      { update, view },
      given(init().model),
      Subscription.emit(Message.ClickedOpenGoals()),
      Command.resolveAll(
        [FetchGoals, Message.SucceededFetchGoals({ goals: graded })],
        [FetchCatalog, Message.SucceededFetchCatalog({ catalog })],
      ),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      expect(role("heading", { name: "Grade history" })).toExist(),
      expect(role("img", { name: "Grades of goal-a, grading g1" })).toExist(),
      expect(role("img", { name: "Grades of goal-a, grading g2" })).toExist(),
      expect(role("img", { name: "Grades of goal-b, grading g1" })).toBeAbsent(),
      expect(label("Summary of goal-a, grading g1")).toHaveText(
        "goal-a · g1: 2 grades · 0 pass, 1 fail, 1 unknown, 0 error · last criteria rate -",
      ),
      expect(label("Summary of goal-a, grading g2")).toHaveText(
        "goal-a · g2: 1 grade · 1 pass, 0 fail, 0 unknown, 0 error · last criteria rate 100%",
      ),
    )
  })
})
