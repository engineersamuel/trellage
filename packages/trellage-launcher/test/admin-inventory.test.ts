import { describe, expect, it } from "vitest"

import type { AdminProfileEntry } from "../src/admin-model.js"
import { buildInventoryCommand, parseInventoryOutput } from "../src/admin-inventory.js"

const entry: AdminProfileEntry = {
  ref: "native:cpx:hve",
  surface: "native",
  launcher: "cpx",
  harness: "copilot",
  name: "hve",
  description: "Copilot native profile.",
  commandPath: "/usr/local/bin/cpx",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  updateCheckStale: false,
}

describe("buildInventoryCommand", () => {
  it("builds `inventory PROFILE --json` against the entry's own command path", () => {
    expect(buildInventoryCommand(entry)).toEqual({
      executable: "/usr/local/bin/cpx",
      args: ["inventory", "hve", "--json"],
    })
  })
})

const validSource = JSON.stringify({
  schemaVersion: 1,
  launcher: "cpx",
  harness: "copilot",
  profile: "hve",
  readiness: "healthy",
  plugins: [{ name: "hve-plugin", version: "1.2.3" }],
  skills: { packageCount: 5, visibleCount: 4 },
  mcps: ["playwright", "github"],
})

describe("parseInventoryOutput", () => {
  it("parses a well-formed healthy inventory result", () => {
    expect(parseInventoryOutput(validSource)).toEqual({
      readiness: "healthy",
      plugins: [{ name: "hve-plugin", version: "1.2.3" }],
      skills: { packageCount: 5, visibleCount: 4 },
      mcps: ["playwright", "github"],
    })
  })

  it("parses a plugin entry with a missing version as undefined rather than failing", () => {
    const source = JSON.stringify({
      schemaVersion: 1,
      readiness: "healthy",
      plugins: [{ name: "hve-plugin" }],
      skills: { packageCount: null, visibleCount: null },
      mcps: [],
    })
    expect(parseInventoryOutput(source)).toEqual({
      readiness: "healthy",
      plugins: [{ name: "hve-plugin", version: undefined }],
      skills: { packageCount: undefined, visibleCount: undefined },
      mcps: [],
    })
  })

  it("reports empty output as malformed", () => {
    expect(parseInventoryOutput("")).toMatchObject({ malformed: true, diagnostic: expect.stringContaining("no output") })
  })

  it("reports invalid JSON as malformed", () => {
    expect(parseInventoryOutput("{not valid json")).toMatchObject({ malformed: true })
  })

  it("reports a non-object JSON value as malformed", () => {
    expect(parseInventoryOutput("[1,2,3]")).toMatchObject({ malformed: true })
  })

  it("reports an unsupported schema version as malformed", () => {
    expect(parseInventoryOutput(JSON.stringify({ schemaVersion: 2, readiness: "healthy", plugins: [], skills: {}, mcps: [] }))).toMatchObject(
      { malformed: true },
    )
  })

  it("reports an unrecognized readiness value as malformed", () => {
    expect(
      parseInventoryOutput(JSON.stringify({ schemaVersion: 1, readiness: "unknown-state", plugins: [], skills: {}, mcps: [] })),
    ).toMatchObject({ malformed: true })
  })

  it("reports a malformed plugins shape as malformed rather than dropping the field silently", () => {
    expect(
      parseInventoryOutput(JSON.stringify({ schemaVersion: 1, readiness: "healthy", plugins: [{ noName: true }], skills: {}, mcps: [] })),
    ).toMatchObject({ malformed: true })
  })

  it("reports a malformed mcps shape as malformed", () => {
    expect(
      parseInventoryOutput(
        JSON.stringify({ schemaVersion: 1, readiness: "healthy", plugins: [], skills: { packageCount: 0, visibleCount: 0 }, mcps: [1, 2] }),
      ),
    ).toMatchObject({ malformed: true })
  })

  it("reports a not-setup profile's inventory as a valid, non-malformed result", () => {
    expect(
      parseInventoryOutput(JSON.stringify({ schemaVersion: 1, readiness: "not-setup", plugins: [], skills: {}, mcps: [] })),
    ).toEqual({
      readiness: "not-setup",
      plugins: [],
      skills: { packageCount: undefined, visibleCount: undefined },
      mcps: [],
    })
  })
})
