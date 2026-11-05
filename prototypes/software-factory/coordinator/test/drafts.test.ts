import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { draftNodeId, isUnstartedDraft, makeDrafts, type DraftDeps } from "../src/drafts.ts"
import { Threads, type Candidate } from "../src/threads.ts"

const candidates: Candidate[] = [
  { title: "A", prompt: "build x well", notes: "clearer" },
  { title: "B", prompt: "build x fast", notes: "shorter" },
  { title: "C", prompt: "build x safe", notes: "safer" },
]

const setup = (over: Partial<DraftDeps> = {}) => {
  const threads = new Threads(mkdtempSync(path.join(tmpdir(), "sf-drafts-")))
  const spawned: (Parameters<DraftDeps["spawn"]>[0] & { id: string })[] = []
  const running = new Set<string>()
  const delivered: { threadId: string; text: string }[] = []
  const calls: string[] = []
  const changed: string[] = []
  const deps: DraftDeps = {
    threads,
    // The test Threads has only the General folder; "repo" gets a worktree, "general" does not.
    createThread: (prompt, folderId) =>
      threads.create(prompt, "general", folderId === "general" ? undefined : () => ({ worktree: "/wt", branch: "b", base: "main" })),
    spawn: async (spec) => {
      const id = `w${spawned.length + 1}`
      spawned.push({ ...spec, id })
      return { id }
    },
    isRunning: (id) => running.has(id),
    stopOwned: async (owner) => void calls.push(`stopOwned ${owner}`),
    discard: async (t) => (calls.push(`discard ${t.id}`), threads.delete(t.id)),
    deliver: async (threadId, text) => void delivered.push({ threadId, text }),
    enhance: async () => candidates,
    stopEnhance: async (id) => void calls.push(`stopEnhance ${id}`),
    changed: (id) => void changed.push(id),
    ...over,
  }
  return { drafts: makeDrafts(deps), threads, spawned, running, delivered, calls, changed }
}

test("create makes one human version and no reports", () => {
  const { drafts, changed } = setup()
  const t = drafts.create("repo", "  build x ")
  expect(t.worktree).toBe("/wt")
  expect(t.draft).toMatchObject({ versions: [{ prompt: "build x", source: "human" }], reports: [] })
  expect(t.draft!.current).toBe(t.draft!.versions[0]!.id)
  expect(changed).toEqual([t.id])
})

test("empty prompt is refused", () => {
  const { drafts, threads } = setup()
  expect(() => drafts.create("repo", "  ")).toThrow(expect.objectContaining({ status: 400 }))
  expect(threads.list()).toEqual([])
})

test("General folder is refused and leaves no thread", async () => {
  const { drafts, threads, calls } = setup()
  expect(() => drafts.create("general", "build x")).toThrow(expect.objectContaining({ status: 400, message: "drafts need a repo folder" }))
  await Promise.resolve()
  expect(calls).toEqual([expect.stringMatching(/^discard /)])
  expect(threads.list()).toEqual([])
})

test("unknown thread or thread without a draft is 404", async () => {
  const { drafts, threads } = setup()
  const plain = threads.create("hi")
  expect(() => drafts.addVersion("nope", "x")).toThrow(expect.objectContaining({ status: 404 }))
  expect(() => drafts.addVersion(plain.id, "x")).toThrow(expect.objectContaining({ status: 404 }))
  await expect(drafts.run(plain.id)).rejects.toMatchObject({ status: 404 })
})

test("addVersion and setCurrent switch the current version", () => {
  const { drafts } = setup()
  const t = drafts.create("repo", "build x")
  const v1 = t.draft!.current
  const d = drafts.addVersion(t.id, "build y")
  expect(d.versions).toHaveLength(2)
  expect(d.versions[1]).toMatchObject({ prompt: "build y", source: "human" })
  expect(d.current).toBe(d.versions[1]!.id)
  expect(drafts.setCurrent(t.id, v1).current).toBe(v1)
  expect(() => drafts.setCurrent(t.id, "nope")).toThrow(expect.objectContaining({ status: 400 }))
})

test("Council twice while the first runs spawns once", async () => {
  const { drafts, spawned, running } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.act(t.id, "council")
  running.add(spawned[0]!.id)
  await expect(drafts.act(t.id, "council")).rejects.toMatchObject({ status: 409 })
  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toMatchObject({ step: "council", owner: draftNodeId(t.id), task: expect.stringContaining("reports/draft-council.md") })
})

