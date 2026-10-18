import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHostAdmission } from "./exhaustive-host-admission.ts"

test("Headlong initializer mock refuses model arguments and missing isolation switches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-host-admission-"))
  try {
    const fixture = await createHostAdmission(root)
    for (const args of [["chat", "fixture prompt"], ["--help"], ["start"]]) {
      const result = spawnSync(fixture.executable, args, { env: fixture.required, encoding: "utf8" })
      expect(result.status).toBe(97)
      expect(result.stdout).toBe("")
    }
    for (const key of Object.keys(fixture.required)) {
      const environment: NodeJS.ProcessEnv = { ...fixture.required }
      delete environment[key]
      const result = spawnSync(fixture.executable, [], { env: environment, encoding: "utf8" })
      expect(result.status).toBe(97)
      expect(result.stdout).toBe("")
    }
    expect(await fixture.calls()).toEqual([])
    const result = spawnSync(fixture.executable, [], { env: fixture.required, encoding: "utf8" })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(await fixture.calls()).toEqual([{ operation: "initialize", args: [] }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
