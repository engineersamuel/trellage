import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { NativeCatalog } from "@trellage/runtime/native-config"
import type { RunOptions } from "@trellage/runtime/native-run"

interface Manifest {
  harness: string
  profiles: string[]
  alwaysProfiles: string[]
  instructions: string[]
  skills: { name: string; sourceId: string; commit: string; digest: string }[]
  plugins: { name: string }[]
}

export const assertRunSelection = async (
  options: RunOptions,
  catalog: NativeCatalog,
  generation: string,
  mappings: string,
  id: string,
) => {
  const manifest = JSON.parse(await readFile(path.join(generation, "manifest.json"), "utf8")) as Manifest
  const clean = options.profiles.includes("clean")
  const profiles = new Set(
    options.profiles.map((name) =>
      Object.hasOwn(catalog.profiles, name)
        ? name
        : Object.hasOwn(catalog.profiles, `preset-${options.harness}-${name}`)
          ? `preset-${options.harness}-${name}`
          : name,
    ),
  )
  const sources = new Map(
    mappings.split(/\s+/u).map((mapping) => {
      const equal = mapping.indexOf("=")
      return [mapping.slice(0, equal), mapping.slice(equal + 1)]
    }),
  )
  const declarations = { ...catalog.profiles }
  const sourceCatalog = { ...catalog.sources }
  if (options.skills?.length) {
    const repositories = new Map<string, Set<string>>()
    for (const selector of options.skills) {
      const [repository, name] = selector.toLowerCase().split(":") as [string, string]
      const names = repositories.get(repository) ?? new Set<string>()
      names.add(name)
      repositories.set(repository, names)
    }
    const selections = [...repositories]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([repository, names]) => {
        const configured = Object.entries(sourceCatalog).find(([, source]) => source.repository === repository)?.[0]
        const source = configured ?? `adhoc-${repository.replace(/[^a-z0-9]+/gu, "-")}`
        if (!configured) sourceCatalog[source] = { repository }
        return { source, names: [...names] }
      })
    const name = `adhoc-${createHash("sha256").update(JSON.stringify(selections)).digest("hex").slice(0, 12)}`
    declarations[name] = { always: false, instructions: [], plugins: [], skills: selections }
    profiles.add(name)
  }
  const always =
    clean || options.noAlways
      ? []
      : Object.entries(catalog.profiles)
          .filter(
            ([, profile]) => profile.always && (!profile.harnesses || profile.harnesses.includes(options.harness)),
          )
          .map(([name]) => name)
          .sort()
  assert.equal(manifest.harness, options.harness, id)
  assert.deepEqual(manifest.profiles, clean ? ["clean"] : [...profiles].sort(), id)
  assert.deepEqual(manifest.alwaysProfiles, always, id)
  const skills = new Map<string, Set<string>>(),
    plugins = new Set<string>(),
    instructions = new Set<string>()
  for (const name of clean ? [] : [...new Set([...profiles, ...always])].sort()) {
    const profile = declarations[name]!
    for (const instruction of profile.instructions) instructions.add(instruction)
    for (const selection of profile.skills) {
      const source = sourceCatalog[selection.source]!
      const names = selection.names.includes("*")
        ? (await readdir(path.join(sources.get(`https://github.com/${source.repository}.git`)!, "skills"))).filter(
            (skill) => !source.exclude?.includes(skill),
          )
        : selection.names
      for (const skill of names) {
        const owners = skills.get(skill) ?? new Set<string>()
        owners.add(selection.source)
        skills.set(skill, owners)
        if (source.alwaysOn && skill !== "i-have-adhd") instructions.add(`skill-${skill}`)
      }
    }
    for (const plugin of profile.plugins)
      if (plugin.harness === options.harness)
        plugins.add(plugin.name ?? path.basename(plugin.path === "." ? plugin.source : plugin.path).toLowerCase())
  }
  assert.deepEqual(
    manifest.skills.map((skill) => skill.name),
    [...skills.keys()].sort(),
    id,
  )
  assert.deepEqual(manifest.plugins.map((plugin) => plugin.name).sort(), [...plugins].sort(), id)
  assert.deepEqual([...manifest.instructions].sort(), [...instructions].sort(), id)
  for (const skill of manifest.skills) {
    assert(skills.get(skill.name)!.has(skill.sourceId), `${id}: unexpected skill owner`)
    assert.match(skill.commit, /^[0-9a-f]{40}$/u, id)
    assert.match(skill.digest, /^[0-9a-f]{64}$/u, id)
  }
  return manifest
}
