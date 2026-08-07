# Trellage `list` JSON Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `trellage list` / `list --json` / `list --json-full` that projects sandbox `profiles/*/profile.toml` into offline selection catalogs, and author condensed selection-oriented descriptions for all nine bundled profiles.

**Architecture:** Reuse `discoverProfileChoices` for discovery and inventory. Add pure DTO mappers (`toSimplifiedList`, `toFullList`) plus a thin Effect CLI `list` command. The shell launcher forwards `list` like other compiler commands. Descriptions are authored only in TOML; no native catalog changes and no network at list time.

**Tech Stack:** TypeScript, Effect, `@effect/cli`, Vitest, bash host contracts, TOML profiles.

## Global Constraints

- Source of truth: `profiles/*/profile.toml` `description` only.
- Simplified JSON: exactly `name` + `description` per profile; top-level `schemaVersion: 1`.
- Full JSON: same descriptions plus `path`, `supportedPlatforms`, `harness`, `skills`, `plugins`, `mcps` (camelCase public keys).
- `--json` and `--json-full` are mutually exclusive.
- Offline, deterministic, no model inference or live GitHub/Perplexity at list time.
- Native `catalog.json` files are out of scope (leave unchanged).
- Keep `choices` working; it naturally picks up richer TOML descriptions.
- Match existing discovery: name sort with `localeCompare(..., "en")`; worktree overrides bundled by name; skip invalid profiles.
- Do not weaken or skip repository contracts.
- Spec: `docs/superpowers/specs/2026-08-07-trellage-list-json-design.md` (force-tracked; path is gitignored).

---

## File map

| File | Responsibility |
|------|----------------|
| `packages/trellage-cli/src/profile-list.ts` | Pure DTO types + mappers from `ProfileChoice` → simplified/full list JSON |
| `packages/trellage-cli/src/profile-discovery.ts` | Unchanged discovery; list mappers consume its `ProfileChoice` |
| `packages/trellage-cli/src/cli.ts` | `list` command, flags, human/JSON output, root registration |
| `packages/trellage-cli/test/profile-list.test.ts` | Unit tests for mappers and schemas |
| `packages/trellage-cli/test/cli.test.ts` | CLI registration + list flag behavior (mocked discovery) |
| `profiles/*/profile.toml` | Canonical selection descriptions |
| `prototypes/trellage/trellage` | Treat `list` as compiler command |
| `prototypes/trellage/tests/host_command_contract.sh` | Delegation + flag rejection contracts |
| `README.md` | Brief mention of `list` / JSON modes |

---

### Task 1: List DTO mappers (TDD)

**Files:**
- Create: `packages/trellage-cli/src/profile-list.ts`
- Create: `packages/trellage-cli/test/profile-list.test.ts`

**Interfaces:**
- Consumes: `ProfileChoice` from `./profile-discovery.js`
- Produces:
  - `export interface SimplifiedProfileList { readonly schemaVersion: 1; readonly profiles: ReadonlyArray<{ readonly name: string; readonly description: string }> }`
  - `export interface FullProfileListEntry { readonly name: string; readonly description: string; readonly path: string; readonly supportedPlatforms: ReadonlyArray<string>; readonly harness: ProfileChoice["harness"]; readonly skills: ProfileChoice["skills"]; readonly plugins: ProfileChoice["plugins"]; readonly mcps: ProfileChoice["mcps"] }`
  - `export interface FullProfileList { readonly schemaVersion: 1; readonly profiles: ReadonlyArray<FullProfileListEntry> }`
  - `export const toSimplifiedList = (choices: ReadonlyArray<ProfileChoice>): SimplifiedProfileList`
  - `export const toFullList = (choices: ReadonlyArray<ProfileChoice>): FullProfileList`
  - `export const formatProfileListHuman = (choices: ReadonlyArray<ProfileChoice>): string` — TSV lines `name\tdescription` (name-sorted input assumed; do not re-sort differently than discovery)

- [ ] **Step 1: Write the failing unit tests**

