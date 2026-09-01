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
| Workflow `skill` | Declare the portable command or skill identifier when its `promptTemplate` contains an invocation that Prompt Master must preserve. This field is also visible during matching. |
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
