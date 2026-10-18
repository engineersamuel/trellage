import path from "node:path"
import { test } from "bun:test"
import { guideWorld } from "./guide-world.ts"
import { verifyRunSelectorProcess } from "./run-selector-process.ts"

test("selector passes overriding options and preserves expected usage rejection", async () => {
  const world = await guideWorld(path.resolve(import.meta.dir, "../.."))
  try {
    await verifyRunSelectorProcess(
      world,
      ["--no-always", "--model", "fixture-other", "--", "-p", "quote ' $() `literal`\n日本語", "--dry-run"],
      0n,
      100,
      "launch",
      {
        options: {
          harness: "pi",
          profiles: ["clean"],
          model: "fixture-other",
          effort: "high",
          dryRun: false,
          noAlways: true,
          plan: false,
          allowUnprovenIsolation: true,
          forwardedArgs: ["-p", "quote ' $() `literal`\n日本語", "--dry-run"],
        },
      },
    )
    await verifyRunSelectorProcess(world, ["--dry-run", "--model", ""], 1n, 100, "launch", { rejection: "usage" })
    await verifyRunSelectorProcess(world, ["--no-always", "--skill", "example/skills:review"], 2n, 100, "launch", {
      options: {
        harness: "pi",
        profiles: ["clean"],
        model: "gpt-6.1-sol",
        effort: "high",
        dryRun: false,
        noAlways: true,
        plan: false,
        allowUnprovenIsolation: true,
        forwardedArgs: [],
        skills: ["example/skills:review"],
      },
      rejection: "usage",
    })
    await verifyRunSelectorProcess(
      world,
      ["--no-always", "--resume=session-fixture", "--", "fixture-prompt"],
      3n,
      100,
      "launch",
      {
        options: {
          harness: "pi",
          profiles: ["clean"],
          model: "gpt-6.1-sol",
          effort: "high",
          dryRun: false,
          noAlways: true,
          plan: false,
          allowUnprovenIsolation: true,
          resume: { kind: "pick", id: "session-fixture" },
          forwardedArgs: ["fixture-prompt"],
        },
      },
    )
  } finally {
    await world.dispose()
  }
}, 60000)
