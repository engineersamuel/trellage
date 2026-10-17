import { execFile } from "node:child_process"
import { lstat, mkdir } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { NativeRunError } from "./paths.ts"

const execFileAsync = promisify(execFile)

export interface ProfileRepository {
  readonly url: string
  readonly branch: string
}

const git = async (args: ReadonlyArray<string>, cwd: string, environment: NodeJS.ProcessEnv): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
    })
    return stdout.trim()
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message
    throw new NativeRunError("launch", `git ${args[0]} failed in ${cwd}: ${detail}`)
  }
}

const exists = async (candidate: string): Promise<boolean> => {
  try {
    await lstat(candidate)
    return true
  } catch {
    return false
  }
}

/** Clone the profile repository when missing, otherwise rebase it onto the latest remote branch. */
export const syncProfileRepository = async (
  directory: string,
  repository: ProfileRepository,
  environment: NodeJS.ProcessEnv,
): Promise<void> => {
  if (!(await exists(directory))) {
    await mkdir(path.dirname(directory), { recursive: true })
    await git(["clone", "--branch", repository.branch, "--", repository.url, directory], path.dirname(directory), environment)
    return
  }
  const origin = await git(["remote", "get-url", "origin"], directory, environment)
  if (origin !== repository.url)
    throw new NativeRunError(
      "launch",
      `${directory} has origin ${origin}, expected ${repository.url}; move it away or fix the profile`,
    )
  await git(["pull", "--rebase", "origin", repository.branch], directory, environment)
}