Create `packages/trellage-cli/test/profile-list.test.ts`:

```typescript
import { describe, expect, it } from "vitest"

import type { ProfileChoice } from "../src/profile-discovery.js"
import { formatProfileListHuman, toFullList, toSimplifiedList } from "../src/profile-list.js"

const sample = (overrides: Partial<ProfileChoice> & Pick<ProfileChoice, "name" | "description" | "value">): ProfileChoice => ({
  supported_platforms: ["linux/arm64"],
  harness: { kind: "codex", version: "latest", model: "gpt-5.6-sol" },
  skills: [{ repository: "https://github.com/example/skills.git", ref: "v1", select: ["a"] }],
  plugins: [
    {
      adapter: "codex-native",
      repository: "https://github.com/example/plugins.git",
      ref: "v2",
      select: ["b"],
    },
  ],
  mcps: [],
  ...overrides,
})

describe("profile list DTOs", () => {
  it("projects simplified JSON with only name and description", () => {
    const choices = [
      sample({ name: "beta", description: "Beta blurb", value: "/p/beta/profile.toml" }),
      sample({ name: "alpha", description: "Alpha blurb", value: "/p/alpha/profile.toml" }),
    ]
    expect(toSimplifiedList(choices)).toEqual({
      schemaVersion: 1,
      profiles: [
        { name: "beta", description: "Beta blurb" },
        { name: "alpha", description: "Alpha blurb" },
      ],
    })
  })

  it("projects full JSON with camelCase inventory keys and path from value", () => {
    const choice = sample({
      name: "detailed",
      description: "Detailed blurb",
      value: "/profiles/detailed/profile.toml",
      supported_platforms: ["linux/arm64", "linux/amd64"],
      mcps: [
        {
          name: "docs",
          transport: "http",
          required: true,
          url: "https://example.test/mcp",
          tools: { allow: ["search"], deny: [] },
        },
      ],
    })
    expect(toFullList([choice])).toEqual({
      schemaVersion: 1,
      profiles: [
        {
          name: "detailed",
          description: "Detailed blurb",
          path: "/profiles/detailed/profile.toml",
          supportedPlatforms: ["linux/arm64", "linux/amd64"],
          harness: { kind: "codex", version: "latest", model: "gpt-5.6-sol" },
          skills: choice.skills,
          plugins: choice.plugins,
          mcps: choice.mcps,
        },
      ],
    })
  })

  it("formats human list as name-description TSV", () => {
    const choices = [sample({ name: "a", description: "line one\nstill one", value: "/a" })]
    // Collapse description newlines to spaces for single-line rows
    expect(formatProfileListHuman(choices)).toBe("a\tline one still one")
  })
})
```

Note: preserve discovery order in mappers (do not re-sort). Human formatter must replace internal newlines/tabs in descriptions with spaces so each profile is one line.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd packages/trellage-cli && npm test -- test/profile-list.test.ts
```

Expected: FAIL — cannot resolve `../src/profile-list.js` or exports missing.

- [ ] **Step 3: Implement mappers**

Create `packages/trellage-cli/src/profile-list.ts`:

```typescript
import type { ProfileChoice } from "./profile-discovery.js"

export interface SimplifiedProfileList {
  readonly schemaVersion: 1
  readonly profiles: ReadonlyArray<{
    readonly name: string
    readonly description: string
  }>
}

export interface FullProfileListEntry {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly supportedPlatforms: ReadonlyArray<string>
  readonly harness: ProfileChoice["harness"]
  readonly skills: ProfileChoice["skills"]
  readonly plugins: ProfileChoice["plugins"]
  readonly mcps: ProfileChoice["mcps"]
}

export interface FullProfileList {
  readonly schemaVersion: 1
  readonly profiles: ReadonlyArray<FullProfileListEntry>
}

const singleLine = (value: string): string => value.replace(/\s+/g, " ").trim()

export const toSimplifiedList = (choices: ReadonlyArray<ProfileChoice>): SimplifiedProfileList => ({
  schemaVersion: 1,
  profiles: choices.map(({ name, description }) => ({ name, description })),
})

