import assert from "node:assert/strict"
import { appendFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import React from "react"
import { render } from "ink"
import {
  ContinuationActionStatus,
  ContinuationOutcome,
  ContinuationPlacementKind,
  ConversationRole,
  type ContinuationDraft,
} from "@trellage/guide-core"
import { ContinuationApp } from "../../src/continuation-ui.tsx"
import { RestrictedGuideModelError } from "../../src/copilot-guide-provider.ts"
import { createInitialGuideRenderHandler } from "../../src/guide-terminal.ts"
import {
  continuationFixtureDraft,
  createContinuationServiceFixture,
  ContinuationFixtureEventKind,
  ContinuationFixtureMode as FixtureMode,
  type ContinuationFixtureEvent,
} from "../helpers/continuation-ui-fixtures.ts"

assert(process.versions.bun, "Continuation integration fixtures must execute with Bun")
const root = process.argv[2]
if (root === undefined) throw new Error("Continuation fixture requires a workspace.")
const mode = Object.values(FixtureMode).find((value) => value === process.argv[3])
if (mode === undefined) throw new Error("Continuation fixture requires a known mode.")
const eventPath = path.join(root, "events.jsonl")
writeFileSync(eventPath, "", { mode: 0o600 })
const record = (event: ContinuationFixtureEvent): void => appendFileSync(eventPath, `${JSON.stringify(event)}\n`)
const recordInput = (input: Buffer | string): void =>
  record({ kind: ContinuationFixtureEventKind.Input, input: input.toString() })
process.stdin.on("data", recordInput)
const outcome =
  mode === FixtureMode.Clarification
    ? ContinuationOutcome.NeedsClarification
    : mode === FixtureMode.NoAction
      ? ContinuationOutcome.NoFurtherAction
      : ContinuationOutcome.Recommendations
const fresh =
  mode === FixtureMode.Fresh || mode === FixtureMode.CancelAnalysis || mode === FixtureMode.CancelSaveFailure
let initial = continuationFixtureDraft(!fresh, outcome)
if (mode === FixtureMode.LongEvidence)
  initial = {
    ...initial,
    snapshot: {
      ...initial.snapshot,
      messages: initial.snapshot.messages.map((message, index) =>
        index === 1
          ? {
              ...message,
              text: [
                "LONG EVIDENCE START",
                ...Array.from({ length: 120 }, (_, n) => `Synthetic evidence line ${n + 1}`),
                "LONG EVIDENCE END",
              ].join("\n"),
            }
          : message,
      ),
    },
  }
if (mode === FixtureMode.ManyMessages) {
  initial = {
    ...initial,
    snapshot: {
      ...initial.snapshot,
      cutoff: { ...initial.snapshot.cutoff, messageId: "message-30", recordIndex: 30 },
      messages: Array.from({ length: 30 }, (_, index) => ({
        id: `message-${index + 1}`,
        recordIndex: index + 1,
        role: index % 2 === 0 ? ConversationRole.User : ConversationRole.Assistant,
        text: `Message body ${index + 1}`,
      })),
    },
  }
}
if (mode === FixtureMode.RedactedMessages) {
  const credential = ["gh", "p_", "runtimeSyntheticCredentialValue123456"].join("")
  const control = String.fromCodePoint(0x202e)
  initial = {
    ...initial,
    snapshot: {
      ...initial.snapshot,
      messages: initial.snapshot.messages.map((message, index) => index === 0
        ? { ...message, text: `api_key=${credential} ${control}visible text` }
        : message),
    },
  }
}
if (mode === FixtureMode.LongPrompt)
  initial = {
    ...initial,
    actions: initial.actions.map((edit, index) =>
      index === 0
        ? {
            ...edit,
            status: ContinuationActionStatus.Prepared,
            prompt: [
              "LONG PROMPT START",
              ...Array.from({ length: 120 }, (_, n) => `Full outgoing instruction line ${n + 1}`),
              "LONG PROMPT END",
            ].join("\n"),
          }
        : edit,
    ),
  }
const fixture = createContinuationServiceFixture(initial, record, { candidates: true })
if (mode === FixtureMode.SaveFailure) {
  const save = fixture.services.save
  let failed = false
  fixture.services.save = async (draft) => {
    if (!failed) {
      failed = true
      throw new Error("Fixture disk is full.")
    }
    return save(draft)
  }
}
if (mode === FixtureMode.Advanced)
  fixture.setSource({ sameSource: true, advanced: true, revision: "source-revision-2" })
if (mode === FixtureMode.Different)
  fixture.setSource({ sameSource: false, advanced: true, revision: "different-session" })
if (mode === FixtureMode.DirtySource) {
  const launch = fixture.services.launch
  fixture.services.launch = async (draft, acknowledgeAdvanced) => {
    const unconfirmed = draft.actions.some(
      (edit) =>
        edit.selected &&
        edit.status === ContinuationActionStatus.Prepared &&
        edit.placement?.kind === ContinuationPlacementKind.NewWorktree &&
        !edit.uncommittedChangesConfirmed,
    )
    if (unconfirmed)
      throw new Error("Dirty source: confirm exclusion of uncommitted changes before launching a new worktree.")
    return launch(draft, acknowledgeAdvanced)
  }
}
const waitForAbort = (
  draft: ContinuationDraft,
  signal: AbortSignal,
  progress: (message: string) => void,
  kind: ContinuationFixtureEventKind,
): Promise<ContinuationDraft> => {
  fixture.emit({ kind, draft })
  if (mode === FixtureMode.CancelSaveFailure)
    fixture.commit({
      ...draft,
      summaries: [{ key: "saved-summary", text: "A completed synthetic summary.", evidenceIds: ["message-1"] }],
    })
  progress("Synthetic provider is active and waits for cancellation.")
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        fixture.emit({ kind: ContinuationFixtureEventKind.Abort })
        if (mode === FixtureMode.CancelSaveFailure) reject(new Error("Summary cache save failed."))
        else if (mode === FixtureMode.CancelCleanupFailure)
          reject(new RestrictedGuideModelError("cancelled", ["force-stop"]))
        else reject(new DOMException("Synthetic provider aborted and cleaned up.", "AbortError"))
      },
      { once: true },
    )
  })
}
if (mode === FixtureMode.CancelAnalysis || mode === FixtureMode.CancelSaveFailure)
  fixture.services.analyze = (draft, signal, progress) =>
    waitForAbort(draft, signal, progress, ContinuationFixtureEventKind.Analyze)
