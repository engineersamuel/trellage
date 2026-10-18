import assert from "node:assert/strict"
import { GUIDE_MAX_GENERATED_SPEC } from "@trellage/guide-core"
import {
  GuideArgsError,
  defaultGuideModelRouting,
  parseGuideHeadlessArgv,
  type GuideGenerationResponse,
  type GuideMatchResponse,
} from "../../packages/trellage-launcher/src/guide-api.ts"
import { GuideValidationError } from "../../packages/trellage-launcher/src/guide-text.ts"
import { GuideGoalError } from "../../packages/trellage-launcher/src/guide-goal-augment.ts"
import { BasketPreviewArgsError, parseBasketPreviewArgv } from "../../packages/trellage-launcher/src/basket-preview.tsx"
import { ForkPreviewArgsError, parseForkPreviewArgv } from "../../packages/trellage-launcher/src/fork-preview.tsx"
import { shippedRituals } from "../../packages/trellage-launcher/src/ritual-catalog.ts"
import { guideParserRejection } from "./guide-parser-oracle.ts"
import { installGuideModelFixture } from "./guide-model-fixture.ts"
import { conversationWorld } from "./conversation-world.ts"
import { runGuideProcess } from "./guide-process.ts"
import type { guideWorld } from "./guide-world.ts"
import { guideJsonRequestInput } from "./guide-request-fields.ts"

export interface GuideCase {
  readonly id: string
  readonly argv: readonly string[]
  readonly values: Readonly<Record<string, string>>
}

