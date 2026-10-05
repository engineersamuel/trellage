import { lstat, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bunArguments, bunExecutable, sourceEnvironment } from "@trellage/runtime"
import { readEngagementFile } from "./engagement-context.ts"
import type { CommandRunner } from "./guide-launch.ts"
import type { OptimizeSource } from "./guide-optimize-evidence.ts"

export const optimizeArchitectureSkill = "improve-codebase-architecture"
const skillNames = [optimizeArchitectureSkill, "codebase-design"] as const

const readManagedSkill = async (bundle: string, name: string): Promise<OptimizeSource> => {
  const content = await readEngagementFile(bundle, `${name}/SKILL.md`, 64_000)
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1]
  const names = [...(frontmatter ?? "").matchAll(/^name:[ \t]*(.+?)[ \t]*\r?$/gmu)]
  if (names.length !== 1 || ![name, `"${name}"`, `'${name}'`].includes(names[0]?.[1] ?? ""))
    throw new Error(`The managed ${name} skill has invalid metadata. Run trx skills update and retry.`)
  return { id: `@skill/${name}`, content }
}

export const loadOptimizeArchitecture = async (
  runner: CommandRunner,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlyArray<OptimizeSource>> => {
  const manager = env.TRELLAGE_GUIDE_SKILLS_MANAGER
  const catalog = env.TRELLAGE_GUIDE_SKILLS_CATALOG
  const cache = env.TRELLAGE_GUIDE_OPTIMIZE_SKILLS_CACHE
  if (!manager || !catalog || !cache || [manager, catalog, cache].some((file) => !path.isAbsolute(file)))
    throw new Error("Optimize skill runtime paths are missing. Reinstall trx before using the architecture reviewer.")
  for (const file of [manager, catalog]) {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("The Optimize skill manager and catalog must be regular files.")
  }
  signal.throwIfAborted()
  const stage = await mkdtemp(path.join(os.tmpdir(), "trx-optimize-skills-"))
  try {
    const bundle = path.join(stage, "bundle")
    await runner.run(
      bunExecutable(),
      bunArguments(manager, [
        "ensure",
        "--bundle",
        "guide-optimize-architecture",
        "--catalog",
        catalog,
        "--cache",
        cache,
        "--target",
        bundle,
      ]),
      {
        cwd: stage,
        signal,
        timeoutMs: 180_000,
        env: sourceEnvironment({ ...env, TMPDIR: stage, TEMP: stage, TMP: stage }),
      },
    )
    const sources: OptimizeSource[] = []
    for (const name of skillNames) {
      signal.throwIfAborted()
      sources.push(await readManagedSkill(bundle, name))
    }
    return sources
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
