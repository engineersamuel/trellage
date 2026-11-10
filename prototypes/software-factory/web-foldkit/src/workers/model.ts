import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { Worker } from "../domain"

export const WorkersAsyncData = AsyncData.Schema(Schema.Array(Worker), Schema.String)

/** The live agent list. The navbar, the diff panel and extensions read it; the Inbox draws agents itself. */
export const Model = Schema.Struct({
  workers: WorkersAsyncData.schema,
})
export type Model = typeof Model.Type
