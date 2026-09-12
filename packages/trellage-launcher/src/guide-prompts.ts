import { readFile } from "node:fs/promises"

export interface GuideModelPrompts {
  readonly match: string
  readonly generate: string
  readonly refine: string
  readonly optimize: string
  readonly enrich: string
}

export const loadDefaultGuidePrompts = async (): Promise<GuideModelPrompts> => {
  const [match, generate, refine, optimize, enrich] = await Promise.all([
    readFile(new URL("../prompts/match.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/generate.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/refine.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/optimize.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/enrich.md", import.meta.url), "utf8"),
  ])
  return { match, generate, refine, optimize, enrich }
}
