import { describe, expect, it } from "vitest"

import {
  buildHarnessVersionCommand,
  harnessVersionColumnsFor,
  harnessVersionEntriesForForceResync,
  harnessVersionLatestLookupSupported,
  harnessVersionOperationKeyFor,
  harnessVersionReleaseKeyFor,
  parseHarnessVersionOutput,
  reconcileHarnessVersionResults,
  refreshedSandboxInstalledState,
  type AdminHarnessVersionResult,
} from "../src/admin-harness-version.js"
import type { AdminProfileEntry } from "../src/admin-model.js"

const nativeEntry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "native:omp/local",
  surface: "native",
  launcher: "omp",
  harness: "oh-my-pi",
  name: "local",
  description: "Oh My Pi native profile.",
  commandPath: "/usr/local/bin/omp",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  harnessVersionSupported: true,
  updateCheckStale: false,
  ...overrides,
})

const sandboxEntry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "sandbox:claude-blog",
  surface: "sandbox",
  harness: "claude",
  name: "claude-blog",
  description: "Sandboxed Claude profile.",
  commandPath: "/usr/local/bin/trellage",
  doctorSupported: true,
  inventorySupported: false,
  health: "healthy",
  install: "installed",
  version: "2.1.222",
  stale: false,
  updateCheckSupported: false,
  harnessVersionSupported: true,
  updateCheckStale: false,
  ...overrides,
})

const known = (installed: string, latest: string): AdminHarnessVersionResult => ({
  installed: { kind: "known", version: installed },
  latest: { kind: "known", version: latest },
})

const unsupported = (installed: string): AdminHarnessVersionResult => ({
  installed: { kind: "known", version: installed },
  latest: { kind: "unsupported" },
})

describe("buildHarnessVersionCommand", () => {
  it("builds a launcher-scoped native command", () => {
    expect(buildHarnessVersionCommand(nativeEntry())).toEqual({
      executable: "/usr/local/bin/omp",
      args: ["harness-version"],
    })
  })

  it("passes the profile to Firstmate because its installed receipt is profile-scoped", () => {
    expect(
      buildHarnessVersionCommand(
        nativeEntry({
          ref: "native:fmx/pstack-workers",
          launcher: "fmx",
          harness: "firstmate",
          name: "pstack-workers",
          commandPath: "/usr/local/bin/fmx",
        }),
      ),
    ).toEqual({
      executable: "/usr/local/bin/fmx",
      args: ["harness-version", "pstack-workers"],
    })
  })

  it("adds the explicit latest-cache bypass only to a forced sandbox command", () => {
    expect(buildHarnessVersionCommand(sandboxEntry())).toEqual({
      executable: "/usr/local/bin/trellage",
      args: ["harness-version", "claude-blog"],
    })
    expect(buildHarnessVersionCommand(sandboxEntry(), { refreshLatest: true })).toEqual({
      executable: "/usr/local/bin/trellage",
      args: ["harness-version", "claude-blog", "--refresh-latest"],
    })
  })
})