export const toFullList = (choices: ReadonlyArray<ProfileChoice>): FullProfileList => ({
  schemaVersion: 1,
  profiles: choices.map((choice) => ({
    name: choice.name,
    description: choice.description,
    path: choice.value,
    supportedPlatforms: choice.supported_platforms,
    harness: choice.harness,
    skills: choice.skills,
    plugins: choice.plugins,
    mcps: choice.mcps,
  })),
})

export const formatProfileListHuman = (choices: ReadonlyArray<ProfileChoice>): string =>
  choices.map((choice) => `${choice.name}\t${singleLine(choice.description)}`).join("\n")
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd packages/trellage-cli && npm test -- test/profile-list.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/trellage-cli/src/profile-list.ts packages/trellage-cli/test/profile-list.test.ts
git commit -m "feat(cli): add profile list JSON DTO mappers"
```

---

### Task 2: Effect CLI `list` command

**Files:**
- Modify: `packages/trellage-cli/src/cli.ts`
- Modify: `packages/trellage-cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `discoverProfileChoices`, `profileDiscoveryRoots`, `toSimplifiedList`, `toFullList`, `formatProfileListHuman`
- Produces: CLI subcommand `list` with options `json` (`--json`) and `jsonFull` (`--json-full`)

- [ ] **Step 1: Extend CLI source expectations (failing)**

In `packages/trellage-cli/test/cli.test.ts`, update the identity test and add list-focused checks:

```typescript
// Inside "uses Trellage identity..." test, add:
expect.soft(cliSource).toContain('Command.make("list"')
expect.soft(cliSource).toContain('Options.boolean("json")')
expect.soft(cliSource).toContain('Options.boolean("json-full")')
```

Add a helper and tests (mock already stubs `discoverProfileChoices` with alpha/beta/gamma — extend the mock to include `description` fields):

Update the `discoverProfileChoices` mock return value to:

```typescript
discoverProfileChoices: () =>
  EffectModule.succeed([
    {
      name: "alpha",
      description: "Alpha description",
      value: "/profiles/alpha/profile.toml",
      supported_platforms: ["linux/arm64"],
      harness: { kind: "codex", version: "latest" },
      skills: [],
      plugins: [],
      mcps: [],
    },
    {
      name: "beta",
      description: "Beta description",
      value: "/profiles/beta/profile.toml",
      supported_platforms: [],
      harness: { kind: "claude", version: "latest", model: "claude-opus-5" },
      skills: [],
      plugins: [],
      mcps: [],
    },
    {
      name: "gamma",
      description: "Gamma description",
      value: "/profiles/gamma/profile.toml",
      supported_platforms: ["linux/amd64"],
      harness: { kind: "copilot", version: "latest" },
      skills: [],
      plugins: [],
      mcps: [],
    },
  ]),
```

Add capture for console output. Prefer spying `Console.log` via Effect is hard; instead add a small pure export test is enough for mappers — for CLI, keep source-contains checks **and** a runtime test that runs list:

