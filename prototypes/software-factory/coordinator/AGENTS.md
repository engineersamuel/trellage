# Factory coordinator agent guide

Prompts, models, thresholds and catalogs are data, not code. Change them in files; change code only for behavior.

## Where things live

| What | Shipped default | User override (wins) |
|---|---|---|
| Models, thresholds, lenses, gates, research workflows, steps | `defaults/config.toml` | `~/.config/trellage/factory/config.toml` |
| Prompt text (system prompts, worker tasks, Jev questions) | `defaults/prompts/<name>.md` | `~/.config/trellage/factory/prompts/<name>.md` |
| Human decision rules (Jev shadow mode) | none | `~/.config/trellage/factory/INSTRUCTIONS.md` |
| UI and agent runtime settings (theme, coordinator model, crons) | `src/settings.ts` | `$SF_STATE_DIR/settings.json` (UI, `update_settings`) |
| Claude/Pi profiles that steps run | trx presets | `[native.profiles]` in `~/.config/trellage/config.toml` |
| Restart-only: port, auth, state dir, proxy URL | env `SF_*` | env `SF_*` |

- `src/config.ts`: schema, merge (tables merge key by key, arrays replace), file watch, last-good fallback, per-run
  snapshots, trx profile check (at worker spawn). `SF_CONFIG` points at another user file.
- `src/prompt.ts`: loads and renders prompt templates. `src/prompts.ts`: system prompt accessors.
- The env vars `SF_MODEL`, `SF_REVIEW_MODEL`, `SF_SECURITY_MODEL` still override the config models.

## Reload rules

- Config file: watched; a valid edit applies at once, an invalid one keeps the last good config and logs the error.
- Prompt files: read on every use; a broken user prompt falls back to the shipped one (`promptErrors`).
- A delivery run pins the config at its first `sdlc_plan` (`Sdlc.configId`, saved under
  `$SF_STATE_DIR/config-snapshots/`). Gates, review lenses and thresholds, review models and the fix-round limit of
  that run use the pinned copy. New runs use the latest.
- A running worker keeps the system prompt it started with. The Factory desk reads its prompt at factory start.

## Template syntax

- `{{name}}` inserts a value. `{{#name}}...{{/name}}` keeps the body when the value is truthy; `{{^name}}...{{/name}}`
  when it is not. Inserted values are never scanned again.
- Every scalar of the config is a variable as `{{section.key}}`, e.g. `{{review.rereview_lines}}`,
  `{{sdlc.max_fix_rounds}}`. A prompt that states a number the code also uses MUST use the placeholder, never a literal.
- An unknown name is an error. The variables a prompt gets are the keys passed to `loadPrompt(name, vars)` at its call
  site; find them with `rg 'loadPrompt\("<name>"'`.

## How to change things

- **Wording of a prompt:** edit `defaults/prompts/<name>.md` (repo default) or tell the human to put an override in
  `~/.config/trellage/factory/prompts/<name>.md` (only theirs). Do not move prompt text back into TypeScript.
- **A number:** change `defaults/config.toml`; prompts pick it up through placeholders.
- **A new step, lens, research workflow:** add a table to `defaults/config.toml`. A `[research.<id>]` needs a
  `[steps.<id>]`. A step with `harness` needs profiles trx knows; otherwise its worker is refused at spawn,
  and the error names the fix.
- **A new prompt:** add `defaults/prompts/<name>.md` and call `loadPrompt("<name>", vars)`, never the global
  `prompt()`. Read it at use time, not at import time, so edits apply.
- **A new config key:** add it to `FactoryConfigSchema` in `src/config.ts` and to `defaults/config.toml` with a comment.
  Read it through `factoryConfig()`, or `pinnedConfig(f.root, sdlc.configId)` when it affects a delivery run.
- Keep in code: tool names and parameter schemas, tool descriptions (`src/tools.ts`, `SETTINGS_TOOL_DOC`), guards
  (no push/merge, approvals, the fix-round check), gate ids and phases, risk floors. Text may describe a guard; it
  must never be what enforces it.

## Checks

- `bun test` from this folder. `test/prompts.test.ts` compares every rendered prompt with
  `test/fixtures/prompts.golden.json`. When you change a default prompt on purpose, update the golden file in the same
  change and say why.
- `bun run check` for types. The repo gate: `python3 scripts/quality_prototypes.py coordinator` from the repo root.
