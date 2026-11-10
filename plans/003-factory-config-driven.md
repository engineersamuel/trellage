# Plan 003: Drive the software factory from config files

Status: IN PROGRESS (increments 1-3 done, 4 open). Priority P1. Effort L (4 increments).
Risk MEDIUM (prompt text, model choice, review gates).
Planned against HEAD `47079db`, 2026-11-10. Code: `prototypes/software-factory/`.

## Goal

Change every factory prompt, model, threshold and catalog without a code change.
Edits apply live, under the reload rules below.

## Agreed decisions (user, 2026-11-10)

| Topic | Decision |
| --- | --- |
| Writers | Layered: code defaults < `~/.config/trellage/factory/config.toml` (user only) < runtime overrides in the state dir (UI and agent). UI shows the source of each value and can promote a value to the file. |
| Location | `~/.config/trellage/factory/config.toml` + `factory/prompts/*.md`. Profiles come from `[native.profiles]` in the main `~/.config/trellage/config.toml` (read, never copied). |
| Agent edits | Agent may change visual settings freely. Prompt and guardrail text: propose only; applies after human approval. |
| Scope v1 | Prompt templates, models, numeric thresholds, step/lens/profile catalogs. Tool names, tool parameter schemas and guards stay in code. |
| Default prompts | Defaults ship in the repo as `.md` files. A user file with the same name overrides that one prompt. |
| Reload in a run | A delivery run pins a config snapshot at start. New runs and new chat turns use the latest valid config. |
| Missing profile | A step whose Claude profile is not in `[native.profiles]` is refused with a clear UI error. |

## Current state (evidence)

- Prompts in TypeScript, about 95 KB: `coordinator/src/prompts.ts` (7 system prompts + settings tool doc),
  `tools.ts` (30 tool descriptions), `steps.ts`, `drafts.ts`, `review.ts` (lens focus), `workflows.ts`, `security.ts`.
- Drift: `subPrompt` says re-review at "50+ lines"; `sdlc.ts:213` `REREVIEW_LINES = 100`.
  "moreWork < 0.3" is prompt text and also `report.ts:84`.
- Models in code: `settings.ts:69,134-135`, `review.ts:33` `REVIEW_MODELS`, `factory.ts:444,452,582`,
  `shared/schemas.ts:194`; env `SF_MODEL`, `SF_REVIEW_MODEL`, `SF_SECURITY_MODEL`.
- Thresholds in code: `review.ts:22-29`, `sdlc.ts:213-215`, `factory.ts:926`, `workflows.ts:29`, `cards.ts`, `main.ts:945`.
- Profiles `council`, `six-hats`, `research` used by `steps.ts:84-100` are trx built-in presets
  (`packages/trellage-runtime/src/native-run/presets.ts`); the profile check accepts presets and declared profiles.
- Settings today: `$SF_STATE_DIR/settings.json` (UI + agent), `factory/INSTRUCTIONS.md` (re-read per decision),
  about 15 `SF_*` env vars, code defaults.
- trx root schema (`packages/trellage-runtime/src/native-config.ts:176`) is not strict, but this plan does not
  add keys to the main file.

## Target layout

```text
~/.config/trellage/factory/
  config.toml          # user-owned: models, thresholds, catalogs, prompt overrides by name
  INSTRUCTIONS.md      # unchanged
  prompts/*.md         # optional per-prompt overrides
prototypes/software-factory/coordinator/defaults/
  config.toml          # shipped defaults (same schema)
  prompts/*.md         # shipped default prompts
$SF_STATE_DIR/settings.json   # runtime overrides only (UI + agent)
```

Prompts are templates. They read config values, for example `{{review.rereviewLines}}`, so text and code
cannot disagree. An unknown placeholder is a load error.

## Reload rules (per key, shown in the UI)

- `live`: next decision or next chat turn (prompts for new turns, thresholds, theme, decisions engine).
- `run`: pinned at delivery-run start (SDLC prompts, review/security thresholds, models of run workers).
- `restart`: port, auth mode, state dir, proxy URL. These stay env vars.

Running workers keep their system prompt.

## Increments

1. **Schema and loader.** Effect Schema for the factory config; merge defaults < user file < overrides;
   watch the files; on an invalid edit keep the last good config and publish the error.
   → verify: tests for invalid TOML, unknown key, unknown placeholder, reload, last-good fallback.
2. **Prompts to templates.** Move every prompt and tool description text to `defaults/prompts/*.md`.
   Replace numbers in text with placeholders; fix the 50-vs-100 drift.
   → verify: snapshot test: rendered prompts equal the current text, except the drift fix.
3. **Models, thresholds, catalogs.** Move `REVIEW_MODELS`, default models, thresholds, `LENSES`, `STEPS`
   descriptions and draft actions to config. Map `SF_MODEL`/`SF_REVIEW_MODEL`/`SF_SECURITY_MODEL` to
   override layer values (env keeps working). Refuse steps with undeclared profiles. Pin a snapshot per run.
   → verify: existing coordinator tests pass; new test for the profile refusal and the run pin.
4. **UI and agent.** Settings drawer shows value source (default / file / override) and reload rule;
   "promote to file" writes one key to the user TOML (comment-preserving edit). Agent prompt changes go through
   `request_approval`. → verify: drive the running app; check a live edit and a promote.

## STOP conditions

- Stop if a comment-preserving TOML writer is not available in the current stack; ask before adding a library.
- Stop if moving tool descriptions changes tool parameter schemas.
- Stop if any guard (no push/merge, approvals, fix-round limit) would read its rule from editable text.

## Out of scope

- Writing factory keys into the main `config.toml`.
- Editable tool schemas or guard logic.
- Migrating `INSTRUCTIONS.md`.
