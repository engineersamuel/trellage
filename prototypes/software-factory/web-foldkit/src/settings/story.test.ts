import { Option } from "effect"
import { AsyncData } from "foldkit"
import { Command, expectOutMessage, given, message, model, story } from "foldkit/story"
import { modifyFields } from "foldkit/struct"
import { describe, expect, test } from "vitest"
import type { Delivery } from "../domain"
import { AddCron, FetchDelivery, FetchSettings, PatchSettings, SyncExtensions } from "./command"
import { document } from "./fixture"
import { Message, OutMessage } from "./message"
import { feedEventToMessage } from "./subscription"
import { init, pressHotkey, update } from "./update"

const delivery: Delivery = { steps: [], run: null, decisions: [], securityReviews: [] }

const loaded = modifyFields(init().model, { document: () => AsyncData.succeed(document) })

describe("loading", () => {
  test("loaded settings go to the extension host; the first load moves no focus", () => {
    story(
      update,
      given(init().model),
      message(Message.SucceededFetchSettings({ document })),
      Command.expectExact(SyncExtensions),
      model((current) => expect(AsyncData.getData(current.document)).toEqual(Option.some(document))),
      Command.resolve(SyncExtensions, Message.CompletedSyncExtensions()),
    )
  })

  test("a failed settings fetch is a Failure, not a crash", () => {
    story(
      update,
      given(init().model),
      message(Message.FailedFetchSettings({ error: "Expected string, got undefined" })),
      model((current) => expect(current.document).toEqual(AsyncData.fail("Expected string, got undefined"))),
    )
  })

  test("a live settings update keeps the loaded options and refreshes delivery", () => {
    const withDelivery = modifyFields(loaded, { delivery: () => AsyncData.succeed(delivery) })
    const next = { ...document.settings, theme: "nord", focus: "namer" }
    story(
      update,
      given(withDelivery),
      message(Message.ReceivedSettingsUpdate({ document: { settings: next, css: ":root{--x:1}" } })),
      Command.expectExact(SyncExtensions, FetchDelivery),
      expectOutMessage(OutMessage.ChangedFocus({ workerId: "namer" })),
      model((current) =>
        expect(AsyncData.getData(current.document)).toEqual(
          Option.some({ settings: next, css: ":root{--x:1}", options: document.options }),
        ),
      ),
      Command.resolveAll(
        [SyncExtensions, Message.CompletedSyncExtensions()],
        [FetchDelivery, Message.SucceededFetchDelivery({ delivery })],
      ),
    )
  })

  test("a feed gap refreshes settings and delivery", () => {
    story(
      update,
      given(modifyFields(loaded, { delivery: () => AsyncData.succeed(delivery) })),
      message(Message.ReceivedFeedGap()),
      Command.expectExact(FetchSettings, FetchDelivery),
      Command.resolveAll(
        [FetchSettings, Message.FailedFetchSettings({ error: "offline" })],
        [FetchDelivery, Message.SucceededFetchDelivery({ delivery })],
      ),
      model((current) => expect(AsyncData.isStale(current.document)).toBe(true)),
    )
  })
})

