import { canonicalJson, exactKeys, fail, identifier, record, text } from "./validation.ts"
import {
  parseProfileFrontmatter,
  validateProfileWorkflows,
  profileGuideGoalExecutionProblem,
  isProfileGuideGoalController,
  type ProfileGuideV1,
  type ProfileGuideWorkflow,
  type ProfileGuideGoalExecution,
  type ProfileGuideIdentity,
  type ProfileGuidePrerequisite,
} from "./index.ts"
import { parseSelectionProjection, type SelectionMetadata } from "./run-selection.ts"

export type AuthoredWorkflow = Omit<ProfileGuideWorkflow, "promptTemplate">
export interface ProfileInstructions {
  readonly schemaVersion: 2
  readonly templates: Readonly<Record<string, string>>
  readonly body: string
}
export interface ResolvedProfileGuideV2 extends ProfileGuideV1 {
  readonly schemaVersion: 2
  readonly selection: SelectionMetadata
  readonly genericWorkflow: boolean
}
export interface ProfileGuideAssemblyPolicy {
  readonly identity: ProfileGuideIdentity
  readonly prerequisites?: ReadonlyArray<ProfileGuidePrerequisite>
  readonly goalExecution?: ProfileGuideGoalExecution
  readonly workflowsDeclared?: boolean
}

export const parseProfileInstructions = (source: string, label: string): ProfileInstructions => {
  const parsed = parseProfileFrontmatter(label, source)
  const fields = record(parsed.value, label)
  exactKeys(fields, label, ["schemaVersion", "templates"])
  if (fields.schemaVersion !== 2) fail(label, "instruction schemaVersion must equal 2")
  const templates = Object.fromEntries(
    Object.entries(record(fields.templates, `${label}.templates`)).map(([id, value]) => {
      identifier(id, `${label}.templates`)
      const template = text(value, `${label}.templates.${id}`, 16000, { multiline: true })
      if (template.split("{{intent}}").length !== 2)
        fail(label, "template must contain exactly one {{intent}} placeholder")
      for (const match of template.matchAll(/\{\{([^{}]+)\}\}/gu))
        if (match[1] !== "intent") fail(label, "unsupported template placeholder")
      return [id, template]
    }),
  )
  return { schemaVersion: 2, templates, body: parsed.body }
}

export const validateResolvedProfileGuide = (
  value: unknown,
  identity: ProfileGuideIdentity,
): ResolvedProfileGuideV2 => {
  const fields = record(value, "guide")
  exactKeys(
    fields,
    "guide",
    [
      "schemaVersion",
      "selection",
      "genericWorkflow",
      "capabilities",
      "bestFor",
      "avoidFor",
      "prerequisites",
      "workflows",
    ],
    ["goalExecution"],
  )
  if (fields.schemaVersion !== 2 || typeof fields.genericWorkflow !== "boolean" || !Array.isArray(fields.workflows))
    return fail("guide", "invalid resolved guide")
  if (!Array.isArray(fields.prerequisites) || fields.prerequisites.length > 32)
    return fail("guide.prerequisites", "must be a bounded array")
  const prerequisites = fields.prerequisites.map((item, index) => {
    const fields = record(item, `prerequisite ${index}`)
    exactKeys(fields, "prerequisite", ["id", "description"])
    return {
      id: identifier(fields.id, "prerequisite.id"),
      description: text(fields.description, "prerequisite.description", 1000),
    }
  })
  const workflows = fields.workflows as ProfileGuideWorkflow[]
  const resolved = assembleProfileGuide(
    parseSelectionProjection(fields.selection, "guide.selection"),
    fields.genericWorkflow ? [] : workflows.map(({ promptTemplate: _template, ...workflow }) => workflow),
    {
      schemaVersion: 2,
      templates: Object.fromEntries(workflows.map((workflow) => [workflow.id, workflow.promptTemplate])),
      body: "",
    },
    {
      identity,
      workflowsDeclared: !fields.genericWorkflow,
      prerequisites,
      ...(fields.goalExecution === undefined
        ? {}
        : { goalExecution: fields.goalExecution as ProfileGuideGoalExecution }),
    },
  )
  if (canonicalJson(resolved) !== canonicalJson(value))
    return fail("guide", "resolved fields differ from authoritative selection or workflow policy")
  return resolved
}

export const assembleProfileGuide = (
  selection: SelectionMetadata,
  workflows: ReadonlyArray<AuthoredWorkflow>,
  instructions: ProfileInstructions | undefined,
  policy: ProfileGuideAssemblyPolicy,
): ResolvedProfileGuideV2 => {
  const generic = workflows.length === 0 && !policy.workflowsDeclared
  if (!generic && workflows.length === 0) fail("guide.workflows", "explicit workflows must not be empty")
  const resolved: ReadonlyArray<ProfileGuideWorkflow> = generic
    ? [
        {
          id: "task",
          description: "Perform the requested task with this profile.",
          examples: [],
          promptTemplate: "{{intent}}",
        },
      ]
    : validateProfileWorkflows(
        workflows.map((workflow) => ({
          ...workflow,
          promptTemplate: instructions?.templates[workflow.id],
        })),
        "guide.workflows",
      )
  if (
    resolved.some((workflow) => workflow.interaction !== undefined) &&
    !(
      policy.identity.surface === "native" &&
      policy.identity.launcher === "copilot" &&
      policy.identity.profile === "hve"
    )
  ) {
    fail("guide.workflows", "verified interactive workflows require native/copilot/hve")
  }
  if (policy.goalExecution !== undefined) {
    const execution = record(policy.goalExecution, "guide.goalExecution")
    exactKeys(execution, "guide.goalExecution", ["controller", "workflowIds"])
    if (
      !isProfileGuideGoalController(execution.controller) ||
      !Array.isArray(execution.workflowIds) ||
      execution.workflowIds.length < 1 ||
      execution.workflowIds.length > 32
    )
      return fail("guide.goalExecution", "requires a supported controller and 1 to 32 workflow IDs")
    const ids = execution.workflowIds.map((id) => identifier(id, "guide.goalExecution.workflowIds"))
    if (new Set(ids).size !== ids.length) return fail("guide.goalExecution.workflowIds", "must contain unique IDs")
    if (generic) fail("guide.goalExecution", "generic workflows have no goal controller")
    const problem = profileGuideGoalExecutionProblem(policy.goalExecution, resolved, policy.identity)
    if (problem !== undefined) fail("guide.goalExecution", problem)
  }
  return {
    schemaVersion: 2,
    selection,
    genericWorkflow: generic,
    capabilities: selection.capabilities ?? [],
    bestFor: selection.bestFor ?? [],
    avoidFor: selection.avoidFor ?? [],
    prerequisites: policy.prerequisites ?? [],
    workflows: resolved,
    ...(policy.goalExecution === undefined ? {} : { goalExecution: policy.goalExecution }),
  }
}
