import {
  sameFirstmateInstance, validateFirstmateInstanceFleet, parseFirstmateInstanceReferenceV1,
  type ContinuationActionDraft, type ContinuationDraft, type FirstmateInstanceReferenceV1,
} from "@trellage/guide-core"
import { selectedProfileFromCatalogRef } from "./guide-api.ts"
import { parseSelectedProfile, type NativeSelectedProfile, type SelectedProfile } from "./guide-launch.ts"
import {
  runFirstmateInstanceMenuOperation,
  type FirstmateInstanceChoice, type FirstmateInstanceMenuState, type FirstmateInstanceMenuEnvironment,
} from "./guide-firstmate-instance-menu.ts"
import {
  createFirstmateJournalFactory, scopeFirstmateJournal, type FirstmateJournalFactory,
} from "./guide-firstmate-journal.ts"
import { firstmateInstanceControlArgs } from "./guide-firstmate-instance-selection.ts"
import { continuationAction, continuationActionLocked } from "./continuation-ui-state.ts"
import type { ContinuationRuntimeOptions } from "./continuation-runtime.ts"
import { verifiedFirstmateOriginCwd } from "./guide-firstmate-origin.ts"
import { savedLegacyFirstmateOrchestration } from "./guide-context.ts"

export const continuationJournalReference = (edit: ContinuationActionDraft): FirstmateInstanceReferenceV1 => {
  const request = edit.firstmateSubmission?.request
  if (request === undefined) throw new Error("Instance journal selection requires the original saved request.")
  const reference = edit.firstmateInstance ?? parseFirstmateInstanceReferenceV1({
    schemaVersion: 1, profile: request.expectedFleet.profile, mode: "legacy", instanceId: request.expectedFleet.instanceId,
  })
  validateFirstmateInstanceFleet(reference, request.expectedFleet)
  return reference
}

export const continuationFirstmateJournals = (options: ContinuationRuntimeOptions): FirstmateJournalFactory => {
  const factory = options.firstmateJournalFor ?? createFirstmateJournalFactory()
  return (reference) => reference.mode === "legacy" && options.firstmateJournal !== undefined
    ? scopeFirstmateJournal(reference, options.firstmateJournal) : factory(reference)
}

const actionKey = (draft: ContinuationDraft, actionId: string): string => `${draft.id}:${draft.snapshot.id}:${actionId}`

/** Live, reviewed controls stay in this process, outside snapshots, model inputs, and artifacts. */
export class ContinuationFirstmateInstances {
  private readonly choices = new Map<string, FirstmateInstanceChoice>()
  private readonly actionReviews = new Set<string>()

  constructor(private readonly options: ContinuationRuntimeOptions) {}

  profile(draft: ContinuationDraft, actionId: string, control = false): SelectedProfile {
    const { action, edit } = continuationAction(draft, actionId)
    const raw = selectedProfileFromCatalogRef(this.options.catalog, edit.profileRef ?? action.profileRef, edit.workflowId ?? action.workflowId)
    if (raw.surface !== "native" || raw.launcher !== "fmx" || raw.orchestration === undefined) return raw
    const compatible = edit.firstmateInstance === undefined && edit.firstmateSubmission !== undefined
      ? { ...raw, orchestration: savedLegacyFirstmateOrchestration(edit.firstmateSubmission.request.generatedSpec, raw.orchestration) } : raw
    const selected = this.boundProfile(compatible, draft, actionId)
    if (control) this.requireControl(selected, draft, edit)
    return selected
  }

  private boundProfile(raw: NativeSelectedProfile, draft: ContinuationDraft, actionId: string): NativeSelectedProfile {
    const { edit } = continuationAction(draft, actionId)
    const reference = edit.firstmateInstance ?? (edit.firstmateSubmission === undefined ? undefined : continuationJournalReference(edit))
    const cached = this.choices.get(actionKey(draft, actionId))
    const choice = reference !== undefined && cached !== undefined && sameFirstmateInstance(cached.context.reference, reference)
      ? cached : undefined
    const selected = parseSelectedProfile({
      ...raw,
      ...(reference === undefined ? {} : { firstmateInstance: reference }),
      ...(choice === undefined ? {} : { firstmateInstanceContext: choice.context }),
    })
    if (selected.surface !== "native") throw new Error("Firstmate instance binding requires a native profile.")
    return selected
  }

  private requireControl(profile: NativeSelectedProfile, draft: ContinuationDraft, edit: ContinuationActionDraft): void {
    if (profile.orchestration?.instances !== undefined) {
      if (profile.firstmateInstance === undefined) throw new Error("Choose and confirm this action's fleet instance first.")
      if (edit.firstmateInstance !== undefined && profile.firstmateInstanceContext === undefined) {
        throw new Error("Review the saved instance before control. Its original UUID remains bound; receipt lookup needs no new approval.")
      }
    }
    firstmateInstanceControlArgs(profile)
  }

