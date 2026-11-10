import { Array, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Button, Checkbox, Dialog, Input } from "@foldkit/ui"
import { agentLabel, workerTree } from "../../../shared/tree"
import { COORDINATOR_ID, type Worker, backendName } from "../domain"
import { MountTranscript } from "./command"
import { workerName } from "./update"
import { Message } from "./message"
import type { LogLine, Model } from "./model"

const STATUS_COLOR: Readonly<Record<string, string>> = { idle: "#16a34a", running: "#f59e0b", error: "#dc2626" }
const UNKNOWN_STATUS_COLOR = "#999"
const ROW_INDENT_PX = 8
const DEPTH_INDENT_PX = 22
const KB_PER_MB = 1024

const memoryLabel = (rssKb: number | null): string => (rssKb ? `${Math.round(rssKb / KB_PER_MB)} MB` : "")

const workerRow = (model: Model, worker: Worker, depth: number, h: HtmlBuilder<Message>): Html => {
  const label = agentLabel(worker)
  const isSelected = worker.id === model.selectedWorkerId
  return h.keyed("li")(
    worker.id,
    [],
    [
      Button.view(
        {
          onClick: Message.ClickedWorker({ workerId: worker.id }),
          toView: (attributes) =>
            h.button(
              [
                ...attributes.button,
                h.Class(`fk-row ${isSelected ? "active" : ""}`),
                h.Style({ "padding-left": `${ROW_INDENT_PX + depth * DEPTH_INDENT_PX}px` }),
                ...(isSelected ? [h.AriaCurrent("true")] : []),
              ],
              [
                ...(depth > 0 ? [h.span([h.Class("fk-branch"), h.AriaHidden(true)], ["└"])] : []),
                h.span([
                  h.Class("fk-dot"),
                  h.AriaHidden(true),
                  h.Style({ background: STATUS_COLOR[worker.status] ?? UNKNOWN_STATUS_COLOR }),
                ]),
                h.span([h.Class(`sf-tag sf-tag-${label.kind}`)], [label.tag]),
                h.b([], [label.name]),
                h.span(
                  [h.Class("fk-meta")],
                  [`${worker.status} · ${worker.auth} · pid ${worker.pid ?? "?"} · ${memoryLabel(worker.rssKb)}`],
                ),
              ],
            ),
        },
        h,
      ),
    ],
  )
}

const workerList = (model: Model, workers: ReadonlyArray<Worker>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("fk-workers"), h.AriaLabel("Agents")],
    [
      h.h2([], [`Agents (${workers.length})`]),
      AsyncData.match(model.workers, {
        onIdle: () => h.empty,
        onLoading: () => h.p([h.Class("fk-muted")], ["Loading agents…"]),
        onRefreshing: () => h.empty,
        onFailure: (error) => h.p([h.Class("fk-error"), h.Role("alert")], [`Could not load agents: ${error}`]),
        onStale: ({ error }) =>
          h.p([h.Class("fk-error"), h.Role("alert")], [`Agent list may be out of date: ${error}`]),
        onSuccess: () => h.empty,
      }),
      h.ul(
        [h.Class("fk-list")],
        Array.map(workerTree(workers), ({ w, depth }) => workerRow(model, w, depth, h)),
      ),
    ],
  )

const rawLog = (logLines: ReadonlyArray<LogLine>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("fk-log")],
    Array.map(logLines, (line) =>
      h.keyed("div")(
        String(line.seq),
        [h.Class("fk-ev")],
        [h.span([h.Class("fk-type")], [line.type]), h.span([h.Class("fk-text")], [line.text])],
      ),
    ),
  )

/** shared/transcript.ts owns the children of the inner element; the Mount starts and stops it with the element. */
const transcript = (workerId: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("fk-log"), h.DataAttribute("transcript-scroll", "")],
    [h.div([h.DataAttribute("transcript", workerId), h.OnMount(MountTranscript({ workerId }))])],
  )

const peerHeading = (model: Model, maybeCurrent: Option.Option<Worker>): string =>
  Option.match(maybeCurrent, {
    onNone: () => model.selectedWorkerId,
    onSome: (current) => `${current.name} · ${current.model} · ${backendName(current.auth)}`,
  })