describe("parseHarnessVersionOutput", () => {
  it("parses installed and latest independently when both are known", () => {
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({
          schemaVersion: 1,
          installed: "18.1.1",
          latest: "18.1.2",
          latestKnown: true,
        }),
      ),
    ).toEqual(known("18.1.1", "18.1.2"))
  })

  describe("refreshedSandboxInstalledState", () => {
    it("preserves old installed evidence after a whole-command failure", () => {
      expect(
        refreshedSandboxInstalledState({
          installed: { kind: "unavailable", diagnostic: "command failed" },
          latest: { kind: "failed", diagnostic: "command failed" },
        }),
      ).toBeUndefined()
    })

    it("accepts independently known installed or a valid unavailable report", () => {
      expect(
        refreshedSandboxInstalledState({
          installed: { kind: "known", version: "2.1.221" },
          latest: { kind: "failed", diagnostic: "release lookup failed" },
        }),
      ).toEqual({ kind: "known", version: "2.1.221" })
      expect(
        refreshedSandboxInstalledState({
          installed: { kind: "unavailable", diagnostic: "receipt unavailable" },
          latest: { kind: "known", version: "2.1.259" },
        }),
      ).toEqual({ kind: "unavailable", diagnostic: "receipt unavailable" })
    })
  })

  it("preserves installed while representing an intentionally unsupported latest", () => {
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({
          schemaVersion: 1,
          installed: "1.0.82",
          latest: null,
          latestKnown: false,
        }),
      ),
    ).toEqual(unsupported("1.0.82"))
  })

  it("preserves installed and a retryable latest diagnostic", () => {
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({
          schemaVersion: 1,
          installed: "1.0.3",
          latest: null,
          latestKnown: false,
          latestDiagnostic: "grok latest-version check failed",
        }),
      ),
    ).toEqual({
      installed: { kind: "known", version: "1.0.3" },
      latest: { kind: "failed", diagnostic: "grok latest-version check failed" },
    })
  })

  it("retains a known latest when installed is unavailable", () => {
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({
          schemaVersion: 1,
          installed: null,
          latest: "2.1.259",
          latestKnown: true,
        }),
      ),
    ).toEqual({
      installed: {
        kind: "unavailable",
        diagnostic: "harness-version could not determine the installed harness version",
      },
      latest: { kind: "known", version: "2.1.259" },
    })
  })

  it("fails malformed top-level and contradictory latest fields closed", () => {
    expect(parseHarnessVersionOutput("not json").latest.kind).toBe("failed")
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({ schemaVersion: 1, installed: "1.0.0", latest: null, latestKnown: true }),
      ).latest.kind,
    ).toBe("failed")
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({ schemaVersion: 1, installed: "1.0.0", latest: "2.0.0", latestKnown: false }),
      ).latest.kind,
    ).toBe("failed")
  })
})

describe("harnessVersionColumnsFor", () => {
  it("renders unsupported or unsettled checks as unknown dashes", () => {
    expect(harnessVersionColumnsFor(false, known("1.0.0", "1.0.0"))).toEqual({
      installed: "—",
      latest: "—",
      status: "unknown",
    })
    expect(harnessVersionColumnsFor(true, undefined)).toEqual({
      installed: "—",
      latest: "—",
      status: "unknown",
    })
  })

  it("renders each independently known value without fabricating its peer", () => {
    expect(harnessVersionColumnsFor(true, unsupported("1.0.82"))).toEqual({
      installed: "1.0.82",
      latest: "—",
      status: "unknown",
    })
    expect(
      harnessVersionColumnsFor(true, {
        installed: { kind: "unavailable", diagnostic: "not installed" },
        latest: { kind: "known", version: "2.1.259" },
      }),
    ).toEqual({ installed: "—", latest: "2.1.259", status: "unknown" })
  })

  it("reports match and mismatch only when both values are known", () => {
    expect(harnessVersionColumnsFor(true, known("18.1.1", "18.1.1")).status).toBe("match")
    expect(harnessVersionColumnsFor(true, known("18.1.1", "18.1.2")).status).toBe("mismatch")
  })
})

describe("operation and release identities", () => {
  it("uses launcher, profile, and release scopes deliberately", () => {
    expect(harnessVersionOperationKeyFor(nativeEntry())).toBe("native:omp")
    expect(
      harnessVersionOperationKeyFor(
        nativeEntry({ ref: "native:fmx/default", launcher: "fmx", harness: "firstmate", name: "default" }),
      ),
    ).toBe("native:fmx:default")
    expect(harnessVersionOperationKeyFor(sandboxEntry())).toBe("sandbox:claude-code")
    expect(harnessVersionOperationKeyFor(sandboxEntry({ ref: "sandbox:claude-docs", name: "claude-docs" }))).toBe(
      "sandbox:claude-code",
    )
  })

  it("maps equivalent sources while separating Pi Coding Agent from Oh My Pi", () => {
    expect(harnessVersionReleaseKeyFor(nativeEntry())).toBe("oh-my-pi")
    expect(harnessVersionReleaseKeyFor(sandboxEntry({ harness: "pi" }))).toBe("oh-my-pi")
    expect(
      harnessVersionReleaseKeyFor(nativeEntry({ launcher: "picx", harness: "pi", ref: "native:picx/default" })),
    ).toBe("pi-coding-agent")
  })

  it("distinguishes latest-capable native producers and fails unsupported aliases closed", () => {
    expect(harnessVersionLatestLookupSupported(nativeEntry())).toBe(true)
    expect(
      harnessVersionLatestLookupSupported(
        nativeEntry({ launcher: "cpx", harness: "copilot", ref: "native:cpx/default" }),
      ),
    ).toBe(false)
    expect(
      harnessVersionOperationKeyFor(
        nativeEntry({
          launcher: "agx",
          harness: "agency",
          ref: "native:agx/default",
          harnessVersionSupported: false,
        }),
      ),
    ).toBeUndefined()
  })
})

