import { test } from "bun:test"
import { GuideEffort, parseGuideHeadlessArgv } from "../packages/trellage-launcher/src/guide-api.ts"
import { assertGuideRequestResolution } from "./exhaustive-guide-request.ts"

for (const model of [undefined, "fixture-model"])
  for (const effort of [undefined, ...Object.values(GuideEffort)])
    for (const input of ["interactive", "stdin-json", "explicit-json"])
      test(`Guide request precedence: ${input}, model=${model}, effort=${effort}`, () => {
        const argv = [
          ...(input === "interactive" ? [] : ["--json"]),
          ...(input === "explicit-json" ? ["--intent", "Explicit intent"] : []),
          ...(model === undefined ? [] : ["--model", model]),
          ...(effort === undefined ? [] : ["--effort", effort]),
        ]
        assertGuideRequestResolution(parseGuideHeadlessArgv(argv), "routing")
      })