```typescript
const runList = async (args: ReadonlyArray<string>): Promise<{
  readonly logs: ReadonlyArray<string>
  readonly exitCode: number | undefined
}> => {
  const originalArgv = process.argv
  const originalExitCode = process.exitCode
  const logs: Array<string> = []
  const originalLog = console.log
  try {
    process.argv = [process.execPath, "trellage-profile", "list", ...args]
    process.exitCode = undefined
    cliHarness.main = undefined
    console.log = (...parts: Array<unknown>) => {
      logs.push(parts.map(String).join(" "))
    }
    vi.resetModules()
    await import("../src/cli.js")
    if (cliHarness.main === undefined) throw new Error("CLI main effect was not captured")
    await Effect.runPromise(cliHarness.main as Effect.Effect<void, unknown, never>)
    return { logs, exitCode: process.exitCode }
  } finally {
    process.argv = originalArgv
    process.exitCode = originalExitCode
    console.log = originalLog
  }
}

it("lists simplified and full JSON catalogs", async () => {
  const simplified = await runList(["--json"])
  expect(simplified.exitCode ?? 0).toBe(0)
  expect(JSON.parse(simplified.logs.join("\n"))).toEqual({
    schemaVersion: 1,
    profiles: [
      { name: "alpha", description: "Alpha description" },
      { name: "beta", description: "Beta description" },
      { name: "gamma", description: "Gamma description" },
    ],
  })

  const full = await runList(["--json-full"])
  const parsed = JSON.parse(full.logs.join("\n")) as {
    schemaVersion: number
    profiles: Array<{ name: string; path: string; supportedPlatforms: string[] }>
  }
  expect(parsed.schemaVersion).toBe(1)
  expect(parsed.profiles.map((p) => p.name)).toEqual(["alpha", "beta", "gamma"])
  expect(parsed.profiles[0]).toMatchObject({
    path: "/profiles/alpha/profile.toml",
    supportedPlatforms: ["linux/arm64"],
  })
})

it("rejects combining --json and --json-full", async () => {
  const result = await runList(["--json", "--json-full"])
  expect(result.exitCode).toBe(1)
})
```

If capturing `Console.log` from Effect is unreliable in this harness, assert via source that the handler calls `toSimplifiedList` / `toFullList` and fails when both flags are set, and rely on Task 1 unit tests + a later integration smoke. Prefer making `runList` work; Effect `Console.log` ultimately uses `console.log`.

- [ ] **Step 2: Run CLI tests to verify failure**

Run:

```bash
cd packages/trellage-cli && npm test -- test/cli.test.ts
```

Expected: FAIL on missing `Command.make("list"` and/or list runtime tests.

- [ ] **Step 3: Implement `list` in `cli.ts`**

Near other option definitions:

```typescript
const json = Options.boolean("json").pipe(Options.withDefault(false))
const jsonFull = Options.boolean("json-full").pipe(Options.withDefault(false))
```

Import mappers:

```typescript
import { formatProfileListHuman, toFullList, toSimplifiedList } from "./profile-list.js"
```

Add command before `root`:

```typescript
const list = Command.make("list", { json, jsonFull }, ({ json: asJson, jsonFull: asJsonFull }) =>
  Effect.gen(function* () {
    if (asJson && asJsonFull) {
      return yield* Effect.fail(
        new ApplicationError({ message: "list: --json and --json-full are mutually exclusive" }),
      )
    }
    const worktree = yield* currentGitWorktree(process.cwd())
    const choices = yield* discoverProfileChoices(profileDiscoveryRoots(worktree)).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    if (asJson) {
      return yield* Console.log(JSON.stringify(toSimplifiedList(choices)))
    }
    if (asJsonFull) {
      return yield* Console.log(JSON.stringify(toFullList(choices)))
    }
    const human = formatProfileListHuman(choices)
    if (human.length > 0) {
      return yield* Console.log(human)
    }
    return yield* Effect.void
  }),
)
```

Update root:

```typescript
const root = Command.make("trellage-profile", {}, () =>
  Console.log("Use validate, lock, build, upgrade, list, metadata, environment, or choices."),
).pipe(Command.withSubcommands([validate, lock, build, upgrade, list, metadata, environment, choices]))
```

`list` does **not** require Docker (unlike validate/lock/build).

- [ ] **Step 4: Run CLI tests**

Run:

```bash
cd packages/trellage-cli && npm test -- test/cli.test.ts test/profile-list.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/trellage-cli/src/cli.ts packages/trellage-cli/test/cli.test.ts
git commit -m "feat(cli): add trellage-profile list with json modes"
```

---

### Task 3: Author bundled profile descriptions

**Files:**
- Modify: each of  
  `profiles/copilot-hve/profile.toml`  
  `profiles/codex-superpowers/profile.toml`  
  `profiles/pi-oh-my-pi/profile.toml`  
  `profiles/prime-agent/profile.toml`  
  `profiles/claude-blog/profile.toml`  
  `profiles/claude-council/profile.toml`  
  `profiles/claude-hyperresearch/profile.toml`  
  `profiles/claude-social-media/profile.toml`  
  `profiles/claude-qwen-local/profile.toml`

