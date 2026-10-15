import { lstat, mkdir } from "node:fs/promises"
import path from "node:path"
import { bunArguments, bunExecutable, sourceEnvironment } from "@trellage/runtime"
import type { CommandRunner } from "./guide-launch.ts"

/** Skills that Optimize downloads before it runs, keyed by Optimize skill ID. */
export const optimizeManagedBundles: Readonly<Record<string, { readonly bundle: string; readonly skills: ReadonlyArray<string> }>> = {
  "improve-codebase-architecture": {
    bundle: "guide-optimize-architecture",
    skills: ["improve-codebase-architecture", "codebase-design"],
  },
}

/**
 * Downloads (or refreshes from cache) the managed bundles the selected skills
 * need, into `<cache>/run`, and returns that skill directory. The directory
 * persists so a harness launched in another pane or worktree can read it.
 */
export const ensureOptimizeSkills = async (
  runner: CommandRunner,
  skillIds: ReadonlyArray<string>,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> => {
  const needed = skillIds.flatMap((id) => optimizeManagedBundles[id] ?? [])
  if (needed.length === 0) return undefined
  const manager = env.TRELLAGE_GUIDE_SKILLS_MANAGER
  const catalog = env.TRELLAGE_GUIDE_SKILLS_CATALOG
  const cache = env.TRELLAGE_GUIDE_OPTIMIZE_SKILLS_CACHE
  if (!manager || !catalog || !cache || [manager, catalog, cache].some((file) => !path.isAbsolute(file)))
    throw new Error("Optimize skill runtime paths are missing. Run Optimize through trx guide.")
  const target = path.join(cache, "run")
  await mkdir(cache, { recursive: true })
  for (const { bundle, skills } of needed) {
    signal.throwIfAborted()
    await runner.run(
      bunExecutable(),
      bunArguments(manager, ["ensure", "--bundle", bundle, "--catalog", catalog, "--cache", cache, "--target", target]),
      { cwd: cache, signal, timeoutMs: 180_000, env: sourceEnvironment(env) },
    )
    for (const skill of skills) {
      const info = await lstat(path.join(target, skill, "SKILL.md"))
      if (!info.isFile()) throw new Error(`The managed ${skill} skill is missing. Run trx skills update and retry.`)
    }
  }
  return target
}
