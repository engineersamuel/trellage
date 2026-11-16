import { Array, Option, Record } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Button, Dialog, Input, Textarea } from "@foldkit/ui"
import { type Row, type TournamentList, type TournamentView, pct, shotUrl, usd } from "./domain"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const button = (label: string, onClick: Message, h: H, ariaLabel?: string): Html =>
  Button.view(
    {
      onClick,
      toView: (attributes) => h.button([...attributes.button, ...(ariaLabel ? [h.AriaLabel(ariaLabel)] : [])], [label]),
    },
    h,
  )

const BUILD_MARK: Record<string, string> = { ok: "✓", dropped: "✗", failed: "✗", pending: "·", building: "…" }

// ---------- List ----------

const listView = (list: TournamentList, h: H): Html =>
  Array.match(list, {
    onEmpty: () => h.p([h.Class("fk-muted")], ["No tournaments yet."]),
    onNonEmpty: (items) =>
      h.ul(
        [h.Class("fk-tour-list")],
        Array.map(items, (t) =>
          h.keyed("li")(
            t.id,
            [],
            [
              button(t.title, Message.ClickedTournament({ id: t.id }), h, `Open tournament ${t.id}`),
              conversationLink(t.threadId, h),
              h.span(
                [h.Class("fk-muted")],
                [
                  ` ${t.status}${t.running ? " (running)" : ""} · ${t.variants} variants · ${usd(t.spentUsd)} of ${usd(t.limitUsd)} · leader: ${t.leader ?? "-"}`,
                ],
              ),
            ],
          ),
        ),
      ),
  })

const presetButton = (preset: Model["preset"], label: string, model: Model, h: H): Html =>
  Button.view(
    {
      onClick: Message.ClickedPreset({ preset }),
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            h.Class(model.preset === preset ? "on" : ""),
            h.AriaPressed(model.preset === preset ? "true" : "false"),
          ],
          [label],
        ),
    },
    h,
  )

/** The tournament's conversation: its sub-coordinator, every agent, and the leaderboard pin. */
const conversationLink = (threadId: string | null | undefined, h: H): Html =>
  threadId ? h.a([h.Href(`/?thread=${encodeURIComponent(threadId)}`)], ["Open conversation ↗"]) : h.empty

const newForm = (model: Model, h: H): Html =>
  h.form(
    [h.Class("fk-tour-form"), h.OnSubmit(Message.SubmittedTournament())],
    [
      h.div(
        [h.Class("fk-tour-presets"), h.Role("group"), h.AriaLabel("Tournament kind")],
        [
          presetButton("ui-skills", "UI skills", model, h),
          presetButton("prototypes", "Prototypes of an idea", model, h),
        ],
      ),
      Textarea.view(
        {
          id: "tournament-sources",
          value: model.sourcesText,
          placeholder:
            model.preset === "ui-skills"
              ? "https://github.com/owner/skills\nhttps://example.dev/skill-page"
              : "A shared grocery list for flatmates that splits the bill",
          onInput: (value) => Message.UpdatedSources({ value }),
          toView: (attributes) =>
            h.span(
              [h.Class("fk-field")],
              [
                h.label(
                  [...attributes.label],
                  [model.preset === "ui-skills" ? "Skill sources, one URL per line" : "The idea"],
                ),
                h.textarea([...attributes.textarea, h.Rows(6)]),
              ],
            ),
        },
        h,
      ),
      Input.view(
        {
          id: "tournament-limit",
          value: model.limitText,
          placeholder: "default from config",
          onInput: (value) => Message.UpdatedLimit({ value }),
          toView: (attributes) =>
            h.span(
              [h.Class("fk-field")],
              [h.label([...attributes.label], ["Cost limit (USD)"]), h.input([...attributes.input])],
            ),
        },
        h,
      ),
      Button.view(
        { type: "submit", toView: (attributes) => h.button([...attributes.button], ["Start tournament"]) },
        h,
      ),
    ],
  )

// ---------- Detail ----------