**Interfaces:**
- Consumes: canonical strings from design spec section “Canonical description text”
- Produces: updated `description = """..."""` (or single-line quoted strings if no internal quotes require multilines)

- [ ] **Step 1: Replace each `description` with the canonical blurb**

Use exact text from the design spec (single-line TOML strings are fine if escaped; prefer basic double-quoted strings without raw newlines). Example for `copilot-hve`:

```toml
description = "GitHub Copilot with Microsoft HVE Core: opinionated agentic SDLC for research, planning, implementation, review, security, accessibility, and work-item workflows. Copilot is the default harness when all else is equal—native subscription path and strong fit for Microsoft/GitHub-centric, high-throughput engineering. Best for hypervelocity delivery on Copilot rather than experimental harnesses."
```

Apply all nine from the spec. Do not change `name`, harness, skills, plugins, or locks.

Canonical set (copy verbatim):

1. **copilot-hve** — `GitHub Copilot with Microsoft HVE Core: opinionated agentic SDLC for research, planning, implementation, review, security, accessibility, and work-item workflows. Copilot is the default harness when all else is equal—native subscription path and strong fit for Microsoft/GitHub-centric, high-throughput engineering. Best for hypervelocity delivery on Copilot rather than experimental harnesses.`

2. **codex-superpowers** — `Codex with Superpowers (brainstorming, written plans, TDD, systematic debugging, review) plus full-stack orchestration agents. Codex is a straightforward workhorse that holds up on long-running workloads. Best for multi-day implementation with disciplined process when you want steady execution over a flashy TUI.`

3. **pi-oh-my-pi** — `Oh My Pi on GitHub Copilot models: batteries-included terminal agent that takes a prompt and keeps cranking, with long, detailed, colorful output. Best when you want minimal setup, aggressive throughput, and rich explanations without babysitting stalls.`

4. **prime-agent** — `Prime Agent with Claude Opus via copilot-proxy-rs: a bleeding-edge recursive, self-improving harness that runs much of its loop through an iPython kernel. Best for experimental agent research and novel workflows—not the default for production delivery.`

5. **claude-blog** — `Claude Code (Opus via proxy) with the Claude Blog skill suite for structured long-form content and publication workflows. Claude is a frontier generalist especially strong on detailed craft and structure. Best for technical posts, docs-as-blog, and content systems that need a full editorial skill kit.`

6. **claude-council** — `Claude Code (Opus via proxy) with Council of High Intelligence for structured multi-perspective deliberation (full councils, triads, or duos). Best for hard tradeoffs, architecture decisions, and high-stakes design calls where one-shot answers are not enough.`

7. **claude-hyperresearch** — `Claude Code (Opus via proxy) with Hyperresearch for multi-step web investigation, browser-assisted collection, and synthesis into a persistent research knowledge base. Best for deep, source-heavy research and cited reports rather than pure coding sprints.`

8. **claude-social-media** — `Claude Code (Opus via proxy) with social-media skills and Humanizer to draft platform copy and strip obvious AI writing tells. Best for social posts, threads, and public-facing short-form content that should sound human.`

9. **claude-qwen-local** — `Claude Code in core mode on local Qwen (qwen3.6-35b-a3b-local) through copilot-proxy-rs. Best for private, offline, or cost-controlled coding when cloud frontier models are unnecessary or unavailable—not for maximum quality on hard UI or orchestration work.`

Note: In TOML, the em dash `—` is fine in double-quoted strings. Parentheses in qwen model id need no escaping.

- [ ] **Step 2: Smoke-validate descriptions load**

Run (after Task 2 is merged in the same branch):

```bash
cd packages/trellage-cli && npm run build && node dist/cli.js list --json | jq -e '
  .schemaVersion == 1
  and (.profiles | length) >= 9
  and all(.profiles[]; (.name | type == "string") and (.description | type == "string" and length > 40))
  and ([.profiles[].name] | sort == unique)
'
```

