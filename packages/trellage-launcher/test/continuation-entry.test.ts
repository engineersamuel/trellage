import { realpath, rm, stat } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ContinuationActionStatus, ContinuationPlacementKind } from "../../trellage-guide-core/dist/index.js"
import { openContinuationRequest, recoverInterruptedContinuation } from "../src/continuation-entry.js"
import { ContinuationStore } from "../src/continuation-store.js"
import { createContinuationFixtureRoot, runtimeAssessment, runtimeSnapshot } from "./helpers/continuation-runtime-fixtures.js"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const setup = async () => {
  const root = await createContinuationFixtureRoot()
  roots.push(root)
  const store = new ContinuationStore(root)
  const snapshot = runtimeSnapshot(root)
  const requestPath = await new ContinuationStore(root).stageRequest(snapshot)
  const check = vi.fn(async () => ({
    sameSource: true,
    advanced: false,
    revision: snapshot.revision,
  }))
  const context = { surface: "popup" as const, workspaceId: "w1", paneId: "w1:p1", cwd: root }
  return {
    store,
    snapshot,
    requestPath,
    sourceClient: { check },
    context,
    model: "fixture-model",
    effort: "medium",
  }
}

describe("focused continuation entry", () => {
  it("creates canonical private fixture roots without using the shared temporary directory", async () => {
    vi.stubEnv("TMPDIR", "/tmp")
    try {
      const root = await createContinuationFixtureRoot()
      roots.push(root)
      expect(await realpath(root)).toBe(root)
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      const store = new ContinuationStore(root)
      await expect(store.create(runtimeSnapshot(root), "fixture-model", "medium")).resolves.toMatchObject({
        snapshot: { source: { cwd: root } },
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("durably creates a source-bound draft before consuming the request", async () => {
    const fixture = await setup()
    const opened = await openContinuationRequest(fixture)
    expect(opened.hasSavedDraft).toBe(false)
    expect(opened.draft.assessment).toBeUndefined()
    expect((await fixture.store.load(opened.draft.id)).snapshot).toEqual(fixture.snapshot)
    await expect(stat(fixture.requestPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(fixture.sourceClient.check).toHaveBeenCalledOnce()
  })

  it("resumes the same exact source without replacing saved edits with a newer snapshot", async () => {
    const fixture = await setup()
    const first = await fixture.store.create(fixture.snapshot, "saved-model", "high")
    const opened = await openContinuationRequest(fixture)
    expect(opened.hasSavedDraft).toBe(true)
    expect(opened.draft.id).toBe(first.id)
    expect(opened.draft.model).toBe("saved-model")
  })

  it("rejects non-popup or another-pane requests before exposing a saved draft", async () => {
    const fixture = await setup()
    const find = vi.spyOn(fixture.store, "find")
    await expect(openContinuationRequest({ ...fixture, context: null })).rejects.toThrow("popup context")
    await expect(
      openContinuationRequest({
        ...fixture,
        context: { ...fixture.context, paneId: "w1:p2" },
      }),
    ).rejects.toThrow("original focused pane")
    expect(find).not.toHaveBeenCalled()
    expect(fixture.sourceClient.check).not.toHaveBeenCalled()
    expect((await stat(fixture.requestPath)).isFile()).toBe(true)
  })

  it("blocks reused live identities before loading their prior private draft", async () => {
    const fixture = await setup()
    fixture.sourceClient.check.mockResolvedValue({
      sameSource: false,
      advanced: false,
      revision: fixture.snapshot.revision,
    })
    const find = vi.spyOn(fixture.store, "find")
    await expect(openContinuationRequest(fixture)).rejects.toThrow("pane changed sessions")
    expect(find).not.toHaveBeenCalled()
  })

  it("keeps the transport request when the durable save fails", async () => {
    const fixture = await setup()
    vi.spyOn(fixture.store, "create").mockRejectedValue(new Error("Disk full"))
    await expect(openContinuationRequest(fixture)).rejects.toThrow("Disk full")
    expect((await stat(fixture.requestPath)).isFile()).toBe(true)
  })

  it("marks an interrupted attempt unknown instead of making it launchable again", async () => {
    const fixture = await setup()
    const created = await fixture.store.create(fixture.snapshot, "fixture-model", "medium")
    const interrupted = await fixture.store.save(
      {
        ...created,
        assessment: runtimeAssessment(),
        actions: runtimeAssessment().actions.map((action, index) => ({
          actionId: action.id,
          brief: action.brief,
          selected: index === 0,
          status: index === 0 ? ContinuationActionStatus.Launching : ContinuationActionStatus.Draft,
          ...(index === 0
            ? {
                prompt: "Review the search flow.",
                placement: { kind: ContinuationPlacementKind.NewTab },
                launch: {
                  attemptId: "109acb73-ad12-457a-b2a4-d490d21bfc9d",
                  status: ContinuationActionStatus.Launching,
                  paneId: "w2:p2",
                },
              }
            : {}),
        })),
      },
      created.revision,
    )
    const recovered = await recoverInterruptedContinuation(fixture.store, interrupted)
    expect(recovered.actions[0]?.status).toBe(ContinuationActionStatus.Unknown)
    expect(recovered.actions[0]?.launch?.paneId).toBe("w2:p2")
    expect(recovered.actions[0]?.launch?.attemptId).toBe("109acb73-ad12-457a-b2a4-d490d21bfc9d")
    expect(recovered.actions[1]?.status).toBe(ContinuationActionStatus.Draft)
    expect(recovered.revision).toBeGreaterThan(interrupted.revision)
  })
})
