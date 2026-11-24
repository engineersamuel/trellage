import {
  Command,
  Mount,
  all,
  change,
  click,
  expect,
  expectAll,
  first,
  given,
  label,
  role,
  scene,
  selector,
  type,
  within,
} from "foldkit/scene"
import { AsyncData } from "foldkit"
import { modifyFields } from "foldkit/struct"
import * as Url from "foldkit/url"
import { Dialog } from "@foldkit/ui"
import {
  Message as ChatMessage,
  NO_ARTIFACTS,
  ThemeSetting,
  memoryNavigation,
  readFlags,
} from "@plana-solutions/agent-interface"
import { Effect, Option } from "effect"
import { describe, test } from "vitest"
import { AttachSlot } from "../command"
import { Message as AppMessage } from "../message"
import type { Model } from "../model"
import { document } from "../settings/fixture"
import { update as appUpdate, init } from "../update"
import { view as appView } from "../view"
import { FetchCalibration, FetchSeries, FetchTable, FetchWorst, SaveLabel } from "./command"
import { type CalibrationList, type Grade, type SeriesPoint, toCells } from "./domain"
import { calibration, grade, series } from "./fixture"
import { Message } from "./message"
import * as Accountability from "."
import { update } from "./update"
import type { Model as AccountabilityModel } from "./model"
import type { Html, HtmlBuilder } from "foldkit/html"

/** The navbar button and the dialog it opens, as the root view renders them. */
const view = (model: AccountabilityModel, h: HtmlBuilder<Message>): Html =>
  h.div([], [Accountability.navButton(model, h), Accountability.view(model, h)])

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
/** The whole app with settings loaded, so the navbar shows; accountability starts at a fixed day. */
const app: Model = modifyFields(init(flags, url, Option.none()).model, {
  settings: modifyFields({ document: () => AsyncData.succeed(document) }),
})

const start = Accountability.init().model

/** Settle what the root view mounts (extension slots, the chat's watchers) with the Messages they report. */
const mount = (name: string) => ({ name })
const appMounts = [
  Mount.resolveAll(
    ...[1, 2, 3, 4, 5].map(() => [AttachSlot, AppMessage.CompletedAttachSlot()] as const),
    [mount("MeasureContainer"), ChatMessage.ResizedContainer({ width: 1200 })],
    [mount("WatchScrollMasks"), ChatMessage.ChangedThreadListMasks({ top: false, bottom: false })],
    [mount("WatchThreadScroll"), ChatMessage.ChangedLatestZone({ zone: "Near" })],
    [mount("PublishComposerSlotHeight"), ChatMessage.CompletedPublishComposerSlotHeight()],
    [mount("WatchComposerClicks"), ChatMessage.ClickedComposerArea()],
  ),
  Command.resolve(
    // agent-interface does not export FocusComposer; an instance matcher with the same name and args stands in.
    {
      name: "FocusComposer",
      args: { elementId: "agent-interface-composer-input" },
      effect: Effect.succeed(ChatMessage.CompletedFocusComposer()),
    },
    ChatMessage.CompletedFocusComposer(),
  ),
  Mount.resolveAll([
    mount("WatchComposerInput"),
    ChatMessage.MeasuredComposerOverflow({ hasOverflowBottom: false, hasOverflowTop: false }),
  ]),
] as const
const worst: ReadonlyArray<Grade> = [grade("w-mid", 0.5), grade("w-low", 0.25, "verify")]
const table = [
  ...toCells("3.5", [{ bucket: "2026-11-17", value: "gpt", score: 0.5, n: 4 }]),
  ...toCells("4.6", [{ bucket: "2026-11-17", value: "gpt", score: 1, n: 2 }]),
]

/** Click the real navbar button and answer every fetch. */
const open = (data: { series: ReadonlyArray<SeriesPoint>; rows: ReadonlyArray<Grade>; calibration: CalibrationList }) =>
  [
    click(role("button", { name: "Open worker accountability" })),
    Command.resolveAll(
      [FetchSeries, Message.SucceededFetchSeries({ series: data.series })],
      [FetchTable, Message.SucceededFetchTable({ table: data.rows.length ? table : [] })],
      [FetchWorst, Message.SucceededFetchWorst({ page: { rows: data.rows, total: data.rows.length } })],
      [FetchCalibration, Message.SucceededFetchCalibration({ calibration: data.calibration })],
    ),
    Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
  ] as const

const chart = role("img", { name: "score by model per day" })