describe("reconcileHarnessVersionResults", () => {
  it("shares only latest while preserving native and sandbox installed versions", () => {
    const cpx = nativeEntry({
      ref: "native:cpx/default",
      launcher: "cpx",
      harness: "copilot",
      name: "default",
    })
    const sandbox = sandboxEntry({
      ref: "sandbox:copilot-awesome",
      harness: "copilot",
      name: "copilot-awesome",
      version: "1.0.70",
    })
    const raw = new Map<string, AdminHarnessVersionResult>([
      ["native:cpx", unsupported("1.0.82")],
      [
        "sandbox:copilot-cli",
        {
          installed: { kind: "unavailable", diagnostic: "representative is unresolved" },
          latest: { kind: "known", version: "1.0.90" },
        },
      ],
    ])

    const results = reconcileHarnessVersionResults([cpx, sandbox], (key) => raw.get(key))
    expect(results.get(cpx.ref)).toEqual(known("1.0.82", "1.0.90"))
    expect(results.get(sandbox.ref)).toEqual(known("1.0.70", "1.0.90"))
  })

  it("does not cross-promote a conflicting latest release", () => {
    const native = nativeEntry()
    const sandbox = sandboxEntry({ harness: "pi", version: "18.1.0" })
    const raw = new Map<string, AdminHarnessVersionResult>([
      ["native:omp", known("18.1.1", "18.1.2")],
      ["sandbox:oh-my-pi", known("18.1.0", "18.1.3")],
    ])

    const results = reconcileHarnessVersionResults([native, sandbox], (key) => raw.get(key))
    expect(results.get(native.ref)?.latest).toEqual({ kind: "known", version: "18.1.2" })
    expect(results.get(sandbox.ref)?.latest).toEqual({ kind: "known", version: "18.1.3" })
  })

  it("applies a profile-scoped sandbox installed refresh without copying it to peers", () => {
    const first = sandboxEntry({ version: "2.1.220" })
    const second = sandboxEntry({
      ref: "sandbox:claude-docs",
      name: "claude-docs",
      version: "2.1.219",
    })
    const raw = new Map<string, AdminHarnessVersionResult>([
      [
        "sandbox:claude-code",
        {
          installed: { kind: "known", version: "2.1.221" },
          latest: { kind: "known", version: "2.1.259" },
        },
      ],
    ])

    const results = reconcileHarnessVersionResults(
      [first, second],
      (key) => raw.get(key),
      (ref) => (ref === first.ref ? { kind: "known", version: "2.1.221" } : undefined),
    )
    expect(results.get(first.ref)?.installed).toEqual({ kind: "known", version: "2.1.221" })
    expect(results.get(second.ref)?.installed).toEqual({ kind: "known", version: "2.1.219" })
  })
})

describe("harnessVersionEntriesForForceResync", () => {
  it("refreshes an equivalent native/sandbox release group", () => {
    const cpx = nativeEntry({ ref: "native:cpx/default", launcher: "cpx", harness: "copilot" })
    const sandbox = sandboxEntry({ ref: "sandbox:copilot", harness: "copilot" })
    expect(harnessVersionEntriesForForceResync(cpx, [cpx, sandbox])).toEqual([cpx, sandbox])
  })

  it("keeps Firstmate force refresh profile-scoped", () => {
    const first = nativeEntry({ ref: "native:fmx/default", launcher: "fmx", harness: "firstmate", name: "default" })
    const second = nativeEntry({
      ref: "native:fmx/pstack-workers",
      launcher: "fmx",
      harness: "firstmate",
      name: "pstack-workers",
    })
    expect(harnessVersionEntriesForForceResync(first, [first, second])).toEqual([first])
  })
})
