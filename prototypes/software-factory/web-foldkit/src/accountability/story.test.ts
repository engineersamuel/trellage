import { Option } from "effect"
import { AsyncData } from "foldkit"
import { Command, given, message, model, story } from "foldkit/story"
import { Dialog } from "@foldkit/ui"
import { describe, expect, test } from "vitest"
import { FetchCalibration, FetchSeries, FetchTable, FetchWorst, SaveLabel, query } from "./command"
import { CONTROLS, toCells } from "./domain"
import { calibration } from "./fixture"
import { Message } from "./message"
import { init, update } from "./update"

const start = init().model
const range = { from: "", to: "" }

describe("accountability pickers", () => {
  test("opening fetches chart, table, worst workers and calibration over all time", () => {
    story(
      update,
      given(start),
      message(Message.ClickedOpenAccountability()),
      Command.expectHas(
        FetchSeries({ dimension: "model", bucket: "day", control: "score", ...range }),
        FetchTable({ dimension: "model", ...range }),
        FetchWorst(range),
        FetchCalibration(),
      ),
      Command.resolveAll(
        [FetchSeries, Message.SucceededFetchSeries({ series: [] })],
        [FetchTable, Message.SucceededFetchTable({ table: [] })],
        [FetchWorst, Message.SucceededFetchWorst({ page: { rows: [], total: 0 } })],
        [FetchCalibration, Message.SucceededFetchCalibration({ calibration })],
        [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
      ),
      model((m) => expect(m.dialog.isOpen).toBe(true)),
    )
  })

  test("each picker changes the fetch parameters", () => {
    story(
      update,
      given(start),
      message(Message.SelectedDimension({ value: "harness" })),
      Command.expectExact(
        FetchSeries({ dimension: "harness", bucket: "day", control: "score", ...range }),
        FetchTable({ dimension: "harness", ...range }),
      ),
      Command.resolveAll(
        [FetchSeries, Message.SucceededFetchSeries({ series: [] })],
        [FetchTable, Message.SucceededFetchTable({ table: [] })],
      ),
      message(Message.SelectedBucket({ value: "week" })),
      Command.expectExact(FetchSeries({ dimension: "harness", bucket: "week", control: "score", ...range })),
      Command.resolve(FetchSeries, Message.SucceededFetchSeries({ series: [] })),
      message(Message.SelectedControl({ value: "4.6" })),
      Command.expectExact(FetchSeries({ dimension: "harness", bucket: "week", control: "4.6", ...range })),
      Command.resolve(FetchSeries, Message.SucceededFetchSeries({ series: [] })),
      message(Message.UpdatedFrom({ value: "2026-11-01" })),
      Command.expectExact(
        FetchSeries({
          dimension: "harness",
          bucket: "week",
          control: "4.6",
          from: "2026-11-01",
          to: range.to,
        }),
        FetchTable({ dimension: "harness", from: "2026-11-01", to: range.to }),
        FetchWorst({ from: "2026-11-01", to: range.to }),
      ),
      Command.resolveAll(
        [FetchSeries, Message.SucceededFetchSeries({ series: [] })],
        [FetchTable, Message.SucceededFetchTable({ table: [] })],
        [FetchWorst, Message.SucceededFetchWorst({ page: { rows: [], total: 0 } })],
      ),
      message(Message.UpdatedTo({ value: "2026-11-10" })),
      Command.expectHas(FetchWorst({ from: "2026-11-01", to: "2026-11-10" })),
      Command.resolveAll(
        [FetchSeries, Message.SucceededFetchSeries({ series: [] })],
        [FetchTable, Message.SucceededFetchTable({ table: [] })],
        [FetchWorst, Message.SucceededFetchWorst({ page: { rows: [], total: 0 } })],
      ),
      model((m) =>
        expect([m.dimension, m.bucket, m.control, m.from, m.to]).toEqual([
          "harness",
          "week",
          "4.6",
          "2026-11-01",
          "2026-11-10",
        ]),
      ),
    )
  })

  test("the request URL carries the picked values; score and empty dates are left out", () => {
    expect(query({ dimension: "step", bucket: "week", control: "5.5", from: "2026-11-01", to: "" })).toBe(
      "dimension=step&bucket=week&control=5.5&from=2026-11-01",
    )
    expect(query({ dimension: "goal", bucket: "day", control: "score", from: "", to: "" })).toBe(
      "dimension=goal&bucket=day",
    )
  })

  test("table cells merge buckets weighted by n", () => {
    expect(
      toCells("3.1", [
        { bucket: "a", value: "gpt", score: 1, n: 1 },
        { bucket: "b", value: "gpt", score: 0, n: 3 },
        { bucket: "a", value: "pi", score: null, n: 0 },
      ]),
    ).toEqual([
      { control: "3.1", value: "gpt", rate: 0.25, n: 4 },
      { control: "3.1", value: "pi", rate: null, n: 0 },
    ])
  })
})

describe("labels", () => {
  test("a label button posts worker, control and pass|fail, then refreshes calibration", () => {
    story(
      update,
      given(start),
      message(Message.ClickedLabel({ worker: "w-1", control: "4.7", label: "fail" })),
      Command.expectExact(SaveLabel({ worker: "w-1", control: "4.7", label: "fail" })),
      Command.resolve(SaveLabel, Message.SucceededLabel()),
      Command.expectExact(FetchCalibration()),
      Command.resolve(FetchCalibration, Message.SucceededFetchCalibration({ calibration })),
      model((m) => expect(AsyncData.getData(m.calibration)).toEqual(Option.some(calibration))),
    )
  })

  test("a refused label is shown and calibration is not refetched", () => {
    story(
      update,
      given(start),
      message(Message.ClickedLabel({ worker: "w-1", control: CONTROLS[0].id, label: "pass" })),
      Command.resolve(SaveLabel, Message.FailedLabel({ error: "unknown worker w-1" })),
      Command.expectNone(),
      model((m) => expect(m.maybeLabelError).toEqual(Option.some("unknown worker w-1"))),
    )
  })
})