test("a finished action runs again and replaces its report entry", async () => {
  const { drafts, spawned } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.act(t.id, "research")
  const d = await drafts.act(t.id, "research")
  expect(spawned).toHaveLength(2)
  expect(spawned[1]).toMatchObject({ name: "draft-research", step: "rpi-research", workdir: "/wt" })
  expect(d.reports).toEqual([{ action: "research", workerId: "w2", path: "reports/draft-rpi-research.md", versionId: d.current }])
})

test("Research runs hve-core RPI research in agent-owned mode", async () => {
  const { drafts, spawned } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.act(t.id, "research")
  expect(spawned[0]!.step).toBe("rpi-research")
  expect(spawned[0]!.task).toContain("reports/draft-rpi-research.md")
  expect(spawned[0]!.task).toContain("agent-owned")
  expect(spawned[0]!.task).toContain(".copilot-tracking/research/")
})

test("Hyperresearch runs the hyperresearch step", async () => {
  const { drafts, spawned } = setup()
  const t = drafts.create("repo", "build x")
  const d = await drafts.act(t.id, "hyperresearch")
  expect(spawned[0]).toMatchObject({ name: "draft-hyperresearch", step: "hyperresearch" })
  expect(spawned[0]!.task).toContain("reports/draft-hyperresearch.md")
  expect(spawned[0]!.task).not.toContain("agent-owned")
  expect(d.reports).toEqual([{ action: "hyperresearch", workerId: "w1", path: "reports/draft-hyperresearch.md", versionId: d.current }])
})

test("Enhance, Pick, then Research runs on the picked prompt", async () => {
  const { drafts, spawned } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.enhance(t.id)
  const picked = drafts.pick(t.id, 2)
  const d = await drafts.act(t.id, "research")
  expect(spawned[0]!.task).toContain("build x safe")
  expect(spawned[0]!.task).not.toMatch(/build x(?! safe)/)
  expect(d.reports[0]!.versionId).toBe(picked.current)
})

test("pending candidates block actions and Run; dismiss keeps the current prompt", async () => {
  const { drafts, spawned, delivered } = setup()
  const t = drafts.create("repo", "build x")
  expect(() => drafts.dismiss(t.id)).toThrow(expect.objectContaining({ status: 400 }))
  await drafts.enhance(t.id)
  for (const a of ["council", "debate", "research", "hyperresearch"] as const)
    await expect(drafts.act(t.id, a)).rejects.toMatchObject({ status: 409, message: "pick a rewrite first" })
  await expect(drafts.run(t.id)).rejects.toMatchObject({ status: 409, message: "pick a rewrite first" })
  expect(spawned).toEqual([])
  expect(delivered).toEqual([])
  const d = drafts.dismiss(t.id)
  expect(d.pending).toBeUndefined()
  expect(d.versions.map((v) => v.prompt)).toEqual(["build x"])
  expect(d.current).toBe(t.draft!.current)
  await drafts.act(t.id, "council")
  expect(spawned).toHaveLength(1)
})

test("dismiss after Run is refused", async () => {
  const { drafts } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.run(t.id)
  expect(() => drafts.dismiss(t.id)).toThrow(expect.objectContaining({ status: 409 }))
})

test("a later action reads the earlier reports of the other actions first", async () => {
  const { drafts, spawned } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.act(t.id, "research")
  expect(spawned[0]!.task).not.toContain("Context from earlier pre-work")
  await drafts.act(t.id, "council")
  expect(spawned[1]!.task).toContain(
    "Context from earlier pre-work in this worktree (read first):\n- reports/draft-rpi-research.md (Research, on prompt version 1)",
  )
  // Its own earlier report is not listed.
  await drafts.act(t.id, "research")
  expect(spawned[2]!.task).toContain("- reports/draft-council.md (Council, on prompt version 1)")
  expect(spawned[2]!.task).not.toContain("- reports/draft-rpi-research.md (")
})

