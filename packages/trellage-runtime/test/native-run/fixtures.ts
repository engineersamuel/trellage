import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { NativeRunPaths } from "../../src/native-run/paths.ts"

const execFilePromise = promisify(execFile)
const roots: string[] = []

export const cleanupFixtures = async (): Promise<void> => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
}

export const tempRoot = async (label: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir().replace(/\/$/, ""), `trellage-${label}-`))
  roots.push(root)
  return root
}

export const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (
    await execFilePromise("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd,
      encoding: "utf8",
    })
  ).stdout.trim()

export interface SourceRepo {
  readonly directory: string
  readonly commit: () => Promise<string>
  readonly write: (files: Record<string, string>, message?: string) => Promise<string>
}

/** Local Git repository standing in for a GitHub source. */
export const createSourceRepo = async (root: string, name: string): Promise<SourceRepo> => {
  const directory = path.join(root, "remotes", name)
  await mkdir(directory, { recursive: true })
  await git(directory, "init", "-q", "-b", "main")
  await git(directory, "config", "uploadpack.allowAnySHA1InWant", "true")
  const write = async (files: Record<string, string>, message = "update"): Promise<string> => {
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, relative)), { recursive: true })
      await writeFile(path.join(directory, relative), content)
    }
    await git(directory, "add", "-A")
    await git(directory, "commit", "-q", "-m", message)
    return git(directory, "rev-parse", "HEAD")
  }
  return { directory, commit: () => git(directory, "rev-parse", "HEAD"), write }
}

export const skillMarkdown = (name: string, body = "body"): string =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`

export const fixturePaths = async (root: string): Promise<NativeRunPaths> => ({
  cache: path.join(root, "cache"),
  data: path.join(root, "data"),
  state: path.join(root, "state"),
})
