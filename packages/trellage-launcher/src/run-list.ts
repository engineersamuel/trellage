import type { RunListCatalog, RunListProfile } from "./run-list-catalog.ts"
import type { SelectionMetadata } from "@trellage/guide-core"

export const RUN_LIST_USAGE =
  "Usage: trx run list [--json]\nLists local harness and profile readiness without setup, credentials, or network access."

export const parseRunListArguments = (
  argv: ReadonlyArray<string>,
): { readonly format: "text" | "json"; readonly help: boolean } => {
  if (argv.length === 0) return { format: "text", help: false }
  if (argv.length === 1 && argv[0] === "--json") return { format: "json", help: false }
  if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]!)) return { format: "text", help: true }
  throw new Error(RUN_LIST_USAGE)
}

const guidance = (selection: SelectionMetadata, indent: string): string[] => [
  `${indent}Strengths: ${selection.strengths?.join("; ") ?? "unknown"}`,
  `${indent}Weaknesses: ${selection.weaknesses?.join("; ") ?? "unknown"}`,
  `${indent}Best for: ${selection.bestFor?.join("; ") ?? "unknown"}`,
  `${indent}Avoid for: ${selection.avoidFor?.join("; ") ?? "unknown"}`,
]

const profileLines = (profile: RunListProfile): string[] => [
  `${profile.id} — ${profile.selection.description ?? "No description"}${profile.metadataStatus === "incomplete" ? " [metadata incomplete]" : ""}`,
  `  Harnesses: ${profile.harnesses.join(", ")}; ready on: ${profile.readyHarnesses.join(", ") || "none"}`,
  ...guidance(profile.selection, "  "),
  `  Headless: ${profile.headless === null ? "unknown or harness-specific" : profile.headless.prompt ? "supported" : "not supported"}; Herdr: ${profile.herdrCompatibility?.status ?? "harness-specific"}`,
  ...profile.workflows.map((workflow) => `  Workflow ${workflow.id}: ${workflow.description}`),
  ...profile.prerequisites.map((item) => `  Requires: ${item.description}`),
  ...profile.readiness.reasons.map((reason) => `  ${reason.code}: ${reason.message}`),
  ...profile.unavailableOn.flatMap((item) =>
    item.reasons.map((reason) => `  Unavailable on ${item.harness}: ${reason.message}`),
  ),
  ...(profile.guideEligibility.eligible ? [] : [`  Guide excluded: ${profile.guideEligibility.reasons.join(", ")}`]),
]

const harnessLines = (catalog: RunListCatalog): string[] => {
  const lines = ["Harnesses (local checks only; authentication and service reachability unverified)"]
  if (!catalog.harnesses.length) lines.push("  None ready")
  for (const harness of catalog.harnesses)
    lines.push(
      "",
      `${harness.id} — ${harness.selection.description ?? "No description"}${harness.metadataStatus === "incomplete" ? " [metadata incomplete]" : ""}`,
      ...guidance(harness.selection, "  "),
      `  Sandbox: ${harness.sandbox === null ? "unknown" : harness.sandbox ? "yes" : "no"}`,
    )
  return lines
}

const profileSection = (catalog: RunListCatalog): string[] => {
  const lines = ["", "Profiles"]
  for (const profile of catalog.profiles) lines.push("", ...profileLines(profile))
  if (!catalog.profiles.length) lines.push("  None ready")
  return lines
}

const unavailableSection = (catalog: RunListCatalog): string[] => {
  const lines = ["", "Unavailable"]
  if (!catalog.unavailable.harnesses.length && !catalog.unavailable.profiles.length) lines.push("  None")
  for (const harness of catalog.unavailable.harnesses)
    lines.push(
      `${harness.id} — ${harness.selection.description ?? "No description"}`,
      ...harness.readiness.reasons.map((reason) => `  ${reason.code}: ${reason.message}`),
    )
  for (const profile of catalog.unavailable.profiles) lines.push(...profileLines(profile))
  return lines
}

export const formatRunList = (catalog: RunListCatalog): string =>
  `${[...harnessLines(catalog), ...profileSection(catalog), ...unavailableSection(catalog)].join("\n")}\n`
