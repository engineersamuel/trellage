import { expect, test } from "vitest"
import { parseRunListArguments, formatRunList } from "../src/run-list.ts"
import { toRunListCatalog } from "../src/run-list-catalog.ts"
import type { RunCatalogV2 } from "../src/run-catalog.ts"
test("listing accepts only text, JSON, or help modes", () => {
  expect(parseRunListArguments([])).toEqual({ format: "text", help: false })
  expect(parseRunListArguments(["--json"])).toEqual({ format: "json", help: false })
  expect(parseRunListArguments(["--help"]).help).toBe(true)
  for (const args of [["--json", "--json"], ["pi"], ["--json-full"], ["--help", "--json"]])
    expect(() => parseRunListArguments(args)).toThrow()
})
test("text rendering includes tradeoffs, incomplete metadata, and unavailable reasons", () => {
  const selection = {
    description: "Review harness",
    strengths: ["Extension tools"],
    weaknesses: null,
    bestFor: ["Patch review"],
    avoidFor: [],
    capabilities: null,
  }
  const readiness = { status: "ready" as const, reasons: [], automaticSetup: [], unverified: ["credential-validity"] }
  const catalog: RunCatalogV2 = {
    schemaVersion: 2,
    harnesses: [
      {
        id: "pi",
        selection,
        metadataStatus: "complete",
        readiness,
        guideEligibility: { eligible: true, reasons: [] },
        profiles: [
          {
            ref: "native:pi/review",
            harnessId: "pi",
            name: "review",
            selection: { ...selection, description: null, bestFor: null },
            metadataStatus: "incomplete",
            readiness,
            guideEligibility: { eligible: false, reasons: ["profile-metadata-incomplete"] },
            command: ["trx", "run", "pi", "review"],
            prerequisites: [],
            workflows: [],
            headless: null,
            sandbox: false,
            herdrCompatibility: { status: "untested" },
          },
        ],
      },
    ],
    unavailable: {
      harnesses: [
        {
          id: "codex",
          selection,
          metadataStatus: "complete",
          readiness: {
            ...readiness,
            status: "unavailable",
            reasons: [{ code: "missing-executable", message: "Codex is not installed", prerequisite: "codex" }],
          },
          guideEligibility: { eligible: false, reasons: ["harness-unavailable"] },
          profiles: [],
        },
      ],
      profiles: [],
    },
  }
  const rendered = formatRunList(toRunListCatalog({catalog}))
  for (const text of [
    "pi",
    "Extension tools",
    "Weaknesses: unknown",
    "review —",
    "metadata incomplete",
    "Unavailable",
    "Codex is not installed",
    "Headless: unknown",
  ])
    expect(rendered).toContain(text)
  expect(rendered).not.toContain("\u001b[")
})
