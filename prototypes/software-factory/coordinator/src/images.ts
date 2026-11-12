// generate_image: a worker tool. Jev picks the image model (copilot-proxy-rs POST /v1/models with type "image"),
// the proxy generates the image (POST /v1/images/generations), and the file is saved in the worker's folder.
import { defineTool, type Tool } from "@github/copilot-sdk"
import { Data, Effect } from "effect"
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Where an image goes when the worker names no path: git-excluded, and the UIs show it. */
export const IMAGE_DIR = ".factory/images"
const SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const
/** File extension -> the image format the proxy is asked for, so the bytes match the name. */
const FORMATS: Record<string, string> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" }
const ROUTE_TIMEOUT_MS = 25_000
const IMAGE_TIMEOUT_MS = 180_000

class ImageError extends Data.TaggedError("ImageError")<{ message: string }> {}

type Picked = { model: string; confidence: number }
export type ImageResult = { path: string; model: string; confidence: number; bytes: number }

const post = (url: string, body: unknown, timeoutMs: number, what: string) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
      return JSON.parse(text) as unknown
    },
    catch: (e) => new ImageError({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` }),
  })

/** Jev's image model for this prompt, from the proxy's image models only. */
export const pickImageModel = (proxyUrl: string, prompt: string) =>
  post(`${proxyUrl}/models`, { input: prompt.slice(0, 16_000), type: "image" }, ROUTE_TIMEOUT_MS, "image routing").pipe(
    Effect.flatMap((r) => {
      const res = r as { recommended?: { id?: string } | null; confidence?: number }
      const model = res.recommended?.id
      return model
        ? Effect.succeed<Picked>({ model, confidence: res.confidence ?? 0 })
        : Effect.fail(new ImageError({ message: "image routing: no image model" }))
    }),
  )

export type Target = { file: string; format: string }

/**
 * The file to write and its format, checked before any model call. Default: .factory/images/image-<time>.png.
 * A named `path` must stay inside `workdir`, not under .git, end in an image extension, and not be a symlink; an
 * existing file is replaced only with `overwrite`.
 */
export const imageTarget = (workdir: string, wanted?: string, overwrite = false): Target | ImageError => {
  const root = path.resolve(workdir)
  if (!wanted?.trim()) return { file: path.join(root, IMAGE_DIR, `image-${Date.now()}.png`), format: "png" }
  const file = path.resolve(root, wanted.trim())
  const fail = (message: string) => new ImageError({ message })
  if (!file.startsWith(root + path.sep)) return fail(`path must stay inside ${root}`)
  if (path.relative(root, file).split(path.sep).includes(".git")) return fail("path must not be under .git")
  const format = FORMATS[path.extname(file).toLowerCase()]
  if (!format) return fail(`path must end in ${Object.keys(FORMATS).join(", ")}`)
  let link = false
  try {
    link = lstatSync(file).isSymbolicLink()
  } catch {}
  if (link) return fail("path is a symlink")
  if (existsSync(file) && !overwrite) return fail(`${wanted} exists; pass overwrite: true to replace it`)
  return { file, format }
}

/** Pick the model, generate one image, save it. */
export const generateImage = (
  proxyUrl: string,
  workdir: string,
  args: { prompt: string; path?: string; size?: string; overwrite?: boolean },
) =>
  Effect.gen(function* () {
    const size = args.size && (SIZES as readonly string[]).includes(args.size) ? args.size : SIZES[0]
    const target = imageTarget(workdir, args.path, args.overwrite)
    if (target instanceof ImageError) return yield* target
    const picked = yield* pickImageModel(proxyUrl, args.prompt)
    const res = (yield* post(
      `${proxyUrl}/images/generations`,
      { model: picked.model, prompt: args.prompt, n: 1, size, output_format: target.format },
      IMAGE_TIMEOUT_MS,
      "image generation",
    )) as { data?: { b64_json?: string }[]; output_format?: string }
    const b64 = res.data?.[0]?.b64_json
    if (!b64) return yield* new ImageError({ message: "image generation: no image in the response" })
    if (res.output_format && res.output_format !== target.format)
      return yield* new ImageError({ message: `image generation: got ${res.output_format}, asked ${target.format}` })
    const file = target.file
    const bytes = Buffer.from(b64, "base64")
    yield* Effect.try({
      try: () => {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, bytes)
      },
      catch: (e) => new ImageError({ message: `save: ${e instanceof Error ? e.message : String(e)}` }),
    })
    return { path: file, model: picked.model, confidence: picked.confidence, bytes: bytes.length } satisfies ImageResult
  })

/** The worker tool; `workdir` is the worker's folder. */
export const imageTool = (proxyUrl: string, workdir: string): Tool<Record<string, unknown>> =>
  defineTool<Record<string, unknown>>("generate_image", {
    description:
      "Generate one image from a text prompt and save it as a file. The factory picks the image model. " +
      `Returns the file path. Without \`path\` the file goes to ${IMAGE_DIR}/ (not committed). To keep it in the repo, ` +
      "name a .png, .jpg or .webp path inside your working folder (for example docs/logo.png); an existing file is " +
      "replaced only with overwrite: true. Say the path in your answer so the UI shows it.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the image shows, in detail." },
        path: { type: "string", description: "Optional file path relative to your working folder." },
        size: { type: "string", enum: [...SIZES], description: "Optional. Default 1024x1024." },
        overwrite: { type: "boolean", description: "Replace an existing image at `path`. Default false." },
      },
      required: ["prompt"],
    },
    handler: (a) =>
      Effect.runPromise(
        generateImage(proxyUrl, workdir, {
          prompt: String(a.prompt ?? ""),
          ...(typeof a.path === "string" ? { path: a.path } : {}),
          ...(typeof a.size === "string" ? { size: a.size } : {}),
          overwrite: a.overwrite === true,
        }).pipe(
          Effect.map((r) => JSON.stringify(r)),
          Effect.catchTag("ImageError", (e) => Effect.succeed(JSON.stringify({ error: e.message }))),
        ),
      ),
  })
