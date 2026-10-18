import type { ListedProfile, RunListCatalog } from "./run-list-catalog.ts"
import type { SelectionMetadata } from "@trellage/guide-core"

export const RUN_LIST_USAGE =
  "Usage: trx run list [--json]\nLists separate harness and profile sets with local readiness and selection guidance.\nNo agents, setup, credential helpers, or network calls are run."
export const parseRunListArguments = (argv: ReadonlyArray<string>): { format: "text" | "json"; help: boolean } => {
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
const profileLines = (profile: ListedProfile): string[] => [
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
export const formatRunList = (catalog: RunListCatalog): string => {
  const lines = ["Harnesses (local checks only; authentication and service reachability unverified)"]
  if (!catalog.harnesses.length) lines.push("  None ready")
  for (const harness of catalog.harnesses)
    lines.push(
      "",
      `${harness.id} — ${harness.selection.description ?? "No description"}${harness.metadataStatus === "incomplete" ? " [metadata incomplete]" : ""}`,
      ...guidance(harness.selection, "  "),
      `  Sandbox: ${harness.sandbox === null ? "unknown" : harness.sandbox ? "yes" : "no"}`,
    )
  lines.push("", "Profiles")
  for (const profile of catalog.profiles) lines.push("", ...profileLines(profile))
  if (!catalog.profiles.length) lines.push("  None ready")
  lines.push("", "Unavailable harnesses")
  if (!catalog.unavailable.harnesses.length) lines.push("  None")
  for (const harness of catalog.unavailable.harnesses)
    lines.push(
      `${harness.id} — ${harness.selection.description ?? "No description"}`,
      ...harness.readiness.reasons.map((reason) => `  ${reason.code}: ${reason.message}`),
    )
  lines.push("", "Unavailable profiles")
  if (!catalog.unavailable.profiles.length) lines.push("  None")
  for (const profile of catalog.unavailable.profiles) lines.push(...profileLines(profile))
  return lines.join("\n") + "\n"
}
