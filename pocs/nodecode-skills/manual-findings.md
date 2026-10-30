# Native manual-dispatch spike

## Verdict

**A small native command bridge is feasible on Nodecode
`0.1.1+6d58aa70b`.** A command-only peripheral can read a selected private
skill as text, build a prompt with its stable asset directory, and call the
native prompt-ingress API. It does not need to register a model tool, import
private knowledge, or install an upstream plugin.

**A slash command is not an authorization boundary.** Nodecode exposes
`nle:slash` inside eval; an eval can invoke the same command. Hiding private
skills from knowledge/tool discovery prevents automatic provisioning, not
access by an agent with host authority. Do not describe this as enforced
user-only execution or a filesystem sandbox.

## Reproduction

```sh
bash pocs/nodecode-skills/manual-probe.sh
```

Requires the installed Nodecode binary and Python 3; `NODECODE_BIN` can select
a specific binary. The observed result is:

```text
nodecode 0.1.1+6d58aa70b
PASS: 36 offline manual-dispatch assertions.
No real session/store, model request, user home or upstream plugin was used.
```

The script creates and deletes an independent temporary home. It clears the
inherited environment, redirects HOME/NODECODE_HOME/XDG paths, disables
updates, uses only synthetic fixtures, and invokes the release's internal
`trial` evaluator. It never uses RPC, starts a gateway, or creates a real
session. `trial` is an internal testing interface, not a proposed production
integration API.

The probe intercepts **the real `nle:submit` seam** through `nle:hook` before
admission, store access, worker startup, or inference. Thus the proof reaches
prompt construction and submission dispatch, **not an actual model applying
the skill**. Do not present these tests as end-to-end inference evidence.

## Prototype

- `manual-bridge.lisp`: Trellage-owned command-only cell. Its synthetic
  allowlist maps `i-have-adhd` to a private fixture directory outside `cells`.
  `/trx-skill SKILL PROMPT` reads only a selected skill, preserves the operator
  request and source provenance, and submits a prompt. It registers neither
  a model tool nor a help topic containing manual prose.
- `manual-check.lisp`: native assertions against the actual loaded cell,
  native knowledge reader, slash registry/dispatch, and function hooks.
- `manual-probe.sh`: disposable packaging, fixtures and test execution.

This is not installed into the operator's home or wired into `trx run`.
The allowlist is a stand-in for a validated selected-snapshot manifest,
not another skill-selection parser.

## Observed contracts

| Contract                                      | Result                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Native ASDF cell packaging and package name   | The boot loader loads the command cell.                                                                                        |
| Native command registration                   | `nle:define-cell` `:command` registers `/trx-skill`.                                                                           |
| Repeat start / repeated stop                  | One command after repeated starts; no command after repeated stops.                                                            |
| Disabled cell                                 | An explicit JSON `false` prevents registration; loaded Lisp functions remain callable.                                         |
| Manual discovery                              | Private fixture name/prose absent from native knowledge; prose absent from help before and after invocation.                   |
| Model tool discovery                          | No `trx-skill` tool is registered.                                                                                             |
| Explicit dispatch                             | `nle:slash` calls the registered handler; the handler reaches `nle:submit` with skill content, operator prompt and provenance. |
| Metadata-only control                         | A knowledge entry retaining `disable-model-invocation: true` remains discoverable/readable through native help.                |
| Unknown skill / ID traversal / missing prompt | Refused without submission.                                                                                                    |
| Deselect                                      | Removing the ID from the selected manifest prevents further dispatch.                                                          |
| Assets                                        | Nested relative asset readable; absolute paths, `..` and an escaping symlink refused.                                          |
| Generation cleanup                            | Deleting the synthetic generation directory does not affect the stable private asset path.                                     |
| Nonexecution                                  | Reader-eval-looking prose does not create its sentinel file.                                                                   |
| Model eval access                             | An eval calling `nle:slash` can invoke this command; absence from tool discovery is not enforcement.                           |

## Exact APIs and evidence pointers

The installed release source under `current/src/src/` establishes:

- `organism/cell.lisp`, `define-cell`: `(:command NAME RUN ...)`, automatic
  registration cleanup, `START-CELL` taking the whole parsed config, and
  idempotent `STOP-CELL`.
- `surface/gateway.lisp`, `register-command`: handler signature is
  `(args session-id)` and its return is `(values TEXT DIALOG)`.
  **Returning skill text merely displays it; it does not start a skill turn.**
- `surface/gateway.lisp`, `submit`: exported native ingress
  `(nle:submit session-id prompt :source SOURCE :source-id ID)` starts or
  queues a turn. Native command submission must report admission honestly;
  the prototype says "submitted", not "completed".
- `surface/client.lisp`, `slash`: exported headless native command dispatch,
  also callable from eval. The prototype deliberately tests this limitation.
- `organism/knowledge.lisp`, `knowledge-entries` / `knowledge-entry-named`:
  the actual native discovery reader used for the privacy assertions.
- `organism/launch.lisp`, `trial-main`: offline form evaluation; resets the
  cell-directory variable, which the assertions rebind to the disposable
  home's `cells/` to exercise discovery. The cell itself loads through boot,
  and the test explicitly calls its `START-CELL` (trial does not run a gateway).
- `waist/json.lisp`: decoded JSON `false` is Lisp `nil`, not `:false`.

Public documentation corroborates the command/lifecycle contract:
<https://nodecode.ai/docs/cell-api>.

## Production implications / unproved behavior

1. Prefer one generic native explicit command over per-skill executable
   cells. A separate `trx skill nodecode` CLI is not required for API
   feasibility, but may be preferable if product policy requires a clearly
   user-originated entry point outside the model's eval surface.
2. Enforce the manual boundary by provisioning: private content never enters
   ordinary knowledge/help/tool catalogs; no upstream code is installed.
   Document the same host-authority limitation as other Native integrations.
3. Consume canonical selection and invocation metadata, and pin a complete
   immutable snapshot for each invocation. The fixture allowlist is not a
   production manifest, publisher or concurrent snapshot lease system.
4. Snapshot publication must validate assets and prevent mutation. The
   `truename` containment check here is useful but does not solve TOCTOU
   against concurrently modified/untrusted filesystem contents.
5. The selected-skill assets are readable data. The spike does not execute
   Office scripts, install host dependencies, or map tool/subagent behavior.
6. No TUI gesture, gateway HTTP/WebSocket round trip, paid inference, real
   session admission, conversation persistence, restart migration, or
   production router integration was tested here.
7. Code stopping/disabling is not unloading. Removal of a manual registration
   does not erase content already submitted to conversation or learned state.
