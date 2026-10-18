import { describe, expect, it } from "vitest"

import type { AdminProfileEntry } from "../src/admin-model.ts"
import { buildInventoryCommand, parseInventoryOutput } from "../src/admin-inventory.ts"

const entry: AdminProfileEntry = {
  ref: "native:copilot:hve",
  surface: "native",
  launcher: "copilot",
  harness: "copilot",
  name: "hve",
  profiles: ["hve"],
  lifecycle: { runtime: "cpx", profile: "hve" },
  description: "Copilot native profile.",
  commandPath: "/usr/local/bin/trx",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  harnessVersionSupported: true,
  updateCheckStale: false,
}

describe("buildInventoryCommand", () => {
  it("builds composition-aware inventory v2 arguments", () => {
    expect(buildInventoryCommand(entry)).toEqual({
      executable: "/usr/local/bin/trx",
      args: ["inventory", "copilot", "hve", "--json"],
    })
  })
})

const validSource = JSON.stringify({
  schemaVersion: 2,
  harness: "copilot",
  profiles: ["hve"],
  readiness: "healthy",
  plugins: [{ name: "hve-plugin", version: "1.2.3" }],
  skills: { packageCount: 5, visibleCount: 4, names: [] },
  mcps: ["playwright", "github"],
})

describe("parseInventoryOutput", () => {
  it("parses a well-formed healthy inventory result", () => {
    expect(parseInventoryOutput(validSource)).toEqual({
      harness: "copilot",
      profiles: ["hve"],
      readiness: "healthy",
      plugins: [{ name: "hve-plugin", version: "1.2.3" }],
      skills: { packageCount: 5, visibleCount: 4 },
      mcps: ["playwright", "github"],
    })
  })

  it("parses a plugin entry with a missing version as undefined rather than failing", () => {
    const source = JSON.stringify({
      schemaVersion: 2,
      harness: "copilot",
      profiles: ["hve"],
      readiness: "healthy",
      plugins: [{ name: "hve-plugin" }],
      skills: { packageCount: null, visibleCount: null, names: [] },
      mcps: [],
    })
    expect(parseInventoryOutput(source)).toEqual({
      harness: "copilot",
      profiles: ["hve"],
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
    expect(parseInventoryOutput(JSON.stringify({ schemaVersion: 1, harness: "copilot", profiles: ["hve"], readiness: "healthy", plugins: [], skills: {}, mcps: [] }))).toMatchObject(
      { malformed: true },
    )
  })

  it("reports an unrecognized readiness value as malformed", () => {
    expect(parseInventoryOutput(JSON.stringify({ schemaVersion: 2, harness: "copilot", profiles: ["hve"], readiness: "unknown-state", plugins: [], skills: {}, mcps: [] }))).toMatchObject({ malformed: true })
  })

  it("reports a malformed plugins shape as malformed rather than dropping the field silently", () => {
    expect(parseInventoryOutput(JSON.stringify({ schemaVersion: 2, harness: "copilot", profiles: ["hve"], readiness: "healthy", plugins: [{ noName: true }], skills: {}, mcps: [] }))).toMatchObject({ malformed: true })
  })

  it("reports a malformed mcps shape as malformed", () => {
    expect(parseInventoryOutput(JSON.stringify({ schemaVersion: 2, harness: "copilot", profiles: ["hve"], readiness: "healthy", plugins: [], skills: { packageCount: 0, visibleCount: 0 }, mcps: [1, 2] }))).toMatchObject({ malformed: true })
  })

  it("reports a not-setup composition as a valid, non-malformed result", () => {
    expect(parseInventoryOutput(JSON.stringify({ schemaVersion: 2, harness: "copilot", profiles: ["hve"], readiness: "not-setup", plugins: [], skills: {}, mcps: [] }))).toEqual({
      harness: "copilot",
      profiles: ["hve"],
      readiness: "not-setup",
      plugins: [],
      skills: { packageCount: undefined, visibleCount: undefined },
      mcps: [],
    })
  })
})
