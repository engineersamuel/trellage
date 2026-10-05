import { execFile, spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { parseProfileGuide } from "@trellage/guide-core"
import { FixtureMode, fixtureProfile, guideSource } from "./guide-integration-data.ts"

const root = process.argv[2]
const hostPath = process.env.TRELLAGE_TEST_HOST_PATH
if (root === undefined || hostPath === undefined)
  throw new Error("The direct Optimize fixture requires its root and host tool path.")
const bin = path.join(root, "bin")
await mkdir(bin)
const marker = path.join(root, "model-started")
for (const name of ["copilot", "herdr"]) {
  const executable = path.join(bin, name)
  await writeFile(
    executable,
    `#!${bunExecutable()}\nimport { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unexpected ${name} call"); process.exit(90)\n`,
  )
  await chmod(executable, 0o700)
}
const env = {
  HOME: path.join(root, "home"),
  XDG_CONFIG_HOME: path.join(root, "home"),
  XDG_CACHE_HOME: path.join(root, "home"),
  PATH: `${bin}${path.delimiter}${hostPath}`,
  TMPDIR: path.join(root, "tmp"),
  TERM: "xterm-256color",
  FORCE_COLOR: "1",
  CI: "true",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  ...(process.argv[3] !== FixtureMode.Herdr
    ? {}
    : {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_PANE_ID: "w1:missing-session",
        HERDR_SOCKET_PATH: path.join(root, "tmp", "unavailable-herdr.sock"),
      }),
}
const git = async (...args: string[]) => promisify(execFile)("git", args, { cwd: root, env })
await git("init", "--quiet", "-b", "main")
await writeFile(
  path.join(root, ".gitignore"),
  "bin/\nhome/\ntmp/\ncatalog.json\nevents.jsonl\nresult.json\nmodel-started\nignored.txt\n",
)
await writeFile(path.join(root, "code.ts"), "before\n")
await writeFile(path.join(root, "dirty.ts"), "before\n")
await git("add", ".gitignore", "code.ts", "dirty.ts")
await git("config", "user.name", "Fixture")
await git("config", "user.email", "fixture@example.invalid")
await git("config", "commit.gpgsign", "false")
await git("config", "core.hooksPath", "/dev/null")
await git("commit", "--quiet", "-m", "Fixture baseline")
await git("branch", "base")
await git("switch", "--quiet", "-c", "task")
await writeFile(path.join(root, "code.ts"), "committed change\n")
await git("commit", "--quiet", "-am", "Committed task work")
await writeFile(path.join(root, "dirty.ts"), "staged change\n")
await git("add", "dirty.ts")
await writeFile(path.join(root, "dirty.ts"), "unstaged change\n")
await writeFile(path.join(root, "notes.txt"), "Explicitly selected new work\n")
await writeFile(path.join(root, "ignored.txt"), "Not part of the review\n")
await symlink("code.ts", path.join(root, "linked.ts"))
const catalogPath = path.join(root, "catalog.json")
await writeFile(
  catalogPath,
  JSON.stringify({
    schemaVersion: 1,
    sandboxCommandPath: path.join(bin, "trellage"),
    sandbox: [],
    native: [
      {
        launcher: "cpx",
        name: "reviewer",
        harness: "copilot",
        description: "Fixture reviewer",
        commandPath: path.join(bin, "cpx"),
        sandbox: false,
        herdrCompatibility: { status: "supported" },
        guide: parseProfileGuide("native/cpx/reviewer.md", guideSource(fixtureProfile("reviewer"))).guide,
        headless: {
          schemaVersion: 1,
          prompt: true,
          outputFormats: ["json"],
          eventContract: null,
          trellageEventContract: null,
          sessionId: "native",
          resume: false,
          resumeWithPrompt: false,
          questionToolControl: "hard-deny",
          changedFiles: "native",
          usage: true,
          cost: true,
          modelOverride: false,
          effortOverride: false,
          testedHarnessVersion: null,
        },
      },
    ],
  }),
  { mode: 0o600 },
)
await writeFile(path.join(root, "events.jsonl"), "")
const descriptor = openSync(catalogPath, "r")
try {
  const base = process.env.TRELLAGE_TEST_OPTIMIZE_BASE
  const child = spawn(
    bunExecutable(),
    bunArguments(fileURLToPath(new URL("../../src/cli.tsx", import.meta.url)), [
      "guide",
      path.join(root, "unused-guides"),
      path.join(root, "missing-prompt-master"),
      "--optimize",
      ...(base === undefined ? [] : ["--base", base]),
      "--intent",
      "Preserve the original task without rewriting it.",
    ]),
    { cwd: root, env, stdio: ["inherit", "inherit", "inherit", descriptor] },
  )
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (status, signal) => {
      if (signal !== null) reject(new Error(`Direct Optimize stopped with ${signal}.`))
      else resolve(status ?? 1)
    })
  })
  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify({ result: { action: "cancel", exitCode: code }, events: [], writes: [] }),
  )
  process.exitCode = code
} finally {
  closeSync(descriptor)
}
