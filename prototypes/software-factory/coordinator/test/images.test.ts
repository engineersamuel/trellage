import { expect, test } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { generateImage, IMAGE_DIR, imageTarget, imageTool } from "../src/images.ts"

const PNG = Buffer.from("89504e470d0a1a0a", "hex")

/** A stub copilot-proxy-rs: the router answers for type "image" only; the image route returns one PNG. */
const stubProxy = (seen: unknown[]) =>
  Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Record<string, unknown>
      seen.push({ path: new URL(req.url).pathname, body })
      if (new URL(req.url).pathname === "/v1/models")
        return body.type === "image"
          ? Response.json({ type: "image", recommended: { id: "img-1" }, confidence: 0.9, ranking: [] })
          : Response.json({ error: "wrong type" }, { status: 400 })
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }], output_format: body.output_format })
    },
  })

test("generate_image asks the router for an image model, then generates and saves the image", async () => {
  const seen: unknown[] = []
  const server = stubProxy(seen)
  const dir = mkdtempSync(path.join(tmpdir(), "sf-img-"))
  try {
    const r = await Effect.runPromise(
      generateImage(`http://localhost:${server.port}/v1`, dir, { prompt: "a gear icon", size: "999x1" }),
    )
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
  } finally {
    server.stop(true)
  }
})

test("generate_image saves to a named image path, asks for its format, and never replaces a file by accident", async () => {
  const seen: { body: Record<string, unknown> }[] = []
  const server = stubProxy(seen)
  const dir = mkdtempSync(path.join(tmpdir(), "sf-img-"))
  const tool = imageTool(`http://localhost:${server.port}/v1`, dir)
  const call = async (args: Record<string, unknown>) =>
    JSON.parse(String(await tool.handler!(args, {} as never))) as Record<string, unknown>
  try {
    expect((await call({ prompt: "x", path: "docs/logo.jpg" })).path).toBe(path.join(dir, "docs/logo.jpg"))
    expect(seen.at(-1)!.body.output_format).toBe("jpeg")
    const calls = seen.length
    // An existing file stays unless overwrite is true; refusals make no model call.
    expect((await call({ prompt: "x", path: "docs/logo.jpg" })).error).toContain("exists")
    expect(seen.length).toBe(calls)
    expect((await call({ prompt: "x", path: "docs/logo.jpg", overwrite: true })).path).toBeString()
  } finally {
    server.stop(true)
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
  const tool = imageTool("http://localhost:1/v1", mkdtempSync(path.join(tmpdir(), "sf-img-")))
  const r = JSON.parse(String(await tool.handler!({ prompt: "x" }, {} as never))) as { error?: string }
  expect(r.error).toStartWith("image routing")
})
