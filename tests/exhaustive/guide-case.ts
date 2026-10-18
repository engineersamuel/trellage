import assert from "node:assert/strict"
import { GuideArgsError, parseGuideHeadlessArgv } from "../../packages/trellage-launcher/src/guide-api.ts"
import { GuideValidationError } from "../../packages/trellage-launcher/src/guide-text.ts"
import { BasketPreviewArgsError, parseBasketPreviewArgv } from "../../packages/trellage-launcher/src/basket-preview.tsx"
import { ForkPreviewArgsError, parseForkPreviewArgv } from "../../packages/trellage-launcher/src/fork-preview.tsx"
import { shippedRituals } from "../../packages/trellage-launcher/src/ritual-catalog.ts"
import { installGuideModelFixture } from "./guide-model-fixture.ts"
import { conversationWorld } from "./conversation-world.ts"
import { runGuideProcess } from "./guide-process.ts"
import type { guideWorld } from "./guide-world.ts"
import { verifyGuideJsonCase } from "./guide-case-json.ts"
import { guideParserRejection } from "./guide-parser-oracle.ts"

export interface GuideCase {
  readonly id: string
  readonly argv: readonly string[]
  readonly values: Readonly<Record<string, string>>
}

type GuideWorld = Awaited<ReturnType<typeof guideWorld>>
type GuideFixture = Awaited<ReturnType<typeof installGuideModelFixture>>
type ParsedGuide = ReturnType<typeof parseGuideHeadlessArgv>

interface PreviewOptions {
  readonly help: boolean
  readonly variant: string
}

const hasOption = (entry: GuideCase, key: string): boolean =>
  entry.values[key] !== undefined && entry.values[key] !== "omitted"

const parsePreviewOptions = (entry: GuideCase, preview: boolean): PreviewOptions | "argument-rejected" => {
  const otherOptions = Object.keys(entry.values).some(
    (key) =>
      !key.startsWith("json-") && !["--help", preview ? "--preview" : "--forks"].includes(key) && hasOption(entry, key),
  )
  const rejection = preview
    ? otherOptions
    : !hasOption(entry, "--help") && (otherOptions || entry.values["--forks"] === "invalid")
  try {
    if (preview) {
      const parsed = parseBasketPreviewArgv(entry.argv)
      assert.equal(rejection, false, `${entry.id}: preview parser accepted invalid options`)
      return { help: parsed.help, variant: "tabs" }
    }
    const parsed = parseForkPreviewArgv(entry.argv)
    assert.equal(rejection, false, `${entry.id}: preview parser accepted invalid options`)
    return { help: parsed.help, variant: parsed.variant }
  } catch (error) {
    if (rejection && (error instanceof BasketPreviewArgsError || error instanceof ForkPreviewArgsError))
      return "argument-rejected"
    throw error
  }
}

const verifyPreviewCase = async (
  world: GuideWorld,
  entry: GuideCase,
  ordinal: bigint,
  preview: boolean,
): Promise<string> => {
  const options = parsePreviewOptions(entry, preview)
  if (options === "argument-rejected") return options
  return world.withCase(ordinal, async (cwd) => {
    const result = await runGuideProcess({
      world,
      cwd,
      argv: entry.argv,
      mode: preview ? "guide-preview" : "guide-forks",
      ...(options.help
        ? {}
        : {
            terminal: {
              columns: 100,
              ready: preview ? "q quit" : `variant (${options.variant})`,
              close: "quit" as const,
            },
          }),
    })
    assert.equal(result.status, 0, result.output)
    assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
    if (options.help) assert.match(result.output, /Usage:/i)
    return options.help ? "help" : "preview"
  })
}

const parseGuideCase = (entry: GuideCase): ParsedGuide | "argument-rejected" => {
  const rejection = guideParserRejection(entry.values)
  try {
    const parsed = parseGuideHeadlessArgv(entry.argv)
    assert.equal(rejection, undefined, `${entry.id}: guide parser accepted invalid options`)
    return parsed
  } catch (error) {
    if (rejection && (error instanceof GuideArgsError || error instanceof GuideValidationError))
      return "argument-rejected"
    throw error
  }
}

const verifyHelpCase = (world: GuideWorld, entry: GuideCase, cwd: string): Promise<string> =>
  runGuideProcess({ world, cwd, argv: entry.argv }).then((result) => {
    assert.equal(result.status, 0, result.output)
    assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
    assert.match(result.output, /Usage:/i)
    return "help"
  })

const verifyRitualCase = async (world: GuideWorld, entry: GuideCase, parsed: ParsedGuide, cwd: string) => {
  const ritual = shippedRituals.find(({ id }) => id === parsed.ritualId)
  const result = await runGuideProcess({
    world,
    cwd,
    argv: entry.argv,
    clipboard: Boolean(parsed.ritualCopy),
  })
  assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
  assert.equal(result.status, ritual ? 0 : 2, result.output)
  if (ritual)
    assert.equal(
      parsed.ritualCopy ? result.audit.clipboard : result.output,
      ritual.prompt + (parsed.ritualPrint ? "\n" : ""),
    )
  else assert.ok(result.output.includes(`No ritual named ${parsed.ritualId}.`), result.output)
  return ritual ? "ritual-output" : "unknown-ritual"
}

