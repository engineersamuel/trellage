import { readFile } from "node:fs/promises"

export interface GuideModelPrompts {
  readonly match: string
  readonly generate: string
  readonly refine: string
  readonly optimize: string
  readonly enrich: string
  /** System prompt of the Firstmate augmenter; it runs on the enrich model route. */
  readonly firstmate?: string
}

export const loadDefaultGuidePrompts = async (): Promise<GuideModelPrompts> => {
  const [match, generate, refine, optimize, enrich, firstmate] = await Promise.all([
    readFile(new URL("../prompts/match.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/generate.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/refine.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/optimize.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/enrich.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/firstmate.md", import.meta.url), "utf8"),
  ])
  return { match, generate, refine, optimize, enrich, firstmate }
}
