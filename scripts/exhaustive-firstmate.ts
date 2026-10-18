import assert from "node:assert/strict"
import { constants } from "node:fs"
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { RunDependencies } from "@trellage/runtime/native-run"

/** Replace repository transport and missing prerequisite tools inside an owned test world. */
export const createFirstmateFixture = async (root: string, environment: NodeJS.ProcessEnv) => {
  assert.equal(environment.TRELLAGE_TEST_OFFLINE, "1")
  assert.equal(environment.HOME, path.join(root, "home"))
  const bin = path.join(root, "bin")
  assert.equal(environment.PATH?.split(path.delimiter)[0], bin)
  const directory = path.join(environment.HOME, ".local/share/trellage/firstmate")
  const repository = { url: "https://github.com/kunchenguid/firstmate.git", branch: "main" }
  const stubs: string[] = []
  for (const command of ["git", "gh", "jq", "node", "treehouse", "gh-axi", "tasks-axi"]) {
    const available = await Promise.all(
      environment.PATH!.split(path.delimiter).map(async (entry) => {
        try {
          await access(path.join(entry, command), constants.X_OK)
          return true
        } catch (error) {
          if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false
          throw error
        }
      }),
    )
    if (available.some(Boolean)) continue
    const executable = path.join(bin, command)
    await writeFile(executable, '#!/bin/sh\necho "Unexpected Firstmate prerequisite execution" >&2\nexit 97\n', {
      mode: 0o700,
      flag: "wx",
    })
    stubs.push(executable)
  }
  const calls: string[] = []
  const syncRepository: NonNullable<RunDependencies["syncRepository"]> = async (requested, source, env) => {
    assert.equal(requested, directory)
    assert.deepEqual(source, repository)
    assert.equal(env.HOME, environment.HOME)
    assert.equal(env.TRELLAGE_TEST_OFFLINE, "1")
    calls.push(requested)
    await mkdir(directory, { recursive: true })
  }
  return { directory, repository, stubs, calls, syncRepository }
}
