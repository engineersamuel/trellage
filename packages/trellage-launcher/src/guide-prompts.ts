/**
 * Loads the authored match/generate/refine prompt instructions for the `trx
 * guide` model-backed core. `CopilotGuideProvider` accepts these as an
 * injectable constructor option so tests never need real Markdown I/O or a
 * bundler; this module is the "load" half of "load or accept them" — the
 * default, used only when a caller does not supply its own prompts.
 *
 * The imports below are dynamic and only resolved when this function is
 * actually invoked, so importing this module (or `copilot-guide-provider.ts`,
 * which never imports it eagerly) does not require a `.md` loader. The
 * production build of `src/cli.tsx` bundles with esbuild's
 * `--loader:.md=text`, so at runtime in the built `dist/launcher.mjs` these
 * resolve to the files' raw text content.
 */

export interface GuideModelPrompts {
  readonly match: string
  readonly generate: string
  readonly refine: string
  readonly optimize: string
}

export const loadDefaultGuidePrompts = async (): Promise<GuideModelPrompts> => {
  const [match, generate, refine, optimize] = await Promise.all([
    import("../prompts/match.md"),
    import("../prompts/generate.md"),
    import("../prompts/refine.md"),
    import("../prompts/optimize.md"),
  ])
  return { match: match.default, generate: generate.default, refine: refine.default, optimize: optimize.default }
}