const verifyNextStepsCase = async (world: GuideWorld, entry: GuideCase, cwd: string): Promise<string> => {
  const conversation = await conversationWorld(cwd, world.environment)
  try {
    const result = await runGuideProcess({
      world: { ...world, environment: { ...world.environment, ...conversation.environment } },
      cwd,
      argv: entry.argv,
      terminal: { columns: 100, ready: "a Analyze | r Resume", close: "cancel" },
    })
    conversation.audit.assertClean()
    assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
    assert.equal(result.status, 0, result.output)
    return "next-steps"
  } finally {
    await conversation.dispose()
  }
}

const initializeEngagementRepository = async (cwd: string): Promise<void> => {
  const gitCommands = [
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
  ]
  for (const args of gitCommands) {
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      stdout: "ignore",
      stderr: "pipe",
    })
    assert.equal(await child.exited, 0, await new Response(child.stderr).text())
  }
}

const rejectLongEngagementIntent = async (
  world: GuideWorld,
  entry: GuideCase,
  parsed: ParsedGuide,
  cwd: string,
): Promise<string | undefined> => {
  if (!parsed.engagement || parsed.intent === undefined || parsed.intent.length <= 8000) return undefined
  const result = await runGuideProcess({ world, cwd, argv: entry.argv })
  assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
  assert.equal(result.status, 2, result.output)
  assert.match(result.output, /engagement intent/)
  return "engagement-intent-rejected"
}

const interactiveTerminal = (parsed: ParsedGuide) => {
  if (parsed.ritual) return { ready: "q quit", close: "quit" as const }
  if (parsed.review) return { ready: "Choose review scope", close: "cancel" as const }
  if (parsed.optimize) return { ready: "First principles", close: "optimize-back" as const }
  if (parsed.engagement) return { ready: "Check engagement", close: "cancel" as const }
  if (parsed.intent !== undefined || parsed.intentStdin) return { ready: "↵ generate", close: "quit" as const }
  return { ready: "Ctrl-C cancel", close: "cancel" as const }
}

const interactiveOutcome = (parsed: ParsedGuide): string => {
  if (parsed.ritual) return "ritual"
  if (parsed.review) return "review"
  if (parsed.optimize) return "optimize"
  if (parsed.engagement) return "engagement"
  return "interactive-guide"
}

const verifyInteractiveCase = async (
  world: GuideWorld,
  entry: GuideCase,
  parsed: ParsedGuide,
  ordinal: bigint,
): Promise<string> =>
  world.withCase(ordinal, async (cwd) => {
    if (parsed.help) return verifyHelpCase(world, entry, cwd)
    if (parsed.ritualPrint || parsed.ritualCopy) return verifyRitualCase(world, entry, parsed, cwd)
    if (parsed.nextSteps) return verifyNextStepsCase(world, entry, cwd)
    if (parsed.engagement) {
      await initializeEngagementRepository(cwd)
      const rejected = await rejectLongEngagementIntent(world, entry, parsed, cwd)
      if (rejected !== undefined) return rejected
    }
    const result = await runGuideProcess({
      world,
      cwd,
      argv: entry.argv,
      terminal: { columns: 100, ...interactiveTerminal(parsed) },
      ...(parsed.intentStdin ? { stdin: "Fix the parser" } : {}),
    })
    assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
    assert.equal(result.status, parsed.ritual ? 0 : 130, result.output)
    return interactiveOutcome(parsed)
  })

export async function createGuideCaseVerifier(world: GuideWorld) {
  const fixture = await installGuideModelFixture()
  const { runGuideJsonCommand } = await import("../../packages/trellage-launcher/src/guide-command.ts")
  const knownProfiles = new Set(world.catalog.native.map((profile) => `native:${profile.launcher}/${profile.name}`))
  const profileWorkflows = new Map(
    world.catalog.native.map((profile) => [
      `native:${profile.launcher}/${profile.name}`,
      new Set(profile.guide.workflows.map(({ id }) => id)),
    ]),
  )
  const verify = async (entry: GuideCase, ordinal: bigint): Promise<string> => {
    const preview = hasOption(entry, "--preview")
    const forks = hasOption(entry, "--forks")
    const earlyMode = ["--ritual", "--review", "--next-steps", "--engagement"].some((key) => hasOption(entry, key))
    if ((preview || forks) && !earlyMode) return verifyPreviewCase(world, entry, ordinal, preview)
    const parsed = parseGuideCase(entry)
    if (parsed === "argument-rejected") return parsed
    if (parsed.json && !parsed.help)
      return verifyGuideJsonCase({
        world,
        fixture,
        entry,
        parsed,
        knownProfiles,
        profileWorkflows,
        ordinal,
        runGuideJsonCommand,
      })
    return verifyInteractiveCase(world, entry, parsed, ordinal)
  }
  return (entry: GuideCase, ordinal: bigint) => verify(entry, ordinal).finally(() => fixture.audit.assertClean())
}
