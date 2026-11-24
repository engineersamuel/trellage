import { Array, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Button, Dialog, Input, Select } from "@foldkit/ui"
import {
  CONTROLS,
  type CalibrationList,
  type ControlId,
  DIMENSIONS,
  type Grade,
  SCORE,
  type SeriesPoint,
  type TableCell,
} from "./domain"
import { Message } from "./message"
import type { Model } from "./model"

/** Categorical line colours, each at least 3:1 on the drawer surface (#171717). The legend names every line too. */
const LINE_COLOURS = ["#60a5fa", "#f59e0b", "#34d399", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c", "#e5e5e5"]
const CHART = { width: 640, height: 220, left: 36, right: 12, top: 10, bottom: 24 }
const EMPTY = "No graded workers yet. Run `sf accountability backfill`."

const pct = (rate: number | null) => (rate === null ? "-" : `${Math.round(rate * 100)}%`)

const section = (title: string, children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section([], [h.h3([], [title]), ...children])

const loading = <A>(
  data: AsyncData.AsyncData<A, string>,
  what: string,
  onData: (a: A) => Html,
  h: HtmlBuilder<Message>,
): Html =>
  AsyncData.matchDataSplitEmpty(data, {
    onIdle: () => h.empty,
    onLoading: () => h.p([h.Class("fk-muted")], [`Loading ${what}…`]),
    onFailure: (error) => h.p([h.Class("fk-error"), h.Role("alert")], [`Could not load ${what}: ${error}`]),
    onData,
  })

/** Controls the human labels have not yet calibrated. Before calibration loads, none is marked. */
const uncalibrated = (model: Model): ReadonlySet<string> =>
  new Set(
    Option.match(AsyncData.getData(model.calibration), {
      onNone: () => [],
      onSome: (list) => list.filter((c) => !c.calibrated).map((c) => c.control),
    }),
  )

const uncalibratedTag = (h: HtmlBuilder<Message>): Html => h.span([h.Class("fk-acct-tag")], ["uncalibrated"])

// ---------- Pickers ----------

const select = (
  id: string,
  label: string,
  value: string,
  options: ReadonlyArray<readonly [string, string]>,
  onChange: (value: string) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  Select.view(
    {
      id,
      value,
      onChange,
      toView: (attributes) =>
        h.span(
          [h.Class("fk-field")],
          [
            h.label([...attributes.label], [label]),
            h.select(
              [...attributes.select],
              options.map(([v, text]) => h.option([h.Value(v)], [text])),
            ),
          ],
        ),
    },
    h,
  )

const dateInput = (
  id: string,
  label: string,
  value: string,
  onInput: (v: string) => Message,
  h: HtmlBuilder<Message>,
) =>
  Input.view(
    {
      id,
      value,
      type: "date",
      onInput,
      toView: (attributes) =>
        h.span([h.Class("fk-field")], [h.label([...attributes.label], [label]), h.input([...attributes.input])]),
    },
    h,
  )

const chip = (label: string, isOn: boolean, onClick: Message, h: HtmlBuilder<Message>): Html =>
  Button.view(
    {
      onClick,
      toView: (attributes) =>
        h.button([...attributes.button, h.Class(isOn ? "on" : ""), h.AriaPressed(isOn ? "true" : "false")], [label]),
    },
    h,
  )

const pickers = (model: Model, h: HtmlBuilder<Message>): Html => {
  const grey = uncalibrated(model)
  return h.div(
    [h.Class("fk-acct-pickers")],
    [
      select(
        "acct-dimension",
        "Group by",
        model.dimension,
        DIMENSIONS.map((d) => [d, d] as const),
        (value) => Message.SelectedDimension({ value: DIMENSIONS.find((d) => d === value) ?? "model" }),
        h,
      ),
      select(
        "acct-control",
        "Plot",
        model.control,
        [
          [SCORE, "score (mean)"],
          ...CONTROLS.map(({ id, title }) => [id, `${id} ${title}${grey.has(id) ? " · uncalibrated" : ""}`] as const),
        ],
        (value) => Message.SelectedControl({ value }),
        h,
      ),
      dateInput("acct-from", "From", model.from, (value) => Message.UpdatedFrom({ value }), h),
      dateInput("acct-to", "To", model.to, (value) => Message.UpdatedTo({ value }), h),
      h.span(
        [h.Class("fk-chips"), h.Role("group"), h.AriaLabel("Bucket")],
        [
          chip("day", model.bucket === "day", Message.SelectedBucket({ value: "day" }), h),
          chip("week", model.bucket === "week", Message.SelectedBucket({ value: "week" }), h),
        ],
      ),
    ],
  )
}

// ---------- Chart ----------

const plotWidth = CHART.width - CHART.left - CHART.right
const plotHeight = CHART.height - CHART.top - CHART.bottom
const chartY = (score: number) => CHART.top + (1 - score) * plotHeight
const chartX = (i: number, n: number) => CHART.left + (n > 1 ? (i * plotWidth) / (n - 1) : plotWidth / 2)

/** One polyline per dimension value over the buckets; a bucket with no counted rows breaks the line. */
const chart = (model: Model, series: ReadonlyArray<SeriesPoint>, h: HtmlBuilder<Message>): Html => {
  const buckets = Array.dedupe(series.map((p) => p.bucket)).sort()
  const values = Array.dedupe(series.map((p) => p.value)).sort()
  const at = (bucket: string) => chartX(buckets.indexOf(bucket), buckets.length)
  const metric = model.control === SCORE ? "score" : `${model.control} pass rate`
  const lines = values.map((value, i) => {
    const colour = LINE_COLOURS[i % LINE_COLOURS.length]!
    const points = series.filter((p) => p.value === value && p.score !== null)
    return h.keyed("g")(
      value,
      [h.Class("fk-acct-line"), h.DataAttribute("value", value)],
      [
        h.polyline([
          h.Points(points.map((p) => `${at(p.bucket)},${chartY(p.score!)}`).join(" ")),
          h.Fill("none"),
          h.Stroke(colour),
          h.StrokeWidth("2"),
        ]),
        ...points.map((p) =>
          h.circle(
            [h.Cx(String(at(p.bucket))), h.Cy(String(chartY(p.score!))), h.R("3.5"), h.Fill(colour)],
            [h.title([], [`${value} · ${p.bucket} · ${metric} ${pct(p.score)} · n ${p.n}`])],
          ),
        ),
      ],
    )
  })
  const grid = [0, 0.5, 1].flatMap((s) => [
    h.line([
      h.X1(String(CHART.left)),
      h.X2(String(CHART.width - CHART.right)),
      h.Y1(String(chartY(s))),
      h.Y2(String(chartY(s))),
      h.Class("fk-acct-grid"),
    ]),
    h.text([h.X(String(CHART.left - 6)), h.Y(String(chartY(s) + 4)), h.TextAnchor("end")], [pct(s)]),
  ])
  const ends = buckets.length
    ? [
        h.text([h.X(String(CHART.left)), h.Y(String(CHART.height - 6))], [buckets[0]!]),
        h.text(
          [h.X(String(CHART.width - CHART.right)), h.Y(String(CHART.height - 6)), h.TextAnchor("end")],
          [buckets.at(-1)!],
        ),
      ]
    : []
  return h.figure(
    [h.Class("fk-acct-chart")],
    [
      h.svg(
        [
          h.Role("img"),
          h.AriaLabel(`${metric} by ${model.dimension} per ${model.bucket}`),
          h.ViewBox(`0 0 ${CHART.width} ${CHART.height}`),
          h.Class("fk-acct-svg"),
        ],
        [...grid, ...ends, ...lines],
      ),
      h.figcaption(
        [],
        [
          h.ul(
            [h.Class("fk-acct-legend"), h.AriaLabel("Lines")],
            values.map((value, i) =>
              h.keyed("li")(
                value,
                [],
                [
                  h.span([h.Class("fk-acct-swatch"), h.Style({ background: LINE_COLOURS[i % LINE_COLOURS.length]! })]),
                  value,
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  )
}

// ---------- Tables ----------

const passTable = (model: Model, cells: ReadonlyArray<TableCell>, h: HtmlBuilder<Message>): Html => {
  const values = Array.dedupe(cells.map((c) => c.value)).sort()
  const grey = uncalibrated(model)
  return h.table(
    [h.Class("fk-acct-table"), h.AriaLabel(`Pass rate by control and ${model.dimension}`)],
    [
      h.thead([], [h.tr([], [h.th([h.Scope("col")], ["control"]), ...values.map((v) => h.th([h.Scope("col")], [v]))])]),
      h.tbody(
        [],
        CONTROLS.map(({ id, title }) =>
          h.keyed("tr")(
            id,
            [h.Class(grey.has(id) ? "fk-acct-uncalibrated" : "")],
            [
              h.th([h.Scope("row"), h.Title(title)], [id, ...(grey.has(id) ? [" ", uncalibratedTag(h)] : [])]),
              ...values.map((value) => {
                const cell = cells.find((c) => c.control === id && c.value === value)
                return h.td([], [cell && cell.n ? `${pct(cell.rate)} · n ${cell.n}` : "-"])
              }),
            ],
          ),
        ),
      ),
    ],
  )
}

/** Lowest score first, ungraded (null) last. */
const byScore = (rows: ReadonlyArray<Grade>) => [...rows].sort((a, b) => (a.score ?? 2) - (b.score ?? 2))

const worstTable = (rows: ReadonlyArray<Grade>, h: HtmlBuilder<Message>): Html =>
  h.table(
    [h.Class("fk-acct-table"), h.AriaLabel("Worst workers")],
    [
      h.thead(
        [],
        [
          h.tr(
            [],
            ["worker", "score", "step", "model", "cost"].map((c) => h.th([h.Scope("col")], [c])),
          ),
        ],
      ),
      h.tbody(
        [],
        byScore(rows).map((g) =>
          h.keyed("tr")(
            g.worker,
            [],
            [
              h.td(
                [],
                [
                  h.a(
                    [
                      h.Href(
                        g.thread
                          ? `?thread=${encodeURIComponent(g.thread)}&worker=${encodeURIComponent(g.worker)}`
                          : `?worker=${encodeURIComponent(g.worker)}`,
                      ),
                      h.Title("Open this worker's chat"),
                      h.OnClick(Message.ClickedWorker({ worker: g.worker, thread: g.thread ?? "" })),
                    ],
                    [g.worker],
                  ),
                ],
              ),
              h.td([], [pct(g.score)]),
              h.td([], [g.step ?? "-"]),
              h.td([], [g.model]),
              h.td([], [`$${g.costUsd.toFixed(2)} / $${g.budgetUsd.toFixed(2)}`]),
            ],
          ),
        ),
      ),
    ],
  )

// ---------- Calibration ----------

const calibrationTable = (list: CalibrationList, h: HtmlBuilder<Message>): Html =>
  h.table(
    [h.Class("fk-acct-table"), h.AriaLabel("Calibration")],
    [
      h.thead(
        [],
        [
          h.tr(
            [],
            ["control", "labels", "agreement", "status"].map((c) => h.th([h.Scope("col")], [c])),
          ),
        ],
      ),
      h.tbody(
        [],
        list.map((c) =>
          h.keyed("tr")(
            c.control,
            [h.Class(c.calibrated ? "" : "fk-acct-uncalibrated")],
            [
              h.th([h.Scope("row")], [c.control]),
              h.td([], [String(c.labels)]),
              h.td([], [c.labels ? `${pct(c.agreement)} (${c.agree}/${c.labels})` : "-"]),
              h.td([], [c.calibrated ? "calibrated" : uncalibratedTag(h)]),
            ],
          ),
        ),
      ),
    ],
  )

const labelButton = (worker: string, control: ControlId, label: "pass" | "fail", h: HtmlBuilder<Message>): Html =>
  Button.view(
    {
      onClick: Message.ClickedLabel({ worker, control, label }),
      toView: (attributes) =>
        h.button([...attributes.button, h.AriaLabel(`Label ${worker} ${control} ${label}`)], [label]),
    },
    h,
  )

/** Per worst worker: the grader's result for each control and the human's pass/fail buttons. */
const labelForms = (rows: ReadonlyArray<Grade>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("fk-acct-labels")],
    rows.map((g) =>
      h.keyed("details")(
        g.worker,
        [],
        [
          h.summary([], [`Label ${g.worker}`]),
          h.ul(
            [h.Class("fk-list")],
            CONTROLS.map(({ id }) =>
              h.keyed("li")(
                id,
                [h.Class("fk-chips")],
                [
                  h.span([], [`${id} `, h.span([h.Class("fk-muted")], [`grader: ${g.controls[id].result}`])]),
                  labelButton(g.worker, id, "pass", h),
                  labelButton(g.worker, id, "fail", h),
                ],
              ),
            ),
          ),
        ],
      ),
    ),
  )

// ---------- Dialog ----------

const isEmpty = (model: Model) =>
  Option.match(AsyncData.getData(model.worst), {
    onNone: () => false,
    onSome: ({ total }) => total === 0,
  })

const body = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  isEmpty(model)
    ? [h.p([h.Class("fk-acct-empty"), h.Role("status")], [EMPTY])]
    : [
        section(
          "Over time",
          [
            loading(
              model.series,
              "the chart",
              (series) =>
                series.length ? chart(model, series, h) : h.p([h.Class("fk-muted")], ["No points in this range."]),
              h,
            ),
          ],
          h,
        ),
        section(
          "Pass rate by control",
          [loading(model.table, "pass rates", (cells) => passTable(model, cells, h), h)],
          h,
        ),
        section("Worst workers", [loading(model.worst, "workers", ({ rows }) => worstTable(rows, h), h)], h),
        section(
          "Calibration",
          [
            h.p(
              [h.Class("fk-muted")],
              [
                "Your pass/fail labels measure how often the grader agrees with you. Lessons use only calibrated controls.",
              ],
            ),
            loading(model.calibration, "calibration", (list) => calibrationTable(list, h), h),
            ...Option.match(model.maybeLabelError, {
              onNone: () => [],
              onSome: (error) => [h.p([h.Class("fk-error"), h.Role("alert")], [`Could not save the label: ${error}`])],
            }),
            loading(model.worst, "workers", ({ rows }) => labelForms(rows, h), h),
          ],
          h,
        ),
      ]

const content = (model: Model, render: Dialog.RenderInfo, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.header(
    [],
    [
      h.h2([...render.title], ["Worker accountability"]),
      h.span([...render.description, h.Class("fk-muted")], [" · record-only grades of finished workers"]),
      h.button([...render.closeButton, h.AriaLabel("Close accountability")], ["✕"]),
    ],
  ),
  pickers(model, h),
  ...body(model, h),
]

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: model.dialog.id,
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      hasDescription: true,
      toView: (render: Dialog.RenderInfo) =>
        h.dialog(
          [...render.dialog, h.Class("fk-dialog")],
          render.isVisible
            ? [
                h.div([...render.backdrop, h.Class("fk-backdrop")]),
                h.div([...render.panel, h.Class("fk-drawer fk-acct")], content(model, render, h)),
              ]
            : [],
        ),
    },
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  }),
)

/** The navbar button that opens the accountability view. */
export const navButton = Submodel.defineView<Model, Message>((_model, h) =>
  Button.view(
    {
      onClick: Message.ClickedOpenAccountability(),
      toView: (attributes) =>
        h.button(
          [...attributes.button, h.AriaLabel("Open worker accountability"), h.Title("Worker accountability")],
          ["⚖", h.span([h.Class("fk-nav-label")], [" Accountability"])],
        ),
    },
    h,
  ),
)
