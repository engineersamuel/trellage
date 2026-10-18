import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { readTrellageConfig } from "../../packages/trellage-runtime/src/native-config.ts"
import { nativePresetProfiles, nativePresetProfile } from "../../packages/trellage-runtime/src/native-run/presets.ts"

// Only external source bytes are fixtures. The launcher still loads shipped
// presets and resolves their selections through its real Git transport.
const [home, ...harnesses] = process.argv.slice(2)
if (!home || harnesses.length === 0) throw new Error("usage: native-preset-sources.ts HOME HARNESS [HARNESS...]")
const { config } = await readTrellageConfig({
  environment: { TRELLAGE_CONFIG: path.resolve(import.meta.dir, "../../config.example.toml") },
})
const selections = new Map<string, Set<string>>()
for (const harness of harnesses) {
  for (const name of nativePresetProfiles(harness)) {
    const profile = config.native.profiles[nativePresetProfile(harness, name)!]!
    if (profile.plugins.length) throw new Error(`plugin fixtures not implemented for ${harness}/${name}`)
    for (const selection of profile.skills) {
      const names = selections.get(selection.source) ?? new Set<string>()
      for (const skill of selection.names) {
        if (skill === "*") throw new Error(`wildcard fixture needs explicit members: ${selection.source}`)
        names.add(skill)
      }
      selections.set(selection.source, names)
    }
  }
}
for (const [id, names] of selections) {
  const source = config.native.sources[id]!
  if (source.commit) throw new Error(`commit-pinned fixture needs an explicit transport: ${id}`)
  const directory = path.join(home, "native-preset-sources", id)
  for (const name of [...names, ...(source.required ?? [])]) {
    const skill = path.join(directory, "skills", name)
    mkdirSync(skill, { recursive: true })
    writeFileSync(path.join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: Offline contract fixture\n---\n# ${name}\n`)
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" })
  git("init", "-q")
  git("add", ".")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Offline preset source")
  if (source.tag) git("tag", source.tag)
  execFileSync("git", ["config", "--file", path.join(home, ".gitconfig"),
    `url.file://${directory}.insteadOf`, `https://github.com/${source.repository}.git`])
}
