import { Option } from "effect";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { describe, expect, test } from "vitest";
import { CopyText, FetchGoals, SaveGoal } from "./command";
import type { GoalCatalog } from "./domain";
import { Message } from "./message";
import { init, update } from "./update";

const catalog: GoalCatalog = {
  steps: [
    { id: "implement", description: "", skills: ["ub-mode"] },
    { id: "verify", description: "", skills: [] },
    { id: "security", description: "", skills: ["security-audit"] },
    { id: "finish", description: "", skills: [] },
    { id: "review", description: "", skills: [] },
  ],
  folders: [{ id: "cpr", name: "cpr", path: "/r/cpr" }],
};
const ready = modifyFields(init().model, { catalog: () => AsyncData.succeed(catalog) });
const saved = { skill: "/factory-loop demo", prompt: "# Factory loop" };

describe("goal form", () => {
  test("an empty form lists its problems and saves nothing", () => {
    story(
      update,
      given(ready),
      message(Message.SubmittedGoal()),
      model((m) => expect(m.problems).toEqual(["id: lowercase letters, digits and dashes, 2-64 chars", "prompt is empty", "repo must be an absolute path"])),
    );
  });

  test("a filled form saves the spec the server expects, then shows the paste line", () => {
    story(
      update,
      given(ready),
      message(Message.UpdatedId({ value: "demo" })),
      message(Message.SelectedRepo({ value: "/r/cpr" })),
      message(Message.UpdatedPrompt({ value: "Add a thing" })),
      message(Message.ToggledStep({ step: "review", isChecked: true })),
      message(Message.ToggledSkill({ skill: "security-audit", isChecked: true })),
      message(Message.ClickedPolicy({ topic: "ship", policy: "human" })),
      message(Message.ClickedGateExpectation({ gate: "codeReview", expectation: "run" })),
      message(Message.ClickedGateExpectation({ gate: "design", expectation: "skip" })),
      message(Message.SubmittedGoal()),
      Command.expectHas(SaveGoal),
      Command.resolve(SaveGoal, Message.SucceededSaveGoal({ saved })),
      Command.resolve(FetchGoals, Message.FailedFetchGoals({ error: "offline" })),
      model((m) => {
        expect(m.maybeSaved).toEqual(Option.some(saved));
        expect(m.draft.steps.review).toEqual({ on: true, min: "1", max: "" });
        expect(m.draft.approvals.ship).toBe("human");
        expect([m.draft.gatesRun, m.draft.gatesSkipped]).toEqual([["codeReview"], ["design"]]);
      }),
      message(Message.ClickedCopy({ text: saved.skill })),
      Command.resolve(CopyText, Message.CompletedCopy()),
      model((m) => expect(m.isCopied).toBe(true)),
    );
  });

  test("a server refusal is shown; an edit clears the saved result", () => {
    story(
      update,
      given(modifyFields(ready, { maybeSaved: () => Option.some(saved) })),
      message(Message.FailedSaveGoal({ error: "invalid goal: unknown step x" })),
      model((m) => expect(m.problems).toEqual(["Could not save: invalid goal: unknown step x"])),
      message(Message.UpdatedTitle({ value: "t" })),
      model((m) => {
        expect(m.problems).toEqual([]);
        expect(m.maybeSaved).toEqual(Option.none());
      }),
    );
  });
});
