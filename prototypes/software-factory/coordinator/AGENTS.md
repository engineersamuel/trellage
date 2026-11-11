# Factory coordinator agent guide

## The rule: where each kind of text lives

| Kind | Home | Example |
|---|---|---|
| Text a model reads that code does not parse or enforce | a prompt file, `defaults/prompts/<name>.md` | system prompts, worker tasks, Jev questions, step and lens descriptions, gate questions |
| Numbers, model names, switches | `defaults/config.toml` | thresholds, limits, models |
| Contracts with code | TypeScript, next to the code | tool name + parameter schema + description, guard messages, output formats code parses, gate ids and phases, verdict mappings |

Code may hold text a model reads only when the same code also parses or enforces it. Text may describe a guard; it
must never be what enforces it.

## Files and overrides

| What | Shipped | User (wins) |
|---|---|---|
| Prompt files | `defaults/prompts/<name>.md` | `~/.config/trellage/factory/prompts/<name>.md` (replaces that one file) |
| Config | `defaults/config.toml` | `~/.config/trellage/factory/config.toml` (key by key) |
| Runtime overrides of config keys (UI, approved agent proposals) | none | `$SF_STATE_DIR/config-overrides.json` |
| UI settings (theme, efforts, crons, extensions) | `src/settings.ts` | `$SF_STATE_DIR/settings.json` (UI, `update_settings`) |
| Human decision rules (Jev shadow mode) | none | `~/.config/trellage/factory/INSTRUCTIONS.md` |
| Claude/Pi profiles that steps run | trx presets | `[native.profiles]` in `~/.config/trellage/config.toml` |
| Restart-only: port, auth, state dir, proxy URL | env `SF_*` | env `SF_*` |

- Config merge order: shipped < user file < runtime overrides. `ConfigStore.values()` reports each key's source.
  `GET/PATCH /api/config` is the UI's view, overrides and "Save to file" (`setTomlKey`, comments kept).
- Coordinator models have one home: `models.coordinator`, `models.sub_coordinator` in the config. The UI model picker
  writes a runtime override; `settings.json` does not store them. `SF_MODEL`, `SF_REVIEW_MODEL`,
  `SF_SECURITY_MODEL` still override worker and reviewer models.
- Catalogs are folders of prompt files: `steps/`, `research/`, `lenses/`, `gates/`, `status/`, `jev/security/`. The
  body is the text the model reads; TOML front matter holds the item's fields (a step's skills, harness,
  instructions, best_for, avoid_for; `order` = its place in the list Jev reads). Add an item: add a file (shipped or
  in the user folder).
  A `research/<id>.md` needs a `steps/<id>.md`. A step with `harness` needs profiles trx knows; otherwise its
  worker is refused at spawn, and the error names the fix.

## Prompt file format

```text
+++
inputs = ["focus"]          # vars the caller passes; required
order = 1                   # catalog position (catalog folders only)
based_on = "1a2b3c4d5e6f"   # user copies only: the shipped version they replaced
+++
Is a review focused on {{focus}} likely to find a real, worth-fixing problem in this diff?
```

- `{{name}}` inserts; `{{#name}}...{{/name}}` keeps the body when truthy, `{{^name}}...{{/name}}` when not. Every
  config key is a variable as `{{section.key}}`. A prompt that states a number the code also uses MUST use the
  placeholder, never a literal.
- `inputs` is the contract with the caller: the caller must pass each one, and the body may use only those and config
  keys. A user copy keeps the shipped declaration. `test/promptFiles.test.ts` checks every shipped file.
- Load with `loadPrompt("<name>", vars)` (text) or `promptFile("<name>")` (front matter + body), never the global
  `prompt()`. Read at use time, not at import time.

## Reload rules

- Config file: watched; a valid edit applies at once, an invalid one keeps the last good config and logs the error.
- Prompt files: read on every use; a user copy that fails falls back to the shipped one (`promptErrors`).
- A delivery run pins config and prompts at its first `sdlc_plan` (`Sdlc.configId`, `Sdlc.promptsId`; snapshots in
  `$SF_STATE_DIR/config-snapshots/` and `prompt-snapshots/`). Everything the run does (`inRun` in `src/gates.ts`:
  gates, reviews, next step, implement and verify rules, fix rounds, report nudge) reads the pinned copy. New runs
  read the latest.
- A running worker keeps the system prompt it started with. The Factory desk reads its prompt at factory start.

## Agent rules

- Read with `get_factory_config`. Change a config key or a prompt only with `propose_config_change`; it opens a
  decision, and only the human's Apply writes it. Coordinators are refused writes and shell commands that name
  `~/.config/trellage/factory/`. Visual settings (`update_settings`) stay free to change.
- A proposal for a decision prompt (`jev/`, `gates/`) is replayed first (`src/promptEval.ts`, at most 20 cases):
  `jev/shadow-pick` against the human's real answers, others by how often the new text flips recorded answers
  (`$SF_STATE_DIR/decision-cases.jsonl`). The result is shown on the card; it never blocks.
- An applied prompt proposal writes a user copy with `based_on`. When the shipped prompt changes later,
  `get_factory_config` (`stalePrompts`) and the settings drawer say so.

## How to change things

- **Wording:** edit `defaults/prompts/<name>.md` (repo default) or the user's copy (only theirs). Do not move prompt
  text back into TypeScript.
- **A number or model:** `defaults/config.toml`, plus `FactoryConfigSchema` in `src/config.ts` for a new key. Read it
  with `factoryConfig()` outside a run and `activeConfig()` inside one (`pinnedConfig` when you hold the run).
- **A new step, lens, research workflow, gate question:** add a file to its catalog folder.
- **A new prompt:** add `defaults/prompts/<name>.md` with its `inputs`, then call `loadPrompt`.

## Checks

- `bun test` from this folder. `test/setup.ts` points `SF_CONFIG` and `SF_STATE_DIR` at a temp folder, so tests never
  read or write the human's files. `test/prompts.test.ts` compares rendered prompts with
  `test/fixtures/prompts.golden.json`; when you change a default prompt on purpose, update the golden file in the same
  change and say why.
- `bun run check` for types. The repo gate: `python3 scripts/quality_prototypes.py coordinator` from the repo root.