test("Run waits for draft workers, then delivers the prompt with reports", async () => {
  const { drafts, spawned, running, delivered } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.act(t.id, "debate")
  running.add(spawned[0]!.id)
  await expect(drafts.run(t.id)).rejects.toMatchObject({ status: 409, message: "wait for debate to finish" })
  expect(delivered).toEqual([])
  running.clear()
  const d = await drafts.run(t.id)
  expect(d.startedAt).toEqual(expect.any(Number))
  expect(delivered[0]!.text).toBe("[from a guided draft] build x\n\nPre-work reports in this worktree (read before planning):\n- reports/draft-six-hats.md (Debate, on prompt version 1)")
})

test("Run without reports delivers only the prompt", async () => {
  const { drafts, delivered } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.run(t.id)
  expect(delivered).toEqual([{ threadId: t.id, text: "[from a guided draft] build x" }])
})

test("after Run every edit is refused", async () => {
  const { drafts } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.run(t.id)
  expect(() => drafts.addVersion(t.id, "y")).toThrow(expect.objectContaining({ status: 409 }))
  expect(() => drafts.setCurrent(t.id, t.draft!.current)).toThrow(expect.objectContaining({ status: 409 }))
  expect(() => drafts.pick(t.id, 0)).toThrow(expect.objectContaining({ status: 409 }))
  await expect(drafts.act(t.id, "council")).rejects.toMatchObject({ status: 409 })
  await expect(drafts.enhance(t.id)).rejects.toMatchObject({ status: 409 })
  await expect(drafts.run(t.id)).rejects.toMatchObject({ status: 409, message: "already started" })
})

test("enhance sets pending candidates", async () => {
  const { drafts } = setup()
  const t = drafts.create("repo", "build x")
  const d = await drafts.enhance(t.id)
  expect(d.pending).toMatchObject({ kind: "enhance", candidates })
})

test("enhance while one is in flight is refused", async () => {
  let release!: (c: Candidate[]) => void
  const { drafts } = setup({ enhance: () => new Promise((r) => (release = r)) })
  const t = drafts.create("repo", "build x")
  const first = drafts.enhance(t.id)
  await expect(drafts.enhance(t.id)).rejects.toMatchObject({ status: 409 })
  release(candidates)
  await first
  const again = drafts.enhance(t.id)
  release(candidates)
  await expect(again).resolves.toBeDefined()
})

test("enhance failure leaves the draft unchanged", async () => {
  const { drafts, threads } = setup({ enhance: async () => Promise.reject(new Error("model down")) })
  const t = drafts.create("repo", "build x")
  const before = structuredClone(threads.get(t.id)!.draft)
  await expect(drafts.enhance(t.id)).rejects.toMatchObject({ status: 502, message: "model down" })
  expect(threads.get(t.id)!.draft).toEqual(before)
})

test("enhance does not clobber a version added while it waited", async () => {
  let release!: (c: Candidate[]) => void
  const { drafts } = setup({ enhance: () => new Promise((r) => (release = r)) })
  const t = drafts.create("repo", "build x")
  const p = drafts.enhance(t.id)
  drafts.addVersion(t.id, "build y")
  release(candidates)
  const d = await p
  expect(d.versions.map((v) => v.prompt)).toEqual(["build x", "build y"])
  expect(d.pending?.candidates).toEqual(candidates)
})

test("act while a spawn is pending is refused, and Run waits for it", async () => {
  let release!: () => void
  const spawned: string[] = []
  const { drafts, delivered } = setup({
    spawn: (spec) => new Promise((r) => (spawned.push(spec.step), (release = () => r({ id: "w1" })))),
  })
  const t = drafts.create("repo", "build x")
  const first = drafts.act(t.id, "council")
  await expect(drafts.act(t.id, "council")).rejects.toMatchObject({ status: 409 })
  await expect(drafts.run(t.id)).rejects.toMatchObject({ status: 409, message: "wait for council to finish" })
  expect(spawned).toHaveLength(1)
  expect(delivered).toEqual([])
  release()
  expect((await first).reports).toHaveLength(1)
})

test("remove during a pending spawn stops the new worker", async () => {
  let release!: () => void
  const { drafts, calls } = setup({ spawn: () => new Promise((r) => (release = () => r({ id: "w1" }))) })
  const t = drafts.create("repo", "build x")
  const p = drafts.act(t.id, "council")
  await drafts.remove(t.id)
  release()
  await expect(p).rejects.toMatchObject({ status: 404 })
  expect(calls).toEqual([`stopOwned ${draftNodeId(t.id)}`, `discard ${t.id}`, `stopOwned ${draftNodeId(t.id)}`])
})

