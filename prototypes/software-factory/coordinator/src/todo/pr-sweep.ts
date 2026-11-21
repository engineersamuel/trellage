import type { BranchPr, PrState } from "../cos.ts"
import type { Thread, Threads } from "../threads.ts"

type PrStates = {
  get(id: string): PrState | undefined
  set(id: string, state: PrState): void
  delete(id: string): void
  keys(): Iterable<string>
}

export type TodoPrSweepDeps = {
  threads: Threads
  prStates: PrStates
  repoPrs(repo: string): Promise<Map<string, BranchPr> | null>
  onPr(thread: Thread, pr: BranchPr): void
  todoEnabled(): boolean
  todoSweep(prs: Map<string, Map<string, BranchPr>>): Promise<void>
  onError(id: string | null, error: unknown): void
}

/** One PR query per repo, shared by ordinary PR events and Todo reconciliation. */
export const makeTodoPrSweep = (d: TodoPrSweepDeps) => async (): Promise<void> => {
  const byRepo = new Map<string, Thread[]>()
  for (const thread of d.threads.list()) {
    const repo = d.threads.folder(thread.folderId)?.path
    if (!repo) continue
    if (thread.worktree && thread.branch && !thread.cleanedAt && !thread.archivedAt)
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), thread])
    if (
      d.todoEnabled() &&
      thread.todo &&
      thread.todo.state !== "completed" &&
      thread.todo.state !== "released" &&
      !byRepo.has(repo)
    )
      byRepo.set(repo, [])
  }
  for (const id of d.prStates.keys()) {
    if (!d.threads.get(id) || d.threads.get(id)!.archivedAt) d.prStates.delete(id)
  }

  const prsByRepo = new Map<string, Map<string, BranchPr>>()
  for (const [repo, threads] of byRepo) {
    try {
      const prs = await d.repoPrs(repo)
      if (!prs) continue
      prsByRepo.set(repo, prs)
      for (const thread of threads) {
        const pr = thread.branch ? prs.get(thread.branch) : undefined
        if (pr) {
          try {
            d.onPr(thread, pr)
          } catch (error) {
            d.onError(thread.id, error)
          }
        }
      }
    } catch (error) {
      d.onError(null, error)
    }
  }
  if (d.todoEnabled())
    try {
      await d.todoSweep(prsByRepo)
    } catch (error) {
      d.onError(null, error)
    }
}
