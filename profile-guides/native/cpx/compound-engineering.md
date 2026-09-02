---
schemaVersion: 1
capabilities:
  - compound-engineering-loop
  - requirements-to-implementation-ready-planning
  - repository-local-solution-reuse
  - verified-one-learning-per-run-capture
  - requirements-ready-autonomous-lfg-delivery
bestFor:
  - Turning raw intent, settled requirements, or a requirements-only CE plan into a reviewed implementation-ready plan that reuses repository solutions
  - Planning a new change from known past bugs or docs/solutions so prior root causes and constraints become implementation decisions
  - Capturing exactly one verified, non-trivial solved problem with ce-compound so later agents reuse the root cause, fix, and prevention
  - Shipping requirements-ready software hands-off to an open pull request with lfg when commit, push, PR creation, and CI access are allowed
avoidFor:
  - Vague product discovery through a generated one-shot prompt; start a bare interactive cpx session and run ce-brainstorm
  - Generated implementation-only work that must stop before commit or push; no headless ce-work workflow is exposed, so use ce-work mode:return-to-caller from a conversational session
  - Evidence-heavy Research-Plan-Implement work that needs HVE artifacts - use cpx hve instead
  - Strict test-first debugging, verification, and branch-finishing discipline - use cpx superpowers instead
  - Finding or importing Copilot agents, instructions, or skills from Awesome Copilot - use cpx awesome instead
  - Approval-required work; every launch uses --autopilot --allow-all --no-ask-user
  - Work that needs OS isolation; this native cpx profile has host access, so use an OS-isolated cdx or grx profile
prerequisites:
  - id: copilot-cli
    description: GitHub Copilot CLI 1.0.74 or later, already authenticated, on the host.
  - id: cli-tools
    description: jq and curl available on the host for setup, doctor, and update checks.
  - id: compound-setup
    description: On first use in a repository, start a bare conversational session and run /ce-setup manually to check capabilities and optionally create the repo-local Compound Engineering configuration.
  - id: lfg-delivery
    description: For lfg delivery, use a trusted worktree with a Git remote, authenticated gh access, and permission to commit, push, open a PR, and watch CI.
  - id: project-tools
    description: The current repository's required build, test, browser, Xcode, and other project tools must be installed on the host for the selected skills.
workflows:
  - id: plan-with-compound-knowledge
    description: In the generated headless run, accept raw intent, settled requirements, or a requirements-only CE plan and use upstream ce-plan's Durable path to produce an implementation-ready unified plan with document review, informed by relevant repository learning. It plans but does not implement.
    skill: ce-plan
    examples:
      - Turn the requirements-only plan at docs/plans/tenant-api-keys-plan.md into a reviewed implementation plan, reusing relevant solutions from earlier authentication work
      - Plan this migration using lessons from past zero-downtime failures, these constraints, and these acceptance criteria
      - Use what this repository learned from past bugs to plan the next change, including constraints and acceptance criteria
    promptTemplate: |
      /ce-plan {{intent}}
  - id: autonomous-lfg-plan-to-pr
    description: For requirements-ready software or an existing plan, run the hands-off pipeline to plan, implement, simplify, review and fix, browser test, commit, push, open a PR, and watch CI. Best results follow ce-brainstorm or include detailed scope, constraints, and acceptance criteria. By default it stops at an open PR and does not merge; an explicit stack-land instruction authorizes landing a managed PR stack. Without a remote it leaves local commits, and it can stop before a PR when planning, implementation, or review gates report a blocker. A bounded repair loop can finish with residuals.
    skill: lfg
    examples:
      - Implement the approved plan at docs/plans/tenant-api-keys-plan.md, verify it, open the pull request, watch CI, and stop before merge
      - "Requirements are settled for resumable uploads: preserve completed chunks, recover after process crashes, and prove retry safety; ship the implementation through an open PR without check-ins"
      - Replace invoice polling with webhook updates under the approved contract, keep the fallback during migration, commit and push the work, open the PR, and watch CI
    promptTemplate: |
      /lfg {{intent}}
  - id: capture-verified-repository-learning
    description: After verified work, record exactly one non-trivial solved problem per run as repository-local solution knowledge, including the root cause, evidence, fix, and prevention. The fresh one-shot run does not inherit the earlier cpx conversation, so the intent must carry those facts and the solved change must be visible in the current tree. It can skip when no valid learning exists.
    skill: ce-compound
    examples:
      - Capture the verified stale-permission-cache failure with its trigger, root cause, fix, proof, and prevention so later authorization work reuses it
      - Record why the zero-downtime enum migration failed, the evidence that isolated the cause, and the validated deployment sequence that fixed it
      - Save the verified webhook deduplication race, the database constraint that solved it, and the test that prevents regression
    promptTemplate: |
      /ce-compound mode:non-interactive {{intent}}
