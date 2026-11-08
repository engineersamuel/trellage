import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { servableImage } from "../src/files.ts"

test("images only, only under the allowed roots, symlinks resolved", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-files-"))
  const out = mkdtempSync(path.join(tmpdir(), "sf-out-"))
  writeFileSync(path.join(root, "a.png"), "x")
  writeFileSync(path.join(root, "notes.txt"), "x")
  writeFileSync(path.join(out, "secret.png"), "x")
  symlinkSync(path.join(out, "secret.png"), path.join(root, "link.png"))
  mkdirSync(path.join(root, "sub"))
  expect(servableImage(path.join(root, "a.png"), [root])).toMatchObject({ type: "image/png" })
  expect(servableImage(path.join(root, "notes.txt"), [root])).toEqual({ error: "not an image file" })
  expect(servableImage(path.join(out, "secret.png"), [root])).toEqual({ error: "outside the factory folders" })
  expect(servableImage(path.join(root, "link.png"), [root])).toEqual({ error: "outside the factory folders" })
  expect(servableImage(path.join(root, "sub", "..", "..", path.basename(out), "secret.png"), [root])).toEqual({ error: "outside the factory folders" })
  expect(servableImage(path.join(root, "none.png"), [root])).toEqual({ error: "no such file" })
})
