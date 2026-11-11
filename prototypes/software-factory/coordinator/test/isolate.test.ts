import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { reapRuntimes, recordRuntime } from "../src/isolate.ts"

test("startup cleanup stops only the recorded runtimes of its own state folder that still run the runtime", () => {
  const mine = mkdtempSync(path.join(tmpdir(), "sf-i-"))
  const other = mkdtempSync(path.join(tmpdir(), "sf-i-"))
  recordRuntime(mine, 999_991) // still a runtime, but its kill fails (no such pid)
  recordRuntime(mine, 999_992) // pid reused by another program
  recordRuntime(mine, 999_993) // gone
  recordRuntime(other, 999_994)
  const seen: number[] = []
  const command = (pid: number) => {
    seen.push(pid)
    return pid === 999_991 ? "/x/copilot-runtime --port 0" : pid === 999_992 ? "vim" : null
  }
  expect(reapRuntimes(mine, command)).toEqual([])
  expect(seen).toEqual([999_991, 999_992, 999_993])
  expect(readFileSync(path.join(mine, "runtime.pids"), "utf8")).toBe("")
  expect(readFileSync(path.join(other, "runtime.pids"), "utf8")).toBe("999994\n")
})

test("startup cleanup kills a live recorded runtime", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-i-"))
  const child = Bun.spawn(["sleep", "30"])
  recordRuntime(root, child.pid)
  expect(reapRuntimes(root, () => "copilot-runtime")).toEqual([child.pid])
  expect(await child.exited).not.toBe(0)
})
