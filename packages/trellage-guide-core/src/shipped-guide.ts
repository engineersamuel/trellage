import { readFile } from "node:fs/promises"
import path from "node:path"
import { parse } from "smol-toml"
import { record } from "./validation.ts"
import { parseSelectionMetadata } from "./run-selection.ts"
import { assembleProfileGuide, parseProfileInstructions, type AuthoredWorkflow } from "./profile-instructions.ts"
import type {
  ProfileGuideDocument,
  ProfileGuideIdentity,
  ProfileGuideGoalExecution,
  ProfileGuidePrerequisite,
} from "./index.ts"

/** Legacy inventory readers still address shipped documents by identity. Their metadata now comes from TOML. */
export const loadShippedProfileGuide = async (
  root: string,
  identity: ProfileGuideIdentity,
  source: string,
): Promise<ProfileGuideDocument> => {
  const candidates = [
    path.resolve(root, "../config.example.toml"),
    path.resolve(root, "../../source/config.example.toml"),
  ]
  let configSource: string | undefined
  for (const file of candidates) {
    try {
      configSource = await readFile(file, "utf8")
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  if (configSource === undefined) throw new Error("shipped guide metadata requires config.example.toml")
  const config = record(parse(configSource), "config")
  const profiles = record(record(config.native, "native").profiles, "profiles")
  const key =
    identity.surface === "native"
      ? identity.profile === "firstmate"
        ? "firstmate"
        : `preset-${identity.harness}-${identity.profile}`
      : identity.profile
  const profile = record(profiles[key], key)
  const guide = record(profile.guide, `${key}.guide`)
  const workflows = decodeAuthoredWorkflows(guide.workflows)
  const instructions = parseProfileInstructions(source, key)
  return {
    guide: assembleProfileGuide(
      parseSelectionMetadata(profile.selection ?? {}, `${key}.selection`),
      workflows,
      instructions,
      {
        identity,
        workflowsDeclared: guide.workflows !== undefined,
        prerequisites: (guide.prerequisites ?? []) as ReadonlyArray<ProfileGuidePrerequisite>,
        ...(guide.goal_execution === undefined ? {} : { goalExecution: decodeGoalExecution(guide.goal_execution) }),
      },
    ),
    body: instructions.body,
  }
}

export const decodeAuthoredWorkflows = (value: unknown): ReadonlyArray<AuthoredWorkflow> => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("guide.workflows must be an array")
  return value.map((value) => {
    const fields = record(value, "workflow")
    const { launch_agent, interaction, ...workflow } = fields
    return {
      ...workflow,
      ...(launch_agent === undefined ? {} : { launchAgent: launch_agent }),
      ...(interaction === undefined
        ? {}
        : {
            interaction: {
              mode: record(interaction, "interaction").mode,
              requiredSkills: record(interaction, "interaction").required_skills,
            },
          }),
    } as unknown as AuthoredWorkflow
  })
}
export const decodeGoalExecution = (value: unknown): ProfileGuideGoalExecution => {
  const fields = record(value, "goal_execution")
  return { controller: fields.controller, workflowIds: fields.workflow_ids } as ProfileGuideGoalExecution
}
