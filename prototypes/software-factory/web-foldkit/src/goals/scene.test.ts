import { Command, Mount, Subscription, change, click, expect, given, label, role, scene, submit, type } from "foldkit/scene";
import { Dialog } from "@foldkit/ui";
import { describe, test } from "vitest";
import { FetchCatalog, FetchGoals, SaveGoal } from "./command";
import { Message } from "./message";
import { init, update } from "./update";
import { view } from "./view";

const catalog = {
  steps: [
    { id: "implement", description: "Write code", skills: ["ub-mode"] },
    { id: "verify", description: "Check", skills: [] },
    { id: "security", description: "Audit", skills: ["security-audit"] },
    { id: "finish", description: "Ship", skills: [] },
  ],
  folders: [{ id: "cpr", name: "cpr", path: "/r/cpr" }],
};
const goals = { dir: "/d", factoryCommit: "abc123", goals: [] };

const openDialog = [
  Subscription.emit(Message.ClickedOpenGoals()),
  Command.resolveAll([FetchGoals, Message.SucceededFetchGoals({ goals })], [FetchCatalog, Message.SucceededFetchCatalog({ catalog })]),
  Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
  Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
] as const;

describe("goal dialog", () => {
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
      Command.resolve(SaveGoal, Message.SucceededSaveGoal({ saved: { skill: "/factory-loop demo", prompt: "# Factory loop" } })),
      Command.resolve(FetchGoals, Message.SucceededFetchGoals({ goals })),
      expect(role("code", { name: "command" })).toHaveText("/factory-loop demo"),
      expect(role("button", { name: "Copy command" })).toExist(),
    );
  });
});
