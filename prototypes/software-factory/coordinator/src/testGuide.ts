// Manual test guide: after a sub-coordinator reports done, a read-only worker in its worktree writes how a human tries
// the change. Published as `factory.test_guide` (newest wins); the header pin shows it. "Open in herdr" writes the
// guide and setup script to .factory/ (git-excluded) and runs them in a herdr tab in the worktree.
import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { decodeGuide, guideMarkdown, setupScript, type TestGuide } from "../../shared/testGuide.ts"
import { now, type Factory } from "./factory.ts"
import { loadPrompt } from "./prompt.ts"
import { diffFiles } from "./sdlc.ts"
import type { Scope } from "./tools.ts"

export const TEST_GUIDE = "factory.test_guide"
const NAME = "manual-test"

const head = (workdir: string): string => {
  try {
    return execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

/** The scope's newest guide. */
export const latestGuide = (f: Factory, scopeId: string): TestGuide | undefined =>
  (f.store.latest(TEST_GUIDE, 2000) as TestGuide[])
    .filter((g) => g.scopeId === scopeId)
    .sort((a, b) => a.at - b.at)
    .at(-1)

/**
 * A guide exists, is not being written, and the worktree HEAD moved past its commit: new work landed without a done
 * report. A failed guide on the same commit is not retried (no loop).
 */
export const guideOutdated = (f: Factory, scopeId: string): boolean => {
  const g = latestGuide(f, scopeId)
  return !!g && g.status !== "writing" && head(g.workdir) !== g.commit
}

/** The newest guide for the UI; `stale` when the worktree HEAD is no longer the commit it was written for. */
export const guideView = (f: Factory, scopeId: string) => {
  const g = latestGuide(f, scopeId)
  if (!g) return null
  // A restart stopped its writer: show it as failed, so Rewrite comes back.
  const lost = g.status === "writing" && ![...f.workers.values()].some((w) => w.owner === scopeId && w.name === NAME)
  return {
    ...g,
    ...(lost ? { status: "failed" as const, error: "coordinator restarted" } : {}),
    stale: g.status === "ready" && head(g.workdir) !== g.commit,
  }
}

/** Write a new guide; a guide still being written for the scope is replaced. Never throws: errors end as `failed`. */
export const writeGuide = async (
  f: Factory,
  scope: Scope,
  summary: string,
  timeoutMs = 300_000,
): Promise<TestGuide> => {
  const workdir = scope.workdir!
  for (const w of [...f.workers.values()])
    if (w.owner === scope.id && w.name === NAME) await f.stop(w.id).catch(() => {})
  const g: TestGuide = {
    id: `tg-${crypto.randomUUID().slice(0, 8)}`,
    scopeId: scope.id,
    threadId: scope.threadId,
    workdir,
    status: "writing",
    commit: head(workdir),
    setup: [],
    steps: [],
    cleanup: [],
    at: Date.now(),
  }
  const set = (patch: Partial<TestGuide>) => {
    Object.assign(g, patch, { at: Date.now() })
    f.publish(scope.id, TEST_GUIDE, null, now(), { ...g })
  }
  set({})
  try {
    const w = await f.spawn({
      name: NAME,
      role: "worker",
      owner: scope.id,
      group: { id: g.id, title: "How to test", after: null },
      workdir,
      ...(f.workers.get(scope.id)?.model ? { model: f.workers.get(scope.id)!.model } : {}),
      permissions: f.subPermissions,
      task: loadPrompt("tasks/manual-test", {
        summary,
        criteria: (f.sdlc.get(scope.id)?.criteria ?? []).map((c, i) => `AC-${i + 1}: ${c}`).join("\n") || "(none)",
        diff: scope.base
          ? diffFiles(workdir, scope.base)
              .map((x) => `- ${x.path} +${x.added} -${x.removed}`)
              .join("\n")
              .slice(0, 3000)
          : "(see git diff)",
      }),
    })
    const idle = await w.waitIdle(timeoutMs)
    await f.stop(w.id).catch(() => {})
    if (!idle) throw new Error("the test guide writer timed out")
    set({ ...decodeGuide(w.lastMessage ?? ""), status: "ready" })
  } catch (e) {
    set({ status: "failed", error: e instanceof Error ? e.message : String(e) })
  }
  return g
}

type Herdr = (args: string[]) => string
const herdrCli: Herdr = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 10_000 })

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Write .factory/manual-test.{md,sh} and run them in a focused herdr tab in the worktree: a new tab in the herdr
 * workspace of that worktree (or the one called `label`), else a new workspace called `label`. Returns the pane id.
 */
export const openInHerdr = (g: TestGuide, label: string, herdr: Herdr = herdrCli): string => {
  const dir = path.join(g.workdir, ".factory")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "manual-test.md"), `# How to test\n\n${guideMarkdown(g)}\n`)
  writeFileSync(path.join(dir, "manual-test.sh"), setupScript(g.setup), { mode: 0o755 })
  const spaces = JSON.parse(herdr(["workspace", "list"])).result.workspaces as {
    workspace_id: string
    label: string
    worktree?: { checkout_path?: string }
  }[]
  // Herdr records `worktree` only on workspaces it opened as worktrees; one this made is found by its label.
  const own = spaces.find(
    (w) => w.label === label || (w.worktree?.checkout_path && real(w.worktree.checkout_path) === real(g.workdir)),
  )
  const made = JSON.parse(
    herdr(
      own
        ? ["tab", "create", "--workspace", own.workspace_id, "--cwd", g.workdir, "--label", "How to test", "--focus"]
        : ["workspace", "create", "--cwd", g.workdir, "--label", label, "--focus"],
    ),
  ).result
  const pane: string = made.root_pane.pane_id
  herdr(["pane", "run", pane, "cat .factory/manual-test.md; bash .factory/manual-test.sh"])
  return pane
}
