# Trellage `list` JSON catalog — design

**Date:** 2026-08-07  
**Status:** Approved for implementation planning  
**Scope:** Sandbox Trellage profiles (`profiles/*/profile.toml`) and the profile compiler / `trellage` launcher

## Problem

Other applications need a machine-readable way to answer: *which Trellage profile should I use for this kind of work?* Today:

- Native launchers (`cpx`, `cdx`, `grx`, `jcx`, `omp`) expose `list --json` from static `catalog.json` files with short install-oriented descriptions.
- The sandbox profile compiler exposes `choices` (JSON inventory for the interactive picker) with short `description` strings from `profile.toml`.
- There is no first-class `trellage list` / `list --json` surface, and descriptions are not written as selection guidance (harness strengths + what the profile excels at).

## Goals

1. Add `trellage list` with two JSON modes apps can consume.
2. Author condensed, research- and observation-backed **descriptions** in `profile.toml` only (single source of truth).
3. Build list output by discovering and projecting profile TOMLs — not by maintaining a parallel catalog of guidance text.
4. Keep list offline, deterministic, and free of model inference or live network calls.

## Non-goals

- Enriching native `catalog.json` with guidance fields (native install metadata stays as-is).
- Generating descriptions at list time from GitHub, Perplexity, or the model.
- Adding structured `best_for` / `tags` / `summary` fields (prose lives entirely in `description` for simplified mode).
- Creating sandbox `profile.toml`s for Grok or jcode in this change (harness notes are recorded for later).
- Changing container build, lock, or launch behavior beyond CLI list surfaces and description text.

## Decisions

| Decision | Choice |
|----------|--------|
| Source of truth | `profiles/*/profile.toml` only |
| Simplified JSON | `name` + `description` only |
| Full JSON | Same description plus inventory (path, platforms, harness, skills, plugins, mcps) |
| Flags | `--json` (simplified) and `--json-full` (inventory); mutually exclusive |
| Human list | Default `list` prints a readable table/TSV of name + description |
| Native catalogs | Unchanged; apps that need selection guidance use sandbox `trellage list --json` |
| `choices` | Keep for picker compatibility; project the same richer `description` string (additive) |
| Implementation home | Effect CLI (`packages/trellage-cli`); shell `trellage` forwards `list` like other compiler commands |

## CLI surface

### Effect CLI (`trellage-profile` / `dist/cli.js`)

| Command | Output |
|---------|--------|
| `list` | Human-readable rows: `name` and `description` (stable column order, name-sorted) |
| `list --json` | Simplified catalog JSON on stdout |
| `list --json-full` | Full catalog JSON on stdout |

Rules:

- `--json` and `--json-full` must not be combined; reject with a clear error.
- Discovery roots match `choices`: bundled `profiles/` plus current git worktree `profiles/` override by declared `name`.
- Invalid profile TOMLs are skipped the same way `discoverProfileChoices` skips them today (do not fail the whole list for one bad neighbor unless no profiles remain — match existing discovery failure behavior).
- Exit non-zero only on discovery/IO failures, not on empty optional fields.

### Shell launcher (`prototypes/trellage/trellage`)

- Treat `list` as a **compiler command** alongside `validate`, `lock`, `build`, `upgrade`.
- Forward `list` (and its flags) to `node dist/cli.js list …` after ensuring the compiler is built.
- Reject launch-only flags (`--prompt`, `--interactive`) on `list`, consistent with other compiler commands.
- Help/usage text should mention `list`, `list --json`, and `list --json-full`.

### Relationship to `choices`

- `choices` remains the picker inventory API used by interactive launch.
- After this change, each choice’s `description` is the same authored selection blurb as `list`.
- Optional later cleanup: have the picker read `list --json-full` shape; **not required** for this work if `choices` stays backward compatible.

## JSON schemas

### Simplified (`list --json`)

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "name": "copilot-hve",
      "description": "…"
    }
  ]
}
```

Constraints:

- `schemaVersion` is integer `1`.
- `profiles` is an array sorted by `name` ascending (locale-independent byte/Unicode code-point order matching existing discovery sort).
- Each entry has exactly `name` and `description` (both non-empty strings).
- No path, harness, or inventory fields in simplified mode.

### Full (`list --json-full`)

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "name": "copilot-hve",
      "description": "…",
      "path": "/absolute/or/resolved/path/to/profile.toml",
      "supportedPlatforms": ["linux/arm64"],
      "harness": {
        "kind": "copilot",
        "version": "latest"
      },
      "skills": [
        {
          "repository": "https://github.com/…",
          "ref": "…",
          "select": ["…"]
        }
      ],
      "plugins": [
        {
          "adapter": "copilot-marketplace",
          "repository": "https://github.com/…",
          "ref": "…",
          "select": ["…"],
          "marketplace": "hve-core"
        }
      ],
      "mcps": []
    }
  ]
}
```

Field notes:

- `path` is the resolved profile document path (same role as today’s `choices[].value`).
- `supportedPlatforms` mirrors lock/platform discovery already used by `choices`.
- `harness.model` is included when the harness kind exposes a model (codex, claude, pi, prime); omitted for copilot when no model field exists.
- `skills` / `plugins` / `mcps` match the projection already produced by `projectProfileChoice` (same shapes, additive description only).
- JSON property names use camelCase (`supportedPlatforms`) for the public list API. Internal TypeScript may keep snake_case if that matches existing `ProfileChoice`; the **serialized list JSON** must use the schema above.

Prefer implementing full mode as: discover → project choice → map to public list DTO (rename `value` → `path`, `supported_platforms` → `supportedPlatforms`) so inventory logic is not duplicated.

## Profile TOML

### Schema

No new required fields. Continue to use existing:

```toml
schema = 1
name = "…"
description = "…"   # becomes the selection-oriented blurb
```

Multiline TOML strings are allowed for longer descriptions. `description` remains `NonEmpty` in the Effect schema.

### Description writing rules

Each sandbox profile `description` is a **single condensed blurb** (typically 2–5 sentences) suitable for both humans and downstream apps. Structure:

1. **What** — harness, model (if fixed), and primary skill/plugin kit.
2. **Harness strength** — from operator observations (below), cleaned and factual.
3. **Best for / excels at** — concrete task fit; when to prefer this profile over siblings.

Do not dump raw skill inventories into the blurb; full mode already exposes inventory. Prefer durable guidance over version-specific hype.

### Harness strengths (operator notes, cleaned)

Use these as the shared voice when a profile’s harness is X. They are observations for Trellage operators, not vendor claims.

| Harness | Strengths to reflect in copy |
|---------|------------------------------|
| **Copilot** | Prefer as the default harness when all else is equal. Strong for Microsoft/GitHub-ecosystem work and hypervelocity engineering; native Copilot subscription path guarantees usage against that entitlement. |
| **Claude Code** | Frontier generalist harness. Especially strong on UI/frontend craft and on complicated, detailed planning and orchestration. |
| **Codex** | Straightforward workhorse; good for long-running workloads that may run for a long time (hours to days). |
| **Pi / Oh My Pi** | Batteries-included: give it a prompt and it keeps going; tends not to stall. Long, detailed, colorful explanations. |
| **Prime** | Recursive / self-improving, bleeding-edge harness; much of the loop runs through an iPython kernel. Experimental, not the safe default. |
| **Grok** *(native only today)* | Outstanding plan-mode TUI (rendered markdown/tables in a scrollable panel; approve / request-changes / comment / copy hotkeys). Strong ask-user flow; solid long-horizon work; snappy TUI. Recorded for future sandbox profiles. |
| **jcode** *(native only today)* | Ultra-light harness, low memory, fast startup. Choose when efficiency and quick spin-up matter. Recorded for future sandbox profiles. |

### Upstream cross-check (skill/plugin kits)

Used when drafting profile blurbs (not fetched at runtime):

| Source | Upstream signal |
|--------|-----------------|
| `microsoft/hve-core` | Hypervelocity Engineering components for Copilot: agents, prompts, skills; opinionated agentic SDLC (e.g. RPI-style flows). |
| `obra/superpowers` | Agentic skills methodology: brainstorming, written plans, TDD, systematic debugging, review, finishing branches. |
| `wshobson/agents` | Multi-harness plugin marketplace; this profile selects full-stack orchestration. |
| `AgriciDaniel/claude-blog` | Blog skill suite (many sub-skills/agents); dual-optimized content delivery contract. |
| `0xNyk/council-of-high-intelligence` | Structured multi-perspective deliberation for hard decisions. |
| `jordan-gibbs/hyperresearch` | Agent-driven web research into a persistent searchable knowledge base. |
| `charlie947/social-media-skills` | Social media skill marketplace plugin (sparse public description; pair with Humanizer). |
| `blader/humanizer` | Removes obvious AI-writing tells from text. |
| `can1357/oh-my-pi` | Terminal coding agent: hash-anchored edits, tools, LSP, browser, subagents. |
| `JuliusBrussee/caveman` | Token-thrifty communication skill; pinned always-on on sandbox profiles — mention only if it materially changes selection (usually omit from blurbs). |

### Canonical description text (author into each `profile.toml`)

These are the intended committed strings (minor wording edits allowed during implementation if tests/docs need alignment; keep meaning stable).

**copilot-hve**

> GitHub Copilot with Microsoft HVE Core: opinionated agentic SDLC for research, planning, implementation, review, security, accessibility, and work-item workflows. Copilot is the default harness when all else is equal—native subscription path and strong fit for Microsoft/GitHub-centric, high-throughput engineering. Best for hypervelocity delivery on Copilot rather than experimental harnesses.

**codex-superpowers**

> Codex with Superpowers (brainstorming, written plans, TDD, systematic debugging, review) plus full-stack orchestration agents. Codex is a straightforward workhorse that holds up on long-running workloads. Best for multi-day implementation with disciplined process when you want steady execution over a flashy TUI.

**pi-oh-my-pi**

> Oh My Pi on GitHub Copilot models: batteries-included terminal agent that takes a prompt and keeps cranking, with long, detailed, colorful output. Best when you want minimal setup, aggressive throughput, and rich explanations without babysitting stalls.

**prime-agent**