describe("controls", () => {
  test("each control patches only its own setting", () => {
    story(
      update,
      given(loaded),
      message(Message.ToggledNavbarItem({ item: "repo" })),
      Command.expectExact(PatchSettings),
      Command.resolve(PatchSettings, Message.SucceededPatchSettings()),
    )
    expect(update(loaded, Message.ToggledNavbarItem({ item: "repo" })).commands?.[0]?.args).toEqual({
      patch: { navbar: ["status", "repo"] },
    })
    expect(update(loaded, Message.ToggledNavbarItem({ item: "status" })).commands?.[0]?.args).toEqual({
      patch: { navbar: [] },
    })
    expect(update(loaded, Message.UpdatedBanner({ value: "" })).commands?.[0]?.args).toEqual({
      patch: { banner: null },
    })
    expect(update(loaded, Message.ToggledInboxCritters({ isChecked: true })).commands?.[0]?.args).toEqual({
      patch: { inboxCritters: true },
    })
    expect(update(loaded, Message.ClickedTreeStyle({ style: "vine" })).commands?.[0]?.args).toEqual({
      patch: { treeStyle: "vine" },
    })
  })

  test("a failed patch is shown", () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedTheme({ theme: "nord" })),
      Command.resolve(PatchSettings, Message.FailedPatchSettings({ error: "HTTP 400: unknown theme" })),
      model((current) => expect(current.maybePatchError).toEqual(Option.some("HTTP 400: unknown theme"))),
    )
  })

  test("a diff style chip saves the style as a setting", () => {
    story(
      update,
      given(loaded),
      message(Message.ClickedDiffStyle({ style: "split" })),
      Command.resolve(PatchSettings, Message.SucceededPatchSettings()),
    )
    expect(update(loaded, Message.ClickedDiffStyle({ style: "split" })).commands?.[0]?.args).toEqual({
      patch: { diffStyle: "split" },
    })
  })

  test("the cycleTheme hotkey picks the next theme", () => {
    expect(pressHotkey("cycleTheme")(loaded).commands?.[0]?.args).toEqual({ patch: { theme: "nord" } })
  })

  test("cycleTheme with no themes does nothing", () => {
    const empty = modifyFields(loaded, {
      document: () => AsyncData.succeed({ ...document, settings: { ...document.settings, themes: {} } }),
    })
    expect(pressHotkey("cycleTheme")(empty).commands).toBeUndefined()
  })
})

describe("cron draft", () => {
  test("typing in several fields keeps every field", () => {
    story(
      update,
      given(loaded),
      message(Message.UpdatedCronName({ value: "nightly" })),
      message(Message.UpdatedCronInterval({ value: "abc" })),
      message(Message.UpdatedCronPrompt({ value: "run tests" })),
      model((current) => expect(current.cronDraft).toEqual({ name: "nightly", every: "abc", prompt: "run tests" })),
    )
  })

  const withDraft = (every: string) =>
    modifyFields(loaded, { cronDraft: () => ({ name: "nightly", every, prompt: "run tests" }) })

  test("an interval that is not a whole number above 0 is rejected, nothing is sent", () => {
    for (const every of ["abc", "0", "-5", "1.5", ""]) {
      story(
        update,
        given(withDraft(every)),
        message(Message.SubmittedCronDraft()),
        Command.expectNone(),
        model((current) => expect(Option.isSome(current.maybeCronDraftError)).toBe(true)),
      )
    }
  })

  test("the draft resets only after the server saved the cron", () => {
    story(
      update,
      given(withDraft("300")),
      message(Message.SubmittedCronDraft()),
      Command.expectExact(AddCron),
      model((current) => expect(current.cronDraft.name).toBe("nightly")),
      Command.resolve(AddCron, Message.SucceededAddCron({ name: "nightly" })),
      model((current) => expect(current.cronDraft.name).toBe("")),
    )
  })

  test("a failed save keeps the draft and shows why", () => {
    story(
      update,
      given(withDraft("300")),
      message(Message.SubmittedCronDraft()),
      Command.resolve(AddCron, Message.FailedAddCron({ error: "HTTP 500" })),
      model((current) => {
        expect(current.cronDraft.name).toBe("nightly")
        expect(current.maybeCronDraftError).toEqual(Option.some("Could not add cron: HTTP 500"))
      }),
    )
  })
})

describe("feed events", () => {
  const raw = (type: string, data: unknown) => ({
    seq: 1,
    workerId: "coordinator",
    type,
    agentId: null,
    timestamp: "0",
    data,
  })

  test("a settings event with a wrong payload is dropped, not a crash", () => {
    expect(feedEventToMessage(raw("factory.settings_updated", { settings: { theme: 1 } }))).toEqual(Option.none())
  })

  test("a valid settings event becomes ReceivedSettingsUpdate", () => {
    expect(
      Option.map(
        feedEventToMessage(raw("factory.settings_updated", { settings: document.settings, css: "" })),
        ({ _tag }) => _tag,
      ),
    ).toEqual(Option.some("ReceivedSettingsUpdate"))
  })

  test("delivery events become ReceivedDeliveryChange; other kinds give nothing", () => {
    expect(feedEventToMessage(raw("factory.step_decided", null))).toEqual(Option.some(Message.ReceivedDeliveryChange()))
    expect(feedEventToMessage(raw("assistant.message", {}))).toEqual(Option.none())
  })
})
