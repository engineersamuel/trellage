# Profile guide authoring

`trx guide` uses profile guides in two phases. Write each field for the phase
that reads it.

## Match-visible fields

The match model receives:

- the Native catalog or Sandbox `profile.toml` `description`;
- `capabilities`;
- `bestFor`;
- `avoidFor`;
- prerequisites;
- workflow IDs, descriptions, skills, and examples.

It does not receive the Markdown body or `promptTemplate` values during
matching.

Use these fields as follows:

| Field | Purpose |
| --- | --- |
| Catalog description | State the profile identity, strongest outcome, and primary differentiator in concise text. |
| `capabilities` | Name stable, searchable abilities. Do not copy a package inventory. |
| `bestFor` | State user outcomes for which this profile is a strong choice. |
| `avoidFor` | State concrete disqualifiers, costs, and close alternatives. |
| Workflow description | State the outcome one workflow delivers. |
| Workflow examples | Give natural user prompts that should select that workflow. |

Every workflow must have at least two realistic examples. At least one example
should distinguish the profile from its closest alternative when profiles
share skills or broad capabilities.

## Generation-only fields

After the user selects a profile, generation receives the complete selected
guide, including:

- each workflow's `promptTemplate`;
- the Markdown body below the frontmatter.

Use the body for detailed operating notes, verified invocation syntax, and
generation context. Do not put important matching distinctions only in the
body.

## Workflow launch settings

Use optional `launchAgent` metadata when a workflow requires a specific
installed Copilot custom agent, for example `launchAgent: hve-core:dt-coach`.
The value is an exact agent identifier of at most 128 ASCII letters, digits,
periods, underscores, colons, or hyphens, starting with a letter or digit.

The guide carries this selection into command previews, current-terminal
launches, and Herdr handoffs and queued jobs as `--agent <identifier>`.
It is supported by native `cpx` and Sandbox `copilot` profiles. It does
not install agents, change prompt delivery, or select an agent for other
workflows on the same profile. Omit it when no workflow-specific agent is
required.

## Goal execution policy

Use optional `goalExecution` frontmatter to declare which existing workflows
can execute an approved goal. A guide without this field declares no goal
execution support. It remains available for ordinary prompts.

```yaml
goalExecution:
  controller: codex-goal
  workflowIds:
    - test-driven-development
    - plan-then-execute-branch
```

The policy accepts exactly `controller` and `workflowIds`. The workflow list
must contain 1 to 32 unique IDs from that guide. The guide file's Native or
Sandbox identity and the catalog's actual harness must support the controller.

| Controller | Supported surface | Workflow rule |
| --- | --- | --- |
| `codex-goal` | Native `cdx` running Codex | Keep the existing workflow discipline inside the application-owned native `/goal` invocation. |
| `claude-goal` | Native `cldx` or Sandbox Claude Code, except Graph of Loops | Keep the existing workflow frame inside the application-owned native `/goal` invocation. |
| `graph-of-loops` | Sandbox `claude-graph-of-loops` only | Use the `graph-of-loops` skill and the authored `/graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="..."` goal-start frame. |

Graph's policy names its four goal-start workflows, not
`inspect-or-resume-run`. Keep its authored constraints; `trellage-graph`
remains the completion authority. Do not wrap it in native `/goal`.

Do not add `/goal` to a native goal workflow template. The application adds
that command once. Do not invent `$goal`, use `/goal-me` or `$goal-me` to
execute an approved goal, or bind a goal workflow to a Copilot `launchAgent`.
Goal me authors goals; it is not an execution controller. Superpowers TDD,
Codex pstack, and other workflow disciplines remain subordinate to the
declared controller. Firstmate, HVE, Pi, and other wrappers do not get a
controller from their skill names or model routes.

The full catalog and selected guide retain the policy. Ordinary matching
does not receive it. Goal matching must call `guideMatchCatalogEntries` or
`toGuideMatchCatalogEntry` with `true` as the second (`includeGoalExecution`)
argument; the policy is then present on the compact entry, not
duplicated inside its `guide`. `compactProfileGuide` keeps its ordinary
projection.

This metadata does not prove runtime readiness or authorize more work.
Launch still requires compatible runtime versions, enabled goal support,
trust, and permitted hooks. Codex needs native command input, not a
positional startup prompt. Claude print mode and interactive sessions have
different delivery requirements. Keep profile restrictions, workflow
approval gates, and the approved goal's criteria intact.

## Exclude profile maintenance

Workflows describe work that a user wants the agent to do. Do not add
workflows or examples for:

- setup or repair;
- doctor or readiness checks;
- profile, proxy, or launcher smoke tests;
- extension or model inventory checks;
- prompts such as `Reply exactly PROFILE_OK`.

Keep those instructions in the Markdown body or the launcher's operational
README.

## Strong example

```yaml
bestFor:
  - Bounded private code changes that must stay on a local model route
  - Cost-controlled refactors where peak frontier-model quality is not required
avoidFor:
  - Hard architecture decisions that need frontier-model reasoning
  - Broad multi-agent programs that need durable orchestration
workflows:
  - id: bounded-private-edit
    description: Implement a well-scoped code change on the local model route.
    examples:
      - Add validation to this internal data-import script without using a hosted model
      - Refactor this small parser while keeping all source code on my machine
    promptTemplate: |
      {{intent}}
```

## Weak example

```yaml
bestFor:
  - Coding
workflows:
  - id: smoke-test
    description: Confirm the profile works.
    examples:
      - Reply exactly OK
```

The weak form gives the matcher no useful outcome, boundary, or
differentiator.

## Evaluation

Normal validation runs the source-controlled scenarios through the
deterministic literal matcher. It does not make model calls.
Each scenario sets a maximum acceptable rank for its expected profile and can
name close alternatives that must rank lower.

Live evaluation is explicit because it can consume paid quota:

```sh
make profile-guide-live-evaluation
```

The live evaluator builds the worktree launcher, uses an isolated guide cache,
and runs the same scenarios through `trx guide --json`. Native launchers must
be synchronized with the worktree first; the evaluator fails before model
calls when an installed Native catalog description differs from its source
catalog.
