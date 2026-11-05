// Draft rules: a repo-folder thread that holds a prompt and starts no work until Run.
import type { Candidate, Draft, DraftAction, DraftVersion, Thread, Threads } from "./threads.ts"
import { researchTask } from "./workflows.ts"

export class DraftError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message)
  }
}

/** Owner id of a draft's pre-work workers. */
export const draftNodeId = (threadId: string) => `draft-${threadId.slice(0, 8)}`

export const ACTION_WORKFLOW: Record<DraftAction, "council" | "six-hats" | "hyperresearch"> = {
  council: "council",
  debate: "six-hats",
  research: "hyperresearch",
}

const LABEL: Record<DraftAction, string> = { council: "Council", debate: "Debate", research: "Research" }

export type DraftDeps = {
  threads: Threads
  createThread: (prompt: string, folderId: string) => Thread
  spawn: (spec: { name: string; step: string; owner: string; workdir: string; task: string }) => Promise<{ id: string }>
  isRunning: (workerId: string) => boolean
  stopOwned: (owner: string) => Promise<void>
  /** Stop the sub, discard the worktree and delete the thread. */
  discard: (t: Thread) => Promise<void>
  deliver: (threadId: string, text: string) => Promise<void>
  enhance: (prompt: string) => Promise<Candidate[]>
  /** Publishes factory.thread_updated. */
  changed: (threadId: string) => void
  now?: () => number
}

const currentPrompt = (draft: Draft) => draft.versions.find((v) => v.id === draft.current)!.prompt

/** The first message of a started draft: its current prompt and the reports to read. */
export const runMessage = (draft: Draft): string => {
  const head = `[from a guided draft] ${currentPrompt(draft)}`
  if (!draft.reports.length) return head
  const lines = draft.reports.map((r) => `- ${r.path} (${LABEL[r.action]}, on prompt version ${draft.versions.findIndex((v) => v.id === r.versionId) + 1})`)
  return `${head}\n\nPre-work reports in this worktree (read before planning):\n${lines.join("\n")}`
}

export const makeDrafts = (d: DraftDeps) => {
  const now = d.now ?? Date.now
  const enhancing = new Set<string>()
  /** Draft id -> action whose spawn is still pending. */
  const acting = new Map<string, DraftAction>()

  const find = (id: string): Thread & { draft: Draft } => {
    const t = d.threads.get(id)
    if (!t?.draft) throw new DraftError(404, "no such draft")
    return t as Thread & { draft: Draft }
  }
  /** A draft that is not started yet, so it can still change. */
  const open = (id: string) => {
    const t = find(id)
    if (t.draft.startedAt) throw new DraftError(409, "already started")
    return t
  }
  const save = (id: string, draft: Draft): Draft => {
    d.threads.setDraft(id, draft)
    d.changed(id)
    return draft
  }
  const version = (prompt: string, extra: Partial<DraftVersion> = {}): DraftVersion => ({ id: crypto.randomUUID(), prompt, source: "human", at: now(), ...extra })

  return {
    create(folderId: string, prompt: string): Thread {
      const text = prompt.trim()
      if (!text) throw new DraftError(400, "prompt is empty")
      const t = d.createThread(text, folderId)
      if (!t.worktree) {
        d.discard(t).catch(console.error)
        throw new DraftError(400, "drafts need a repo folder")
      }
      const v = version(text)
      save(t.id, { versions: [v], current: v.id, reports: [] })
      return d.threads.get(t.id)!
    },

    addVersion(id: string, prompt: string): Draft {
      const { draft } = open(id)
      const text = prompt.trim()
      if (!text) throw new DraftError(400, "prompt is empty")
      const v = version(text)
      return save(id, { ...draft, versions: [...draft.versions, v], current: v.id })
    },

    setCurrent(id: string, versionId: string): Draft {
      const { draft } = open(id)
      if (!draft.versions.some((v) => v.id === versionId)) throw new DraftError(400, "no such version")
      return save(id, { ...draft, current: versionId })
    },

    async enhance(id: string): Promise<Draft> {
      const { draft } = open(id)
      if (enhancing.has(id)) throw new DraftError(409, "enhance is already running")
      enhancing.add(id)
      try {
        let candidates: Candidate[]
        try {
          candidates = await d.enhance(currentPrompt(draft))
        } catch (e) {
          throw new DraftError(502, e instanceof Error ? e.message : String(e))
        }
        // Re-read: the draft can change while the model works.
        const fresh = open(id).draft
        return save(id, { ...fresh, pending: { kind: "enhance", candidates, at: now() } })
      } finally {
        enhancing.delete(id)
      }
    },

    pick(id: string, index: number): Draft {
      const { draft } = open(id)
      const c = draft.pending?.candidates[index]
      if (!c || index > 2) throw new DraftError(400, "no such candidate")
      const v = version(c.prompt, { source: "enhance", title: c.title, notes: c.notes })
      const { pending: _, ...rest } = draft
      return save(id, { ...rest, versions: [...draft.versions, v], current: v.id })
    },

    async act(id: string, action: DraftAction): Promise<Draft> {
      const t = open(id)
      const pending = acting.get(id)
      if (pending) throw new DraftError(409, `${pending} is starting`)
      if (t.draft.reports.some((r) => r.action === action && d.isRunning(r.workerId))) throw new DraftError(409, `${action} is already running`)
      const workflow = ACTION_WORKFLOW[action]
      acting.set(id, action)
      try {
        const w = await d.spawn({
          name: `draft-${action}`,
          step: workflow,
          owner: draftNodeId(id),
          workdir: t.worktree!,
          task: researchTask(workflow, currentPrompt(t.draft), `draft-${workflow}`),
        })
        let fresh: Draft
        try {
          fresh = open(id).draft
        } catch (e) {
          // Removed during the spawn: do not leave the new worker running.
          await d.stopOwned(draftNodeId(id))
          throw e
        }
        const report = { action, workerId: w.id, path: `reports/draft-${workflow}.md`, versionId: t.draft.current }
        return save(id, { ...fresh, reports: [...fresh.reports.filter((r) => r.action !== action), report] })
      } finally {
        acting.delete(id)
      }
    },

    async run(id: string): Promise<Draft> {
      const { draft } = open(id)
      const b = acting.get(id) ?? draft.reports.find((r) => d.isRunning(r.workerId))?.action
      if (b) throw new DraftError(409, `wait for ${b} to finish`)
      const started = save(id, { ...draft, startedAt: now() })
      try {
        await d.deliver(id, runMessage(started))
      } catch (e) {
        // Not delivered: unlock the draft so the user can try again.
        const t = d.threads.get(id)
        if (t?.draft) {
          const { startedAt: _, ...rest } = t.draft
          save(id, rest)
        }
        throw e
      }
      return started
    },

    async remove(id: string): Promise<void> {
      const t = find(id)
      await d.stopOwned(draftNodeId(id))
      await d.discard(t)
      d.changed(id)
    },
  }
}
