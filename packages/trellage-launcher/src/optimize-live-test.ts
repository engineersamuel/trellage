import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { resolveGuideModelRouting } from "./guide-api.ts"
import { createNodeCommandRunner } from "./guide-launch.ts"
import { ensureOptimizeSkills } from "./guide-optimize-skills.ts"
import { buildGuideOptimizePrompt, runGuideOptimizeSdk, selectGuideOptimizeSkills } from "./guide-optimize.ts"

const usage = "mise run trx-optimize-test -- --live [--skill ID ...] [--timeout-seconds N]"

const fixtureCss = `.card { display: flex; margin-left: 16px; padding-right: 8px; }
.card > .title { flex: 1; white-space: nowrap; overflow: hidden; }
.button:focus { outline: none; }
.panel { transition: transform 300ms; }
@media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
@media (min-width: 601px) and (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } }
@media (min-width: 901px) { .grid { grid-template-columns: 1fr 1fr 1fr; } }
`
const fixtureHtml = `<!doctype html><link rel="stylesheet" href="styles.css">
<div class="grid"><div class="card"><span class="title">A long card title</span><button class="button">Open</button></div></div>
`

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

/** Real Copilot SDK run on a throwaway repository; checks that the agent edits it and leaves it uncommitted. */
const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      skill: { type: "string", multiple: true },
      "timeout-seconds": { type: "string", default: "900" },
    },
  })
  if (!values.live) {
    process.stderr.write(`Live Copilot SDK calls consume quota. Pass --live to consent.\n${usage}\n`)
    return 2
  }
  const skillIds = values.skill?.length ? values.skill : ["ui-css", "improve-codebase-architecture"]
  const skills = selectGuideOptimizeSkills(skillIds)
  const root = await mkdtemp(path.join(os.tmpdir(), "trx-optimize-live-"))
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "optimize@example.invalid")
  git(root, "config", "user.name", "Optimize")
  await writeFile(path.join(root, "styles.css"), fixtureCss)
  await writeFile(path.join(root, "index.html"), fixtureHtml)
  git(root, "add", ".")
  git(root, "commit", "-qm", "Fixture baseline")
  const head = git(root, "rev-parse", "HEAD").trim()

  const repo = fileURLToPath(new URL("../../../", import.meta.url))
  const env = {
    ...process.env,
    TRELLAGE_GUIDE_SKILLS_MANAGER: path.join(repo, "scripts/floating-skills.ts"),
    TRELLAGE_GUIDE_SKILLS_CATALOG: path.join(repo, "config.example.toml"),
    TRELLAGE_GUIDE_OPTIMIZE_SKILLS_CACHE: path.join(os.homedir(), ".local/share/trellage/common/guide-optimize-architecture-skills"),
  }
  const signal = AbortSignal.timeout(Number(values["timeout-seconds"]) * 1000)
  process.stderr.write(`Repository: ${root}\nSkills: ${skills.map((skill) => skill.id).join(", ")}\n`)
  const skillDirectory = await ensureOptimizeSkills(createNodeCommandRunner(), skillIds, signal, env)
  if (skillDirectory !== undefined) process.stderr.write(`Managed skills: ${skillDirectory}\n`)
  const model = resolveGuideModelRouting({}, process.env).optimize
  const toolCalls = new Set<string>()
  await runGuideOptimizeSdk({
    cwd: root, prompt: buildGuideOptimizePrompt(skills, skillDirectory), skillDirectory, model, signal,
    onActivity: (entry) => {
      if (entry.kind === "assistant" && entry.append) return
      if (entry.kind === "tool") {
        if (toolCalls.has(entry.id)) return
        toolCalls.add(entry.id)
      }
      const text = entry.kind === "tool" ? `Tool: ${entry.text}` : entry.text
      process.stderr.write(`${text.split("\n")[0]}\n`)
    },
  })

  const failures: string[] = []
  const changed = git(root, "status", "--porcelain").trim()
  if (!changed) failures.push("The agent changed no files.")
  if (git(root, "rev-parse", "HEAD").trim() !== head) failures.push("The agent committed; Optimize must not commit.")
  if (toolCalls.size === 0) failures.push("No tool use was observed.")
  const css = await readFile(path.join(root, "styles.css"), "utf8")
  if (skillIds.includes("ui-css") && css.includes("outline: none") && !css.includes("focus-visible"))
    failures.push("The UI and CSS skill left the removed focus outline unchanged.")
  const result = { passed: failures.length === 0, failures, repository: root, model, skills: skillIds, skillDirectory: skillDirectory ?? null,
    changedFiles: changed.split("\n").filter(Boolean), toolCalls: toolCalls.size }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.passed ? 0 : 1
}

if (import.meta.main) process.exitCode = await main()