const rubricText = (row: Row): string =>
  Record.toEntries(row.rubric)
    .map(([k, v]) => `${k.replace("_", " ")} ${v}`)
    .join(" · ")

const buildsView = (row: Row, checks: Record<string, string>, h: H): Html =>
  h.div(
    [h.Class("fk-tour-builds")],
    [
      ...(row.skills.length ? [h.p([h.Class("fk-muted")], [`Skills: ${row.skills.join(", ")}`])] : []),
      ...(Record.isEmptyRecord(row.rubric)
        ? []
        : [h.p([], [`Mean expert scores per aspect (1-10): ${rubricText(row)}`])]),
      ...Array.map(row.reasons, (r) => h.p([h.Class("fk-tour-reason")], [r])),
      ...Array.map(row.builds, (b) =>
        h.keyed("div")(
          `${row.id}-${b.n}`,
          [h.Class("fk-tour-build")],
          [
            h.h4(
              [],
              [
                `Build ${b.n}: ${b.status}${b.error ? ` (${b.error})` : ""}`,
                ...(b.checks
                  ? [
                      ` · ${Record.toEntries(b.checks)
                        .map(([k, p]) => `${checks[k] ?? k} ${pct(p)}`)
                        .join(", ")}`,
                    ]
                  : []),
              ],
            ),
            h.div(
              [h.Class("fk-tour-shots")],
              Array.map(b.shots, (s) =>
                h.a(
                  [h.Href(shotUrl(s.file)), h.Target("_blank")],
                  [
                    h.img([
                      h.Src(shotUrl(s.file)),
                      h.Alt(`${row.label}, build ${b.n}: ${s.page} on ${s.viewport}`),
                      h.Loading("lazy"),
                    ]),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    ],
  )

const leaderboardView = (model: Model, t: TournamentView, h: H): Html =>
  h.table(
    [h.Class("fk-tour-table")],
    [
      h.thead(
        [],
        [
          h.tr(
            [],
            Array.map(["#", "Variant", "Rating", "P(beat base)", "W-L-T", "Builds"], (c) =>
              h.th([h.Scope("col")], [c]),
            ),
          ),
        ],
      ),
      h.tbody(
        [],
        Array.flatMap(t.leaderboard, (row, i) => {
          const isOpen = Option.contains(model.maybeExpandedRow, row.id)
          return [
            h.keyed("tr")(
              row.id,
              [h.Class(row.kind === "baseline" ? "fk-tour-baseline" : "")],
              [
                h.td([], [String(i + 1)]),
                h.td(
                  [],
                  [
                    button(
                      `${isOpen ? "▾" : "▸"} ${row.label}`,
                      Message.ClickedRow({ id: row.id }),
                      h,
                      `${isOpen ? "Hide" : "Show"} builds of ${row.label}`,
                    ),
                  ],
                ),
                h.td([], [row.games > 0 ? String(row.rating) : "-"]),
                h.td([], [row.kind === "baseline" || row.games === 0 ? "-" : pct(row.vsBaseline)]),
                h.td([], [`${row.wins}-${row.losses}-${row.ties}`]),
                h.td([h.Class("fk-mono")], [row.builds.map((b) => BUILD_MARK[b.status] ?? "?").join("")]),
              ],
            ),
            ...(isOpen
              ? [h.keyed("tr")(`${row.id}-detail`, [], [h.td([h.Colspan(6)], [buildsView(row, t.checks, h)])])]
              : []),
          ]
        }),
      ),
    ],
  )

const controls = (model: Model, t: TournamentView, h: H): Html =>
  h.div(
    [h.Class("fk-tour-controls")],
    [
      h.span(
        [h.Role("status")],
        [
          `${t.status}${t.running ? " (running)" : ""} · ${usd(t.spentUsd)} of ${usd(t.limitUsd)}${t.reason ? ` · ${t.reason}` : ""}`,
        ],
      ),
      ...(t.running ? [button("Stop", Message.ClickedStop({ id: t.id }), h)] : []),
      ...(!t.running && (t.status === "paused" || t.status === "failed")
        ? [
            Input.view(
              {
                id: "tournament-resume-limit",
                value: model.limitDialogText,
                placeholder: `above ${usd(t.spentUsd)}`,
                onInput: (value) => Message.UpdatedResumeLimit({ value }),
                toView: (attributes) =>
                  h.span(
                    [h.Class("fk-field")],
                    [h.label([...attributes.label], ["New limit (USD)"]), h.input([...attributes.input])],
                  ),
              },
              h,
            ),
            button("Resume", Message.ClickedResume({ id: t.id }), h),
          ]
        : []),
    ],
  )

const sourcesView = (t: TournamentView, h: H): Html =>
  h.details(
    [],
    [
      h.summary([], [`Sources (${Record.size(t.cards)})`]),
      h.ul(
        [],
        Array.map(Record.values(t.cards), (c) =>
          h.li([], [`${c.status} · ${c.source}${c.reason && c.status !== "ok" ? ` · ${c.reason}` : ""}`]),
        ),
      ),
    ],
  )

const logView = (t: TournamentView, h: H): Html =>
  h.details(
    [],
    [
      h.summary([], ["Log"]),
      h.ul(
        [h.Class("fk-tour-log")],
        Array.map(Array.takeRight(t.log, 60), (l) =>
          h.li([], [`${new Date(l.at).toISOString().slice(11, 19)} ${l.text}`]),
        ),
      ),
    ],
  )

const detail = (model: Model, h: H): Html =>
  AsyncData.matchDataSplitEmpty(model.selected, {
    onIdle: () => h.empty,
    onLoading: () => h.p([h.Class("fk-muted")], ["Loading…"]),
    onFailure: (error) => h.p([h.Class("fk-error"), h.Role("alert")], [`Could not load: ${error}`]),
    onData: (t) =>
      h.div(
        [],
        [
          button("← All tournaments", Message.ClickedBackToList(), h),
          h.h3([], [t.title]),
          conversationLink(t.threadId, h),
          controls(model, t, h),
          leaderboardView(model, t, h),
          sourcesView(t, h),
          logView(t, h),
        ],
      ),
  })

const content = (model: Model, render: Dialog.RenderInfo, h: H): ReadonlyArray<Html> => [
  h.header(
    [],
    [
      h.h2([...render.title], ["UI skill tournaments"]),
      h.span([...render.description, h.Class("fk-muted")], [" · which design skills build the best storefront"]),
      h.button([...render.closeButton, h.AriaLabel("Close tournaments")], ["✕"]),
    ],
  ),
  ...Option.match(model.maybeError, {
    onNone: () => [],
    onSome: (error) => [h.p([h.Class("fk-error"), h.Role("alert")], [error])],
  }),
  ...Option.match(model.maybeSelectedId, {
    onSome: () => [detail(model, h)],
    onNone: () => [
      h.section(
        [],
        [
          h.h3([], ["Tournaments"]),
          AsyncData.matchDataSplitEmpty(model.tournaments, {
            onIdle: () => h.empty,
            onLoading: () => h.p([h.Class("fk-muted")], ["Loading…"]),
            onFailure: (error) => h.p([h.Class("fk-error"), h.Role("alert")], [`Could not load: ${error}`]),
            onData: (list) => listView(list, h),
          }),
        ],
      ),
      h.section([], [h.h3([], ["New tournament"]), newForm(model, h)]),
    ],
  }),
]

/** The tournaments dialog: a wide side panel, like the goals dialog. */
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
                h.div([...render.panel, h.Class("fk-drawer fk-tournaments")], content(model, render, h)),
              ]
            : [],
        ),
    },
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  }),
)

export const navButton = Submodel.defineView<Model, Message>((_model, h) =>
  Button.view(
    {
      onClick: Message.ClickedOpenTournaments(),
      toView: (attributes) =>
        h.button(
          [...attributes.button, h.AriaLabel("Open UI skill tournaments"), h.Title("UI skill tournaments")],
          ["♛ Tournaments"],
        ),
    },
    h,
  ),
)