describe("accountability view", () => {
  test("the app navbar has the Accountability button next to Goals; clicking it opens the view", () => {
    const nav = role("navigation", { name: "Factory status" })
    scene(
      { update: appUpdate, view: appView },
      given(app),
      ...appMounts,
      expect(within(nav, role("button", { name: "Open factory goals" }))).toExist(),
      expect(within(nav, role("button", { name: "Open worker accountability" }))).toContainText("Accountability"),
      ...open({ series, rows: worst, calibration }),
      expect(role("heading", { name: "Worker accountability" })).toExist(),
      expectAll(all.selector(".fk-acct-svg polyline")).toHaveCount(2),
    )
  })

  test("the navbar button opens a line chart with one polyline per value, plotted from the series", () => {
    scene(
      { update, view },
      given(start),
      ...open({ series, rows: worst, calibration }),
      expect(role("heading", { name: "Worker accountability" })).toExist(),
      expectAll(all.selector(".fk-acct-svg polyline")).toHaveCount(2),
      // x: buckets 11-20 and 11-21 at the plot's two ends (36 and 628); y: 10 + (1 - score) * 186.
      expect(within(chart, selector('[data-value="gpt"] polyline'))).toHaveAttr("points", "36,103 628,56.5"),
      expect(within(chart, selector('[data-value="opus"] polyline'))).toHaveAttr("points", "36,10 628,149.5"),
      expectAll(all.selector('.fk-acct-svg [data-value="opus"] circle')).toHaveCount(2),
      expect(within(role("list", { name: "Lines" }), role("listitem", { name: "opus" }))).toExist(),
    )
  })

  test("a control pick re-plots with that control's pass rate", () => {
    scene(
      { update, view },
      given(start),
      ...open({ series, rows: worst, calibration }),
      change(label("Plot"), "3.5"),
      Command.resolve(
        FetchSeries,
        Message.SucceededFetchSeries({
          series: [{ bucket: "2026-11-21", value: "gpt", score: 0, n: 3 }],
        }),
      ),
      expect(within(role("img", { name: "3.5 pass rate by model per day" }), selector("polyline"))).toHaveAttr(
        "points",
        "332,196",
      ),
      click(role("button", { name: "week" })),
      Command.resolve(FetchSeries, Message.SucceededFetchSeries({ series })),
      expect(role("img", { name: "3.5 pass rate by model per week" })).toExist(),
      change(label("Group by"), "step"),
      Command.resolveAll(
        [FetchSeries, Message.SucceededFetchSeries({ series })],
        [FetchTable, Message.SucceededFetchTable({ table })],
      ),
      expect(role("img", { name: "3.5 pass rate by step per week" })).toExist(),
      type(label("From"), "2026-11-01"),
      Command.resolveAll(
        [FetchSeries, Message.SucceededFetchSeries({ series })],
        [FetchTable, Message.SucceededFetchTable({ table })],
        [FetchWorst, Message.SucceededFetchWorst({ page: { rows: worst, total: 2 } })],
      ),
      expect(label("From")).toHaveValue("2026-11-01"),
    )
  })

  test("control x value table shows pass rate and n; uncalibrated controls are greyed with the word", () => {
    const passRates = role("table", { name: "Pass rate by control and model" })
    scene(
      { update, view },
      given(start),
      ...open({ series, rows: worst, calibration }),
      expect(within(passRates, role("columnheader", { name: "gpt" }))).toExist(),
      expect(within(passRates, role("row", { name: /^3\.5/ }))).toContainText("50% · n 4"),
      expect(within(passRates, role("row", { name: /^3\.5/ }))).not.toHaveClass("fk-acct-uncalibrated"),
      expect(within(passRates, role("row", { name: /^4\.6/ }))).toContainText("100% · n 2"),
      expect(within(passRates, role("row", { name: /^4\.6/ }))).toHaveClass("fk-acct-uncalibrated"),
      expect(within(passRates, role("row", { name: /^4\.6/ }))).toContainText("uncalibrated"),
      expect(within(role("table", { name: "Calibration" }), role("row", { name: /^3\.5/ }))).toContainText(
        "80% (16/20)calibrated",
      ),
      expect(within(role("table", { name: "Calibration" }), role("row", { name: /^4\.7/ }))).toHaveClass(
        "fk-acct-uncalibrated",
      ),
    )
  })

  test("worst workers link to the worker's chat, lowest score first", () => {
    const worstWorkers = role("table", { name: "Worst workers" })
    scene(
      { update, view },
      given(start),
      ...open({ series, rows: worst, calibration }),
      expect(within(worstWorkers, role("link", { name: "w-low" }))).toHaveAttr("href", "?worker=w-low"),
      expect(within(worstWorkers, role("link", { name: "w-mid" }))).toHaveAttr("href", "?worker=w-mid"),
      expect(within(worstWorkers, role("row", { name: /^w-low/ }))).toContainText("25%verifygpt$1.25 / $2.00"),
      expect(within(worstWorkers, first(all.role("row", { name: /^w-/ })))).toContainText("w-low"),
    )
  })

  test("a label button posts the label, then calibration refreshes", () => {
    const after = calibration.map((c) => (c.control === "4.7" ? { ...c, labels: 4, agree: 2, agreement: 0.5 } : c))
    scene(
      { update, view },
      given(start),
      ...open({ series, rows: worst, calibration }),
      click(role("button", { name: "Label w-low 4.7 fail" })),
      Command.expectExact(SaveLabel({ worker: "w-low", control: "4.7", label: "fail" })),
      Command.resolve(SaveLabel, Message.SucceededLabel()),
      Command.resolve(FetchCalibration, Message.SucceededFetchCalibration({ calibration: after })),
      expect(within(role("table", { name: "Calibration" }), role("row", { name: /^4\.7/ }))).toContainText("50% (2/4)"),
    )
  })

  test("nothing graded shows the empty state, not empty tables", () => {
    scene(
      { update, view },
      given(start),
      ...open({ series: [], rows: [], calibration }),
      expect(role("status")).toHaveText("No graded workers yet. Run `sf accountability backfill`."),
      expect(role("table", { name: "Worst workers" })).toBeAbsent(),
      expect(selector(".fk-acct-svg")).toBeAbsent(),
    )
  })
})
