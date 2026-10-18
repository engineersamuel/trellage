# Profile guide authoring

`trx guide` and `trx run list` share one selection catalog. Author descriptions,
strengths, weaknesses, capabilities, suitable/unsuitable tasks, prerequisites,
and workflow selection metadata in `config.example.toml`. This file contains
shipped defaults; a user's effective config at `~/.config/trellage/config.toml`
owns custom profiles and overrides.
See [the run catalog contract](../docs/run-catalog.md) for precedence and readiness.

Markdown files in this directory contain detailed operating notes and workflow
prompt templates. They are not a second source of selection descriptions.

## Match-visible fields

The match model receives both harness and profile selection metadata:

| TOML field | Purpose |
| --- | --- |
| `description` | Identity, strongest intended outcome, and primary differentiator. |
| `strengths` | Concrete advantages of the configured tools or workflow. |
| `weaknesses` | Known limits and costs, not unsupported benchmark claims. |
| `capabilities` | Stable, searchable ability identifiers; not a package inventory. |
| `best_for` | User outcomes for which this configuration is a strong choice. |
| `avoid_for` | Concrete disqualifiers and close alternatives. |
| Workflow `description` | The outcome one workflow delivers. |
| Workflow `examples` | Natural prompts that distinguish it from close alternatives. |

TOML uses snake_case; JSON projects `bestFor` and `avoidFor`. A description and
one `best_for` entry are the minimum metadata for Guide eligibility. Missing
assessments are unknown, not empty statements of no weaknesses. Keep existing
user profiles runnable when metadata is missing, but do not recommend them.

Every explicitly authored workflow must have at least two realistic examples.
At least one should distinguish it from the closest alternative when profiles
share skills or broad capabilities. The built-in generic `task` workflow has no
fabricated examples and needs no Markdown document.

```toml
[native.profiles.patch-review.selection]
description = "Review a bounded patch for correctness and regressions."
best_for = ["Pre-integration patch review"]
avoid_for = ["Unbounded redesign"]

[native.profiles.patch-review.guide]
document = "patch-review.md"

[[native.profiles.patch-review.guide.workflows]]
id = "review-patch"
description = "Find correctness and regression risks in the requested patch."
examples = [
  "Review this parser change for edge cases before integration",
  "Check this bug fix for regressions without redesigning the subsystem",
]
```

User document paths resolve relative to the config file; `~/` is supported.
Bundled documents use references such as `shipped:native/pi/default.md`, which
resolve under the installed guide root rather than the user's config directory.
For a shared profile, `guide.documents` maps harness IDs to different instruction
documents and overrides `guide.document` for those harnesses.

## Generation-only instructions

A Markdown instruction document uses schema version 2:

```markdown
---
schemaVersion: 2
templates:
  review-patch: |
    Review {{intent}} for correctness and regression risks.
    Report evidence and keep proposed changes within the requested scope.
---

# Patch review

Detailed operating notes and verified tool invocation syntax go here.
```

Each template must contain exactly one `{{intent}}` placeholder and no other
placeholder. The keys must match the TOML workflow IDs. The body must be nonempty.
Do not repeat selection fields in this frontmatter: the parser rejects them.
The match model receives neither prompt templates nor the Markdown body.
Generation receives the selected workflow's full instructions after selection.

Existing v1 document parsing remains for compatibility readers and fixtures;
shipped selection descriptions are authored in TOML, not v1 Markdown.

## Workflow launch settings

Use optional TOML `launch_agent` when a workflow requires a specific installed
Copilot custom agent, for example `hve-core:dt-coach`. The exact identifier has
at most 128 ASCII letters, digits, periods, underscores, colons, or hyphens and
starts with a letter or digit. JSON retains the `launchAgent` spelling.

Guide carries it into command previews, current-terminal launches, and Herdr
handoffs/jobs as `--agent <identifier>`. This does not install agents or change
other workflows' prompt delivery.

Verified customer workflows on `native:copilot/hve` may declare:

```toml
launch_agent = "hve-core:dt-coach"
interaction = { mode = "interactive", required_skills = ["dt-coaching-foundation", "dt-methods", "dt-rpi-integration"] }
frame = "fixed"
```

This requires an explicit agent and 1 to 16 unique lowercase kebab-case skill
names. It selects `trx run copilot hve -- --agent ...` with one `--require-skill`
per entry and `-i` for the prompt. Before launch, Guide checks the installed
manifest and enabled skill files through the private Copilot lifecycle manager's
`workflow-check`, including a recheck in the chosen Herdr destination.

Interactive workflows require a terminal and cannot use the batch queue.
They do not use headless fallback or autonomous Copilot defaults. Other profiles
cannot declare this contract without equivalent verified checks. Keep a fixed
frame bounded to one agent's purpose. Require applicable references and stop if
they are unavailable. Static checks do not prove upstream instructions were
followed; keep customer signoff, evidence quality, experiment outcomes, and
permission to implement distinct.

## Goal execution policy

Optional TOML `guide.goal_execution` declares which existing workflows can
execute an approved goal. Omission means no goal execution support, not exclusion
from ordinary matching.

```toml
[native.profiles.preset-codex-superpowers.guide.goal_execution]
controller = "codex-goal"
workflow_ids = ["test-driven-development", "plan-then-execute-branch"]
```

The policy accepts exactly `controller` and `workflow_ids`, with 1 to 32 unique
IDs from the profile's authored workflows. Canonical profile identity and actual
harness must support the controller:

| Controller | Supported Native harness |
| --- | --- |
| `codex-goal` | Codex |
| `claude-goal` | Claude Code |

Existing workflow discipline stays inside the application-owned native `/goal`
invocation. Do not add `/goal` to a template; the application adds it once.
Do not invent `$goal`, use `/goal-me` or `$goal-me` to execute an approved goal,
or bind a goal workflow to a Copilot `launchAgent`. Goal me authors goals; it is
not an execution controller. Firstmate, HVE, Pi, and other wrappers do not get a
controller from skill names or model routes. Generic task workflows have none.

The catalog retains the policy. Ordinary matching excludes it; goal matching
uses `guideMatchCatalogEntries(catalog, true)` or
`toGuideMatchCatalogEntry(entry, true)`. The policy appears on the compact entry,
not duplicated inside its compact guide.

Metadata is not runtime readiness or authorization. Launch still checks compatible
runtime versions, enabled goal support, trust, and permitted hooks. Codex needs
native command input, not a positional startup prompt. Claude print mode and
interactive sessions have different delivery requirements. Preserve profile
restrictions, workflow approval gates, and the approved goal's criteria.

## Exclude profile maintenance

Workflows describe work a user wants the agent to do. Do not add workflow examples
for setup/repair, doctor/readiness checks, launcher/proxy smoke tests, inventory
checks, or prompts such as `Reply exactly PROFILE_OK`. Keep operational guidance
in the Markdown body or the launcher's operational README.

## Evaluation and generated content

Normal validation uses deterministic literal-matching scenarios and makes no
model calls. Scenarios set a maximum acceptable rank for the expected profile
and may require close alternatives to rank lower.

Shipped examples and retained lifecycle descriptions are derived from TOML:

```sh
bun scripts/generate-run-catalog-content.ts --check
make profile-guide-contract
```

Live evaluation is explicit because it may consume paid quota:

```sh
make profile-guide-live-evaluation
```

It uses the shared effective catalog and local eligibility, an isolated Guide
cache, and the scenarios through `trx guide --json`. Unavailable or incomplete
choices are not valid evaluation recommendations. Diagnose local setup/metadata
rather than silently expanding the catalog to make a scenario pass.
