/** Expected parser outcomes from the declared input classes and CLI mode contract.
 * This does not call the production parser or learn expectations from its output.
 * Router dispatch, catalog resolution, and execution are separate obligations.
 */
export const guideParserRejection = (selection: Readonly<Record<string, string>>): string | undefined => {
  const present = (key: string) => selection[key] !== undefined && selection[key] !== "omitted"
  const any = (...keys: string[]) => keys.some(present)
  const invalid = (key: string, ...classes: string[]) => classes.includes(selection[key] ?? "omitted")
  if (any("--preview", "--forks")) return "preview options belong to a separate parser"
  if (invalid("--intent", "empty", "whitespace", "over-maximum", "control")) return "invalid intent"
  if (invalid("--profile", "empty", "over-maximum")) return "invalid profile text"
  if (invalid("--model", "empty", "over-maximum", "invalid")) return "invalid model"
  if (invalid("--effort", "invalid")) return "invalid effort"
  if (invalid("--ui-variant", "invalid")) return "invalid UI variant"
  if (invalid("--base", "empty", "over-maximum")) return "invalid review base"
  if (selection.positional === "extra") return "multiple positional arguments"
  if (present("--intent") && present("positional")) return "multiple intent sources"
  if (present("--intent-stdin") && any("--intent", "positional", "--json")) return "stdin intent conflict"
  if (present("--profile") && !present("--json")) return "profile requires JSON"
  if (present("--ui-variant") && present("--json")) return "UI variant is interactive"
  if (present("--base") && !present("--review")) return "base requires review"
  if (present("--engagement") && any("--json", "--next-steps", "--review", "--prompts", "--profile", "--ui-variant"))
    return "engagement mode conflict"
  if (present("--review") && any("--json", "--next-steps", "--engagement", "--prompts", "--profile", "--ui-variant"))
    return "review mode conflict"
  if (
    present("--optimize") &&
    any(
      "--review",
      "--json",
      "--next-steps",
      "--engagement",
      "--prompts",
      "--profile",
      "--intent",
      "positional",
      "--intent-stdin",
    )
  )
    return "optimize mode conflict"
  if (present("--next-steps") && any("--json", "--intent-stdin", "--intent", "positional", "--profile", "--ui-variant"))
    return "next steps mode conflict"
  if (any("--print", "--copy") && !present("--prompts")) return "ritual output requires ritual mode"
  if (present("--prompts")) {
    if (
      any(
        "--json",
        "--next-steps",
        "--engagement",
        "--review",
        "--optimize",
        "--profile",
        "--ui-variant",
        "--base",
        "--intent",
        "--intent-stdin",
      )
    )
      return "ritual mode conflict"
    if (present("--print") && present("--copy")) return "ritual output modes conflict"
    if (any("--print", "--copy") && !present("positional")) return "ritual output needs an ID"
    if (invalid("positional", "empty", "ritual-over-maximum")) return "invalid ritual ID"
  } else if (selection.positional === "empty") return "empty positional intent"
  return undefined
}
