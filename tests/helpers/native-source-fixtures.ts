import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { readCatalog } from "@trellage/runtime/skill-config"

const destination = process.argv[2]
if (!destination || !path.isAbsolute(destination) || /\s/.test(destination)) {
  throw new Error("Native source fixtures need an absolute destination without whitespace")
}
const configPath = fileURLToPath(new URL("../../config.toml", import.meta.url))
const config = await readTrellageConfig({ environment: { TRELLAGE_CONFIG: configPath } })
const declaredUrls = [...readFileSync(configPath, "utf8").matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)]
  .map(([url]) => url.replace(/\.git$/, ""))
const repositories = new Map<string, Map<string, string>>()
const filesFor = (source: string): Map<string, string> => {
  const repository = config.config.native.sources[source]!.repository
  let files = repositories.get(repository)
  if (!files) {
    files = new Map()
    repositories.set(repository, files)
  }
  return files
}
const skill = (files: Map<string, string>, name: string): void => {
  files.set(`skills/${name}/SKILL.md`, [
    "---", `name: ${name}`, `description: Offline fixture for ${name}`,
    ...(name === "i-have-adhd" ? ["disable-model-invocation: true"] : []),
    "---", `Deterministic test fixture for ${name}.`, "",
  ].join("\n"))
}
for (const [id, source] of Object.entries(config.config.native.sources)) {
  for (const name of source.required ?? []) skill(filesFor(id), name)
}
const catalog = await readCatalog(configPath)
for (const [id, source] of Object.entries(catalog.sources)) {
  for (const name of [...source.select, ...source.required]) {
    skill(filesFor(id), name === "*" ? "fixture-personal" : name)
  }
}
for (const profile of Object.values(config.config.native.profiles)) {
  for (const selection of profile.skills) {
    const files = filesFor(selection.source)
    for (const name of selection.names) {
      if (name === "*") skill(files, "fixture-personal")
      else skill(files, name)
    }
  }
  for (const selection of profile.plugins) {
    const files = filesFor(selection.source)
    const name = selection.plugin ?? selection.name ?? selection.source
    files.set(path.join(selection.path, ".claude-plugin/plugin.json"), JSON.stringify({ name, version: "1.0.0" }))
  }
}
// Open-ended --skill domains use these owned repositories, never GitHub transport.
for (const [repository, names] of [["a/b", ["c", "d"]], ["owner/repository", ["skill-name"]]] as const) {
  const files = new Map<string, string>()
  for (const name of names) skill(files, name)
  repositories.set(repository, files)
}
const overrides: string[] = []
const transportConfig: string[] = []
for (const [repository, files] of repositories) {
  const directory = path.join(destination, repository)
  mkdirSync(directory, { recursive: true })
  for (const [relative, content] of files) {
    const file = path.join(directory, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: directory, stdio: "pipe",
      env: {
        ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@trellage.invalid",
        GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@trellage.invalid",
        GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000",
      },
    })
  }
  git("init", "-q", "-b", "main")
  git("add", ".")
  git("commit", "-q", "-m", "offline fixture")
  for (const source of Object.values(config.config.native.sources)) {
    if (source.repository === repository && source.tag) git("tag", "-f", source.tag)
  }
  overrides.push(`https://github.com/${repository}.git=${directory}`)
  const urls = new Set([
    `https://github.com/${repository}`,
    ...declaredUrls.filter((url) => url.toLowerCase() === `https://github.com/${repository}`),
  ])
  transportConfig.push(`[url "file://${directory}"]`)
  for (const url of urls) transportConfig.push(`\tinsteadOf = ${url}.git`, `\tinsteadOf = ${url}`)
}
writeFileSync(path.join(destination, "gitconfig"), transportConfig.join("\n") + "\n")
process.stdout.write(overrides.join(" "))
