import assert from "node:assert/strict"
import path from "node:path"
import { guideWorld } from "./guide-world.ts"
import { createGuideCaseVerifier } from "./guide-case.ts"
import { guideStdinCases } from "./guide-stdin.ts"
import { runGuideProcess } from "./guide-process.ts"
import { captureSourceIdentity } from "./source-identity.ts"

const args = process.argv.slice(2)
if (args.length > 1 || (args[0] !== undefined && args[0] !== "--process-all"))
  throw Error("Only --process-all is accepted")
const processAll = args.length === 1

const root = path.resolve(import.meta.dir, "../..")
const identity = captureSourceIdentity(root)
const world = await guideWorld(root)
try {
  const verify = await createGuideCaseVerifier(world)
  const profile = world.catalog.native[0]!
  const ref = `native:${profile.launcher}/${profile.name}`
  const results: { input: string; cliIntent: boolean; generation: boolean; outcome: string }[] = []
  const processResults: { input: string; cliIntent: boolean; generation: boolean; status: number }[] = []
  for (const input of guideStdinCases)
    for (const cliIntent of [false, true])
      for (const generation of [false, true]) {
        const argv = [
          "--json",
          ...(cliIntent ? ["--intent", "Fix from CLI"] : []),
          ...(generation ? ["--profile", ref] : []),
        ]
        const values = {
          "--json": "present",
          "json-stdin": input.id,
          ...(cliIntent ? { "--intent": "representative" } : {}),
          ...(generation ? { "--profile": ref } : {}),
        }
        const outcome = await verify({ id: `stdin:${results.length}`, argv, values }, BigInt(results.length))
        assert.equal(
          outcome,
          input.rejected && !cliIntent ? "json-input-rejected" : generation ? "generated" : "matched",
        )
        results.push({ input: input.id, cliIntent, generation, outcome })
        if (processAll || (!generation && ["omitted", "malformed"].includes(input.id))) {
          await world.withCase(BigInt(1000 + results.length), async (cwd) => {
            const result = await runGuideProcess({ world, cwd, argv, stdin: input.source })
            const rejected = input.rejected && !cliIntent
            assert.equal(result.audit.clean, true, result.audit.failure ?? "Unexpected model interaction")
            assert.equal(result.status, rejected ? 2 : 0, result.output)
            if (rejected)
              assert.deepEqual(result.audit.calls, {}, "Invalid stdin must not construct or call model clients")
            else {
              const response = JSON.parse(result.output)
              assert.equal(response.intent, cliIntent ? "Fix from CLI" : input.intent)
              assert.equal(response.phase, generation ? "generation" : "match")
              if (generation) assert.equal(response.profile.ref, ref)
            }
            processResults.push({ input: input.id, cliIntent, generation, status: result.status })
          })
        }
      }
  assert.equal(results.length, 60)
  assert.equal(processResults.length, processAll ? 60 : 4)
  identity.assertUnchanged()
  console.log(
    JSON.stringify({
      status: "passed",
      scope:
        "All JSON stdin request fixtures crossed with CLI intent override and matching/generation; not the full command matrix",
      results,
      processResults,
      sourceIdentity: identity.sha256,
    }),
  )
} finally {
  await world.dispose()
}
