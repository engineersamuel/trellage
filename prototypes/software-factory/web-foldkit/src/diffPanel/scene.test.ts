import { Command, Mount, Subscription, click, expect, given, keydown, label, role, scene } from "foldkit/scene";
import { Option } from "effect";
import { Dialog } from "@foldkit/ui";
import { describe, test, expect as vitestExpect } from "vitest";
import type { FeedEvent } from "../../../shared/feed";
import { FetchDiff, MountNativeDiff } from "./command";
import { Message } from "./message";
import { follow, init, open, totals, update } from "./update";
import { changesWorktree, reloadDependencies } from "./subscription";
import { view } from "./view";

const file = (path: string, status: "M" | "A" | "D" | "?") => ({
  path,
  status,
  added: 2,
  removed: 1,
  binary: false,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-a\n+b\n+c\n`,
  tooLarge: false,
  committed: status !== "?",
  local: status === "?",
});
const diff = { worktree: "/w", base: "abcdef1234", unpushed: 0, files: [file("README.md", "M"), file("src/new.ts", "?"), file("src/pi.ts", "M")] };
// `given` starts from the Model `open` returns; its Commands are dropped, so the test reloads to fetch.
const opened = open("t1")(init().model).model;

describe("worktree changes panel", () => {
  test("lists files by folder, shows the first diff and moves with j/k", () => {
    scene(
      { update, view },
      given(opened),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      click(role("button", { name: "Reload changes" })),
      Command.resolve(FetchDiff, Message.SucceededFetchDiff({ threadId: "t1", diff })),
      expect(role("heading", { name: "Worktree changes" })).toExist(),
      expect(role("navigation", { name: "Changed files" })).toContainText("src/"),
      expect(label("Diff of README.md")).toExist(),
      Mount.resolve(MountNativeDiff, Message.CompletedMountNativeDiff()),
      // Scene tracks a Mount by name and position, so the next file's diff reuses the resolved MountNativeDiff.
      // Committed files come first, then files only on disk.
      expect(label("In the branch (committed)")).toContainText("pi.ts"),
      expect(label("Only on disk (not committed)")).toContainText("new.ts"),
      keydown(".fk-diff-panel", "j"),
      expect(label("Diff of src/pi.ts")).toExist(),
      keydown(".fk-diff-panel", "j"),
      expect(label("Diff of src/new.ts")).toExist(),
      keydown(".fk-diff-panel", "k"),
      expect(label("Diff of src/pi.ts")).toExist(),
      click(role("button", { name: /README\.md/ })),
      expect(label("Diff of README.md")).toExist(),
    );
  });

  test("an empty worktree says so", () => {
    scene(
      { update, view },
      given(opened),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      click(role("button", { name: "Reload changes" })),
      Command.resolve(FetchDiff, Message.SucceededFetchDiff({ threadId: "t1", diff: { ...diff, files: [] } })),
      expect(role("paragraph")).toHaveText("No changes against the base commit."),
    );
  });

  test("a file change reloads the panel", () => {
    const edited = { ...diff, files: [{ ...diff.files[0]!, added: 3, patch: `${diff.files[0]!.patch}+d\n` }, ...diff.files.slice(1)] };
    scene(
      { update, view },
      given(opened),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      click(role("button", { name: "Reload changes" })),
      Command.resolve(FetchDiff, Message.SucceededFetchDiff({ threadId: "t1", diff })),
      Mount.resolve(MountNativeDiff, Message.CompletedMountNativeDiff()),
      Subscription.emit(Message.ReceivedFileChange()),
      Command.resolve(FetchDiff, Message.SucceededFetchDiff({ threadId: "t1", diff: edited })),
      expect(role("button", { name: /README\.md/ })).toContainText("+3"),
    );
  });

  test("only tool calls of agents in the shown worktree reload, plus cleanups and gaps", () => {
    const event = (type: string, workerId = "w"): FeedEvent => ({ seq: 1, workerId, type, agentId: null, timestamp: "", data: {} });
    const inWorktree = changesWorktree(["sub-t1", "w1"]);
    vitestExpect(inWorktree(event("tool.execution_complete", "w1"))).toBe(true);
    vitestExpect(inWorktree(event("tool.execution_complete", "other"))).toBe(false);
    vitestExpect(inWorktree(event("factory.worktree_cleaned"))).toBe(true);
    vitestExpect(inWorktree(event("assistant.message_delta", "w1"))).toBe(false);
  });

  test("the agents whose workdir is the shown worktree", () => {
    const loaded = update(opened, Message.SucceededFetchDiff({ threadId: "t1", diff })).model;
    const worker = (id: string, workdir: string | null) => ({ id, name: id, role: "worker", status: "idle", auth: "native", model: "m", pid: null, rssKb: null, workdir });
    vitestExpect(reloadDependencies(loaded, [worker("w1", "/w"), worker("w2", "/elsewhere"), worker("w3", null)])).toEqual({ agentIds: ["w1"] });
  });

  test("follows the open conversation while closed and sums the lines for the navbar", () => {
    const following = follow("t2")(init().model);
    vitestExpect(following.model.threadId).toBe("t2");
    vitestExpect(following.model.dialog.isOpen).toBe(false);
    vitestExpect(following.commands?.length).toBe(1);
    vitestExpect(follow("t2")(following.model).commands ?? []).toEqual([]);
    const loaded = update(following.model, Message.SucceededFetchDiff({ threadId: "t2", diff })).model;
    vitestExpect(update(loaded, Message.FailedFetchDiff({ threadId: "-", error: "late" })).model).toBe(loaded);
    vitestExpect(totals(loaded)).toEqual(Option.some({ added: 6, removed: 3 }));
  });
});
