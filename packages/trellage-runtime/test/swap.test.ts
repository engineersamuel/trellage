import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { swapPaths } from "../src/swap.ts"

test("swapPaths exchanges two directories; a missing path is an error and changes nothing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "swap-"))
  const a = path.join(root, "a")
  const b = path.join(root, "b")
  mkdirSync(a)
  mkdirSync(b)
  writeFileSync(path.join(a, "id"), "old")
  writeFileSync(path.join(b, "id"), "new")
  swapPaths(b, a)
  expect([readFileSync(path.join(a, "id"), "utf8"), readFileSync(path.join(b, "id"), "utf8")]).toEqual(["new", "old"])
  expect(() => swapPaths(path.join(root, "missing"), a)).toThrow("atomic swap failed")
  expect(readFileSync(path.join(a, "id"), "utf8")).toBe("new")
})
