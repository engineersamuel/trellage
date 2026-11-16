// Tournament presets: what the variants are, which files a build must write, which screenshots the judges see, and
// the aspects they score. Contracts with code, so they live here; the text models read is in
// prompts/tournament/<preset>/ (brief, build, judge, checks/, and scout for source tournaments).

/** One screenshot: a page at a viewport size from config (home = tall desktop). */
export type ShotSpec = {
  page: string
  viewport: "desktop" | "mobile"
  size: "home" | "desktop" | "mobile"
  /** The whole page, not one screen (sections the brief asks for sit below the first screen). */
  full?: boolean
}

export type Preset = {
  id: string
  title: string
  /** sources: each variant is a skill source a scout reads. approaches: the sub-coordinator writes each variant. */
  variants: "sources" | "approaches"
  /** Files a build must write at the top of its folder. */
  pages: string[]
  shots: ShotSpec[]
  /** The keys a judge scores 1-10; each counts the same (tournament.ts voteValue). */
  aspects: string[]
  /** The baseline's build gets no direction beyond the brief. */
  baselineLabel: string
  /** The build's asset the leaderboard opens: a page served live (html) or a file to download. */
  asset: { file: string; kind: "html" | "file" }
}

export const PRESETS: Record<string, Preset> = {
  "ui-skills": {
    id: "ui-skills",
    title: "UI skills",
    variants: "sources",
    pages: ["index.html", "products.html", "product.html", "cart.html"],
    shots: [
      { page: "index.html", viewport: "desktop", size: "home" },
      { page: "products.html", viewport: "desktop", size: "desktop" },
      { page: "product.html", viewport: "desktop", size: "desktop", full: true },
      { page: "cart.html", viewport: "desktop", size: "desktop" },
      { page: "index.html", viewport: "mobile", size: "mobile" },
    ],
    aspects: [
      "typography",
      "color",
      "layout",
      "hierarchy",
      "spacing",
      "consistency",
      "imagery",
      "accessibility",
      "responsiveness",
      "commerce_clarity",
      "distinctiveness",
    ],
    baselineLabel: "No skill (baseline)",
    asset: { file: "index.html", kind: "html" },
  },
  prototypes: {
    id: "prototypes",
    title: "Prototypes of an idea",
    variants: "approaches",
    pages: ["index.html"],
    shots: [
      { page: "index.html", viewport: "desktop", size: "home" },
      { page: "index.html", viewport: "desktop", size: "desktop" },
      { page: "index.html", viewport: "mobile", size: "mobile" },
    ],
    aspects: [
      "concept",
      "usefulness",
      "usability",
      "clarity",
      "visual_design",
      "interaction",
      "feasibility",
      "delight",
    ],
    baselineLabel: "No direction (baseline)",
    asset: { file: "index.html", kind: "html" },
  },
}

export const presetOf = (id: string): Preset => {
  const p = PRESETS[id]
  if (!p) throw new Error(`unknown tournament preset ${id}; one of ${Object.keys(PRESETS).join(", ")}`)
  return p
}

/** Prompt file of a preset, e.g. tournament/ui-skills/judge. */
export const presetPrompt = (preset: string, name: string) => `tournament/${preset}/${name}`
