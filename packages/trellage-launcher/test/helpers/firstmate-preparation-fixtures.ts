import {
  parseFirstmateFleetReadinessV1,
  parseFirstmateOrchestrationV1,
  parseFirstmatePrerequisiteInstallPlanV1,
  type FirstmateFleetReadinessV1,
  type FirstmatePrerequisiteInstallPlanV1,
} from "@trellage/guide-core"
import type { NativeSelectedProfile } from "../../src/guide-launch.ts"

export const preparationRevision = "b".repeat(40)

export const preparationPlan = parseFirstmatePrerequisiteInstallPlanV1({
  identity: "d".repeat(64),
  destination: "/fixture/private-managed-tools/current",
  tools: [{ name: "herdr", version: "0.14.0" }, { name: "bv", version: "0.9.3" }],
  sources: ["https://fixture.example/herdr/v0.14.0", "https://fixture.example/bv/v0.9.3"],
  statePaths: ["/fixture/private-state/herdr", "/fixture/private-state/bv"],
})

export const preparationProfile = (profile = "default"): NativeSelectedProfile => ({
  surface: "native",
  launcher: "fmx",
  profile,
  commandPath: "/fixture/managed launchers/fmx",
  headlessPrompt: false,
  orchestration: parseFirstmateOrchestrationV1({
    schemaVersion: 1, kind: "firstmate", sourceRevision: preparationRevision,
    taskIdPrefix: profile === "default" ? "fmd" : "fmp",
    workerPolicy: null, workerHarness: "claude", workerEfforts: ["low", "medium", "high"],
    dispatchRules: "claude-single",
    submission: { schemaVersion: 1, maxRequestBytes: 524288 },
    preparation: { schemaVersion: 1 },
  }),
})

export const preparedFleet = (
  profile = "default",
  state: "running" | "stopped" | "stale" = "stale",
): FirstmateFleetReadinessV1 => parseFirstmateFleetReadinessV1({
  schemaVersion: 1,
  identity: {
    profile, instanceId: "00000000-0000-4000-8000-000000000001",
    home: `/fixture/private-owned-fleet/${profile}`, sourceRevision: preparationRevision,
  },
  runtime: "ready", backend: "tmux",
  supervisor: { state, pid: state === "running" ? 312 : null },
  activeWorkers: 0,
  prerequisites: [
    { id: "claude", ready: true, status: "ready", description: "Claude authentication is ready." },
    { id: "github", ready: true, status: "ready", description: "GitHub authentication is ready." },
    { id: "fleet-tools", ready: true, status: "ready", description: "Verified managed tools are ready." },
    { id: "worker-controls", ready: true, status: "ready", description: "Worker controls are ready." },
    { id: "skills", ready: true, status: "ready", description: "Shared skills are ready." },
    { id: "backend", ready: true, status: "ready", description: "tmux is ready." },
  ],
  consentRequired: false,
  actions: {
    start: { allowed: state === "stopped", reason: state === "stopped" ? null : "Choose Recover fleet for the stale supervisor, or Send work if it is running." },
    recover: { allowed: state === "stale", reason: state === "stale" ? null : "Recovery requires a stale owned supervisor." },
    submit: { allowed: true, reason: null },
  },
  preparation: {
    schemaVersion: 1, state: "ready", diagnostic: null, installation: null,
    repairs: ["Reused the verified managed-tool cache."],
  },
})

export const missingToolsFleet = (
  profile = "default",
  installation: FirstmatePrerequisiteInstallPlanV1 = preparationPlan,
): FirstmateFleetReadinessV1 => {
  const fleet = preparedFleet(profile)
  const diagnostic = `Missing managed tools: ${installation.tools.map(({ name, version }) => `${name} ${version}`).join(", ")}.`
  const reason = "Existing tools, authentication, skills and backend must already be ready; inventory never installs them."
  return parseFirstmateFleetReadinessV1({
    ...fleet,
    prerequisites: fleet.prerequisites.map((item) =>
      item.id === "fleet-tools" ? { ...item, ready: false, status: "blocked", description: diagnostic } : item),
    actions: {
      start: { allowed: false, reason },
      recover: { allowed: false, reason },
      submit: { allowed: true, reason: null },
    },
    preparation: {
      schemaVersion: 1, state: "needs-consent", diagnostic,
      repairs: ["Repaired the owned idle profile configuration."],
      installation,
    },
  })
}

export const preparationInventory = (fleet: FirstmateFleetReadinessV1): string => JSON.stringify({
  schemaVersion: 1, launcher: "fmx", profile: fleet.identity?.profile ?? "default", readiness: "unhealthy", fleet,
})
