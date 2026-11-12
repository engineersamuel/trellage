import { afterEach, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { generateImage, IMAGE_DIR, imageTarget, imageTool } from "../src/images.ts"

const PNG = Buffer.from("89504e470d0a1a0a", "hex")

const PROXY = "http://proxy.test/v1"

/** A stub copilot-proxy-rs as a fetch stub (tests run offline): the router answers for type "image" only; the image
 *  route returns one PNG in the asked format. */
const stubProxy = (seen: { path: string; body: Record<string, unknown> }[]) =>
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: { body: string }) => {
    const pathname = new URL(url).pathname
    const body = JSON.parse(init.body) as Record<string, unknown>
    seen.push({ path: pathname, body })
    if (pathname === "/v1/models")
      return body.type === "image"
        ? Response.json({ type: "image", recommended: { id: "img-1" }, confidence: 0.9, ranking: [] })
        : Response.json({ error: "wrong type" }, { status: 400 })
    return Response.json({ data: [{ b64_json: PNG.toString("base64") }], output_format: body.output_format })
  }) as unknown as typeof fetch)

afterEach(() => (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.())

test("generate_image asks the router for an image model, then generates and saves the image", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = []
  stubProxy(seen)
  const dir = mkdtempSync(path.join(tmpdir(), "sf-img-"))
  {
    const r = await Effect.runPromise(generateImage(PROXY, dir, { prompt: "a gear icon", size: "999x1" }))
    expect(r.model).toBe("img-1")
    expect(r.path.startsWith(path.join(dir, IMAGE_DIR))).toBe(true)
    expect(readFileSync(r.path)).toEqual(PNG)
    expect(seen).toEqual([
      { path: "/v1/models", body: { input: "a gear icon", type: "image" } },
      // An unknown size falls back to the default.
      {
        path: "/v1/images/generations",
        body: { model: "img-1", prompt: "a gear icon", n: 1, size: "1024x1024", output_format: "png" },
      },
    ])
  }
})

test("generate_image saves to a named image path, asks for its format, and never replaces a file by accident", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = []
  stubProxy(seen)
  const dir = mkdtempSync(path.join(tmpdir(), "sf-img-"))
  const tool = imageTool(PROXY, dir)
  const call = async (args: Record<string, unknown>) =>
    JSON.parse(String(await tool.handler!(args, {} as never))) as Record<string, unknown>
  {
    expect((await call({ prompt: "x", path: "docs/logo.jpg" })).path).toBe(path.join(dir, "docs/logo.jpg"))
    expect(seen.at(-1)!.body.output_format).toBe("jpeg")
    const calls = seen.length
    // An existing file stays unless overwrite is true; refusals make no model call.
    expect((await call({ prompt: "x", path: "docs/logo.jpg" })).error).toContain("exists")
    expect(seen.length).toBe(calls)
    expect((await call({ prompt: "x", path: "docs/logo.jpg", overwrite: true })).path).toBeString()
  }
})

test("imageTarget refuses paths outside the folder, under .git, without an image extension, or through a symlink", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-img-"))
  mkdirSync(path.join(dir, "src"))
  writeFileSync(path.join(dir, "src/main.rs"), "fn main() {}")
  symlinkSync(path.join(dir, "src/main.rs"), path.join(dir, "evil.png"))
  const err = (p: string, overwrite = false) => {
    const t = imageTarget(dir, p, overwrite)
    return "message" in t ? t.message : null
  }
  expect(err("../escape.png")).toBe(`path must stay inside ${dir}`)
  expect(err("/etc/x.png")).toBe(`path must stay inside ${dir}`)
  expect(err(".git/x.png")).toBe("path must not be under .git")
  expect(err("src/main.rs", true)).toBe("path must end in .png, .jpg, .jpeg, .webp")
  expect(err("evil.png", true)).toBe("path is a symlink")
  expect(imageTarget(dir, "a/b.webp")).toEqual({ file: path.join(dir, "a/b.webp"), format: "webp" })
  expect(imageTarget(dir)).toMatchObject({ format: "png" })
  expect(readFileSync(path.join(dir, "src/main.rs"), "utf8")).toBe("fn main() {}")
  expect(existsSync(path.join(dir, "../escape.png"))).toBe(false)
})

test("generate_image returns the error as text when the proxy fails", async () => {
  spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("connection refused")
  }) as unknown as typeof fetch)
  const tool = imageTool(PROXY, mkdtempSync(path.join(tmpdir(), "sf-img-")))
  const r = JSON.parse(String(await tool.handler!({ prompt: "x" }, {} as never))) as { error?: string }
  expect(r.error).toStartWith("image routing")
})