if (mode === FixtureMode.CancelPreparation || mode === FixtureMode.CancelCleanupFailure)
  fixture.services.prepare = (draft, _id, signal, progress) =>
    waitForAbort(draft, signal, progress, ContinuationFixtureEventKind.Prepare)
if (mode === FixtureMode.Unknown)
  fixture.services.launch = async (draft, acknowledgeAdvanced) => {
    fixture.emit({ kind: ContinuationFixtureEventKind.Launch, draft, acknowledgeAdvanced })
    return fixture.commit({
      ...draft,
      actions: draft.actions.map((edit) =>
        edit.selected
          ? {
              ...edit,
              status: ContinuationActionStatus.Unknown,
              launch: {
                attemptId: "30000000-0000-4000-8000-000000000001",
                status: ContinuationActionStatus.Unknown,
                paneId: "already-created-pane",
                message: "Delivery acknowledgement was lost.",
              },
            }
          : edit,
      ),
    })
  }
const app = render(
  <ContinuationApp
    initialDraft={initial}
    services={fixture.services}
    hasSavedDraft={!fresh}
    onExit={(code) => {
      writeFileSync(
        path.join(root, "result.json"),
        JSON.stringify({ draft: fixture.saved(), events: fixture.events, code }),
        { mode: 0o600 },
      )
      process.exitCode = code
    }}
  />,
  {
    interactive: true,
    exitOnCtrlC: false,
    alternateScreen: true,
    kittyKeyboard: { mode: "disabled" },
    maxFps: 30,
    onRender: createInitialGuideRenderHandler((text) => process.stdout.write(text), true),
  },
)
await app.waitUntilExit()
process.stdin.off("data", recordInput)
process.stdin.pause()
