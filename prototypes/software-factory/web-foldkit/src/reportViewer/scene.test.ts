import { Command, Mount, click, expect, given, role, scene } from "foldkit/scene";
import { Command as StoryCommand, message, model, story, given as storyGiven } from "foldkit/story";
import { AsyncData } from "foldkit";
import { Option } from "effect";
import { modifyFields } from "foldkit/struct";
import { Dialog } from "@foldkit/ui";
import { describe, test, expect as vitestExpect } from "vitest";
import { FetchBrief, OpenThread, StartFinding } from "./command";
import { Message } from "./message";
import { init, open, update } from "./update";
import { view } from "./view";

const REF = "reports/synthesis.md";
const report = {
  threadId: "84574dec-0000",
  folderId: "copilot-proxy-rs",
  title: "Synthesis",
  path: REF,
  file: "/wt/reports/synthesis.md",
  content: "# Top 2\n\n## 1. Make SSE line framing byte-safe\nBody one.\n\n## 2. Route chat by resolved model\nBody two.\n",
};
const opening = open(REF, Option.some("sub-84574dec"))(init().model);
const loaded = modifyFields(opening.model, { report: () => AsyncData.succeed(report) });

describe("report viewer", () => {
  test("opening loads the report for the agent that wrote the link, then its brief", () => {
    vitestExpect(opening.commands?.map((c) => [c.name, c.args])).toContainEqual(["FetchReport", { ref: REF, agent: "sub-84574dec" }]);
    story(
      update,
      storyGiven(opening.model),
      message(Message.SucceededFetchReport({ ref: REF, report })),
      StoryCommand.expectHas(FetchBrief({ ref: REF, briefRef: "reports/synthesis.brief.md", threadId: report.threadId })),
      StoryCommand.resolve(FetchBrief, Message.SucceededFetchBrief({ ref: REF, content: "**TL;DR:** decode bytes once." })),
      model((m) => vitestExpect([m.view, Option.getOrNull(m.maybeBrief)]).toEqual(["brief", "**TL;DR:** decode bytes once."])),
      // A late reply for another report is dropped.
      message(Message.FailedFetchReport({ ref: "reports/other.md", error: "x" })),
      model((m) => vitestExpect(AsyncData.isSuccess(m.report)).toBe(true)),
    );
  });

  test("shows the findings and starts one in a new conversation", () => {
    scene(
      { update, view },
      given(loaded),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      expect(role("dialog", { name: "Report synthesis.md" })).toExist(),
      expect(role("heading", { name: "2. Route chat by resolved model" })).toExist(),
      click(role("button", { name: "Start in Factory: finding 2" })),
      expect(role("button", { name: "Starting: finding 2" })).toBeDisabled(),
      Command.resolve(StartFinding, Message.SucceededStart({ rank: 2, threadId: "new-1", branch: "factory/x" })),
      Command.resolve(OpenThread, Message.CompletedOpenThread()),
      expect(role("dialog")).toContainText("Started in Factory · factory/x"),
      click(role("tab", { name: "Source" })),
      expect(role("dialog")).toContainText("## 1. Make SSE line framing byte-safe"),
    );
  });

  test("a missing report says why", () => {
    scene(
      { update, view },
      given(modifyFields(opening.model, { report: () => AsyncData.fail("report not found in any conversation worktree") })),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      expect(role("alert")).toHaveText("report not found in any conversation worktree"),
    );
  });
});