export async function createGuideCaseVerifier(world: Awaited<ReturnType<typeof guideWorld>>) {
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
    const present = (key: string) => entry.values[key] !== undefined && entry.values[key] !== "omitted"
    const preview = present("--preview"),
      forks = present("--forks")
    // The router handles these modes before preview dispatch and rejects their preview combinations.
    const earlyMode = ["--ritual", "--review", "--next-steps", "--engagement"].some(present)
    if ((preview || forks) && !earlyMode) {
      const mode = preview ? "guide-preview" : "guide-forks"
      const otherOptions = Object.keys(entry.values).some(
        (key) =>
          !key.startsWith("json-") && !["--help", preview ? "--preview" : "--forks"].includes(key) && present(key),
      )
      const rejection = preview
        ? otherOptions
        : !present("--help") && (otherOptions || entry.values["--forks"] === "invalid")
      let help: boolean
      let variant = "tabs"
      try {
        if (preview) help = parseBasketPreviewArgv(entry.argv).help
        else {
          const parsed = parseForkPreviewArgv(entry.argv)
          help = parsed.help
          variant = parsed.variant
        }
        assert.equal(rejection, false, `${entry.id}: preview parser accepted invalid options`)
      } catch (error) {
        if (rejection && (error instanceof BasketPreviewArgsError || error instanceof ForkPreviewArgsError))
          return "argument-rejected"
        throw error
      }
      return world.withCase(ordinal, async (cwd) => {
        const result = await runGuideProcess({
          world,
          cwd,
          argv: entry.argv,
          mode,
          ...(help
            ? {}
            : {
                terminal: {
                  columns: 100,
                  ready: preview ? "q quit" : `variant (${variant})`,
                  close: "quit" as const,
                },
              }),
        })
        assert.equal(result.status, 0, result.output)
        assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
        if (help) assert.match(result.output, /Usage:/i)
        return help ? "help" : "preview"
      })
    }
    const rejection = guideParserRejection(entry.values)
    let parsed: ReturnType<typeof parseGuideHeadlessArgv>
    try {
      parsed = parseGuideHeadlessArgv(entry.argv)
      assert.equal(rejection, undefined, `${entry.id}: guide parser accepted invalid options`)
    } catch (error) {
      if (rejection && (error instanceof GuideArgsError || error instanceof GuideValidationError))
        return "argument-rejected"
      throw error
    }
    if (parsed.json && !parsed.help) {
      return world.withCase(ordinal, async (cwd) => {
        const input = guideJsonRequestInput(entry.values)
        const effectiveProfile = parsed.profile ?? (parsed.intent === undefined ? input.profile : undefined)
        const effectiveModel = parsed.model ?? (parsed.intent === undefined ? input.model : undefined)
        const effectiveEffort = parsed.effort ?? (parsed.intent === undefined ? input.effort : undefined)
        const effectiveWorkflow = parsed.intent === undefined ? input.workflowId : undefined
        const effectiveOriginal = parsed.intent === undefined ? input.originalIntent : undefined
        const effectiveGoal = parsed.intent === undefined ? input.goal : undefined
        fixture.configure({
          fallback: false,
          optimize: true,
          ...(effectiveGoal === undefined ? {} : { goal: effectiveGoal }),
        })
        const rejectsInput =
          parsed.intent === undefined &&
          (input.rejected || (effectiveWorkflow !== undefined && effectiveProfile === undefined))
        const before = fixture.audit.snapshot()
        let response: unknown
        try {
          response = await runGuideJsonCommand({
            argv: entry.argv,
            catalog: world.catalog,
            guideRoot: world.guideRoot,
            promptMasterSkillDirectory: world.promptMasterSkillDirectory,
            cwd,
            stdinRequest: input.source,
            env: { HOME: world.root, TYPESAFE_API_KEY: "fixture-not-a-secret" },
          })
        } catch (error) {
          fixture.audit.assertClean()
          if (rejectsInput && (error instanceof GuideValidationError || error instanceof GuideGoalError)) {
            assert.deepEqual(
              fixture.audit.snapshot(),
              before,
              `${entry.id}: invalid JSON request reached a model boundary`,
            )
            return "json-input-rejected"
          }
          if (
            parsed.intent === undefined &&
            input.goal !== undefined &&
            effectiveProfile !== undefined &&
            knownProfiles.has(effectiveProfile)
          ) {
            const profile = world.catalog.native.find(
              (profile) => `native:${profile.launcher}/${profile.name}` === effectiveProfile,
            )!
            const policy = profile.guide.goalExecution
            if (
              policy === undefined ||
              (effectiveWorkflow !== undefined && !policy.workflowIds.includes(effectiveWorkflow))
            ) {
              assert.ok(
                error instanceof Error && error.message.includes("cannot execute this goal:"),
                `${entry.id}: ${error}`,
              )
              for (const operation of ["copilot.generate", "copilot.optimize", "jev.systemOne"])
                assert.equal(
                  fixture.audit.snapshot()[operation],
                  before[operation],
                  `${entry.id}: incompatible goal reached ${operation}`,
                )
              return "goal-incompatible"
            }
            if (policy.controller === "claude-goal" && input.goal.task.length > 4000) {
              assert.ok(
                error instanceof Error && error.message.includes("4,000-character condition limit"),
                `${entry.id}: ${error}`,
              )
              for (const operation of ["copilot.generate", "copilot.optimize", "jev.systemOne"])
                assert.equal(
                  fixture.audit.snapshot()[operation],
                  before[operation],
                  `${entry.id}: oversized goal reached ${operation}`,
                )
              return "goal-too-large"
            }
          }
          if (
            effectiveProfile !== undefined &&
            !knownProfiles.has(effectiveProfile) &&
            error instanceof Error &&
            error.message === `Unknown profile reference: ${effectiveProfile}`
          )
            return "unknown-profile"
          if (
            effectiveProfile !== undefined &&
            knownProfiles.has(effectiveProfile) &&
            effectiveWorkflow !== undefined &&
            !profileWorkflows.get(effectiveProfile)!.has(effectiveWorkflow) &&
            error instanceof Error &&
            error.message === `Selected workflow is unknown for ${effectiveProfile}: ${effectiveWorkflow}`
          )
            return "unknown-workflow"
          if (
            effectiveProfile !== undefined &&
            knownProfiles.has(effectiveProfile) &&
            effectiveOriginal !== undefined &&
            error instanceof GuideValidationError &&
            ["single-prompt delivery", "bodyBudget"].includes(error.path)
          ) {
            assert.ok(
              effectiveOriginal.length >= GUIDE_MAX_GENERATED_SPEC,
              `${entry.id}: unexpected original intent rejection`,
            )
            const tooLarge = effectiveOriginal.length > GUIDE_MAX_GENERATED_SPEC
            assert.equal(error.path, tooLarge ? "single-prompt delivery" : "bodyBudget")
            for (const operation of ["copilot.generate", "copilot.optimize", "jev.systemOne"])
              assert.equal(
                fixture.audit.snapshot()[operation],
                before[operation],
                `${entry.id}: rejected original intent reached ${operation}`,
              )
            return tooLarge ? "original-intent-too-large" : "original-intent-no-room"
          }
          throw error
        }
        fixture.audit.assertClean()
        assert.equal(rejectsInput, false, `${entry.id}: accepted invalid JSON stdin`)
        assert.equal((response as GuideMatchResponse | GuideGenerationResponse).intent, parsed.intent ?? input.intent)
        if (effectiveProfile !== undefined) {
          assert.ok(knownProfiles.has(effectiveProfile), `${entry.id}: accepted unknown profile`)
          const generated = response as GuideGenerationResponse
          assert.equal(generated.profile.ref, effectiveProfile)
          assert.equal(generated.model, effectiveModel ?? defaultGuideModelRouting.generate.model)
          assert.equal(generated.effort, effectiveEffort ?? defaultGuideModelRouting.generate.effort)
          if (effectiveWorkflow !== undefined) assert.equal(generated.profile.workflowId, effectiveWorkflow)
          assert.equal(generated.originalIntent, effectiveOriginal)
          assert.equal(generated.candidates.length, 3)
          assert.equal(new Set(generated.candidates.map((candidate) => candidate.prompt)).size, 3)
          const [harness, profile] = effectiveProfile.slice("native:".length).split("/")
          for (const candidate of generated.candidates) {
            if (effectiveOriginal !== undefined && effectiveGoal === undefined)
              assert.ok(candidate.prompt.includes(effectiveOriginal), `${entry.id}: original intent was removed`)
            assert.equal(candidate.command.executable, "trx")
            assert.deepEqual(candidate.command.args.slice(0, 3), ["run", harness, profile])
            if (effectiveGoal !== undefined) {
              const selected: (typeof world.catalog.native)[number] = world.catalog.native.find(
                (entry) => `native:${entry.launcher}/${entry.name}` === effectiveProfile,
              )!
              const policy: typeof selected.guide.goalExecution = selected.guide.goalExecution
              assert.ok(policy, `${entry.id}: goal accepted without a controller`)
              assert.ok(policy.workflowIds.includes(generated.profile.workflowId))
              assert.equal(generated.profile.goalExecution?.controller, policy.controller)
              assert.equal(candidate.goalExecution?.controller, policy.controller)
              assert.ok(candidate.prompt.startsWith("/goal "))
              if (policy.controller === "claude-goal") assert.ok([...candidate.prompt.slice(6)].length <= 4000)
              assert.ok(candidate.prompt.includes(`ARTIFACT: ${effectiveGoal.artifact}\n`))
              assert.ok(candidate.prompt.includes(`TASK:\n${effectiveGoal.task}\n`))
              for (const criterion of effectiveGoal.criteria) assert.ok(candidate.prompt.includes(`- ${criterion}\n`))
              const transport = candidate.command.goalTransport
              assert.ok(transport)
              assert.equal(transport.controller, policy.controller)
              const manual: boolean = policy.controller === "codex-goal" || !selected.headless.prompt
              assert.equal(transport.mode, manual ? "manual" : "argv")
              if (transport.mode === "manual") {
                assert.equal(transport.commandInput.command, "/goal")
                assert.equal(transport.commandInput.body, candidate.prompt.slice(6))
                assert.equal(candidate.command.args.includes(candidate.prompt), false)
              } else assert.ok(candidate.command.args.includes(candidate.prompt))
            }
          }
          return effectiveGoal === undefined ? "generated" : "goal-generated"
        }
        const matched = response as GuideMatchResponse
        assert.equal(Object.hasOwn(matched, "originalIntent"), false)
        assert.equal(matched.model, effectiveModel ?? defaultGuideModelRouting.match.model)
        assert.equal(matched.effort, effectiveEffort ?? defaultGuideModelRouting.match.effort)
        assert.deepEqual(
          matched.recommendations.map(({ ref, workflowId, confidence }) => ({
            profileRef: ref,
            workflowId,
            confidence,
          })),
          fixture.expectedMatches(),
        )
        if (effectiveGoal !== undefined)
          for (const recommendation of matched.recommendations) {
            const selected = world.catalog.native.find(
              (entry) => `native:${entry.launcher}/${entry.name}` === recommendation.ref,
            )!
            assert.ok(selected.guide.goalExecution)
            assert.ok(selected.guide.goalExecution.workflowIds.includes(recommendation.workflowId))
            assert.equal(recommendation.goalExecution?.controller, selected.guide.goalExecution.controller)
          }
        return effectiveGoal === undefined ? "matched" : "goal-matched"
      })
    }
    return world.withCase(ordinal, async (cwd) => {
      if (parsed.help) {
        const result = await runGuideProcess({ world, cwd, argv: entry.argv })
        assert.equal(result.status, 0, result.output)
        assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
        assert.match(result.output, /Usage:/i)
        return "help"
      }
      if (parsed.ritualPrint || parsed.ritualCopy) {
        const ritual = shippedRituals.find((ritual) => ritual.id === parsed.ritualId)
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
      if (parsed.nextSteps) {
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
      if (parsed.engagement) {
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
        if (parsed.intent !== undefined && parsed.intent.length > 8000) {
          const result = await runGuideProcess({ world, cwd, argv: entry.argv })
          assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
          assert.equal(result.status, 2, result.output)
          assert.match(result.output, /engagement intent/)
          return "engagement-intent-rejected"
        }
      }
      const terminal = parsed.ritual
        ? { ready: "q quit", close: "quit" as const }
        : parsed.review
          ? { ready: "Choose review scope", close: "cancel" as const }
          : parsed.optimize
            ? { ready: "First principles", close: "optimize-back" as const }
            : parsed.engagement
              ? { ready: "Check engagement", close: "cancel" as const }
              : parsed.intent !== undefined || parsed.intentStdin
                ? { ready: "↵ generate", close: "quit" as const }
                : { ready: "Ctrl-C cancel", close: "cancel" as const }
      const result = await runGuideProcess({
        world,
        cwd,
        argv: entry.argv,
        terminal: { columns: 100, ...terminal },
        ...(parsed.intentStdin ? { stdin: "Fix the parser" } : {}),
      })
      assert.equal(result.audit.clean, true, result.audit.failure ?? entry.id)
      assert.equal(result.status, parsed.ritual ? 0 : 130, result.output)
      return parsed.ritual
        ? "ritual"
        : parsed.review
          ? "review"
          : parsed.optimize
            ? "optimize"
            : parsed.engagement
              ? "engagement"
              : "interactive-guide"
    })
  }
  return (entry: GuideCase, ordinal: bigint) => verify(entry, ordinal).finally(() => fixture.audit.assertClean())
}
