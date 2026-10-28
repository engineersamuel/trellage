import React from "react"
import { stripVTControlCharacters } from "node:util"
import { renderToString } from "ink"
import { describe, expect, it, vi } from "vitest"

import { AdminApp } from "../src/admin-ui.tsx"
import { AdminRunManager } from "../src/admin-run-manager.ts"
import { DoctorFailureDiagnosisProvider } from "../src/admin-diagnosis-provider.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"
import type { CommandRunner } from "../src/guide-launch.ts"

vi.mock("../src/admin-harness-version-cache.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin-harness-version-cache.ts")>()),
  loadHarnessVersionCache: async () => ({ schemaVersion: 2, entries: {} }),
  defaultAdminHarnessVersionCachePath: () => "/unused/admin-cache.json",
}))

const renderEntry = (_surface: "native", harness: string, launcher: string, name = "default"): string => {
  const entry: AdminProfileEntry = {
    ref: `native:${launcher}/${name}`,
    surface: "native",
    harness,
    launcher,
    name,
    profiles: [name],
    lifecycle: ["codex", "pi", "nodecode"].includes(launcher) ? null : { runtime: launcher, profile: name },
    description: `${harness} profile`,
    commandPath: `/fixture/${launcher}`,
    doctorSupported: true,
    inventorySupported: true,
    health: "unknown",
    install: "unknown",
    stale: true,
    updateCheckSupported: false,
    harnessVersionSupported: true,
    updateCheckStale: false,
  }
  const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({ stdout: "healthy", stderr: "", exitCode: 0 })
  const clientFactory = vi.fn(() => {
    throw new Error("Model calls are not allowed")
  })
  const output = renderToString(
    React.createElement(AdminApp, {
      entries: [entry],
      runManager: new AdminRunManager({ runner: { run } }),
      guideRoot: "/unused",
      runner: { run },
      diagnosisProvider: new DoctorFailureDiagnosisProvider({ clientFactory }),
      herdrEnv: {},
      cwd: "/fixture/worktree",
    }),
    { columns: 140 },
  )
  expect(clientFactory).not.toHaveBeenCalled()
  expect(run.mock.calls.some(([, args]) => ["update", "upgrade", "harness-update"].includes(args[0] ?? ""))).toBe(false)
  return stripVTControlCharacters(output)
}

describe("Admin harness update control", () => {
  it.each([
    ["native", "copilot", "copilot"],
    ["native", "claude", "claude"],
    ["native", "omp", "omp"],
    ["native", "jcode", "jcode"],
    ["native", "prime", "prime"],
    ["native", "nodecode", "nodecode"],
  ] as const)("shows U for %s %s before version data is available, without starting an update", (surface, harness, launcher) => {
    expect(renderEntry(surface, harness, launcher)).toContain("[U] update harness")
  })

  it.each([
    ["pi", "default", "pi"],
    ["codex", "youtube", "codex"],
    ["codex", "superpowers", "codex"],
  ])("does not show U for externally managed native %s/%s", (harness, name, launcher) => {
    expect(renderEntry("native", harness, launcher, name)).not.toContain("[U] update harness")
  })

  it("does not offer harness updates for unsupported native launchers", () => {
    expect(renderEntry("native", "unknown", "unknown")).not.toContain("[U]")
  })

})
