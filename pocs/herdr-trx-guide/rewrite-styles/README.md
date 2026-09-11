# Rewrite style sources

These Markdown files are writing references loaded by the rewrite worker, not
installed agent skills. The plugin reads only the selected reference; opening
the picker does not fetch upstream content. The source-specific licenses in
[licenses/](licenses/) apply to the references, independently of the launcher
code. In particular, `spartan.md` and `attention-kind.md` retain their upstream
AGPL-3.0 license. Their Markdown source is included here without modification.

**TL&DR Rundown** reads the user's `~/.claude/output-styles/rundown.md` directly;
that local file is not copied into this repository. Its upstream is
[alexgreensh/attention-span](https://github.com/alexgreensh/attention-span).

Ponytail and Caveman retain their existing inline instructions. The catalog in
[`../lib/rewrite-styles.ts`](../lib/rewrite-styles.ts) supplies display names,
short descriptions, and the rewrite-only adapter for all other references.

Reviewed 2026-09-11. Files were fetched from the repositories' default branches at
the commit SHAs below. Raw file URLs are stable when the SHA is substituted for
`HEAD`.

| Requested styles | Repository / commit | Exact upstream file | License |
|---|---|---|---|
| Military, BLUF, Reality Check, First Principles | [bsquang/claude-comstyle](https://github.com/bsquang/claude-comstyle) `3fb4c41965000f3a282a7fb23b6114d512430f4b` | [skills/style-switcher/SKILL.md](https://github.com/bsquang/claude-comstyle/blob/3fb4c41965000f3a282a7fb23b6114d512430f4b/skills/style-switcher/SKILL.md), prompts at lines 59-64, 72-78, 93-100, 138-143 | Unlicense / public-domain dedication ([LICENSE](https://github.com/bsquang/claude-comstyle/blob/3fb4c41965000f3a282a7fb23b6114d512430f4b/LICENSE)) |
| STE English | [danyuchn/asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill) `7d4a135a199a5d7447c4886bcd7ffe742a627bc9` | [SKILL.md](https://github.com/danyuchn/asd-ste100-skill/blob/7d4a135a199a5d7447c4886bcd7ffe742a627bc9/SKILL.md), plus delegated [references/writing-rules.md](https://github.com/danyuchn/asd-ste100-skill/blob/7d4a135a199a5d7447c4886bcd7ffe742a627bc9/references/writing-rules.md) | MIT for repo code/content; SKILL itself says ASD-STE100 Issue 9 dictionary is not redistributed and points to [official downloads](https://www.asd-ste100.org/STE_downloads.html) |
| no-slop, no-ai-slop, unslop, wait-what, eli15, ladder, analogy-engine, yoda | [smixs/awesome-claude-output-styles](https://github.com/smixs/awesome-claude-output-styles) `52bc415c6c1b4b44047fc8c17158e5b85a054261` | [output-styles/](https://github.com/smixs/awesome-claude-output-styles/tree/52bc415c6c1b4b44047fc8c17158e5b85a054261/output-styles) and the individual files staged here | MIT. LICENSE preserves credits for adapted styles, including Matt Pocock, Julius Brussee, Carlos Duplá, ayghri, Amin Boulegroun, Peter Yang, and Lauren Tan. |
| Spartan, Attention-kind | [alexgreensh/attention-span](https://github.com/alexgreensh/attention-span) `2714c965e6be1fa2597510e66651e63bc67cb448` | [output-styles/spartan.md](https://github.com/alexgreensh/attention-span/blob/2714c965e6be1fa2597510e66651e63bc67cb448/output-styles/spartan.md), [output-styles/attention-kind.md](https://github.com/alexgreensh/attention-span/blob/2714c965e6be1fa2597510e66651e63bc67cb448/output-styles/attention-kind.md) | AGPL-3.0 ([LICENSE](https://github.com/alexgreensh/attention-span/blob/2714c965e6be1fa2597510e66651e63bc67cb448/LICENSE)); retain license/attribution if redistributing substantial text |
| Humanizer | [blader/humanizer](https://github.com/blader/humanizer) `9862685f575c65a8247f90369951df1b3416e3d6` | [SKILL.md](https://github.com/blader/humanizer/blob/9862685f575c65a8247f90369951df1b3416e3d6/SKILL.md) | MIT, copyright Siqi Chen 2025 |
| Avoid AI Writing | [conorbronsdon/avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing) `8ed577651c63207ee38fd6b362714feae6ed141c` | [skills/avoid-ai-writing/SKILL.md](https://github.com/conorbronsdon/avoid-ai-writing/blob/8ed577651c63207ee38fd6b362714feae6ed141c/skills/avoid-ai-writing/SKILL.md) | MIT, copyright Conor Bronsdon 2026 |

## Adaptations for the rewrite popup

- `military.md`, `bluf.md`, `reality-check.md`, and `first-principles.md` extract
  only the corresponding prompt from the comstyle skill. The interactive
  style-switching workflow is omitted because the popup already selects a style.
- `ste-english.md` combines the complete upstream `SKILL.md` and
  `references/writing-rules.md`. This is STE writing guidance, not validation
  against the official ASD dictionary, which the upstream skill does not include.
- `avoid-ai-writing.md` combines the complete upstream `SKILL.md` and required
  [`references/patterns.md`](https://github.com/conorbronsdon/avoid-ai-writing/blob/8ed577651c63207ee38fd6b362714feae6ed141c/skills/avoid-ai-writing/references/patterns.md).
  The model applies the writing rules; script execution, file editing, and audit
  reports are outside the popup's rewrite-only behavior.
- Humanizer and the packaged output styles are otherwise copied verbatim.
  The packaged `no-ai-slop` and `unslop` files preserve their Peter Yang and
  Lauren Tan credits. Yoda uses the packaged plain-answer-first version.
- All references fit within the worker's 256 KiB read limit. Their full effective
  contents participate in cache invalidation. Update the source links and license
  notices with any future refresh of these bundled references.
