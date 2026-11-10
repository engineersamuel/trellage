import { Effect, Option } from "effect"
import { AsyncData } from "foldkit"
import { Command, given, message, model, story } from "foldkit/story"
import { modifyFields } from "foldkit/struct"
import * as Url from "foldkit/url"
import { NO_ARTIFACTS, ThemeSetting, memoryNavigation, readFlags } from "@plana-solutions/agent-interface"
import { Dialog } from "@foldkit/ui"
import { describe, expect, test } from "vitest"
import { RefreshThreads, ShowAgent, SyncExtensionWorkers } from "./command"
import { FetchReport as ReportViewerFetch } from "./reportViewer/command"
import { Message as ReportViewerMessage } from "./reportViewer/message"
import type { Worker } from "./domain"
import { Message } from "./message"
import type { Model } from "./model"
import * as Settings from "./settings"
import { SyncExtensions } from "./settings/command"
import { document } from "./settings/fixture"
import { init, update } from "./update"
import * as Workers from "./workers"

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
)
const url = Option.getOrThrow(Url.fromString("http://localhost/"))

const coordinator: Worker = {
  id: "coordinator",
  name: "Factory desk",
  role: "coordinator",
  status: "idle",
  auth: "native",
  model: "gpt",
  pid: 1,
  rssKb: 2048,
}
const namer: Worker = { ...coordinator, id: "namer", name: "namer", role: "worker", status: "running" }

/** Settings and workers loaded, no thread open. */
const loaded: Model = modifyFields(init(flags, url, Option.none()).model, {
  settings: modifyFields({ document: () => AsyncData.succeed(document) }),
  workers: modifyFields({ workers: () => AsyncData.succeed([coordinator, namer]) }),
})

const toSettings = (settingsMessage: Settings.Message): Message =>
  Message.GotSettingsMessage({ message: settingsMessage })
const toWorkers = (workersMessage: Workers.Message): Message => Message.GotWorkersMessage({ message: workersMessage })

describe("focus", () => {
  test("a focus change in a settings update selects that agent in the Inbox; the same focus does nothing", () => {
    story(
      update,
      given(loaded),
      message(
        toSettings(
          Settings.Message.ReceivedSettingsUpdate({
            document: { settings: { ...document.settings, focus: "namer" }, css: "" },
          }),
        ),
      ),
      Command.expectExact(SyncExtensions, ShowAgent),
      Command.resolveAll(
        [SyncExtensions, Settings.Message.CompletedSyncExtensions()],
        [ShowAgent, Message.CompletedShowAgent()],
      ),
      model((current) =>
        expect(Settings.maybeSettings(current.settings).pipe(Option.map(({ focus }) => focus))).toEqual(
          Option.some("namer"),
        ),
      ),
    )
    story(
      update,
      given(loaded),
      message(
        toSettings(Settings.Message.ReceivedSettingsUpdate({ document: { settings: document.settings, css: "" } })),
      ),
      Command.expectExact(SyncExtensions),
      Command.resolve(SyncExtensions, Settings.Message.CompletedSyncExtensions()),
      model((current) =>
        expect(Settings.maybeSettings(current.settings).pipe(Option.map(({ focus }) => focus))).toEqual(
          Option.some("coordinator"),
        ),
      ),
    )
  })
})

describe("hotkeys", () => {
  test("the abort hotkey aborts the coordinator", () => {
    story(
      update,
      given(
        modifyFields(loaded, {
          settings: modifyFields({
            document: () =>
              AsyncData.succeed({
                ...document,
                settings: { ...document.settings, hotkeys: { x: "abortCoordinator" } },
              }),
          }),
        }),
      ),
      message(Message.PressedKey({ key: "x" })),
      Command.expectExact(Workers.AbortWorker),
      Command.resolve(
        Workers.AbortWorker,
        Workers.Message.FailedAbortWorker({ workerId: "coordinator", error: "HTTP 500" }),
      ),
      model((current) => expect(current.workers).toEqual(loaded.workers)),
    )
  })

  test("a key with no binding does nothing", () => {
    story(
      update,
      given(loaded),
      message(Message.PressedKey({ key: "q" })),
      Command.expectNone(),
      model((current) => expect(current).toEqual(loaded)),
    )
  })
})

