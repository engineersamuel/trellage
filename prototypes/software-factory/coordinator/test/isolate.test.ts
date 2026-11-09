import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isolatedLauncher } from "../src/isolate.ts"

test("the launcher runs the binary in its own process group with its arguments and exit code", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-iso-"))
  const launcher = isolatedLauncher(dir, "/bin/sh")
  // A new session leader leads its own process group: pgid == pid, unlike the caller's group.
  const r = spawnSync(launcher, ["-c", 'test "$(ps -o pgid= -p $$ | tr -d " ")" = "$$" && echo own-group; exit 7'], { encoding: "utf8" })
  expect(r.stdout.trim()).toBe("own-group")
  expect(r.status).toBe(7)
})