Expected: `jq` exits 0. Spot-check one:

```bash
node dist/cli.js list --json | jq -r '.profiles[] | select(.name=="copilot-hve") | .description' | grep -F 'HVE Core'
```

- [ ] **Step 3: Commit**

```bash
git add profiles/*/profile.toml
git commit -m "docs(profiles): author selection-oriented profile descriptions"
```

---

### Task 4: Shell launcher forwarding + host contracts

**Files:**
- Modify: `prototypes/trellage/trellage` (compiler mode case lists ~lines 117–120 and ~318–322)
- Modify: `prototypes/trellage/tests/host_command_contract.sh`
- Modify: `README.md` (short usage blurb near other compiler examples)

**Interfaces:**
- Consumes: Effect CLI `list`
- Produces: `trellage list`, `trellage list --json`, `trellage list --json-full` via compiler exec path

- [ ] **Step 1: Write host contract expectations**

In `host_command_contract.sh`, add `test_list_delegates_to_effect_cli` modeled on `test_upgrade_delegates_to_effect_cli`:

```bash
test_list_delegates_to_effect_cli() {
  local compiler
  local fake_node_bin="$test_root/fake-list-node-bin"
  local node_log="$test_root/list-node.log"
  local help_output real_node
  compiler="$(cd "$prototype_dir/../../packages/trellage-cli" && pwd -P)/dist/cli.js"
  real_node="$(command -v node)"
  help_output="$("$real_node" "$compiler" --help)"
  grep -Eq -- '- list' <<<"$help_output" \
    || fail 'Effect CLI help does not list list'

  mkdir -p "$fake_node_bin"
  ln -sf "$prototype_dir/tests/fakes/host-env" "$fake_node_bin/env"
  printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'fixture_config="$(dirname "$0")/.trellage-fixture-env"' \
    '[ ! -f "$fixture_config" ] || . "$fixture_config"' \
    'printf '\''ARG\t%s\n'\'' "$@" >"$FAKE_NODE_LOG"' \
    >"$fake_node_bin/node"
  chmod +x "$fake_node_bin/node"

  FAKE_NODE_LOG="$node_log" PATH="$fake_node_bin:$PATH" \
    "$prototype_dir/trellage" list --json
  [[ "$(sed -n '1p' "$node_log")" == $'ARG\t'"$compiler" ]] \
    || fail 'list did not delegate to the profile compiler'
  [[ "$(sed -n '2p' "$node_log")" == $'ARG\tlist' ]] \
    || fail 'list command was not preserved during delegation'
  [[ "$(sed -n '3p' "$node_log")" == $'ARG\t--json' ]] \
    || fail 'list --json flag was not preserved during delegation'

  : >"$node_log"
  FAKE_NODE_LOG="$node_log" PATH="$fake_node_bin:$PATH" \
    "$prototype_dir/trellage" list --json-full
  [[ "$(sed -n '2p' "$node_log")" == $'ARG\tlist' ]] \
    || fail 'list --json-full did not preserve list'
  [[ "$(sed -n '3p' "$node_log")" == $'ARG\t--json-full' ]] \
    || fail 'list --json-full flag was not preserved during delegation'

  output="$("$prototype_dir/trellage" list --prompt hello 2>&1)" && fail 'list accepted --prompt' || true
  grep -Fqx 'trellage: --prompt is not supported for compiler commands' <<<"$output" \
    || fail 'list --prompt diagnostic is incorrect'

  printf 'Trellage host test: PASS: list delegates to Effect CLI\n'
}
```

Register the test next to the other compiler tests in the file’s test runner section (same place `test_upgrade_delegates_to_effect_cli` is invoked).

Also ensure any exhaustive case that rejects `--prompt` on compiler commands includes `list` if it enumerates command names — the early `compiler_mode` detection is the mechanism.

- [ ] **Step 2: Run host contract expecting failure**

Run:

```bash
bash prototypes/trellage/tests/host_command_contract.sh
```

Or, if the suite is large, run after implementation. If the suite has no filter, implement shell changes first then run — still write the test before fixing if practical. Minimum: after shell change, run the full host contract or the subset the Makefile uses.

- [ ] **Step 3: Update `prototypes/trellage/trellage`**

Change both compiler command lists from:

```bash
validate|lock|build|upgrade)
```

to:

```bash
validate|lock|build|upgrade|list)
```

There are **two** sites: early `mode=compiler` detection (~line 118) and the `exec` dispatch case (~line 319). Update both.

- [ ] **Step 4: Document in README**

Near existing `trellage validate` examples in `README.md`, add:

```markdown
# List sandbox profiles (selection catalog)
trellage list
trellage list --json
trellage list --json-full
```

Keep it short; no need for a long section.

- [ ] **Step 5: Run host contracts + package tests**

```bash
cd packages/trellage-cli && npm test
bash prototypes/trellage/tests/host_command_contract.sh
```

Expected: PASS for new list tests; no regressions on upgrade/choices.

If full host suite is too long for interactive use, still run it once before final claim of completion.

- [ ] **Step 6: Commit**

```bash
git add prototypes/trellage/trellage prototypes/trellage/tests/host_command_contract.sh README.md
git commit -m "feat(trellage): forward list to profile compiler"
```

---

### Task 5: End-to-end verification

**Files:** none new (verification only)

- [ ] **Step 1: Build compiler and exercise all three modes**

```bash
cd packages/trellage-cli && npm run build
node dist/cli.js list | head
node dist/cli.js list --json | jq .
node dist/cli.js list --json-full | jq '.[ ]? // . | {schemaVersion, names: [.profiles[].name], sample: .profiles[0] | keys}'
```

Assert:

```bash
node dist/cli.js list --json | jq -e '
  .schemaVersion == 1
  and ([.profiles[] | keys] | all(. == ["description","name"] or . == ["name","description"]))
'
node dist/cli.js list --json-full | jq -e '
  .schemaVersion == 1
  and all(.profiles[]; has("path") and has("supportedPlatforms") and has("harness") and has("skills") and has("plugins") and has("mcps") and has("description") and has("name"))
'
# mutual exclusion
if node dist/cli.js list --json --json-full 2>/tmp/list-err.txt; then echo FAIL; exit 1; fi
grep -qi 'mutually exclusive' /tmp/list-err.txt
```

- [ ] **Step 2: Via shell launcher (worktree)**

```bash
./prototypes/trellage/trellage list --json | jq -e '.profiles | length >= 9'
```

- [ ] **Step 3: Run package test suite**

```bash
cd packages/trellage-cli && npm test
```

Expected: all green.

- [ ] **Step 4: Final commit only if verification fixed anything; otherwise done**

No empty commit. If README or error message tweaks were needed, commit:

```bash
git add -A && git status
# commit only if there are real fixes
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| `list` human output | 2, 4 |
| `list --json` simplified schema | 1, 2 |
| `list --json-full` inventory schema | 1, 2 |
| Mutual exclusion of flags | 2 |
| TOML-only source of truth | 3 |
| Discover via bundled + worktree | 2 (reuses `discoverProfileChoices`) |
| Shell forward as compiler command | 4 |
| Reject `--prompt` / `--interactive` on list | 4 |
| Canonical nine descriptions | 3 |
| `choices` unchanged API | 2 (no choices rewrite) |
| Native catalogs untouched | (no task — intentional) |
| Offline / no network | 1–2 |
| Tests without Docker | 1, 2, 5 |

## Placeholder / consistency self-review

- No TBD steps; canonical description strings inlined in Task 3.
- DTO names (`toSimplifiedList`, `toFullList`, `formatProfileListHuman`) consistent across tasks.
- Public JSON uses `path` / `supportedPlatforms`; internal `ProfileChoice` keeps `value` / `supported_platforms`.
- Em dash characters in descriptions are intentional (from design); keep them.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-trellage-list-json.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