---

# Native Copilot CLI (`cpx`) - `compound-engineering`

`cpx compound-engineering` loads Every's 33-skill Compound Engineering
package. Its promise is simple: each completed unit of engineering work should
make the next easier through better requirements, reviewed plans, verified
delivery, and repository-local solution knowledge.

## Set Up Each Repository Once

Install the profile with `cpx setup compound-engineering`. On first use in a
repository, start a bare conversational session and run `/ce-setup` manually:

```text
cpx compound-engineering
/ce-setup
```

Even a bare session uses `--autopilot --allow-all --no-ask-user`. It has no
blocking question tool or permission pause. CE skills that need a decision
fall back to numbered choices in chat and wait for the next conversational
turn.

`/ce-setup` reports optional capabilities, refreshes the generated example
configuration, and offers before creating the optional repository
configuration or editing user-owned files. Plans default to `docs/plans/` and
learnings to `docs/solutions/`; set `docs_root` in
`.compound-engineering/config.yaml` when the repository needs another tracked
artifact root. An invalid `docs_root` blocks artifact writes until it is fixed.

## Most Effective Loop

Spend the most human judgment on requirements, planning, and review. Let the
agent do the implementation between those gates:

```text
/ce-brainstorm <vague feature or problem>
/ce-plan
/ce-work
/ce-compound
```

Use `/ce-brainstorm` when product behavior, scope, or success criteria are
still open. It presents one question per turn in chat and produces
requirements for `/ce-plan`. Standalone `/ce-work` implements the approved
plan, then owns its simplify, code-review, commit, push, and open-PR tail. Use
`/lfg` only when requirements are settled and you want the whole pipeline to
run without check-ins. Compound exactly one verified, non-trivial learning per
`/ce-compound` run.

For implementation-only work that must stop after local verification, use
`/ce-work mode:return-to-caller <plan-path>`. That mode skips the standalone
simplify, review, commit, push, PR, and CI tail.

When `cpx list --json` advertises `headless.prompt: true` for the installed
Copilot version, `trx guide` can use a headless one-shot `cpx -p` command.
Otherwise it returns a conversational launch with a prompt to paste. In both
cases the selected prompt names exactly one skill, and Trellage does not chain
skills. The `/ce-plan`, `/lfg`, and `/ce-compound` tokens are Copilot skill
references inside prompts, not built-in CLI commands.

Outside headless mode, an ordinary interactive `/ce-plan` run can right-size
work to Direct or a Chat brief. It selects Durable when the current turn has
no synchronous user, the request asks for a plan, file, or output format, or
the work has a risk surface.

In a generated headless run, `/ce-plan` has no synchronous user, so it uses
Durable and produces an implementation-ready unified plan with document
review.

For interactive product shaping, start bare `cpx compound-engineering` without
`-p`. Run `/ce-brainstorm <intent>` and answer one question per turn. Then use
the same-session `ce-plan` handoff, or select `lfg` when the requirements are
ready for autonomous delivery.

## Give `trx guide` a Strong Intent