> Prime Agent with Claude Opus via copilot-proxy-rs: a bleeding-edge recursive, self-improving harness that runs much of its loop through an iPython kernel. Best for experimental agent research and novel workflows—not the default for production delivery.

**claude-blog**

> Claude Code (Opus via proxy) with the Claude Blog skill suite for structured long-form content and publication workflows. Claude is a frontier generalist especially strong on detailed craft and structure. Best for technical posts, docs-as-blog, and content systems that need a full editorial skill kit.

**claude-council**

> Claude Code (Opus via proxy) with Council of High Intelligence for structured multi-perspective deliberation (full councils, triads, or duos). Best for hard tradeoffs, architecture decisions, and high-stakes design calls where one-shot answers are not enough.

**claude-hyperresearch**

> Claude Code (Opus via proxy) with Hyperresearch for multi-step web investigation, browser-assisted collection, and synthesis into a persistent research knowledge base. Best for deep, source-heavy research and cited reports rather than pure coding sprints.

**claude-social-media**

> Claude Code (Opus via proxy) with social-media skills and Humanizer to draft platform copy and strip obvious AI writing tells. Best for social posts, threads, and public-facing short-form content that should sound human.

**claude-qwen-local**

> Claude Code in core mode on local Qwen (`qwen3.6-35b-a3b-local`) through copilot-proxy-rs. Best for private, offline, or cost-controlled coding when cloud frontier models are unnecessary or unavailable—not for maximum quality on hard UI or orchestration work.

## Architecture

```
profiles/*/profile.toml
        │
        ▼
discoverProfileChoices / listProfiles  (Effect)
        │
        ├─► list (human table)
        ├─► list --json       → { schemaVersion, profiles: [{name, description}] }
        └─► list --json-full  → { schemaVersion, profiles: [{name, description, path, …}] }

prototypes/trellage/trellage
        │  case list → exec node dist/cli.js "$@"
        ▼
external apps / scripts
```

### Code touchpoints (expected)

| Area | Change |
|------|--------|
| `packages/trellage-cli/src/cli.ts` | Add `list` command; register on root; help text |
| `packages/trellage-cli/src/profile-discovery.ts` (or small `list.ts`) | Shared projection helpers for simplified/full DTOs |
| `packages/trellage-cli/test/cli.test.ts`, `profile-discovery.test.ts` | Flag mutual exclusion; JSON shapes; sorting |
| `profiles/*/profile.toml` | Replace `description` with canonical blurbs |
| `prototypes/trellage/trellage` | Compiler-mode `list`; help |
| `prototypes/trellage/tests/host_command_contract.sh` | `list` forwards; rejects launch flags |
| README / user-facing docs if they document compiler subcommands | Mention `list` |

Avoid drive-by refactors. Prefer extending `projectProfileChoice` over a second discovery path.

## Error handling

| Case | Behavior |
|------|----------|
| Both `--json` and `--json-full` | Fail with explicit mutual-exclusion message |
| No profiles discovered | Fail consistently with upgrade-all / choices empty behavior (or empty array if choices today returns `[]` — **match `discoverProfileChoices`**) |
| Unreadable profiles root | ProfileDiscoveryError → non-zero exit, stderr message via existing CLI cause formatting |
| Invalid single profile | Skip (existing discovery); do not emit partial garbage for that name |

## Testing

1. **Unit / package tests (Effect CLI)**  
   - `list --json` parses as schemaVersion 1, only `name`/`description`, sorted.  
   - `list --json-full` includes inventory keys and same descriptions as simplified for the same fixture set.  
   - Mutual exclusion of flags.  
   - Worktree name override still wins (reuse discovery fixtures).

2. **Profile content contracts**  
   - Every bundled profile has non-empty `description`.  
   - Optional: snapshot or contains-checks for harness keywords if useful; prefer not to over-lock exact prose if that makes benign edits painful — at minimum assert non-empty and that `list --json` round-trips TOML descriptions.

3. **Host contract**  
   - `trellage list` delegates to compiler.  
   - `trellage list --json` / `--json-full` delegate with flags.  
   - `trellage list --prompt` / `--interactive` rejected.

4. **No live network** in tests; no Docker required for list.

## Rollout

1. Implement projection + `list` command with fixtures.  
2. Author the nine sandbox descriptions.  
3. Wire shell forwarding + host contracts.  
4. Run `make test` (or scoped package + host contracts) before claiming done.

## Future work (out of scope)

- Sandbox profiles for Grok and jcode using the harness notes above.  
- Native launchers reading the same TOMLs if native and sandbox profiles are unified.  
- Optional structured `bestFor` arrays if apps outgrow prose.  
- `trx` aggregating sandbox `list --json` alongside native catalogs.

## Open items resolved in design

| Question | Resolution |
|----------|------------|
| Where does guidance live? | Only `profile.toml` `description` |
| Simplified vs full? | `--json` vs `--json-full` |
| Native catalogs? | Unchanged |
| Live research at list time? | No; offline authored text |
| Perplexity MCP? | Used only during design research if available; not a runtime dependency (unavailable in this environment; upstream GitHub + operator notes used instead) |
