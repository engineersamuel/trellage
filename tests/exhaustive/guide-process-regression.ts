import assert from "node:assert/strict"
import path from "node:path"
import { conversationWorld } from "./conversation-world.ts"
import { guideWorld } from "./guide-world.ts"
import { runGuideProcess } from "./guide-process.ts"
import { shippedRituals } from "../../packages/trellage-launcher/src/ritual-catalog.ts"
const root = path.resolve(import.meta.dir, "../..")
const args = process.argv.slice(2)
if (args.length > 1 || (args[0] !== undefined && args[0] !== "--all-terminal-widths"))
  throw Error("Only --all-terminal-widths is accepted")
const widths = args.length ? [69, 70, 100] : [100]
const world = await guideWorld(root)
let ordinal = 0n

const verifySuccessfulJsonResponse = (
  result: Awaited<ReturnType<typeof runGuideProcess>>,
  item: {
    readonly argv: readonly string[]
    readonly fallback?: boolean
    readonly optimize?: boolean
  },
): void => {
  if (result.status !== 0 || !item.argv.includes("--json")) return
  const response = JSON.parse(result.output)
  if (item.argv.includes("--profile")) {
    assert.equal(response.profile.ref, "native:codex/superpowers")
    assert.equal(response.candidates.length, 3)
    assert.equal(result.audit.calls["copilot.optimize"] ?? 0, item.optimize ? 1 : 0)
    for (const candidate of response.candidates)
      assert.deepEqual(candidate.command.args.slice(0, 3), ["run", "codex", "superpowers"])
    return
  }
  assert.deepEqual(
    response.recommendations.map(
      ({ ref, workflowId, confidence }: { ref: string; workflowId: string; confidence: number }) => ({
        profileRef: ref,
        workflowId,
        confidence,
      }),
    ),
    result.audit.expectedMatches,
  )
  assert.equal(response.execution.backend, item.fallback ? "copilot" : "jev")
}

try {
  for (const ritual of shippedRituals)
    for (const flag of ["--print", "--copy"]) {
      await world.withCase(ordinal++, async (cwd) => {
        const result = await runGuideProcess({
          world,
          cwd,
          argv: ["--prompts", ritual.id, flag],
          clipboard: flag === "--copy",
        })
        assert.equal(result.status, 0, result.output)
        assert.equal(result.audit.clean, true, result.audit.failure ?? "Unexpected model interaction")
        assert.equal(
          flag === "--print" ? result.output : result.audit.clipboard,
          ritual.prompt + (flag === "--print" ? "\n" : ""),
        )
      })
    }
  for (const columns of widths)
    for (const item of [
      { argv: [], ready: "Ctrl-C cancel", close: "cancel" as const, status: 130 },
      { argv: ["--intent", "Fix the parser"], ready: "↵ generate", close: "quit" as const, status: 130 },
      { argv: ["--intent-stdin"], stdin: "Fix the parser", ready: "↵ generate", close: "quit" as const, status: 130 },
      { argv: ["--optimize"], ready: "First principles", close: "optimize-back" as const, status: 130 },
      { argv: ["--review"], ready: "Choose review scope", close: "cancel" as const, status: 130 },
      { argv: ["--prompts"], ready: "q quit", close: "quit" as const, status: 0 },
      { argv: ["--engagement"], ready: "Check engagement", close: "cancel" as const, status: 130 },
      { argv: ["--preview"], mode: "guide-preview" as const, ready: "q quit", close: "quit" as const, status: 0 },
      {
        argv: ["--forks", "tabs"],
        mode: "guide-forks" as const,
        ready: "variant (tabs)",
        close: "quit" as const,
        status: 0,
      },
      {
        argv: ["--forks", "inline"],
        mode: "guide-forks" as const,
        ready: "variant (inline)",
        close: "quit" as const,
        status: 0,
      },
    ])
      await world.withCase(ordinal++, async (cwd) => {
        if (item.argv.includes("--engagement"))
          for (const args of [
            ["init", "-q"],
            [
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.invalid",
              "commit",
              "--allow-empty",
              "-qm",
              "fixture",
            ],
          ]) {
            const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
              cwd,
              stdout: "ignore",
              stderr: "pipe",
            })
            assert.equal(await child.exited, 0, await new Response(child.stderr).text())
          }
        const result = await runGuideProcess({
          world,
          cwd,
          mode: item.mode ?? "guide",
          argv: item.argv,
          ...(item.stdin === undefined ? {} : { stdin: item.stdin }),
          terminal: { columns, ready: item.ready, close: item.close },
        })
        assert.equal(result.status, item.status, result.output)
        assert.equal(result.audit.clean, true, result.audit.failure ?? "Unexpected model interaction")
      })
  for (const item of [
    { argv: ["--help"], status: 0 },
    { argv: ["--json", "--intent", "Fix the parser"], status: 0 },
    { argv: ["--json", "--intent", "Fix the parser"], status: 0, fallback: true },
    { argv: ["--json", "--intent", "Fix the parser"], status: 2, missingKey: true },
    { argv: ["--next-steps"], status: 2 },
    { argv: ["--json", "--intent", ""], status: 2 },
    { argv: ["--json"], stdin: JSON.stringify({ schemaVersion: 2, intent: "Fix the parser" }), status: 0 },
    { argv: ["--json", "--intent", "Fix the parser", "--profile", "native:codex/superpowers"], status: 0 },
    {
      argv: ["--json", "--intent", "Fix the parser", "--profile", "native:codex/superpowers"],
      status: 0,
      optimize: true,
    },
  ])
    await world.withCase(ordinal++, async (cwd) => {
      const result = await runGuideProcess({ world, cwd, ...item })
      assert.equal(result.status, item.status, result.output)
      assert.equal(result.audit.clean, !item.missingKey, result.audit.failure ?? "Unexpected model interaction")
      verifySuccessfulJsonResponse(result, item)
    })
  for (const columns of widths)
    await world.withCase(ordinal++, async (cwd) => {
      const conversation = await conversationWorld(cwd, world.environment)
      try {
        const result = await runGuideProcess({
          world: { ...world, environment: { ...world.environment, ...conversation.environment } },
          cwd,
          argv: ["--next-steps"],
          terminal: { columns, ready: "a Analyze | r Resume", close: "cancel" },
        })
        assert.equal(result.status, 0, result.output)
        assert.equal(result.audit.clean, true, result.audit.failure ?? "Unexpected model interaction")
        conversation.audit.assertClean()
      } finally {
        await conversation.dispose()
      }
    })
  console.log(
    `Guide process helper PASS: ${ordinal} cases with real entrypoint, terminal cancellation, and persistent mock audits`,
  )
} finally {
  await world.dispose()
}
