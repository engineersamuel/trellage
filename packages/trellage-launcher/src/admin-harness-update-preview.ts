import type { AdminHarnessVersionResult } from "./admin-harness-version.ts"
import type { AdminProfileEntry } from "./admin-model.ts"

interface UpgradeTargetVersion {
  readonly version?: string
  readonly label: string
}

export interface HarnessUpgradeVersionPreview {
  readonly isCurrent: boolean
  readonly text: string
}

const latestTargetFor = (result: AdminHarnessVersionResult | undefined, suffix = ""): UpgradeTargetVersion => {
  const latest = result?.latest
  if (latest?.kind === "known") return { version: latest.version, label: `${latest.version}${suffix}` }
  return { label: latest?.kind === "failed" ? "unknown (lookup failed)" : "unknown" }
}

const sandboxTargetFor = (selector: string | undefined, result: AdminHarnessVersionResult | undefined): UpgradeTargetVersion => {
  if (selector === "latest") return latestTargetFor(result)
  if (selector === undefined) return { label: "unknown (target selector unavailable)" }
  if (/^(?:\d+\.\d+\.\d+|[0-9a-f]{40})$/u.test(selector)) return { version: selector, label: `${selector} (pinned)` }
  return { label: `unknown (selector: ${selector})` }
}

const targetFor = (entry: AdminProfileEntry, result: AdminHarnessVersionResult | undefined): UpgradeTargetVersion =>
  entry.surface === "sandbox"
    ? sandboxTargetFor(entry.harnessVersionSelector, result)
    : latestTargetFor(result, entry.launcher === "fmx" ? " (catalog pin)" : "")

export const harnessUpgradeAvailability = (
  entry: AdminProfileEntry,
  result: AdminHarnessVersionResult | undefined,
): "available" | "current" | "unknown" => {
  const target = targetFor(entry, result)
  if (result?.installed.kind !== "known" || target.version === undefined) return "unknown"
  return result.installed.version === target.version ? "current" : "available"
}

export const harnessUpgradeVersionPreview = (
  entry: AdminProfileEntry,
  result: AdminHarnessVersionResult | undefined,
): HarnessUpgradeVersionPreview => {
  const current = result?.installed.kind === "known" ? result.installed.version : undefined
  const target = targetFor(entry, result)
  const isCurrent = current !== undefined && current === target.version
  return { isCurrent, text: isCurrent ? target.label : `${current ?? "unknown"} -> ${target.label}` }
}
