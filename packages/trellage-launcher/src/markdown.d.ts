/**
 * Ambient module declaration for statically imported Markdown prompt sources
 * (`../prompts/*.md`). The `trellage-launcher` production build bundles
 * `src/cli.tsx` with esbuild's `--loader:.md=text`, so a plain `import`
 * resolves to the file's raw text content at build time. This declaration
 * only affects type-checking (`tsc --noEmit`); it has no runtime behavior.
 */
declare module "*.md" {
  const content: string
  export default content
}
