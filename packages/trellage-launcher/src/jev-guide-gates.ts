import type { GuideOptimizeInput } from "./guide-provider.ts"
import { askJevNouls, askJevNoul, type JevDecisionOptions } from "./jev-decisions.ts"

const reportFallback = (onNotice: ((message: string) => void) | undefined): void => {
  const message = "Jev decision unavailable; continuing with the existing LLM step."
  if (onNotice === undefined) process.stderr.write(`${message}\n`)
  else onNotice(message)
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError"

export const jevShouldSkipPromptOptimization = async (
  input: GuideOptimizeInput,
  taskIntent: string,
  options: JevDecisionOptions,
  onNotice?: (message: string) => void,
): Promise<boolean> => {
  try {
    const scores = await askJevNouls(
      options,
      {
        intent: taskIntent,
        originalIntent: input.originalIntent ?? null,
        profileRef: input.profileRef,
        targetTool: input.targetTool,
        candidates: input.candidates.map(({ title, prompt }) => ({ title, prompt })),
      },
      Object.fromEntries(
        input.candidates.map((candidate, index) => [
          `candidate${index}`,
          {
            instructions: `Would Prompt Master make a material improvement to candidate ${index + 1} while preserving the stated intent and selected workflow?`,
            criteria: {
              true: "The prompt has a clear, material gap in task coverage, clarity, or workflow fit that Prompt Master should fix.",
              false:
                "The prompt is already clear, complete, distinct, and aligned with the requested task and selected workflow.",
            },
          },
        ]),
      ),
    )
    return Object.values(scores).every((needsOptimization) => needsOptimization <= 0.03)
  } catch (error) {
    if (isAbort(error)) throw error
    reportFallback(onNotice)
    return false
  }
}

export const jevIntentNeedsRepositoryContext = async (
  intent: string,
  options: JevDecisionOptions,
  onNotice?: (message: string) => void,
  signal?: AbortSignal,
): Promise<boolean> => {
  try {
    const probability = await askJevNoul(
      options,
      { intent },
      "Does this request need concrete facts from the current repository to make its meaning or target clear before profile matching?",
      {
        true: "The request is ambiguous or repository-specific; source paths, symbols, project structure, or local conventions are needed to clarify it.",
        false: "The request is already clear enough for profile matching without reading repository contents.",
      },
      signal,
    )
    return probability > 0.02
  } catch (error) {
    if (isAbort(error)) throw error
    reportFallback(onNotice)
    return true
  }
}
