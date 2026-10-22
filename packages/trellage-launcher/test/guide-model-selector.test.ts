import { describe, expect, it, vi } from "vitest"
import {
  createGuideModelSelector,
  type GuideModelFetch,
  guideModelSelectionPrompt,
  resolveGuideTaskModel,
} from "../src/guide-model-selector.ts"

describe("guide task model selection", () => {
  it("posts the task and instructions to the proxy and executes its recommendation at medium effort", async () => {
    const request = vi.fn<GuideModelFetch>(async () => Response.json({ recommended: { id: "claude-opus-5.5" }, confidence: 0.4 }))
    const config = await resolveGuideTaskModel({ model: "auto", effort: "medium" }, {
      systemPrompt: "Draft three approaches.", prompt: "Investigate recurring mistakes in this repository.",
    }, createGuideModelSelector(request))
    expect(config).toEqual({ model: "claude-opus-5.5", effort: "medium" })
    expect(request).toHaveBeenCalledOnce()
    const [url, options] = request.mock.calls[0]!
    expect(url).toBe("http://127.0.0.1:8080/v1/models")
    expect(options).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } })
    expect(JSON.parse(options!.body as string)).toEqual({
      input: "Instructions:\nDraft three approaches.\n\nInvestigate recurring mistakes in this repository.",
    })
  })

  it("preserves explicit model and effort choices without contacting the selector", async () => {
    const select = vi.fn(async () => "unused")
    expect(await resolveGuideTaskModel({ model: "chosen-model", effort: "high" }, { prompt: "Task" }, select))
      .toEqual({ model: "chosen-model", effort: "high" })
    expect(select).not.toHaveBeenCalled()
    expect(await resolveGuideTaskModel({ model: "auto", effort: "high" }, { prompt: "Task" }, select))
      .toEqual({ model: "unused", effort: "high" })
  })

  it("bounds Unicode routing excerpts to 16 KiB without altering the execution input", () => {
    const input = { systemPrompt: "🙂".repeat(6000), prompt: `Beginning ${"世界🙂".repeat(9000)} ending` }
    const original = structuredClone(input)
    const routed = guideModelSelectionPrompt(input)
    expect(Buffer.byteLength(routed)).toBeLessThanOrEqual(16 * 1024)
    expect(routed).toContain("Beginning")
    expect(routed).toContain("ending")
    expect(routed).toContain("Excerpt for model selection")
    expect(input).toEqual(original)
  })

  it.each([400, 502, 503])("stops on HTTP %i without falling back or exposing the response body", async (status) => {
    const select = createGuideModelSelector(vi.fn<GuideModelFetch>(async () => new Response("private upstream body", { status })))
    await expect(select({ prompt: "Task" })).rejects.toThrow(`HTTP ${status}`)
  })

  it.each([{}, { recommended: null }, { recommended: { id: "" } }, { recommended: { id: "auto" } },
    { recommended: { id: "bad\nmodel" } }])("rejects an invalid recommendation: %j", async (body) => {
    const select = createGuideModelSelector(vi.fn<GuideModelFetch>(async () => Response.json(body)))
    await expect(select({ prompt: "Task" })).rejects.toThrow("no valid recommended model")
  })

  it("cancels before a request and passes cancellation through an in-flight request", async () => {
    const controller = new AbortController()
    const request = vi.fn<GuideModelFetch>(async (_url, options) => {
      controller.abort(new Error("Cancelled"))
      options!.signal!.throwIfAborted()
      return Response.json({ recommended: { id: "unreachable" } })
    })
    const select = createGuideModelSelector(request)
    await expect(select({ prompt: "Task", signal: controller.signal })).rejects.toThrow("Cancelled")
    await expect(select({ prompt: "Task", signal: controller.signal })).rejects.toThrow("Cancelled")
    expect(request).toHaveBeenCalledOnce()
  })
})
