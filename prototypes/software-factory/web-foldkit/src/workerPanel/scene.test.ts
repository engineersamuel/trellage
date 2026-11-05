import { Command, Mount, Subscription, click, expect, given, label, role, scene, submit, text, type } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { describe, test } from "vitest";
import type { Worker } from "../domain";
import { MountTranscript, SendToWorker, StopWorker } from "./command";
import { Message } from "./message";
import { WorkersAsyncData } from "./model";
import { init, update } from "./update";
import { view } from "./view";

const coordinator: Worker = { id: "coordinator", name: "Factory desk", role: "coordinator", status: "idle", auth: "native", model: "gpt", pid: 1, rssKb: 2048 };
const namer: Worker = { ...coordinator, id: "namer", name: "namer", role: "worker", status: "running" };

const loaded = modifyFields(init("coordinator").model, { workers: () => WorkersAsyncData.Success({ data: [coordinator, namer] }) });
const namerSelected = modifyFields(loaded, { selectedWorkerId: () => "namer" });

const messageField = label("Message namer");

describe("worker panel", () => {
  test("lists the agents and marks the selected one", () => {
    scene(
      { update, view },
      given(loaded),
      Mount.resolve(MountTranscript, Message.CompletedMountTranscript()),
      expect(role("heading", { name: "Agents (2)" })).toExist(),
      expect(role("button", { name: /Factory desk/ })).toHaveAttr("aria-current", "true"),
      expect(role("button", { name: /namer/ })).not.toHaveAttr("aria-current", "true"),
    );
  });

  test("shows a load failure as an alert", () => {
    scene(
      { update, view },
      given(init("coordinator").model),
      Mount.resolve(MountTranscript, Message.CompletedMountTranscript()),
      expect(text("Loading agents…")).toExist(),
      Subscription.emit(Message.FailedFetchWorkers({ error: "HTTP 500" })),
      expect(role("alert")).toHaveText("Could not load agents: HTTP 500"),
    );
  });

  test("sending a message: type, submit, the draft clears on success", () => {
    scene(
      { update, view },
      given(namerSelected),
      Mount.resolve(MountTranscript, Message.CompletedMountTranscript()),
      type(messageField, "hello"),
      submit(role("form")),
      Command.expectExact(SendToWorker),
      Command.resolve(SendToWorker, Message.SucceededSendToWorker({ prompt: "hello" })),
      expect(messageField).toHaveValue(""),
    );
  });

  test("a failed stop shows an alert the user can dismiss", () => {
    scene(
      { update, view },
      given(namerSelected),
      Mount.resolve(MountTranscript, Message.CompletedMountTranscript()),
      click(role("button", { name: "Stop namer" })),
      Command.resolve(StopWorker, Message.FailedStopWorker({ error: "HTTP 404" })),
      expect(role("alert")).toHaveText(/Stop failed: HTTP 404/),
      click(role("button", { name: "Dismiss error" })),
      expect(role("alert")).not.toExist(),
    );
  });

  test("the raw-events checkbox switches the transcript for the raw log", () => {
    scene(
      { update, view },
      given(loaded),
      Mount.resolve(MountTranscript, Message.CompletedMountTranscript()),
      click(role("checkbox", { name: "raw events" })),
      expect(role("checkbox", { name: "raw events" })).toBeChecked(),
      Mount.expectEnded(MountTranscript),
    );
  });
});