const peerToolbar = (model: Model, maybeCurrent: Option.Option<Worker>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("fk-toolbar")],
    [
      Checkbox.view(
        {
          id: "raw-events",
          isChecked: model.isRawLogVisible,
          onToggle: (isChecked) => Message.ToggledRawLog({ isChecked }),
          toView: (attributes) =>
            h.span(
              [h.Class("fk-raw")],
              [
                h.button([...attributes.checkbox, h.Class("fk-check")], model.isRawLogVisible ? ["✓"] : []),
                h.label([...attributes.label], ["raw events"]),
              ],
            ),
        },
        h,
      ),
      // Cancel only while a run is going: on an idle worker the button would do nothing.
      ...Option.match(
        Option.filter(maybeCurrent, (current) => current.status === "running"),
        {
          onNone: () => [],
          onSome: (current) => [
            Button.view(
              {
                onClick: Message.ClickedCancelRun({ workerId: current.id }),
                toView: (attributes) =>
                  h.button([...attributes.button, h.AriaLabel(`Cancel run of ${current.name}`)], ["Cancel run"]),
              },
              h,
            ),
          ],
        },
      ),
      ...Option.match(
        Option.filter(maybeCurrent, (current) => current.role !== COORDINATOR_ID),
        {
          onNone: () => [],
          onSome: (current) => [
            Button.view(
              {
                onClick: Message.ClickedRemove({ workerId: current.id }),
                toView: (attributes) =>
                  h.button(
                    [...attributes.button, h.Class("fk-danger"), h.AriaLabel(`Remove ${current.name}`)],
                    ["Remove worker"],
                  ),
              },
              h,
            ),
          ],
        },
      ),
    ],
  )

const errorBanner = (maybeError: Option.Option<string>, h: HtmlBuilder<Message>): Html =>
  Option.match(maybeError, {
    onNone: () => h.empty,
    onSome: (error) =>
      h.div(
        [h.Class("fk-error"), h.Role("alert")],
        [
          error,
          Button.view(
            {
              onClick: Message.ClickedDismissError(),
              toView: (attributes) => h.button([...attributes.button, h.AriaLabel("Dismiss error")], ["✕"]),
            },
            h,
          ),
        ],
      ),
  })

const messageForm = (model: Model, maybeCurrent: Option.Option<Worker>, h: HtmlBuilder<Message>): Html => {
  const name = Option.match(maybeCurrent, { onNone: () => model.selectedWorkerId, onSome: (current) => current.name })
  return h.form(
    [h.Class("fk-send"), h.OnSubmit(Message.SubmittedMessageDraft())],
    [
      Input.view(
        {
          id: "worker-message",
          value: model.messageDraft,
          placeholder: `message ${name} directly`,
          onInput: (value) => Message.UpdatedMessageDraft({ value }),
          toView: (attributes) =>
            h.span(
              [h.Class("fk-field")],
              [
                h.label([...attributes.label, h.Class("fk-visually-hidden")], [`Message ${name}`]),
                h.input([...attributes.input]),
              ],
            ),
        },
        h,
      ),
      Button.view({ type: "submit", toView: (attributes) => h.button([...attributes.button], ["Send"]) }, h),
    ],
  )
}

/** Asks before a worker is removed. Cancel, Escape and the backdrop all keep it. */
const removeDialog = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: model.removeDialog.id,
    model: model.removeDialog,
    view: Dialog.view,
    viewInputs: {
      hasDescription: true,
      toView: (render: Dialog.RenderInfo) =>
        h.dialog(
          [...render.dialog, h.Class("fk-dialog")],
          render.isVisible
            ? [
                h.div([...render.backdrop, h.Class("fk-backdrop")]),
                h.div(
                  [...render.panel, h.Class("fk-confirm")],
                  Option.match(model.maybePendingRemoval, {
                    onNone: () => [],
                    onSome: (workerId) => [
                      h.h2([...render.title], [`Remove ${workerName(model, workerId)}?`]),
                      h.p([...render.description], ["Its session ends and it leaves the list. You cannot undo this."]),
                      h.div(
                        [h.Class("fk-confirm-actions")],
                        [
                          h.button([...render.closeButton], ["Cancel"]),
                          Button.view(
                            {
                              onClick: Message.ConfirmedRemove(),
                              toView: (attributes) =>
                                h.button([...attributes.button, h.Class("fk-danger")], ["Remove"]),
                            },
                            h,
                          ),
                        ],
                      ),
                    ],
                  }),
                ),
              ]
            : [],
        ),
    },
    toParentMessage: (message: Dialog.Message) => Message.GotRemoveDialogMessage({ message }),
  })

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const workers = AsyncData.getOrElse(model.workers, (): ReadonlyArray<Worker> => [])
  const maybeCurrent = Array.findFirst(workers, ({ id }) => id === model.selectedWorkerId)
  return h.div(
    [h.Class("fk-panel-body")],
    [
      workerList(model, workers, h),
      h.section(
        [h.Class("fk-peer"), h.AriaLabel("Selected agent")],
        [
          h.h2([], [peerHeading(model, maybeCurrent)]),
          peerToolbar(model, maybeCurrent, h),
          errorBanner(model.maybeError, h),
          // Keyed by worker: a new selection remounts the transcript for that worker.
          model.isRawLogVisible
            ? rawLog(model.logLines, h)
            : h.keyed("div")(
                `tx-${model.selectedWorkerId}`,
                [h.Class("fk-log-host")],
                [transcript(model.selectedWorkerId, h)],
              ),
          messageForm(model, maybeCurrent, h),
        ],
      ),
      removeDialog(model, h),
    ],
  )
})