describe("outside sync", () => {
  test("a thread update with no open thread refreshes only the thread list", () => {
    story(
      update,
      given(loaded),
      message(Message.ReceivedThreadUpdate({ threadId: "t1" })),
      Command.expectExact(RefreshThreads),
      Command.resolve(RefreshThreads, Message.FailedRefreshThreads({ error: "offline" })),
      model((current) => expect(current.chat).toBe(loaded.chat)),
    )
  })

  test("a worker list change is handed to the extension host, whatever Message caused it", () => {
    story(
      update,
      given(loaded),
      message(toWorkers(Workers.Message.ReceivedWorkerStopped({ workerId: "namer" }))),
      Command.expectExact(SyncExtensionWorkers),
      Command.resolve(SyncExtensionWorkers, Message.CompletedSyncExtensionWorkers()),
      model((current) => expect(AsyncData.getData(current.workers.workers)).toEqual(Option.some([coordinator]))),
    )
  })
})

describe("render cost", () => {
  // Foldkit renders the page when the Model reference changes: stream deltas and other workers' events must not.
  test("an identical worker report, an unknown stop, or the same approvals keep the same Model", () => {
    expect(update(loaded, toWorkers(Workers.Message.ReceivedWorkerUpdate({ worker: { ...namer } }))).model).toBe(loaded)
    expect(update(loaded, toWorkers(Workers.Message.ReceivedWorkerStopped({ workerId: "gone" }))).model).toBe(loaded)
    expect(update(loaded, Message.UpdatedApprovals({ pending: [] })).model).toBe(loaded)
  })

  test("a changed worker report still updates the list", () => {
    const busy = update(
      loaded,
      toWorkers(Workers.Message.ReceivedWorkerUpdate({ worker: { ...namer, contextTokens: 5 } })),
    ).model
    expect(AsyncData.getData(busy.workers.workers)).toEqual(Option.some([coordinator, { ...namer, contextTokens: 5 }]))
  })

  test("a thread list or a reloaded thread equal to what the chat shows keeps the same Model", () => {
    const thread = { id: "t1", title: "chat", createdAt: 1 }
    const listed = update(loaded, Message.SucceededRefreshThreads({ threads: [thread] })).model
    expect(listed).not.toBe(loaded)
    expect(update(listed, Message.SucceededRefreshThreads({ threads: [{ ...thread }] })).model).toBe(listed)
    const open = modifyFields(listed, { chat: modifyFields({ maybeSelectedThreadId: () => Option.some("t1") }) })
    const messages = [{ id: "m1", role: "user" as const, content: "hi" }]
    const shown = update(open, Message.SucceededReloadThread({ threadId: "t1", messages })).model
    expect(shown).not.toBe(open)
    expect(
      update(shown, Message.SucceededReloadThread({ threadId: "t1", messages: [{ ...messages[0]! }] })).model,
    ).toBe(shown)
  })

  test("a child update that keeps its Model keeps the root Model", () => {
    expect(update(loaded, toWorkers(Workers.Message.SucceededAbortWorker())).model).toBe(loaded)
    expect(update(loaded, toSettings(Settings.Message.CompletedSyncExtensions())).model).toBe(loaded)
  })
})

describe("agent UI actions", () => {
  test("open_report (or a click on a report path) opens the viewer on that report", () => {
    story(
      update,
      given(loaded),
      message(Message.RequestedOpenReport({ ref: "reports/synthesis.md", maybeAgent: Option.some("gen-1") })),
      model((current) =>
        expect([current.reportViewer.dialog.isOpen, current.reportViewer.ref, current.reportViewer.maybeAgent]).toEqual(
          [true, "reports/synthesis.md", Option.some("gen-1")],
        ),
      ),
      Command.expectHas(ReportViewerFetch),
      Command.resolveAll(
        [ReportViewerFetch, ReportViewerMessage.FailedFetchReport({ ref: "reports/synthesis.md", error: "gone" })],
        [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
      ),
    )
  })
})
