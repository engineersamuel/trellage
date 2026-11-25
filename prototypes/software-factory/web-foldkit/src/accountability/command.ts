import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { getJson, postJson } from "../api"
import {
  Bucket,
  CONTROLS,
  CalibrationList,
  ControlId,
  Dimension,
  LabelReply,
  Series,
  WorkerPage,
  toCells,
} from "./domain"
import { Message } from "./message"

const Range = { from: Schema.String, to: Schema.String }

/** Query string of the set fields; an empty date or "score" is left out (the server reads no control as score). */
export const query = (params: Record<string, string>): string =>
  new URLSearchParams(
    Object.entries(params).filter(([key, value]) => value !== "" && !(key === "control" && value === "score")),
  ).toString()

export const FetchSeries = Command.define("FetchSeries", {
  args: { dimension: Dimension, bucket: Bucket, control: Schema.String, ...Range },
  messages: [Message.SucceededFetchSeries, Message.FailedFetchSeries],
  execute: (args) =>
    getJson(`/api/accountability/series?${query(args)}`, Series).pipe(
      Effect.map((series) => Message.SucceededFetchSeries({ series })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchSeries({ error }))),
    ),
})

/** One series call per control over the range, merged to one pass rate and n per dimension value. */
export const FetchTable = Command.define("FetchTable", {
  args: { dimension: Dimension, ...Range },
  messages: [Message.SucceededFetchTable, Message.FailedFetchTable],
  execute: ({ dimension, from, to }) =>
    Effect.forEach(CONTROLS, ({ id }) =>
      getJson(`/api/accountability/series?${query({ dimension, bucket: "week", control: id, from, to })}`, Series).pipe(
        Effect.map((points) => toCells(id, points)),
      ),
    ).pipe(
      Effect.map((cells) => Message.SucceededFetchTable({ table: cells.flat() })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchTable({ error }))),
    ),
})

/** The 10 lowest-scoring workers in the range. */
export const FetchWorst = Command.define("FetchWorst", {
  args: Range,
  messages: [Message.SucceededFetchWorst, Message.FailedFetchWorst],
  execute: (args) =>
    getJson(`/api/accountability/workers?${query({ sort: "score", limit: "10", ...args })}`, WorkerPage).pipe(
      Effect.map((page) => Message.SucceededFetchWorst({ page })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchWorst({ error }))),
    ),
})

export const FetchCalibration = Command.define("FetchCalibration", {
  messages: [Message.SucceededFetchCalibration, Message.FailedFetchCalibration],
  execute: getJson("/api/accountability/calibration", CalibrationList).pipe(
    Effect.map((calibration) => Message.SucceededFetchCalibration({ calibration })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchCalibration({ error }))),
  ),
})

export const SaveLabel = Command.define("SaveLabel", {
  args: { worker: Schema.String, control: ControlId, label: Schema.Literals(["pass", "fail"]) },
  messages: [Message.SucceededLabel, Message.FailedLabel],
  execute: (body) =>
    postJson("/api/accountability/labels", body, LabelReply).pipe(
      Effect.as(Message.SucceededLabel()),
      Effect.catch((error) => Effect.succeed(Message.FailedLabel({ error }))),
    ),
})
