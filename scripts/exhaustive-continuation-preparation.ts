import assert from "node:assert/strict"
import { ContinuationActionStatus, type ContinuationDraft, type ContinuationActionDraft } from "@trellage/guide-core"
import { createContinuationServices } from "../packages/trellage-launcher/src/continuation-runtime.ts"
import type { ContinuationStore } from "../packages/trellage-launcher/src/continuation-store.ts"
import {
  changeContinuationAction,
  selectContinuationCandidate,
} from "../packages/trellage-launcher/src/continuation-ui-state.ts"
import type { createGuideWorld } from "./exhaustive-guide-world.ts"
import { assertContinuationLaunch } from "./exhaustive-continuation-launch.ts"

export const assertContinuationPreparation = async (
  store: ContinuationStore,
  initial: ContinuationDraft,
  world: Awaited<ReturnType<typeof createGuideWorld>>,
  id: string,
): Promise<void> => {
  let draft = initial
  let actionId: string | undefined
  let launchSource: { sameSource: boolean; advanced: boolean } | undefined
  let sourceChecks = 0
  const calls: string[] = []
  const launchReady: ContinuationActionDraft[] = []
  const unexpected = (): never => {
    throw new Error(`${id}: unexpected preparation boundary`)
  }
  const controller = new AbortController()
  const titles = ["Focused", "Thorough", "Cautious"] as const
  const services = createContinuationServices({
    store,
    initialDraft: initial,
    catalog: world.catalog,
    guideRoot: world.guideRoot,
    runner: { run: unexpected },
    sourceClient: {
      refresh: unexpected,
      check: async (snapshot) => {
        assert(launchSource !== undefined, id)
        assert.deepEqual(snapshot, initial.snapshot, id)
        sourceChecks++
        return { ...launchSource, revision: snapshot.revision }
      },
    },
    assessmentProvider: unexpected,
    jevDecision: { cwd: initial.snapshot.source.cwd, client: { systemOne: unexpected } },
    preparationProvider: (current, signal) => {
      assert.deepEqual(current, draft, id)
      assert.equal(signal, controller.signal, id)
      const action = draft.assessment!.actions.find((action) => action.id === actionId)!
      const edit = draft.actions.find((edit) => edit.actionId === actionId)!
      assert(action && edit, id)
      calls.push("provider")
      return {
        match: unexpected,
        refine: unexpected,
        enrich: unexpected,
        firstmate: unexpected,
        generate: async (input) => {
          assert.equal(input.profileRef, action.profileRef, id)
          assert.equal(input.workflowId, action.workflowId, id)
          assert(input.intent.includes(edit.brief), id)
          assert.equal(input.originalIntent, edit.brief, id)
          calls.push("generate")
          return {
            candidates: titles.map((title) => ({
              title,
              prompt: `Fixture ${title}: ${edit.brief}`,
              notes: "Explicit offline preparation fixture",
            })),
          }
        },
        optimize: async (input) => {
          assert.equal(input.profileRef, action.profileRef, id)
          assert.equal(input.originalIntent, edit.brief, id)
          assert.equal(input.candidates.length, 3, id)
          for (const [index, candidate] of input.candidates.entries()) {
            assert(candidate.prompt.includes(`Fixture ${titles[index]}`), id)
          }
          calls.push("optimize")
          return { candidates: input.candidates }
        },
      }
    },
  })
  assert.deepEqual(calls, [], id)
  for (const action of initial.assessment!.actions) {
    actionId = action.id
    const before = draft
    calls.length = 0
    draft = await services.prepare(draft, actionId, controller.signal, () => {})
    assert.deepEqual(calls, ["provider", "generate", "optimize"], id)
    const prepared = draft.actions.find((edit) => edit.actionId === actionId)!
    assert.equal(prepared.status, ContinuationActionStatus.Draft, id)
    assert.equal(prepared.prompt, undefined, id)
    assert.equal(prepared.selected, false, id)
    assert.equal(prepared.originalIntent, prepared.brief, id)
    assert.deepEqual(
      prepared.candidates?.map((candidate) => candidate.id),
      ["candidate-1", "candidate-2", "candidate-3"],
      id,
    )
    assert.equal(new Set(prepared.candidates?.map((candidate) => candidate.prompt)).size, 3, id)
    assert.deepEqual(draft.assessment, before.assessment, id)
    assert.deepEqual(
      draft.actions.filter((edit) => edit.actionId !== actionId),
      before.actions.filter((edit) => edit.actionId !== actionId),
      id,
    )
    assert.deepEqual(await store.load(draft.id), draft, id)
    for (const [index, candidate] of prepared.candidates!.entries()) {
      assert(candidate.prompt.includes(`Fixture ${titles[index]}`), id)
      draft = await services.save(selectContinuationCandidate(draft, actionId, candidate.id))
      const selected = draft.actions.find((edit) => edit.actionId === actionId)!
      assert.equal(selected.status, ContinuationActionStatus.Prepared, id)
      assert.equal(selected.selectedCandidateId, candidate.id, id)
      assert.equal(selected.prompt, candidate.prompt, id)
      assert.equal(selected.selected, false, id)
      assert.deepEqual(await store.load(draft.id), draft, id)
    }
    assert.deepEqual(calls, ["provider", "generate", "optimize"], id)
    launchReady.push(structuredClone(draft.actions.find((edit) => edit.actionId === actionId)!))
    draft = await services.save(
      changeContinuationAction(draft, actionId, { brief: `${prepared.brief} Include boundary evidence.` }),
    )
    const invalidated = draft.actions.find((edit) => edit.actionId === actionId)!
    assert.equal(invalidated.status, ContinuationActionStatus.Draft, id)
    assert.equal(invalidated.prompt, undefined, id)
    assert.equal(invalidated.candidates, undefined, id)
    assert.equal(invalidated.selectedCandidateId, undefined, id)
    assert.deepEqual(await store.load(draft.id), draft, id)
  }
  assert.equal(sourceChecks, 0, id)
  for (const fixture of [
    { sameSource: false, advanced: false, acknowledge: false, error: /no longer contains this conversation/ },
    { sameSource: true, advanced: true, acknowledge: false, error: /conversation advanced/ },
    { sameSource: true, advanced: true, acknowledge: true, error: /Select a prepared, unlaunched action/ },
    { sameSource: true, advanced: false, acknowledge: false, error: /Select a prepared, unlaunched action/ },
  ]) {
    launchSource = { sameSource: fixture.sameSource, advanced: fixture.advanced }
    await assert.rejects(services.launch(draft, fixture.acknowledge), fixture.error, id)
    assert.deepEqual(await store.load(draft.id), draft, id)
  }
  draft = await services.save(changeContinuationAction(draft, initial.actions[0]!.actionId, { selected: true }))
  await assert.rejects(services.launch(draft, false), /Prepare and review every selected prompt/, id)
  assert.deepEqual(await store.load(draft.id), draft, id)
  assert.equal(sourceChecks, 5, id)
  assert.deepEqual(calls, ["provider", "generate", "optimize"], id)
  await assertContinuationLaunch(store, initial, launchReady, world, id)
}