test("addVersion refuses an empty prompt", () => {
  const { drafts } = setup()
  const t = drafts.create("repo", "build x")
  expect(() => drafts.addVersion(t.id, "  ")).toThrow(expect.objectContaining({ status: 400 }))
  expect(drafts.addVersion(t.id, " build y ").versions[1]!.prompt).toBe("build y")
})

test("a failed delivery unlocks the draft", async () => {
  let fail = true
  const { drafts, threads, delivered } = setup({
    deliver: async (threadId, text) => {
      if (fail) throw new Error("sub down")
      delivered.push({ threadId, text })
    },
  })
  const t = drafts.create("repo", "build x")
  await expect(drafts.run(t.id)).rejects.toThrow("sub down")
  expect(threads.get(t.id)!.draft!.startedAt).toBeUndefined()
  fail = false
  await drafts.run(t.id)
  expect(delivered).toHaveLength(1)
})

test("a failed delivery stops the spawned sub; a failing stop keeps the delivery error", async () => {
  const stopped: string[] = []
  const { drafts, threads } = setup({
    deliver: async () => {
      throw new Error("sub down")
    },
    stopSub: async (id) => {
      stopped.push(id)
      throw new Error("stop failed")
    },
  })
  const t = drafts.create("repo", "build x")
  await expect(drafts.run(t.id)).rejects.toThrow("sub down")
  expect(stopped).toEqual([t.id])
  expect(threads.get(t.id)!.draft!.startedAt).toBeUndefined()
})

test("isUnstartedDraft: only a draft without startedAt", async () => {
  const { drafts, threads } = setup({
    // deliver sees the saved thread: Run marks it started before it delivers.
    deliver: async (id) => expect(isUnstartedDraft(threads.get(id))).toBe(false),
  })
  const t = drafts.create("repo", "build x")
  expect(isUnstartedDraft(threads.get(t.id))).toBe(true)
  expect(isUnstartedDraft(threads.create("hi"))).toBe(false)
  expect(isUnstartedDraft(undefined)).toBe(false)
  await drafts.run(t.id)
  expect(isUnstartedDraft(threads.get(t.id))).toBe(false)
})

test("pick makes the candidate the current version", async () => {
  const { drafts } = setup()
  const t = drafts.create("repo", "build x")
  expect(() => drafts.pick(t.id, 0)).toThrow(expect.objectContaining({ status: 400 }))
  await drafts.enhance(t.id)
  expect(() => drafts.pick(t.id, 3)).toThrow(expect.objectContaining({ status: 400 }))
  const d = drafts.pick(t.id, 1)
  expect(d.versions[1]).toMatchObject({ prompt: "build x fast", source: "enhance", title: "B", notes: "shorter" })
  expect(d.current).toBe(d.versions[1]!.id)
  expect(d.pending).toBeUndefined()
})

test("remove stops draft workers before discard", async () => {
  const { drafts, threads, calls } = setup()
  const t = drafts.create("repo", "build x")
  await drafts.run(t.id)
  calls.length = 0
  await drafts.remove(t.id)
  expect(calls).toEqual([`stopOwned ${draftNodeId(t.id)}`, `discard ${t.id}`])
  expect(threads.get(t.id)).toBeUndefined()
})

test("every mutation calls changed", async () => {
  const { drafts, changed } = setup()
  const t = drafts.create("repo", "build x")
  drafts.addVersion(t.id, "y")
  drafts.setCurrent(t.id, t.draft!.versions[0]!.id)
  await drafts.enhance(t.id)
  drafts.pick(t.id, 0)
  await drafts.act(t.id, "council")
  await drafts.run(t.id)
  await drafts.remove(t.id)
  expect(changed).toEqual(Array(8).fill(t.id))
})

test("enhance passes the draft node as owner; Pick and Run stop the enhance worker", async () => {
  const owners: string[] = []
  const { drafts, calls } = setup({ enhance: async (_p, owner) => (owners.push(owner), candidates) })
  const t = drafts.create("repo", "build x")
  await drafts.enhance(t.id)
  expect(owners).toEqual([draftNodeId(t.id)])
  drafts.pick(t.id, 0)
  await Promise.resolve()
  expect(calls).toContain(`stopEnhance ${t.id}`)
  calls.length = 0
  await drafts.run(t.id)
  expect(calls).toContain(`stopEnhance ${t.id}`)
})
