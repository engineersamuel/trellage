import path from "node:path"
import { ContinuationActionStatus, type ContinuationDraft } from "@trellage/guide-core"
import type { HerdrContext } from "./guide-launch.ts"
import type { ContinuationSourceClient } from "./continuation-source-client.ts"
import type { ContinuationStore } from "./continuation-store.ts"

enum InvocationSurface {
  Popup = "popup",
}

export const appendContinuationLaunchEvent = async (
  store: ContinuationStore,
  draft: ContinuationDraft,
  actionId: string,
): Promise<void> => {
  const receipt = draft.actions.find((action) => action.actionId === actionId)?.launch
  if (receipt === undefined) throw new Error("Cannot journal an action without a durable launch attempt.")
  const { attemptId, status, paneId, workspaceId, cwd } = receipt
  await store.appendLaunchEvent(draft.id, {
    actionId,
    attemptId,
    status,
    ...(paneId === undefined ? {} : { paneId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(cwd === undefined ? {} : { cwd }),
  })
}

export const recoverInterruptedContinuation = async (
  store: ContinuationStore,
  draft: ContinuationDraft,
): Promise<ContinuationDraft> => {
  if (!draft.actions.some((action) => action.status === ContinuationActionStatus.Launching)) return draft
  const recovered = await store.save(
    {
      ...draft,
      actions: draft.actions.map((action) =>
        action.status !== ContinuationActionStatus.Launching
          ? action
          : {
              ...action,
              status: ContinuationActionStatus.Unknown,
              ...(action.launch === undefined
                ? {}
                : {
                    launch: {
                      ...action.launch,
                      status: ContinuationActionStatus.Unknown,
                      message:
                        "The previous launch ended without a saved acknowledgment. Inspect its pane; do not automatically resend.",
                    },
                  }),
            },
      ),
    },
    draft.revision,
  )
  for (const action of draft.actions) {
    if (action.status === ContinuationActionStatus.Launching) {
      await appendContinuationLaunchEvent(store, recovered, action.actionId)
    }
  }
  return recovered
}

export const openContinuationRequest = async (options: {
  readonly store: ContinuationStore
  readonly sourceClient: Pick<ContinuationSourceClient, "check">
  readonly context: HerdrContext | null
  readonly requestPath: string | undefined
  readonly model: string
  readonly effort: string
}): Promise<{ readonly draft: ContinuationDraft; readonly hasSavedDraft: boolean }> => {
  const context = options.context
  if (context === null || context.surface !== InvocationSurface.Popup || context.cwd === undefined) {
    throw new Error("--next-steps requires the focused-pane Herdr popup context.")
  }
  if (options.requestPath === undefined || !path.isAbsolute(options.requestPath)) {
    throw new Error("--next-steps requires a private conversation request.")
  }
  const snapshot = await options.store.consumeRequest(options.requestPath)
  if (
    context.paneId !== snapshot.source.paneId ||
    context.workspaceId !== snapshot.source.workspaceId ||
    path.resolve(context.cwd) !== path.resolve(snapshot.source.cwd)
  ) {
    throw new Error("The conversation request does not match the popup's original focused pane.")
  }
  const status = await options.sourceClient.check(snapshot)
  if (!status.sameSource) throw new Error("The original pane changed sessions. Open the source picker again.")
  const existing = await options.store.find(snapshot.source)
  const draft =
    existing === undefined
      ? await options.store.create(snapshot, options.model, options.effort)
      : await recoverInterruptedContinuation(options.store, existing)
  await options.store.acknowledgeRequest(options.requestPath)
  return { draft, hasSavedDraft: existing !== undefined }
}
