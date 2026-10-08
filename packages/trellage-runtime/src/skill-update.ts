import { lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { parse } from "smol-toml"
import { parseCatalog } from "./skill-config.ts"
import { digestDirectory } from "./native-run/source.ts"
import { parseTrellageConfig, type NativeSource } from "./native-config.ts"
import {
  createSourceResolver,
  gitSourceTransport,
  type ResolvedSource,
  type SourceTransport,
} from "./native-run/source.ts"
import { discoverSkillNames, findSkill } from "./native-run/compose.ts"
import { NativeRunError, resolveNativeRunPaths, type NativeRunPaths } from "./native-run/paths.ts"

export interface SkillUpdateResult {
  readonly source: string
  readonly profiles: readonly string[]
  readonly oldSelector: string
  readonly newSelector: string
  readonly commit?: string
  readonly candidateCommit?: string
}
export interface SkillUpdateOptions {
  readonly configPath: string
  readonly paths?: NativeRunPaths
  readonly transport?: SourceTransport
  readonly check?: boolean
  readonly upgradePins?: boolean
  readonly validate?: (source: ResolvedSource) => Promise<void>
}
const selector = (source: NativeSource): string => source.commit ?? source.tag ?? "HEAD"
const stableTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const newestStableTag = (tags: readonly string[]): string => {
  const versions = tags
    .filter((tag) => stableTag.test(tag))
    .map((tag) => ({ tag, parts: tag.replace(/^v/, "").split(".").map(Number) }))
  versions.sort((a, b) => b.parts[0]! - a.parts[0]! || b.parts[1]! - a.parts[1]! || b.parts[2]! - a.parts[2]!)
  const first = versions[0]
  if (!first || (versions[1] && first.parts.join(".") === versions[1].parts.join("."))) {
    throw new NativeRunError("config", "tag upgrade is ambiguous; choose an explicit new tag or commit in config.toml")
  }
  return first.tag
}

const replacePin = (text: string, section: string, key: string, oldValue: string, newValue: string): string => {
  const lines = text.split("\n")
  let active = false
  let changed = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (header) active = header[1]!.replace(/["']/g, "") === section
    if (!active) continue
    const field = new RegExp(`^(\\s*${key}\\s*=\\s*)(["'])([^"']*)\\2(\\s*(?:#.*)?)$`).exec(line)
    if (field?.[3] === oldValue) {
      lines[index] = `${field[1]}${field[2]}${newValue}${field[2]}${field[4]}`
      changed = true
    }
  }
  if (!changed)
    throw new NativeRunError("config", `cannot safely edit ${section}.${key}; use a table with a single-line pin`)
  return lines.join("\n")
}

export const updateSkills = async (options: SkillUpdateOptions): Promise<SkillUpdateResult[]> => {
  if (options.check && options.upgradePins)
    throw new NativeRunError("usage", "--check and --upgrade-pins are mutually exclusive")
  const original = await readFile(options.configPath, "utf8")
  const info = await lstat(options.configPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new NativeRunError("unsafe-path", "config must be a regular file")
  const config = await Effect.runPromise(parseTrellageConfig(original))
  const raw = parse(original)
  const sharedCatalog = raw.skills ? parseCatalog(original) : undefined
  const shared = (raw.skills as { sources?: Record<string, unknown> } | undefined)?.sources ?? {}
  const transport = options.transport ?? gitSourceTransport()
  const paths = options.paths ?? resolveNativeRunPaths()
  const resolver = createSourceResolver({ paths, transport })
  const receipts = await readFile(path.join(paths.state, "receipts.json"), "utf8")
    .then(
      (text) => JSON.parse(text) as { pins?: Record<string, string>; floating?: Record<string, { commit: string }> },
    )
    .catch(() => ({}) as { pins?: Record<string, string>; floating?: Record<string, { commit: string }> })
  const results: SkillUpdateResult[] = []
  const validated: ResolvedSource[] = []
  let replacement = original
  for (const [id, source] of Object.entries(config.native.sources)) {
    const profiles = Object.entries(config.native.profiles)
      .filter(([, profile]) => [...profile.skills, ...profile.plugins].some((item) => item.source === id))
      .map(([name]) => name)
    profiles.push(
      ...Object.entries(sharedCatalog?.bundles ?? {})
        .filter(([, ids]) => ids.includes(id))
        .map(([name]) => `bundle:${name}`),
    )
    let desired = source
    let candidateCommit: string | undefined
    if (options.check || (options.upgradePins && (source.commit || source.tag))) {
      if (source.tag) {
        if (!transport.listTags)
          throw new NativeRunError(
            "config",
            `cannot determine stable tags for ${id}; select an explicit tag in config.toml`,
          )
        const tag = newestStableTag(await transport.listTags(source.repository))
        candidateCommit = await transport.resolveRef(source.repository, tag)
        desired = { ...source, tag }
      } else {
        candidateCommit = await transport.resolveRef(source.repository, "HEAD")
        if (source.commit) desired = { ...source, commit: candidateCommit }
      }
    }
    if (options.check) {
      const currentCommit =
        source.commit ??
        (source.tag
          ? receipts.pins?.[`${source.repository}|tag|${source.tag}`]
          : receipts.floating?.[source.repository]?.commit)
      results.push({
        source: id,
        profiles,
        oldSelector: selector(source),
        newSelector: selector(desired),
        ...(currentCommit ? { commit: currentCommit } : {}),
        ...(candidateCommit ? { candidateCommit } : {}),
      })
      continue
    }
    const resolved = await resolver.resolve(id, desired)
    if (resolved.warning) throw new NativeRunError("source-unavailable", resolved.warning)
    for (const profile of Object.values(config.native.profiles)) {
      for (const selection of profile.skills.filter((item) => item.source === id)) {
        for (const name of selection.names) {
          if (name !== "*" && !(await findSkill(resolved.directory, name)))
            throw new NativeRunError("skill-not-found", `skill ${name} missing from replacement ${id}`)
        }
      }
    }
    const sharedPolicy = sharedCatalog?.sources[id]
    if (sharedPolicy) {
      const selected = sharedPolicy.select.includes("*")
        ? (await discoverSkillNames(resolved.directory)).filter((name) => !sharedPolicy.exclude.includes(name))
        : sharedPolicy.select
      for (const required of sharedPolicy.required)
        if (!selected.includes(required))
          throw new NativeRunError("skill-not-found", `required skill ${required} missing from replacement ${id}`)
      for (const name of selected) {
        const directory = await findSkill(resolved.directory, name)
        if (!directory) throw new NativeRunError("skill-not-found", `skill ${name} missing from replacement ${id}`)
        await digestDirectory(directory)
      }
    }
    await options.validate?.(resolved)
    validated.push(resolved)
    if (selector(desired) !== selector(source)) {
      replacement = replacePin(
        replacement,
        `${Object.hasOwn(shared, id) ? "skills" : "native"}.sources.${id}`,
        source.commit ? "commit" : "tag",
        selector(source),
        selector(desired),
      )
    }
    results.push({
      source: id,
      profiles,
      oldSelector: selector(source),
      newSelector: selector(desired),
      commit: resolved.commit,
      ...(candidateCommit ? { candidateCommit } : {}),
    })
  }
  if (replacement !== original) {
    const lock = `${options.configPath}.upgrade.lock`
    const handle = await open(lock, "wx", 0o600)
    const temporary = path.join(
      path.dirname(options.configPath),
      `.config-upgrade-${process.pid}-${crypto.randomUUID()}.toml`,
    )
    try {
      if ((await readFile(options.configPath, "utf8")) !== original)
        throw new NativeRunError("conflict", "config changed during skill upgrade; retry with the new configuration")
      await writeFile(temporary, replacement, { mode: info.mode & 0o777 })
      await rename(temporary, options.configPath)
    } finally {
      await handle.close()
      await rm(temporary, { force: true })
      await rm(lock, { force: true })
    }
  }
  for (const source of validated) await resolver.markGood(source)
  return results
}