  private discoveryProfile(draft: ContinuationDraft, actionId: string): SelectedProfile {
    const { action, edit } = continuationAction(draft, actionId)
    const raw = selectedProfileFromCatalogRef(this.options.catalog, edit.profileRef ?? action.profileRef, edit.workflowId ?? action.workflowId)
    const reference = edit.firstmateInstance ?? (edit.firstmateSubmission === undefined ? undefined : continuationJournalReference(edit))
    return parseSelectedProfile({ ...raw, ...(reference === undefined ? {} : { firstmateInstance: reference }) })
  }

  environment(draft: ContinuationDraft, actionId: string): FirstmateInstanceMenuEnvironment {
    const { edit } = continuationAction(draft, actionId)
    if (continuationActionLocked(edit)) throw new Error("An accepted or uncertain request cannot select or create another instance.")
    const profile = this.discoveryProfile(draft, actionId)
    if (profile.surface !== "native" || profile.launcher !== "fmx" || profile.orchestration?.instances === undefined) {
      throw new Error("This backend does not advertise instance selection. Keep the legacy workflow.")
    }
    return {
      profile, runner: this.options.runner, cwd: this.options.context?.cwd ?? draft.snapshot.source.cwd,
      ...(this.options.context?.launchOrigin === undefined ? {} : { launchOrigin: this.options.context.launchOrigin }),
      ...(this.options.firstmateCreationStore === undefined ? {} : { creationStore: this.options.firstmateCreationStore }),
    }
  }

  async run(draft: ContinuationDraft, actionId: string, state: FirstmateInstanceMenuState, signal: AbortSignal) {
    return runFirstmateInstanceMenuOperation(this.environment(draft, actionId), state, signal)
  }

  async verify(draft: ContinuationDraft, actionId: string, choice: FirstmateInstanceChoice, signal: AbortSignal): Promise<FirstmateInstanceChoice> {
    const state: FirstmateInstanceMenuState = {
      generation: 1, screen: "review", operation: { kind: "select", choice },
      instances: [], entry: choice.context.entryWorktree, configurationCwd: choice.configurationCwd,
      index: 0, text: "", confirm: true, creationUncertain: false, recoveryPlans: [],
    }
    const result = await this.run(draft, actionId, state, signal)
    if (result.type !== "resolved" || result.result.kind !== "select") {
      throw new Error(result.type === "failed" ? result.error : "Instance confirmation did not return verified controls.")
    }
    return result.result.choice
  }

  remember(draft: ContinuationDraft, actionId: string, choice: FirstmateInstanceChoice): void {
    const key = actionKey(draft, actionId)
    if (continuationAction(draft, actionId).edit.firstmateSubmission === undefined) this.actionReviews.delete(key)
    else if (this.contextChanged(draft, actionId, choice)) this.actionReviews.add(key)
    this.choices.set(key, choice)
  }

  contextChanged(draft: ContinuationDraft, actionId: string, choice: FirstmateInstanceChoice): boolean {
    const previous = this.choices.get(actionKey(draft, actionId))
    return previous === undefined || JSON.stringify(previous.context) !== JSON.stringify(choice.context) ||
      previous.configurationCwd !== choice.configurationCwd
  }

  requireActionApproval(draft: ContinuationDraft, actionId: string): void {
    if (this.actionReviews.has(actionKey(draft, actionId))) {
      throw new Error("Reconfirm the same fleet action after reviewing the instance context. The original request ID and payload are unchanged.")
    }
  }

  actionConfirmed(draft: ContinuationDraft, actionId: string): void {
    this.actionReviews.delete(actionKey(draft, actionId))
  }

  configurationCwd(draft: ContinuationDraft, actionId: string): string {
    const profile = this.profile(draft, actionId)
    const choice = this.choices.get(actionKey(draft, actionId))
    return profile.surface === "native" && profile.firstmateInstance !== undefined && choice !== undefined &&
      sameFirstmateInstance(profile.firstmateInstance, choice.context.reference)
      ? choice.configurationCwd : draft.snapshot.source.cwd
  }

  async entryCwd(draft: ContinuationDraft, actionId: string): Promise<string> {
    const profile = this.profile(draft, actionId, true)
    if ((profile.surface !== "native" || profile.firstmateInstanceContext === undefined) && this.options.context?.launchOrigin !== undefined) {
      return verifiedFirstmateOriginCwd(this.options.runner, this.options.catalog, draft.snapshot.source.cwd, this.options.context.launchOrigin)
    }
    if (profile.surface === "native" && profile.orchestration?.instances !== undefined &&
        profile.firstmateInstanceContext?.entryWorktree == null) {
      throw new Error("No verified entry worktree is available. Choose an explicit repository; managed runtime cwd is not a fallback.")
    }
    return this.configurationCwd(draft, actionId)
  }
}
