import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import { executeGuideUiResult, type GuideInteractiveExecutionServices } from "./guide-interactive-execution.ts"
import { assertEngagementSnapshotCurrent, engagementErrorMessage } from "./engagement-context.ts"
import { EngagementWorkStore, engagementLaunchPlan, type EngagementWork } from "./engagement-work.ts"

export const executeEngagementWork = async (
  work: EngagementWork,
  store: EngagementWorkStore,
  catalog: CombinedGuideCatalog,
  guideRoot: string,
  services: GuideInteractiveExecutionServices,
): Promise<{ readonly work: EngagementWork; readonly notice: string }> => {
  const plan = await engagementLaunchPlan(work, store, catalog, guideRoot, services.runner)
  const launching = await store.update(work, { status: "launching", exitCode: null, review: null })
  let exitCode: number
  try {
    exitCode = await executeGuideUiResult(plan, {
      ...services,
      beforeCurrentTerminalLaunch: async () => {
        await assertEngagementSnapshotCurrent(services.runner, store.root, work.request.snapshot)
        if (JSON.stringify(await store.read(work.request.id)) !== JSON.stringify(launching)) {
          throw new Error("Saved assignment changed during readiness checks; no agent was launched.")
        }
      },
    })
  } catch (cause) {
    const unknown = await store.update(launching, { status: "unknown", exitCode: null, review: null })
    return {
      work: unknown,
      notice: `Launch was not confirmed: ${engagementErrorMessage(cause)}. Inspect the work; Guide will not retry it.`,
    }
  }
  return {
    work: await store.update(launching, { status: "returned", exitCode, review: null }),
    notice: `The execution attempt ended with exit ${exitCode}. Review the actual result; exit status is not engagement progress.`,
  }
}
