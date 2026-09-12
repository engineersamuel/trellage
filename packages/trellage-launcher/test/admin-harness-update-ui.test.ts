import React from "react"
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

const renderEntry = (surface: "native" | "sandbox", harness: string, launcher: string, name = "default"): string => {
  const entry: AdminProfileEntry = {
    ref: surface === "native" ? `native:${launcher}/${name}` : `sandbox:${name}`,
    surface,
    harness,
    ...(surface === "native" ? { launcher } : {}),
    name,
    description: `${harness} profile`,
    commandPath: `/fixture/${surface === "native" ? launcher : "trellage"}`,
    doctorSupported: true,
    inventorySupported: surface === "native",
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
  return output
}

describe("Admin harness update control", () => {
  it.each([
    ["native", "copilot", "cpx"],
    ["native", "claude", "cldx"],
    ["native", "oh-my-pi", "omp"],
    ["native", "firstmate", "fmx"],
    ["native", "jcode", "jcx"],
    ["native", "pi", "picx"],
    ["native", "prime", "prx"],
    ["sandbox", "claude", ""],
    ["sandbox", "codex", ""],
    ["sandbox", "copilot", ""],
    ["sandbox", "pi", ""],
    ["sandbox", "prime", ""],
    ["sandbox", "headlong", ""],
  ] as const)("shows U for %s %s before version data is available, without starting an update", (surface, harness, launcher) => {
    expect(renderEntry(surface, harness, launcher)).toContain("[U] update harness")
  })

  it.each([
    ["codex", "youtube", "cdx"],
    ["codex", "superpowers", "cdx"],
    ["grok", "superpowers", "grx"],
  ])("shows U for native %s/%s without starting a profile update", (harness, name, launcher) => {
    expect(renderEntry("native", harness, launcher, name)).toContain("[U] update harness")
  })

  it("does not offer harness updates for unsupported native launchers", () => {
    expect(renderEntry("native", "claude", "unknown")).not.toContain("[U]")
  })

  it("shows U for the graph-of-loops container without starting an update", () => {
    expect(renderEntry("sandbox", "claude", "", "claude-graph-of-loops")).toContain("[U] update harness")
  })
})
