# Native Firstmate profiles (`fmx`)

`fmx` is the Trellage Native launcher for [Firstmate](https://github.com/kunchenguid/firstmate),
an agent distro that turns one coding agent into a fleet captain. `fmx` runs the
captain from a **pinned, overlaid runtime** and gives the captain and every
worker isolated Trellage-managed Claude state.

`fmx` is state isolation, not a security boundary. Firstmate, its captain, and
its workers run directly on the host.

## Profiles

| Profile | Task-id namespace | What it adds |
| --- | --- | --- |
| `default` | `fmd-` | Firstmate as shipped, with isolated captain and worker state. No worker policy. |
| `pstack-workers` | `fmp-` | The same fleet plus one small pstack-derived engineering policy inserted once into every ship and scout brief. |

Both profiles are interactive. Neither publishes a headless prompt contract:
`list --json` reports `prompt: false`, `outputFormats: ["text"]`, no resume, no
session id, no usage or cost, and no model or effort override.

## Commands

```
fmx PROFILE [FIRSTMATE_ARGS...]     launch the captain
fmx list [--json]                   static catalog; never probes anything
fmx inventory PROFILE --json        live readiness and fleet state
fmx setup PROFILE|--all             install the pinned runtime and profile state
fmx doctor PROFILE                  diagnose without changing anything
fmx repair PROFILE                  restore managed state
fmx update [--check] PROFILE|--all  move the runtime to the catalog pin
```

Network use, stated precisely:

- `setup` always fetches the pinned Firstmate source.
- `update PROFILE` fetches whenever the runtime must change or be reinstalled;
  it reports `is current` without fetching when the runtime already matches.
- `update --check` never fetches. It is a purely offline receipt comparison.
- `repair` fetches **only** when it must restage the runtime; otherwise it is
  local.
- `doctor` never fetches Firstmate source, but it does run the GitHub identity
  check (`gh auth status`), local Firstmate prerequisite detection, and the
  shared Claude health checks (local proxy), so it is not fully offline.
- A launch that finds missing Firstmate-specific prerequisites asks for
  consent before it downloads anything. An accepted install uses the host's
  configured npm registry plus locked, checksum-verified GitHub release
  assets.
- `list` and `list --json` are a pure projection of `catalog.json` and probe
  nothing at all.

If a shell remains inside a profile runtime that was atomically replaced,
its working directory inode can be deleted even though the same path exists
again. `fmx` detects this before it runs prerequisite or Claude checks,
continues from the validated home directory, and prints one recovery
diagnostic. The parent shell still owns its own directory; after the captain
exits, run `cd ~` before the next command if the shell prompt reports `getcwd`
or `Current directory does not exist`.

## First-launch prerequisites

`fmx setup` installs the pinned Firstmate runtime but does not silently change
the host toolchain. On the first captain launch, `fmx` runs Firstmate's own
detect-only, network-disabled prerequisite check with the selected backend and
the exact PATH that the captain and workers will receive.

If Firstmate-specific tools are missing, `fmx` shows:

- every missing tool;
- every exact version that Trellage will install;
- the complete install destination;
- the npm and GitHub release network sources;
- the separate `~/.no-mistakes` daemon-state location; and
- that no global npm package or global agent hook will be installed.

It then asks `Install these prerequisites now? [y/N]`. Anything except an
explicit yes changes nothing and stops the launch. Consent installs one
versioned toolchain under:

```
~/.local/share/trellage/fmx/prerequisites/<lock-identity>/
  bin/{no-mistakes,treehouse}
  npm/node_modules/.bin/{gh-axi,chrome-devtools-axi,lavish-axi,tasks-axi,quota-axi}
```

The npm dependency graph is committed in `prerequisite-lock/npm/package-lock.json`.
Its lock omits public-registry URLs, so `npm ci` uses the registry configured on
the host, including CFS packagefeedproxy where required. `no-mistakes` and
Treehouse use fixed release assets and checked-in SHA-256 values. Installation
is staged and verified before publication. The complete marker is written only
after every exact version runs. Project initialization keeps ownership of
`no-mistakes` daemon startup and readiness checks.

The toolchain directory is added before the host PATH for the captain and every
worker. Existing global tools are not replaced. A later launcher can publish a
different lock identity beside the old toolchain and does not delete the old
identity. Installing a new identity requires every Firstmate fleet and profile
mutation to be idle.

Host integration requirements stay outside this managed directory: `git`,
authenticated `gh`, `python3`, `jq`, Node 20+, npm, curl, and the selected
session backend (`herdr` in a valid Herdr pane, otherwise `tmux`). A missing
host requirement is reported but never installed through a package manager.

`chrome-devtools-axi` is installed because the pinned Firstmate contract treats
it as universal. The install does not start Chrome and does not install its
SessionStart hooks. A browser task starts or connects to Chrome only when it
uses that tool.

## The pinned runtime

`catalog.json` owns the exact source pin:

```json
"source": {
  "repository": "https://github.com/kunchenguid/firstmate.git",
  "commit": "4ad8cbaeafc109a17c1af3911867b7fe9e04e801",
  "overlay": "4ad8cbaeafc109a17c1af3911867b7fe9e04e801"
}
```

`fmx` never follows `main`. `setup` and `update` install exactly that commit:

1. Stage a fresh checkout and fetch the exact commit.
2. Verify the staged `HEAD` equals the pin. A different `HEAD` aborts.
3. Verify the sha256 of every file the overlay edits against
   `overlay/<commit>/manifest.json`. Any drift aborts before a single edit.
4. Apply the checked-in patches with `lib/fmx-overlay.py`, which matches hunk
   context exactly and never fuzzes.
5. Verify the sha256 of every patched file against the recorded result.
6. Publish the staged checkout over the live runtime by rename, then write the
   receipt.

The runtime and its receipt are published as **one transaction**. If either
move fails, the previous runtime *and* the previous receipt are renamed back
before the failure is reported; if even that rollback fails, both are preserved
and named in the error. A previously retired runtime is never discarded while
the live runtime is absent — it is restored instead, so the only good copy
cannot be lost. Failures before publication (fetch, HEAD mismatch, digest
mismatch, unclean stage) never touch the live runtime at all.

`update --check` is **always offline**: it compares the installed receipt to
the catalog pin and never contacts the network. `update` without `--check`
always fetches whenever the runtime must change or be reinstalled, and reports
`is current` without fetching when the installed runtime already matches the
pin. Either way it installs only the catalog pin; it is never a "latest" fetch.

## What the overlay changes

The overlay is small, keyed by commit, and stored in `overlay/<commit>/`.

- **`bin/fm-update.sh`** and the `updatefirstmate` skill: firstmate self-update
  is refused whenever a `.fmx-managed` marker is present, with a diagnostic that
  points at `fmx update <profile>`. Unmanaged clones are untouched.
- **`bin/fm-brief.sh`**: reads one worker-policy file from
  `FMX_WORKER_POLICY_FILE` and inserts it once into ship and scout briefs.
  Secondmate charters never receive it. The size bound is **fixed at 16384
  bytes by the overlay** and is deliberately not configurable from the
  environment. It also enforces the profile's task-id namespace.
- **`bin/fm-spawn.sh`**: replaces the opaque shell launch string with
  **structured inputs** to `FMX_WORKER_LAUNCHER` — task, kind, backend, brief,
  worktree, operational-input helper, model, effort, trace-context decision,
  `FMX_GH_CONFIG_DIR`, `FMX_TASK_ID_PREFIX`, `FMX_WORKER_HOME`, and
  `FMX_WORKER_PATH`, plus the captain's absolute `FMX_WORKER_BASH`. The pane
  command is leading variable assignments followed by that absolute Bash and
  the absolute helper path, not `env …`, so neither interpreter nor helper
  startup depends on the session daemon's `PATH`. It enforces Claude-only
  crewmates **before** building the invocation, refuses secondmate spawns,
  enforces the task-id namespace, and stops forwarding the captain's Claude
  store to workers. With no `FMX_*` variables set, the upstream launch path is
  byte-for-byte unchanged.

## Layout

Launcher runtime, removed by `uninstall.sh`:

```
~/.local/share/trellage/fmx/
  bin/fmx  catalog.json  policies/  overlay/<commit>/
  prerequisite-lock/{manifest.json,npm/{package.json,package-lock.json}}
  prerequisites/<lock-identity>/   consent-installed shared toolchain
  lib/{fmx-worker,fmx-overlay.py,fmx-prerequisites,native-claude,trellage-session-bridge.py}
~/.local/bin/fmx -> ...
```

`uninstall.sh` removes the launcher runtime and these managed prerequisite
toolchains. Both install and uninstall refuse while a Firstmate captain
session, worker, or profile mutation is active, or while one of those activity
markers is incomplete. They do not remove `~/.no-mistakes` state or any
profile root.

`install.sh` uses the sibling lock
`~/.local/share/trellage/.fmx-install.lock`, stages a complete replacement,
and swaps the runtime by rename. The prerequisite installer and uninstaller
use the same lock, so they cannot mutate the runtime during replacement. The
lock records its owner and pid: a dead owned lock is reclaimed, while an
active, incomplete, or unowned lock is left in place with a diagnostic.

The transaction preserves the consent-installed `prerequisites/` cache across
successful reinstall and rollback. If staging, publication, or shared
floating-skill runtime installation fails, it restores the prior runtime and
command before it releases the lock. A new command is published only after all
required runtime installation succeeds. If the process is killed before its
trap can run, the next `install.sh` restores or removes the recorded
transaction before it starts a new install. If rollback itself cannot complete,
the diagnostic retains the lock and transaction directory for manual recovery.
An interrupted prerequisite stage is recovered by the next prerequisite
installation. If a launcher reinstall reports one, run
`~/.local/share/trellage/fmx/lib/fmx-prerequisites install`, then retry
`install.sh`.

Profile roots, **never** removed by `uninstall.sh`:

```
~/.local/share/trellage/profiles/firstmate/<profile>/
  runtime/          the published pinned checkout (FM_ROOT)
  home/             FM_HOME: data, state, config, projects, .tasks.toml, .fmx-managed
  captain/claude/   the captain's Claude home
  workers/<task>/   one Claude home, record, and liveness marker per task
  policy/           the profile's managed worker policy, if any
  receipts/         the installed source pin
  locks/            the captain session record
```

## Managed Firstmate configuration

v1 supports exactly one worker harness, because the fmx worker boundary only
wraps Claude launches. `setup`, `repair`, and `update` manage these files inside
`FM_HOME`:

| File | Managed content |
| --- | --- |
| `home/.tasks.toml` | Firstmate's markdown backend at `data/backlog.md`, archive at `data/done-archive.md`, and ten retained Done items |
| `home/config/crew-harness` | exactly `claude` (7 bytes, `claude` + newline) |
| `home/config/secondmate-harness` | exactly `claude` (7 bytes, `claude` + newline) |

`doctor` and a launch fail if a managed file is missing, a symlink, or differs
by even one byte. Captain and worker processes also receive explicit
`TASKS_AXI_BACKEND=markdown` and
`TASKS_AXI_FILE=<FM_HOME>/data/backlog.md`, so neither a project checkout nor a
long-lived Herdr or tmux daemon can redirect the fleet queue.

Older `fmx` builds could let `tasks-axi` create `home/backlog.md` because the
managed runtime and `FM_HOME` are separate directories. `repair` moves that
legacy file to `home/data/backlog.md` only when the managed destination does not
already exist. If both files exist, repair fails rather than guessing how to
merge them.

`doctor` keeps runtime health separate from fleet readiness. Missing
prerequisites are printed as an advisory with the exact Firstmate diagnostics;
`doctor` never installs them. The next interactive launch owns the consent
prompt.

`home/config/crew-dispatch.json` selects a harness per task and would bypass the
fmx worker boundary entirely, so its **mere presence fails closed**, whether it
is a regular file or a symlink. Remove it, then run `fmx doctor PROFILE`.

Everything else under `FM_HOME` — task records, project clones, watcher state,
`config/backend`, and any operator files — is preserved untouched.

## Runtime integrity

`doctor`, a launch, and a `healthy` inventory verify the **whole checkout**, not
only the four patched files. All of it is offline:

1. `git -C runtime rev-parse HEAD` equals the catalog pin.
2. `git status --porcelain --untracked-files=all --ignored=matching` contains
   exactly the four manifest paths as modified tracked files — no other tracked
   change, nothing staged, no untracked file, and no *ignored* file either, so
   a gitignored `.env`, `config/`, or executable cannot hide in the runtime.
3. `git diff --raw HEAD` shows no file-mode change, so an added executable bit
   is drift.
4. Every managed file hashes to its recorded post-overlay digest.
5. The receipt matches the full pinned schema: exact key set, `schemaVersion`,
   `profile`, `repository`, `commit`, and `overlay`.
6. `home/.fmx-managed` matches its exact two-line content, not merely exists.
7. Every fmx-owned subdirectory a check traverses (`home`, `home/config`,
   `home/data`, `home/state`, `home/projects`, `captain`, `captain/claude`,
   `workers`, `receipts`, `locks`, `policy`, `runtime`) is a real directory
   inside the profile root — never a symlink that could redirect a read.
8. For `pstack-workers`, the installed worker policy is byte-identical to the
   Trellage-owned source in `policies/` and within the fixed 16384-byte bound.

The same report runs against the **staged** checkout before publication, so an
unclean stage is never published and only then diagnosed.

## Mutation lock

`setup`, `repair`, and `update` take a per-profile lock at `locks/mutation`.
A captain launch takes the same mutation gate while it validates the runtime
and claims `locks/session`, then releases the mutation gate before Claude
starts. Both lock types are claimed with
`mkdir`, which is exclusive creation and **never replaces anything**;
`rename(2)` is deliberately not used to claim, because it silently replaces an
empty destination directory — exactly what a competitor looks like between its
own `mkdir` and publishing its pid.

A lock is classified, never raced:

| State | Meaning | Action |
| --- | --- | --- |
| `none` | no lock | claim it |
| `active` | exact owner, valid live pid | refuse as busy |
| `incomplete` | owner or pid missing or malformed | **refuse and leave it**; never auto-reclaimed |
| `unowned` | some other tool's lock | refuse and leave it |
| `stale` | exact owner, valid **dead** pid | reclaim atomically via `rename(2)`, then claim |

`incomplete` is the initialization window of a competing process, so treating it
as abandoned is exactly the bug being avoided. The cost is that a process killed
between `mkdir` and publishing its pid leaves a lock that must be removed by
hand; the diagnostic says so explicitly. `inventory` reports `readiness: "busy"`
for an active, incomplete, or unowned lock.

`setup` checks the fleet unconditionally after taking the lock, so a missing or
unreadable receipt can never become a licence to replace a runtime under a live
captain or worker. `inventory` checks for a live mutation **before** deciding a
profile is `not-setup`, so a first setup in progress reports `busy`. A second mutation fails as busy, and `inventory` reports
`readiness: "busy"` with `mutation: "active"`. Only an exact stale lock that fmx
owns is reclaimed; an unowned lock directory is reported and left alone. The
lock never touches fleet state. `HUP`, `INT`, and `TERM` release the mutation
lock and terminate the operation; cleanup never returns to the interrupted
mutation. Mutators advance `locks/generation` before changing profile state.
`inventory` and `update --check` accept a result only when that generation is
unchanged across the complete read, so a publication cannot be observed as a
mixed runtime/receipt snapshot.

Publication is a rename transaction. The old receipt is retired before the live
runtime moves. If retiring either item or publishing either staged item fails,
the previous runtime and receipt stay live or are restored before the failure
is reported. If restoration itself fails, both preserved paths are named in the
error. Lifecycle-gated commands also recover a preserved old pair or safe
singleton after an abrupt process exit in any intermediate publication state.

## Captain

- Runs from `runtime/` with explicit `FM_HOME` and `FM_ROOT_OVERRIDE`.
- Uses its own Claude home with the Trellage session bridge **enabled**.
- Names the selected profile on every shared-runtime call (`prepare`, `doctor`,
  and `launch`). The shared runtime validates the *exact* per-profile bridge
  hook, so a `pstack-workers` captain launched without `--profile` would be
  checked against the `default` profile's hook and refused.
- Selects `FM_BACKEND=herdr` only when `HERDR_ENV=1` and `HERDR_PANE_ID` is
  non-empty. Otherwise `tmux` is required and used.
- Requires an authenticated host `gh` configuration. The directory is resolved
  the way `gh` resolves it — `GH_CONFIG_DIR`, else `XDG_CONFIG_HOME/gh`, else
  `$HOME/.config/gh` — and validated as an absolute real directory. Its
  `hosts.yml` must contain a `github.com:` entry, and `gh auth status --hostname
  github.com` must succeed with `GH_TOKEN`, `GITHUB_TOKEN`,
  `COPILOT_GITHUB_TOKEN`, `COPILOT_PROXY_GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
  `GITHUB_ENTERPRISE_TOKEN`, and `COPILOT_TOKEN` removed from the environment.
  `COPILOT_PROXY_GITHUB_TOKEN` is the Trellage-specific proxy secret; the shared
  Claude runtime scrubs it on the launch path, and it is scrubbed here too so it
  never reaches `gh` either. `doctor` **and** a launch
  both run this full check.
- The resolved configuration directory is passed on explicitly as
  `GH_CONFIG_DIR` and `FMX_GH_CONFIG_DIR`. Nothing relies on a tmux or Herdr
  server inheriting it.

## Workers

`lib/fmx-worker` is the worker launch boundary. Crewmate panes are created by a
long-lived tmux or Herdr daemon, so nothing useful is inherited and a great deal
that is wrong may be: every value arrives explicitly, and every value the worker
must not see is removed.

**The worker's Claude process is started by the shared runtime**, not by this
package:

```
native-claude launch --home <per-task home> --marker … --bridge disabled --   [--model M] [--effort E] <encoded launch brief>
```

Before any worker-side helper runs, `fmx-worker` re-execs itself through the
shared runtime's `exec-clean` boundary. That single shared scrub then owns
executable resolution and verification (one
`claude`, resolved and version-checked once, exec'd by absolute path), the
`--dangerously-skip-permissions` / `--permission-mode bypassPermissions` /
`--disallowedTools AskUserQuestion` contract, proxy routing, and the complete
provider-credential boundary. No external preprocessing helper sees ambient
provider credentials, and **no opaque harness command string is ever parsed or
evaluated**. The
session backend still executes the safely shell-quoted pane command that invokes
this helper; what is gone is the arbitrary harness command the helper used to
receive and run through `sh -c`.

Firstmate semantics are preserved as inputs rather than reimplemented:

- the operational-input `encode launch-brief` encoding, run through Firstmate's
  own helper, supplies the prompt argument;
- the model and effort selection uses the same mapping the pinned
  `fm-spawn.sh` applies to its `claude` adapter;
- the trace-context decision (`keep` or `unset`) is carried through;
- the worker starts in the task worktree, so Firstmate's project-local
  turn-end hooks load exactly as they would have in the pane.

### What the backend is allowed to supply

Exactly one thing: a Herdr worker's **own** Herdr context, on the Herdr backend,
because only the pane itself knows it. It is accepted only after the worker's
`HERDR_PANE_ID` is validated as present and distinct from the captain's.

Everything else is carried explicitly, including `HOME`, `PATH`, and Bash. The
captain passes them as `FMX_WORKER_HOME`, `FMX_WORKER_PATH`, and
`FMX_WORKER_BASH`. The pane invokes that absolute Bash directly; `fmx-worker`
then validates every PATH entry with shell builtins and exports the carrier PATH
before the shared scrub needs an external utility. A wrong ambient pane `HOME`
would put worker state in the wrong place, while a wrong ambient `PATH` cannot
select Bash, `native-claude`, or `claude`. All three carriers are scrubbed once
consumed.

Isolation rules:

- One Claude home per task id, with the session bridge **disabled**. `prepare`
  and `launch` name the same fmx profile, so the shared runtime's hook
  accounting stays consistent even with the bridge off.
- tmux workers have **every** `HERDR_*` variable scrubbed, not a fixed list, and
  `TRELLAGE_GUIDE_HERDR_CONTEXT_JSON` is dropped on both backends. A Herdr worker
  keeps the Herdr context it was actually started in, but only after its own
  `HERDR_PANE_ID` is validated as present and distinct from the captain's.
- Inherited Firstmate captain controls are removed before the launch:
  `FM_HOME`, `FM_ROOT_OVERRIDE`, `FM_STATE_OVERRIDE`, `FM_DATA_OVERRIDE`,
  `FM_PROJECTS_OVERRIDE`, `FM_CONFIG_OVERRIDE`,
  `FM_PUBLIC_FOLLOWUP_PRIMARY_HOME`, `FM_TRACE_CONTEXT`, `FM_SUPERVISION_MODEL`,
  and `FM_BACKEND`. The explicit `FMX_TASK`, `FMX_BRIEF`, and `FMX_WORKTREE`
  values are kept.
- The task-id namespace arrives as a structured `FMX_TASK_ID_PREFIX` carrier and
  is revalidated here, so a worker home and its `fm/<id>` branch cannot be
  created outside the profile's namespace.
- `worker.json` is built with `jq -n`, so a model or effort value containing a
  quote cannot produce malformed JSON.
- `FMX_GH_CONFIG_DIR` is validated (absolute, real directory, readable
  `hosts.yml` with a `github.com:` entry), exported as `GH_CONFIG_DIR`, and then
  scrubbed along with every other `FMX_*` carrier.
- `FMX_WORKER_HOME` must be an absolute, existing, non-symlink directory that is
  not `/`; every `FMX_WORKER_PATH` entry must be non-empty, newline-free, and
  absolute; `FMX_WORKER_BASH` must be an absolute executable file. Any carrier
  being absent or unusable fails closed — there is no fallback to an ambient
  value.
- `CURSOR_AGENT` and `CURSOR_INVOKED_AS` are unset, matching upstream's
  `env -u` prefix, and `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` is set.
- Worker records keep `harness=claude` and record the model and effort.

**v1 limit:** secondmate homes are not managed. A secondmate spawn is refused at
the boundary with an explicit diagnostic rather than started without its
`FM_HOME` environment.

## Fleet state

`inventory` and `doctor` report and never delete:

- `active`: an fmx marker whose pid is alive.
- `stale`: an fmx marker whose pid is gone, or a worker home with a Firstmate
  task record and no live process.
- `orphaned`: a worker home with neither.

`update` and `repair` refuse while the captain session or any worker is active.
`uninstall.sh` removes only the launcher runtime and its command symlink.

## Inventory evidence

`fmx inventory PROFILE --json` is the machine-readable acceptance surface.
Source and overlay evidence reads local files only. A healthy readiness verdict
also runs `doctor`, including its local proxy and GitHub authentication checks.

| Field | Meaning |
| --- | --- |
| `.readiness` | `healthy`, `unhealthy`, `not-setup`, or `busy` |
| `.source.repository` | the pinned Firstmate remote |
| `.source.pinnedCommit` | the exact 40-hex commit the catalog pins |
| `.source.installedCommit` | the commit recorded in the installed receipt, or `null` |
| `.source.commitMatchesPin` | `true` only when the receipt equals the pin |
| `.overlay.commit` | the commit the checked-in overlay is keyed by |
| `.overlay.digestAlgorithm` | always `sha256` |
| `.overlay.manifestDigest` | sha256 of `overlay/<commit>/manifest.json` |
| `.overlay.contentDigest` | sha256 over the sorted `<path>:<result digest>` lines; the identity of the overlaid runtime content |
| `.overlay.fileCount` | number of files the overlay manages |
| `.overlay.verified` | `true` only when every managed file in the installed runtime hashes to its recorded post-overlay digest |
| `.session` | `active`, `stale`, `incomplete`, `unowned`, or `none` |
| `.mutation` | `active`, `stale`, `incomplete`, `unowned`, or `none` for the per-profile mutation lock |
| `.workers[].task` / `.workers[].state` | per-task id and `active`/`stale`/`orphaned` |

`.overlay.manifestDigest` and `.overlay.contentDigest` are reproducible from the
checked-in manifest alone, so acceptance can pin them without running `fmx`. Two
profiles installed from the same pin report identical overlay identity.

The `.source.*` and `.overlay.*` fields are computed by reading and hashing
local files only — no network, no `gh`, no proxy. Overall `.readiness` is a
different thing: reaching `healthy` runs the full `doctor` path, which includes
the GitHub identity check and the shared Claude health checks, so producing
`.readiness` is **not** an offline operation. Assert `.readiness` when you want
the live verdict; assert the digest fields when you want the offline identity.

`fmx list [--json]` stays a pure projection of `catalog.json`: it never reads a
profile root, never hashes a runtime, and never touches the network.

## Tests

```sh
bash prototypes/trellage-firstmate-profiles/tests/contract.sh
# or
make native-firstmate-profile
```

The contract is fully offline. It fakes `gh`, `tmux`, `herdr`, `claude`, and the
shared `native-claude` helper, and stages the pinned source from
`tests/fixtures/firstmate/<commit>/`, which holds verbatim copies of the exact
upstream files the overlay edits. See `tests/fixtures/NOTICE.md`.

The contract also exercises the **real** shared Claude runtime for a worker
launch when `prototypes/trellage-claude-common/native-claude` is present: a
decoy `claude` is placed later on `PATH` and stale Bedrock, Vertex, AWS, Google,
Azure, OpenAI, Anthropic, and GitHub variables are injected, then the test
asserts that the verified executable was the one that ran, that the shared flags
were applied, that every stale variable was scrubbed, and that no Herdr context
survived.

`git` is only *partially* faked: the network fetch, the initial materialization,
and `rev-parse HEAD` are simulated, because a synthetic repository cannot
reproduce the upstream SHA. Every other Git operation — `init`, `add`, `commit`,
`status`, `diff` — is real, so the runtime-integrity checks are exercised
against genuine Git behavior.
