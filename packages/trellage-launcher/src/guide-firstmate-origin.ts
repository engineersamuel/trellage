import {
  firstmateWorktreeBindingDigest, sameFirstmateInstance, validateFirstmateInstanceControlContextV1,
  type FirstmateInstanceControlContextV1,
} from "@trellage/guide-core"
import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import { parseSelectedProfile, type CommandRunner } from "./guide-launch.ts"
import { createFirstmateInstancesClient } from "./guide-firstmate-instances.ts"

/** A private launch hint is not a target, selection, or replacement for snapshot.source.cwd. */
export const verifiedFirstmateOriginCwd = async (
  runner: CommandRunner, catalog: CombinedGuideCatalog, cwd: string,
  origin: FirstmateInstanceControlContextV1, signal?: AbortSignal,
): Promise<string> => {
  const entry = catalog.native.find(({ launcher, name }) => launcher === "fmx" && name === origin.reference.profile)
  if (entry?.orchestration?.instances === undefined) throw new Error("The captured Firstmate origin cannot be verified. Choose an explicit existing worktree.")
  const profile = parseSelectedProfile({
    surface: "native", launcher: "fmx", commandPath: entry.commandPath, profile: entry.name,
    headlessPrompt: entry.headless.prompt, orchestration: entry.orchestration,
  })
  if (profile.surface !== "native") throw new Error("Firstmate origin requires a Native profile.")
  const client = createFirstmateInstancesClient(runner, profile, cwd)
  const options = signal === undefined ? {} : { signal }
  const descriptors = await client.list(options)
  const owner = descriptors.find(({ reference }) => reference !== null && sameFirstmateInstance(reference, origin.reference))
  if (owner === undefined) throw new Error("The captured origin no longer identifies an owned instance. Runtime cwd is not a fallback.")
  validateFirstmateInstanceControlContextV1(origin, owner)
  const evidence = origin.entryWorktree
  if (evidence === null || descriptors.some(({ root }) =>
    evidence.locators.worktree === root || evidence.locators.worktree.startsWith(`${root}/`))) {
    throw new Error("The captured origin is not a project worktree. Choose an explicit existing worktree.")
  }
  const resolved = await client.resolve(evidence.locators.worktree, options)
  if (resolved.state === "blocked" || resolved.worktree === null ||
      firstmateWorktreeBindingDigest(evidence) !== firstmateWorktreeBindingDigest(resolved.worktree)) {
    throw new Error("Captured entry-worktree evidence changed. No replacement worktree or runtime cwd was selected.")
  }
  return evidence.locators.worktree
}
