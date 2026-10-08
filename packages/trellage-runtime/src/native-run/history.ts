import { execFile } from "node:child_process"
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { NativeRunPaths } from "./paths.ts"

const execFilePromise = promisify(execFile)

export interface Selection {
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

interface HistoryFile {
  readonly version: 1
  readonly worktrees: Readonly<Record<string, Selection>>
  readonly repositories: Readonly<Record<string, Selection>>
  readonly global?: Selection
}

export interface ScopeKeys {
  readonly worktree: string
  readonly repository: string
}

/** Canonical worktree path and Git common-directory identity; both fall back to the real cwd outside Git. */
export const scopeKeysFor = async (cwd: string): Promise<ScopeKeys> => {
  const worktree = await realpath(cwd)
  try {
    const common = (
      await execFilePromise("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" })
    ).stdout.trim()
    return { worktree, repository: await realpath(common) }
  } catch {
    return { worktree, repository: worktree }
  }
}

const emptyHistory: HistoryFile = { version: 1, worktrees: {}, repositories: {} }

export interface SelectionHistory {
  readonly restore: (keys: ScopeKeys) => Promise<{ scope: "worktree" | "repository" | "global"; selection: Selection } | null>
  readonly record: (keys: ScopeKeys, selection: Selection) => Promise<void>
}

export const createSelectionHistory = (paths: NativeRunPaths): SelectionHistory => {
  const file = path.join(paths.state, "selections.json")
  const read = async (): Promise<HistoryFile> => {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as HistoryFile
      return parsed.version === 1 ? parsed : emptyHistory
    } catch {
      return emptyHistory
    }
  }
  return {
    restore: async (keys) => {
      const history = await read()
      const worktree = history.worktrees[keys.worktree]
      if (worktree) return { scope: "worktree", selection: worktree }
      const repository = history.repositories[keys.repository]
      if (repository) return { scope: "repository", selection: repository }
      return history.global ? { scope: "global", selection: history.global } : null
    },
    record: async (keys, selection) => {
      const history = await read()
      const next: HistoryFile = {
        version: 1,
        worktrees: { ...history.worktrees, [keys.worktree]: selection },
        repositories: { ...history.repositories, [keys.repository]: selection },
        global: selection,
      }
      await mkdir(paths.state, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, file)
    },
  }
}
