---
name: trellage-upgrade-all
description: 'Update all Trellage Native and Container harness versions and skills through the same operation as Admin A. Use when the user invokes trellage-upgrade-all, asks to upgrade every harness and its skills, or requests a repeated global upgrade.'
user-invocable: true
disable-model-invocation: false
---

# Upgrade all harnesses and skills

Use `trx upgrade all`. Admin's `A` action and this skill use the same planner
and queue. Do not maintain a second upgrade loop or run separate skill and
harness update sequences.

## Safety

- Run on the host, not inside an agent container.
- Use the installed `trx` command. A worktree-local Node entry point is not
  proof that the installed command works.
- Preserve unrelated changes, authentication, profile version pins, source
  pins, and user-owned skills.
- Do not install or promote Trellage itself, change branches, commit, push,
  merge, or publish as part of this operation. These require separate intent.
- Do not start agent sessions or paid probes. Do not repair profiles, replace
  authentication, or substitute plugin updates for unsupported commands.
- Do not call `trellage upgrade all` as a substitute. That command remains
  Container-only and does not synchronize Native skill copies.
- Keep failures and unsupported profiles visible. Never report an old
  harness fallback as a successful update.

## 1. Confirm the command and target

Inspect:

```bash
command -v trx
command -v trellage
trx --help
```

Require `trx --help` to advertise `upgrade all` before invoking that mode.
Then inspect `trx upgrade --help` and require the combined harness-and-skills
operation. If the installed router is too old, report that it needs a
separate Trellage installation update. Do not silently use another checkout
or forward an unknown management command into a launcher.

Use the current Git worktree, as Admin does. If `TRELLAGE_UPGRADE_ROOT` is set,
it is authoritative: require an absolute, valid Git worktree root and verify
its repository identity before changing into it. A bad override is an error;
never fall back to a different repository. Record the chosen directory.

The command updates the discovered catalog: bundled Container profiles,
current-worktree overrides, and Native profiles. It does not scan unrelated
repositories or restart running sessions.

## 2. Preview the complete operation

From the chosen worktree:

```bash
trx upgrade all --dry-run
```

Review the Native skill targets, shared cache operation, Native harness
groups, Container images, and unsupported entries. Do not use Admin filters
to infer the scope; the global operation includes hidden profiles.

The preview does not update harnesses, skill caches, profile skill files, or
installed-version data. A missing or incomplete catalog blocks execution.
Unsupported profiles make the preview exit nonzero; distinguish that from
failed discovery and retain those diagnostics.

If the user requested only a preview, stop here. Otherwise, an explicit
request to run this skill or upgrade all harnesses and skills authorizes the
confirmed operation below. Do not infer that approval from a design question.

## 3. Run the shared queue

```bash
trx upgrade all --yes
```

For a human-driven terminal session, `trx upgrade all` provides its own
preview and confirmation instead. Do not pipe `yes` into it.

The command owns all mutation and ordering:

1. Update each shared Native harness runtime once. Firstmate remains
   profile-scoped and keeps its catalog source pins.
2. Refresh the shared Native skill caches once, including the YouTube, OMP
   community, and guide Prompt Master caches.
3. Copy and verify current managed skills for each confirmed Native profile.
   A cache-refresh failure prevents stale Native skill copies.
   This happens after Native harness updates so those updaters cannot
   overwrite the final skill copies.
4. Rebuild each Container profile with its configured harness selector and
   current configured skills. Harness package and harness-source fallback
   fail closed.
5. Read installed versions and report all outcomes.

Do not repeat these phases yourself. The queue handles independent failures,
unsupported commands, cancellation, and version refresh.

## 4. Report the actual result

Require exit status zero and complete harness and skill results before
reporting success. A nonzero result can include useful completed updates;
report those alongside failures, unsupported profiles, and work not run.
Latest-version lookup failures must remain visible and are not proof that a
harness is current.

A missing `skills-update` or `harness-update` command requires a separate
launcher installation update. A missing profile setup or unsafe path is not
permission to create or repair it. Preserve the exact diagnostic.

Cancellation exits `130`. Completed updates are kept; do not claim a rollback.
Running sessions are not restarted and can still use their previous loaded
harness or skill content until relaunched.

Only repeat `trx upgrade all --yes` when the user requested a repeated
upgrade. Core locks and pins are distinct from floating skills. Do not
promise byte-identical skills or images when upstream default branches have
changed between runs.
