import React from "react"
import { render } from "ink"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { engagementDefaultIntent, inspectEngagementRepository } from "../../src/engagement-context.ts"
import { EngagementApp, type EngagementUiResult } from "../../src/engagement-ui.tsx"
import { executeEngagementWork } from "../../src/engagement-execution.ts"
import { EngagementWorkStore, type EngagementWork } from "../../src/engagement-work.ts"
import { ProfileReadinessKind } from "../../src/guide-preflight.ts"
import { createInitialGuideRenderHandler } from "../../src/guide-terminal.ts"
import { createEngagementFixture, engagementAssessment, engagementGuideRoot } from "../helpers/engagement-fixtures.ts"

const root = process.argv[2]
if (root === undefined) throw new Error("Missing integration fixture directory")
const fixture = await createEngagementFixture(root)
const scenario = process.env.ENGAGEMENT_SCENARIO ?? "agent"
const counts: {
  assessments: number
  launches: number
  sentContexts: string[]
  sentPaths: Array<ReadonlyArray<string>>
} = { assessments: 0, launches: 0, sentContexts: [], sentPaths: [] }
if (scenario === "scope") {
  await writeFile(path.join(root, "docs/engagement/notes.md"), "Do not send this excluded note.\n")
}
const saveCounts = () => writeFile(path.join(root, "counts.json"), JSON.stringify(counts))
await saveCounts()
let initialWork: EngagementWork | undefined
let notice: string | undefined
for (;;) {
  const store = new EngagementWorkStore(fixture.repository.root, fixture.catalog, fixture.runner)
  const result: { current: EngagementUiResult } = { current: { action: "exit", exitCode: 130 } }
  const instance = render(
    <EngagementApp
      repository={await inspectEngagementRepository(fixture.runner, root)}
      intent={engagementDefaultIntent}
      catalog={fixture.catalog}
      guideRoot={engagementGuideRoot}
      runner={fixture.runner}
      modelLabel="offline fixture; no model"
      store={store}
      records={await store.list()}
      {...(initialWork === undefined ? {} : { initialWork })}
      {...(notice === undefined ? {} : { notice })}
      assessor={async (snapshot) => {
        counts.assessments += 1
        counts.sentContexts.push(snapshot.context)
        counts.sentPaths.push(snapshot.sources.map((source) => source.path))
        await saveCounts()
        if (scenario === "clarification" && !snapshot.context) {
          return {
            ...engagementAssessment,
            outcome: "needs-clarification",
            actions: [],
            question: "Which decision must this workshop support?",
          }
        }
        if (scenario === "human") {
          return { ...engagementAssessment, actions: [{ ...engagementAssessment.actions[0]!, workflow: null }] }
        }
        return engagementAssessment
      }}
      onResult={(value) => {
        result.current = value
      }}
    />,
    {
      interactive: true,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "disabled" },
      alternateScreen: true,
      onRender: createInitialGuideRenderHandler((value) => {
        process.stdout.write(value)
      }, true),
    },
  )
  await instance.waitUntilExit()
  if (result.current.action === "exit") {
    process.exitCode = result.current.exitCode
    break
  }
  const executed = await executeEngagementWork(result.current.work, store, fixture.catalog, engagementGuideRoot, {
    runner: fixture.runner,
    write: () => {},
    checkReadiness: async () => ({ kind: ProfileReadinessKind.Ready, summary: "Fixture readiness only" }),
    runInteractive: async () => {
      counts.launches += 1
      await saveCounts()
      await fixture.runner.run(
        bunExecutable(),
        bunArguments(fileURLToPath(new URL("./engagement-terminal-transport.ts", import.meta.url)), [
          path.join(root, "terminal-proof"),
        ]),
        { cwd: root },
      )
      const source = await readFile(path.join(root, "docs/engagement/overview.md"), "utf8")
      await writeFile(
        path.join(root, "docs/engagement/workshop.md"),
        `# Workshop draft\n\n${source}\nCustomer review is pending.\n`,
      )
    },
  })
  initialWork = executed.work
  notice = executed.notice
}
