import { parseFirstmateOrchestrationV1, type FirstmateOrchestrationV1 } from "@trellage/guide-core"

export type GuideTaskOrchestration = FirstmateOrchestrationV1 | Omit<FirstmateOrchestrationV1, "taskIdPrefix">

export const guideTaskOrchestration = (value: GuideTaskOrchestration): GuideTaskOrchestration => {
  // A fixed validation placeholder is never a runtime namespace or model field.
  const projected = value !== null && typeof value === "object" && value.instances !== undefined && !("taskIdPrefix" in value)
  const parsed = parseFirstmateOrchestrationV1(projected ? { ...value, taskIdPrefix: "runtime" } : value)
  if (parsed.instances === undefined) return parsed
  const { taskIdPrefix: _legacyPrefix, ...modelControls } = parsed
  return modelControls
}
