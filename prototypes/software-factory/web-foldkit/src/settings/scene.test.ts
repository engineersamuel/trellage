import { AsyncData } from "foldkit";
import { Command, Mount, Subscription, click, expect, given, label, role, scene, submit, type } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { Dialog } from "@foldkit/ui";
import { describe, test } from "vitest";
import { AddCron, MountDiffPreview, PatchSettings } from "./command";
import { document } from "./fixture";
import { Message } from "./message";
import { init, update } from "./update";
import { view } from "./view";

const loaded = modifyFields(init().model, { document: () => AsyncData.succeed(document) });

/** Open the drawer and settle what the Dialog and the diff preview start. */
const openDrawer = [
  Subscription.emit(Message.ClickedOpenSettings()),
  Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
  Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
  Mount.resolve(MountDiffPreview, Message.CompletedMountDiffPreview()),
] as const;

describe("settings drawer", () => {
  test("a failed change shows an alert", () => {
    scene(
      { update, view },
      given(loaded),
      ...openDrawer,
      click(role("button", { name: /nord/ })),
      Command.resolve(PatchSettings, Message.FailedPatchSettings({ error: "HTTP 500" })),
      expect(role("alert")).toHaveText("HTTP 500"),
    );
  });

  test("the cron form explains a missing prompt, then shows a save failure and keeps the draft", () => {
    scene(
      { update, view },
      given(loaded),
      ...openDrawer,
      type(label("Cron name"), "nightly"),
      submit(role("form")),
      expect(role("alert")).toHaveText("Give the cron a prompt."),
      type(label("Cron prompt"), "run the tests"),
      submit(role("form")),
      Command.resolve(AddCron, Message.FailedAddCron({ error: "HTTP 409" })),
      expect(role("alert")).toHaveText("Could not add cron: HTTP 409"),
      expect(label("Cron name")).toHaveValue("nightly"),
    );
  });
});
