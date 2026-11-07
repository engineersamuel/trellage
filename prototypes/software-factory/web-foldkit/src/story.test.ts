import { Effect, Option } from "effect";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import * as Url from "foldkit/url";
import { NO_ARTIFACTS, ThemeSetting, memoryNavigation, readFlags } from "@plana-solutions/agent-interface";
import { describe, expect, test } from "vitest";
import { RefreshThreads, SyncExtensionWorkers } from "./command";
import type { Worker } from "./domain";
import { Message } from "./message";
import type { Model } from "./model";
import * as Settings from "./settings";
import { FetchBacklog } from "./workerPanel/command";
import { PatchSettings, SyncExtensions } from "./settings/command";
import { document } from "./settings/fixture";
import { init, update } from "./update";
import * as WorkerPanel from "./workerPanel";

const flags = Effect.runSync(
  readFlags({
    agentName: "test",
    artifacts: NO_ARTIFACTS,
    componentLibrary: "openuiChat",
    maybeStarterVariant: Option.none(),
    maybeWelcome: Option.none(),
    navigation: memoryNavigation,
    placeholder: "",
    starters: [],
    theme: ThemeSetting.Fixed({ mode: "dark" }),
  }),
);
const url = Option.getOrThrow(Url.fromString("http://localhost/"));

const coordinator: Worker = { id: "coordinator", name: "Factory desk", role: "coordinator", status: "idle", auth: "native", model: "gpt", pid: 1, rssKb: 2048 };
const namer: Worker = { ...coordinator, id: "namer", name: "namer", role: "worker", status: "running" };

/** Settings and workers loaded, no thread open. */
const loaded: Model = modifyFields(init(flags, url, Option.none()).model, {
  settings: modifyFields({ document: () => AsyncData.succeed(document) }),
  workerPanel: modifyFields({ workers: () => AsyncData.succeed([coordinator, namer]) }),
});

const toSettings = (settingsMessage: Settings.Message): Message => Message.GotSettingsMessage({ message: settingsMessage });
const toPanel = (panelMessage: WorkerPanel.Message): Message => Message.GotWorkerPanelMessage({ message: panelMessage });

describe("focus round trip", () => {
  test("a click asks the server; the panel moves only when the settings broadcast arrives", () => {
    story(
      update,
      given(loaded),
      message(toPanel(WorkerPanel.Message.ClickedWorker({ workerId: "namer" }))),
      Command.expectExact(PatchSettings),
      model((current) => expect(current.workerPanel.selectedWorkerId).toBe("coordinator")),
      Command.resolve(PatchSettings, Settings.Message.SucceededPatchSettings()),
      message(toSettings(Settings.Message.ReceivedSettingsUpdate({ document: { settings: { ...document.settings, focus: "namer" }, css: "" } }))),
      model((current) => expect(current.workerPanel.selectedWorkerId).toBe("namer")),
      Command.expectExact(SyncExtensions, FetchBacklog),
      Command.resolveAll(
        [SyncExtensions, Settings.Message.CompletedSyncExtensions()],
        [FetchBacklog, WorkerPanel.Message.SucceededFetchBacklog({ workerId: "namer", lines: [] })],
      ),
    );
  });
});

describe("hotkeys", () => {
  test("the abort hotkey aborts the coordinator; a failure shows in the panel", () => {
    story(
      update,
      given(modifyFields(loaded, { settings: modifyFields({ document: () => AsyncData.succeed({ ...document, settings: { ...document.settings, hotkeys: { x: "abortCoordinator" } } }) }) })),
      message(Message.PressedKey({ key: "x" })),
      Command.expectExact(WorkerPanel.AbortWorker),
      Command.resolve(WorkerPanel.AbortWorker, WorkerPanel.Message.FailedAbortWorker({ workerId: "coordinator", error: "HTTP 500" })),
      model((current) => expect(current.workerPanel.maybeError).toEqual(Option.some("Could not cancel the run of Factory desk: HTTP 500"))),
    );
  });

  test("a key with no binding does nothing", () => {
    story(update, given(loaded), message(Message.PressedKey({ key: "q" })), Command.expectNone(), model((current) => expect(current).toEqual(loaded)));
  });
});

