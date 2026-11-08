import { Command, Mount, click, expect, given, keydown, label, role, scene } from "foldkit/scene";
import { Dialog } from "@foldkit/ui";
import { describe, test } from "vitest";
import { FetchDiff, MountNativeDiff } from "./command";
import { Message } from "./message";
import { init, open, update } from "./update";
import { view } from "./view";

const file = (path: string, status: "M" | "A" | "D" | "?") => ({
  path,
  status,
  added: 2,
  removed: 1,
  binary: false,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-a\n+b\n+c\n`,
  tooLarge: false,
});
const diff = { worktree: "/w", base: "abcdef1234", files: [file("README.md", "M"), file("src/new.ts", "?"), file("src/pi.ts", "M")] };
// `given` starts from the Model `open` returns; its Commands are dropped, so the test reloads to fetch.
const opened = open("t1")(init().model).model;

describe("worktree changes panel", () => {
  test("lists files by folder, shows the first diff and moves with j/k", () => {
    scene(
      { update, view },
      given(opened),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      click(role("button", { name: "Reload changes" })),
      Command.resolve(FetchDiff, Message.SucceededFetchDiff({ diff })),
      expect(role("heading", { name: "Worktree changes" })).toExist(),
      expect(role("navigation", { name: "Changed files" })).toContainText("src/"),
      expect(label("Diff of README.md")).toExist(),
      Mount.resolve(MountNativeDiff, Message.CompletedMountNativeDiff()),
      // Scene tracks a Mount by name and position, so the next file's diff reuses the resolved MountNativeDiff.
      keydown(".fk-diff-panel", "j"),
      expect(label("Diff of src/new.ts")).toExist(),
      keydown(".fk-diff-panel", "k"),
      expect(label("Diff of README.md")).toExist(),
      click(role("button", { name: /pi\.ts/ })),
      expect(label("Diff of src/pi.ts")).toExist(),
    );
  });

  test("an empty worktree says so", () => {
    scene(
      { update, view },
      given(opened),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      click(role("button", { name: "Reload changes" })),
      Command.resolve(FetchDiff, Message.SucceededFetchDiff({ diff: { ...diff, files: [] } })),
      expect(role("paragraph")).toHaveText("No changes against the base commit."),
    );
  });
});