The guide exposes only the three reliable one-shot entry points below. Include
the outcome, constraints, acceptance criteria, relevant plan or prior
learning, and delivery boundary that apply.

| Goal | Effective intent |
| --- | --- |
| Plan | Name the desired outcome and product constraints, point to requirements or earlier solutions, and ask for an implementation-ready plan. |
| Ship with `lfg` | Point to approved requirements or a plan, state required verification, and explicitly allow commit, push, PR creation, and CI watching while forbidding merge. |
| Compound | Name one solved problem and provide the verified symptom, root cause, fix, evidence, and prevention to preserve. |

```text
trx guide "Turn the requirements-only plan at docs/plans/webhook-retries-plan.md into an implementation-ready plan using relevant solutions from earlier incidents."
trx guide "Implement the approved plan at docs/plans/tenant-api-keys-plan.md, verify it, commit, push, open the PR, watch CI, and stop before merge."
trx guide "Capture one verified stale-cache failure: include the trigger, root cause, fix, proof, and prevention for future authorization work."
```

Do not give `lfg` only a one-line feature idea when product choices are still
open. Brainstorm first, or put the settled requirements and acceptance
criteria directly in the intent.

The generated `/ce-compound mode:non-interactive` run does not inherit the cpx
conversation that fixed the problem. Do not say only "capture what we just
fixed." Put the symptom, root cause, fix, proof, and prevention in the intent,
and make sure the solved change is visible in the current tree.

Naming a model or harness as an instruction in an `lfg` intent can route
planning or implementation to that external target. Do not name one unless
that cross-harness execution is intentional.

## Other Interactive Entry Points

| Need | Skill |
| --- | --- |
| Decide what to build | `/ce-ideate` |
| Explore a vague feature | `/ce-brainstorm` |
| Diagnose an open-ended bug | `/ce-debug` |
| Implement, review, and ship an approved plan | `/ce-work` |
| Implement and verify locally without the shipping tail | `/ce-work mode:return-to-caller <plan-path>` |
| Review code before delivery | `/ce-code-review` |
| Polish a working browser feature with live feedback | `/ce-polish` |

## Choose a `cpx` Profile

- Choose `cpx compound-engineering` for compound learning and plans informed by
  repository-local solution knowledge.
- Choose `cpx hve` for evidence-backed Research-Plan-Implement work and staged
  RPI artifacts.
- Choose `cpx superpowers` for strict TDD, root-cause debugging, verification,
  and branch-finishing discipline.
- Choose `cpx awesome` to find and import curated Copilot agents,
  instructions, and skills.

## Risks and Limits

- This native profile has host access. Its isolated `COPILOT_HOME` is not an
  OS security boundary.
- Every launch uses `--autopilot --allow-all --no-ask-user`. It has no approval
  pause.
- Standalone `/ce-work` and `/lfg` can commit, push, and open a PR. `/lfg`
  stops at the open PR and does not merge by default, but an explicit
  `stack-land` instruction authorizes it to merge a managed PR stack. Without
  a remote, it leaves local commits. It can stop early when a planning,
  implementation, or review gate reports a blocker, and it can finish with
  residual findings when its bounded CI repair budget is exhausted.
- CE planning, implementation, or review can send plan or code context to an
  installed external harness when live intent or checkout configuration
  selects it. `plan_model` and `brainstorm_model` are independent of the
  review switch; leave them unset to keep planning on the current host.
  Automatic cross-model review also requires a resolvable peer and an
  attestable host family. Set `cross_model_review_mode: off` in the active
  `.compound-engineering/config.local.yaml` or `config.yaml` layer to disable
  automatic review egress. A live explicit request can still opt in for that
  run.
- Browser, Xcode, and configured integrations need their host or network
  prerequisites.

## Operations

- Health checks all 33 cataloged runtime skills. The catalog is the source of
  the exact health list.
- The profile has no standalone MCPs.
- `cpx list --json` advertises the exact headless contract for tested Copilot
  CLI version `1.0.81`; other versions report conservative headless values.
