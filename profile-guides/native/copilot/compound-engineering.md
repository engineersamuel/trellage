---
schemaVersion: 2
templates:
  plan-with-compound-knowledge: /ce-plan {{intent}}
  autonomous-lfg-plan-to-pr: /lfg {{intent}}
  capture-verified-repository-learning: /ce-compound mode:non-interactive {{intent}}
---

# Native Copilot CLI (`copilot`) - `compound-engineering`

`trx run copilot compound-engineering` loads Every's 33-skill Compound Engineering
package. Its promise is simple: each completed unit of engineering work should
make the next easier through better requirements, reviewed plans, verified
delivery, and repository-local solution knowledge.

## Set Up Each Repository Once

Install the profile with `trx setup copilot compound-engineering`. On first use in a
repository, start a bare conversational session and run `/ce-setup` manually:

```text
trx run copilot compound-engineering
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

When `trx list copilot --json` advertises `headless.prompt: true` for the installed
Copilot version, `trx guide` can use a headless one-shot `trx run copilot compound-engineering -- -p` command.
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

For interactive product shaping, start bare `trx run copilot compound-engineering` without
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

The generated `/ce-compound mode:non-interactive` run does not inherit the Copilot
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

## Choose a `copilot` Profile

- Choose `trx run copilot compound-engineering` for compound learning and plans informed by
  repository-local solution knowledge.
- Choose `trx run copilot hve` for evidence-backed Research-Plan-Implement work and staged
  RPI artifacts.
- Choose `trx run copilot superpowers` for strict TDD, root-cause debugging, verification,
  and branch-finishing discipline.
- Choose `trx run copilot awesome` to find and import curated Copilot agents,
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
- `trx list copilot --json` advertises the exact headless contract for tested Copilot
  CLI version `1.0.81`; other versions report conservative headless values.
