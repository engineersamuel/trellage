import type { AdminProfileEntry } from "./admin-model.js"
import type { AdminHarnessVersionResult } from "./admin-harness-version.js"
import type { AdminSkillsCheckResult } from "./admin-skills-check.js"
import type { HarnessUpdateAllPlan } from "./admin-harness-update-all.js"
import type { HarnessUpdatePlan } from "./admin-harness-update.js"
import { harnessUpgradeAvailability } from "./admin-harness-update-preview.js"

export interface UpdateCheckIssue {
  readonly ref: string
  readonly diagnostic: string
}

export interface AdminUpdateSelection {
  readonly plan: HarnessUpdateAllPlan
  readonly issues: ReadonlyArray<UpdateCheckIssue>
  readonly harnessUpdateRefs: ReadonlySet<string>
  readonly skillUpdateRefs: ReadonlySet<string>
  readonly dependentSkillRefs: ReadonlySet<string>
  readonly sharedSkillsUpdate: boolean
}

const versionIssue = (entry: AdminProfileEntry, result: AdminHarnessVersionResult | undefined): UpdateCheckIssue => {
  if (result?.installed.kind === "unavailable") return { ref: entry.ref, diagnostic: result.installed.diagnostic }
  if (result?.latest.kind === "failed") return { ref: entry.ref, diagnostic: result.latest.diagnostic }
  return { ref: entry.ref, diagnostic: "Harness version could not be checked." }
}

const selectGroup = (group: HarnessUpdatePlan, wanted: ReadonlySet<string>): HarnessUpdatePlan | undefined => {
  const steps = group.steps
    .map((step) => ({ ...step, targets: step.targets.filter((entry) => wanted.has(entry.ref)) }))
    .filter((step) => step.targets.length > 0)
  const targets = group.targets.filter((entry) => wanted.has(entry.ref))
  return targets.length === 0 ? undefined : { ...group, targets, steps }
}

const collectHarnessUpdates = (
  full: HarnessUpdateAllPlan,
  versionResultFor: (entry: AdminProfileEntry) => AdminHarnessVersionResult | undefined,
  issues: Array<UpdateCheckIssue>,
): Set<string> => {
  const wanted = new Set<string>()
  for (const entry of full.groups.flatMap((group) => group.targets)) {
    const result = versionResultFor(entry)
    const availability = harnessUpgradeAvailability(entry, result)
    if (availability === "unknown") issues.push(versionIssue(entry, result))
    if (availability === "available") wanted.add(entry.ref)
  }
  return wanted
}

const collectSkillUpdates = (
  full: HarnessUpdateAllPlan,
  skillChecks: ReadonlyMap<string, AdminSkillsCheckResult>,
  issues: Array<UpdateCheckIssue>,
): Set<string> => {
  const profiles = new Map([
    ...full.groups.flatMap((group) => group.targets).map((entry) => [entry.ref, entry] as const),
    ...(full.skills?.targets ?? []).map((entry) => [entry.ref, entry] as const),
  ])
  const updates = new Set<string>()
  for (const ref of [...profiles.keys(), "skills:shared"]) {
    const check = skillChecks.get(ref)
    if (ref === "skills:shared" && check === undefined) continue
    if (check?.kind === "available") updates.add(ref)
    if (check?.diagnostic !== undefined) issues.push({ ref, diagnostic: check.diagnostic })
    else if (check === undefined || check.kind === "unknown") issues.push({ ref, diagnostic: "Skill update check did not complete." })
  }
  return updates
}

export const selectAvailableAdminUpdates = (
  full: HarnessUpdateAllPlan,
  versionResultFor: (entry: AdminProfileEntry) => AdminHarnessVersionResult | undefined,
  skillChecks: ReadonlyMap<string, AdminSkillsCheckResult>,
  routerCommandPath = full.skills?.refresh.executable ?? "trx",
): AdminUpdateSelection => {
  const issues: Array<UpdateCheckIssue> = full.unsupported.map(({ entry, diagnostic }) => ({ ref: entry.ref, diagnostic }))
  const harnessUpdateRefs = collectHarnessUpdates(full, versionResultFor, issues)
  const skillUpdateRefs = collectSkillUpdates(full, skillChecks, issues)
  const containerSkillRefs = full.groups
    .filter((group) => group.surface === "sandbox")
    .flatMap((group) => group.targets.filter((entry) => skillUpdateRefs.has(entry.ref)).map((entry) => entry.ref))
  const wanted = new Set([...harnessUpdateRefs, ...containerSkillRefs])
  const groups = full.groups.map((group) => selectGroup(group, wanted)).filter((group): group is HarnessUpdatePlan => group !== undefined)
  const dependentSkillRefs = new Set(
    groups.filter((group) => group.surface === "native").flatMap((group) => group.targets.map((entry) => entry.ref)),
  )
  const targets = full.skills?.targets.filter((entry) => skillUpdateRefs.has(entry.ref) || dependentSkillRefs.has(entry.ref)) ?? []
  const sharedSkillsUpdate = skillUpdateRefs.has("skills:shared")
  const skills =
    targets.length > 0 || sharedSkillsUpdate
      ? { refresh: full.skills?.refresh ?? { executable: routerCommandPath, args: ["skills", "update"] }, targets }
      : undefined
  return {
    plan: {
      groups,
      skills,
      unsupported: [],
      profileCount: groups.reduce((count, group) => count + group.targets.length, 0),
      nativeUpdateCount: groups.filter((group) => group.surface === "native").reduce((count, group) => count + group.steps.length, 0),
      containerUpdateCount: groups.filter((group) => group.surface === "sandbox").reduce((count, group) => count + group.steps.length, 0),
    },
    issues,
    harnessUpdateRefs,
    skillUpdateRefs,
    dependentSkillRefs,
    sharedSkillsUpdate,
  }
}

export const hasSelectedAdminUpdates = (plan: HarnessUpdateAllPlan): boolean => plan.groups.length > 0 || plan.skills !== undefined
