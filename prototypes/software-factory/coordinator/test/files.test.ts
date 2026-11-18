import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { peekFile, servableImage } from "../src/files.ts"

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
  expect(servableImage(path.join(root, "sub", "..", "..", path.basename(out), "secret.png"), [root])).toEqual({
    error: "outside the factory folders",
  })
  expect(servableImage(path.join(root, "none.png"), [root])).toEqual({ error: "no such file" })
})

test("peekFile: text, folder, image and binary under the roots; :line dropped; outside refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-peek-"))
  const out = mkdtempSync(path.join(tmpdir(), "sf-peek-out-"))
  writeFileSync(path.join(root, "design.md"), "# Design")
  writeFileSync(path.join(root, "a.png"), "x")
  writeFileSync(path.join(root, "blob.bin"), Buffer.from([1, 0, 2]))
  mkdirSync(path.join(root, "sub"))
  writeFileSync(path.join(out, "secret.md"), "no")
  const md = path.join(root, "design.md")
  expect(peekFile(md, [root], false)).toMatchObject({ kind: "text", size: 8 })
  expect(peekFile(`${md}:3:1`, [root], true)).toMatchObject({ kind: "text", text: "# Design", truncated: false })
  expect(peekFile(root, [root], true)).toMatchObject({
    kind: "dir",
    entries: ["a.png", "blob.bin", "design.md", "sub/"],
  })
  expect(peekFile(path.join(root, "a.png"), [root], true)).toMatchObject({ kind: "image" })
  expect(peekFile(path.join(root, "blob.bin"), [root], true)).toMatchObject({ kind: "binary" })
  expect(peekFile(path.join(out, "secret.md"), [root], true)).toEqual({ error: "outside the factory folders" })
  expect(peekFile("design.md", [root], true)).toEqual({ error: "not an absolute path" })
  expect(peekFile(path.join(root, "none.md"), [root], true)).toEqual({ error: "no such file" })
})
