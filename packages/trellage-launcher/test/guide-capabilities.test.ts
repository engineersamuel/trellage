import { describe, expect, it, vi } from "vitest"
import { parseGuideCatalog } from "../src/guide-catalog.ts"
import { resolveGuideCapabilities } from "../src/guide-capabilities.ts"
import { publicGuideLaunchCommand } from "../src/guide-api.ts"

const headless = {
  schemaVersion: 1, prompt: true, outputFormats: ["text"], eventContract: null,
  trellageEventContract: null, sessionId: "none", resume: false, resumeWithPrompt: false,
  questionToolControl: "none", changedFiles: "none", usage: false, cost: false,
  modelOverride: true, effortOverride: false, testedHarnessVersion: "1.0.81",
}
const catalog = () => parseGuideCatalog(JSON.stringify({
  schemaVersion: 1, sandboxCommandPath: "/bin/trellage", sandbox: [],
  native: ["cpx", "cdx"].map((launcher) => ({
    launcher, harness: launcher === "cpx" ? "copilot" : "codex", name: "review",
    description: "Review code", sandbox: false, commandPath: `/bin/${launcher}`, headless,
    herdrCompatibility: { status: "supported" },
    guide: {
      schemaVersion: 1, capabilities: ["review"], bestFor: ["Code review", "Bug checks"],
      avoidFor: ["Other work", "Deployment"], prerequisites: [],
      workflows: [{ id: "review", description: "Review code", examples: ["Review this change", "Check this diff"], promptTemplate: "{{intent}}" }],
    },
  })),
}))
const response = (profiles: unknown = [{ name: "review", headless }]) => ({
  stdout: JSON.stringify({ schemaVersion: 1, launcher: "cpx", harness: "copilot", profiles }),
  stderr: "", exitCode: 0 as const,
})

describe("deferred guide capabilities", () => {
  it("refreshes only capabilities through the catalog's executable and preserves launch routing", async () => {
    const input = catalog()
    const run = vi.fn(async () => response())
    const signal = new AbortController().signal
    const result = await resolveGuideCapabilities(input, { run }, "/work", signal)
    expect(run).toHaveBeenCalledWith("/bin/cpx", ["list", "--json"], expect.objectContaining({ cwd: "/work", signal, timeoutMs: 5000 }))
    expect(result.native[1]).toBe(input.native[1])
    expect(result.native[0]?.guide).toBe(input.native[0]?.guide)
    expect(publicGuideLaunchCommand(result, "native:cpx/review", "Check changes", "review").promptHandling).toBe("argv")
  })

  it.each(["malformed", "missing", "duplicate", "wrong launcher", "failed"]) (
    "disables stale automatic delivery after a %s refresh", async (failure) => {
      const input = catalog()
      const run = vi.fn(async () => {
        if (failure === "failed") throw new Error("unavailable")
        if (failure === "malformed") return response([{ name: "review", headless: { prompt: true } }])
        if (failure === "missing") return response([])
        if (failure === "duplicate") return response([{ name: "review", headless }, { name: "review", headless }])
        return { ...response(), stdout: response().stdout.replace('"cpx"', '"cdx"') }
      })
      const result = await resolveGuideCapabilities(input, { run }, "/work")
      expect(result.native[0]?.headless.prompt).toBe(false)
      expect(result.native[0]?.headless.modelOverride).toBe(false)
      expect(result.native[0]?.headless.testedHarnessVersion).toBeNull()
      expect(result.native[1]).toBe(input.native[1])
      expect(publicGuideLaunchCommand(result, "native:cpx/review", "Check changes", "review").promptHandling).toBe("manual-paste")
      expect(input.native[0]?.headless.prompt).toBe(true)
    },
  )

  it("does no work for catalogs without Copilot", async () => {
    const input = { ...catalog(), native: catalog().native.filter(({ launcher }) => launcher !== "cpx") }
    const run = vi.fn()
    expect(await resolveGuideCapabilities(input, { run }, "/work")).toBe(input)
    expect(run).not.toHaveBeenCalled()
  })

  it("propagates cancellation rather than converting it into a conservative result", async () => {
    const controller = new AbortController()
    const run = vi.fn(async () => { controller.abort(); throw new Error("terminated") })
    await expect(resolveGuideCapabilities(catalog(), { run }, "/work", controller.signal)).rejects.toThrow()
    run.mockClear()
    await expect(resolveGuideCapabilities(catalog(), { run }, "/work", controller.signal)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