describe("outside sync", () => {
  test("a thread update with no open thread refreshes only the thread list", () => {
    story(update, given(loaded), message(Message.ReceivedThreadUpdate({ threadId: "t1" })), Command.expectExact(RefreshThreads), Command.resolve(RefreshThreads, Message.FailedRefreshThreads({ error: "offline" })));
  });

  test("a worker list change is handed to the extension host, whatever Message caused it", () => {
    story(
      update,
      given(loaded),
      message(toPanel(WorkerPanel.Message.ReceivedWorkerStopped({ workerId: "namer" }))),
      Command.expectExact(SyncExtensionWorkers),
      Command.resolve(SyncExtensionWorkers, Message.CompletedSyncExtensionWorkers()),
    );
  });
});

describe("render cost", () => {
  // Foldkit renders the page when the Model reference changes: stream deltas and other workers' events must not.
  test("a feed event the panel does not log keeps the same Model", () => {
    const event = (workerId: string, type: string) => ({ seq: 9, workerId, type, agentId: null, timestamp: "0", data: { content: "x" } });
    expect(update(loaded, toPanel(WorkerPanel.Message.ReceivedWorkerEvent({ event: event("namer", "user.message") }))).model).toBe(loaded);
    expect(update(loaded, toPanel(WorkerPanel.Message.ReceivedWorkerEvent({ event: event("coordinator", "assistant.message_delta") }))).model).toBe(loaded);
  });

  test("an identical worker report, an unknown stop, or the same approvals keep the same Model", () => {
    expect(update(loaded, toPanel(WorkerPanel.Message.ReceivedWorkerUpdate({ worker: { ...namer } }))).model).toBe(loaded);
    expect(update(loaded, toPanel(WorkerPanel.Message.ReceivedWorkerStopped({ workerId: "gone" }))).model).toBe(loaded);
    expect(update(loaded, Message.UpdatedApprovals({ pending: [] })).model).toBe(loaded);
  });

  test("a changed worker report still updates the list", () => {
    const busy = update(loaded, toPanel(WorkerPanel.Message.ReceivedWorkerUpdate({ worker: { ...namer, contextTokens: 5 } }))).model;
    expect(AsyncData.getData(busy.workerPanel.workers)).toEqual(Option.some([coordinator, { ...namer, contextTokens: 5 }]));
  });

  test("a thread list or a reloaded thread equal to what the chat shows keeps the same Model", () => {
    const thread = { id: "t1", title: "chat", createdAt: 1 };
    const listed = update(loaded, Message.SucceededRefreshThreads({ threads: [thread] })).model;
    expect(listed).not.toBe(loaded);
    expect(update(listed, Message.SucceededRefreshThreads({ threads: [{ ...thread }] })).model).toBe(listed);
    const open = modifyFields(listed, { chat: modifyFields({ maybeSelectedThreadId: () => Option.some("t1") }) });
    const messages = [{ id: "m1", role: "user" as const, content: "hi" }];
    const shown = update(open, Message.SucceededReloadThread({ threadId: "t1", messages })).model;
    expect(shown).not.toBe(open);
    expect(update(shown, Message.SucceededReloadThread({ threadId: "t1", messages: [{ ...messages[0]! }] })).model).toBe(shown);
  });

  test("a child update that keeps its Model keeps the root Model", () => {
    expect(update(loaded, toPanel(WorkerPanel.Message.SucceededAbortWorker())).model).toBe(loaded);
    expect(update(loaded, toSettings(Settings.Message.CompletedSyncExtensions())).model).toBe(loaded);
  });
});
