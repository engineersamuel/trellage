# Headless execution contract

Trellage publishes a version-gated `headless` object for each Sandbox runtime
adapter and each Native profile. An advertised capability applies only to the
exact `testedHarnessVersion`. A different or unknown harness version resolves
to conservative values.

Use these inventory commands:

```bash
trellage list --json --full
trx list --json
```

`trellage list --json` keeps its small compatibility schema. The equivalent
full Sandbox forms are `--json-full` and `--json --full`.

## Capability schema

The V1 object has these exact keys:

```json
{
  "schemaVersion": 1,
  "prompt": true,
  "outputFormats": ["text", "json", "jsonl"],
  "eventContract": "claude-stream-json-v1",
  "trellageEventContract": "trellage-headless-v1",
  "sessionId": "native",
  "resume": true,
  "resumeWithPrompt": true,
  "questionToolControl": "hard-deny",
  "changedFiles": "git-diff",
  "usage": true,
  "cost": true,
  "modelOverride": true,
  "effortOverride": false,
  "testedHarnessVersion": "2.1.229"
}
```

Allowed values:

| Field | Values |
| --- | --- |
| `outputFormats` | `text`, `json`, `jsonl` |
| `sessionId` | `native`, `trellage`, `none` |
| `questionToolControl` | `hard-deny`, `prompt-only`, `none` |
| `changedFiles` | `native`, `git-diff`, `none` |

`eventContract` is the native machine-output contract. A null value means that
Trellage does not publish a native event schema. The initial Trellage event
contract is `trellage-headless-v1`.

Conservative values do not claim headless prompt, structured output, session,
resume, question control, evidence, usage, cost, or overrides. `text` can
remain in `outputFormats` because it is the normal terminal output mode.

## Launch checks

The Sandbox host checks the selected profile metadata before lock refresh,
image build, lease creation, volume or container mutation, and authentication
mutation. Unsupported prompt, JSONL, resume, exact-session resume,
resume-with-prompt, model override, and Trellage event requests fail with a
nonzero status.

Trellage does not downgrade JSONL to text. A rejected JSONL request writes no
stdout.

## Native and Trellage events

Native JSONL remains the default and is not rewritten. Add Trellage metadata
only when the profile advertises both event contracts:

```bash
trellage --profile PROFILE --output-format jsonl --trellage-events -p "PROMPT"
```

`--trellage-events` is invalid without `--output-format jsonl`.

The bridge writes each native line before related Trellage metadata. Native
bytes are unchanged. If the final native line has no newline, the bridge adds
one separator before its own event.

### `trellage.session`

The bridge emits this event once, when the first authoritative native session
ID is available:

```json
{
  "type": "trellage.session",
  "schemaVersion": 1,
  "profile": "claude-profile",
  "harness": "claude",
  "runtime": "claude",
  "eventContract": "claude-stream-json-v1",
  "sessionId": "native-session-id",
  "expectedSessionId": null,
  "expectedSessionIdMatches": null
}
```

For an exact resume, `expectedSessionId` contains the requested ID and the
match field is a boolean.

### `trellage.result`

The bridge always tries to emit one terminal event after the child exits:

```json
{
  "type": "trellage.result",
  "schemaVersion": 1,
  "profile": "claude-profile",
  "harness": "claude",
  "runtime": "claude",
  "eventContract": "claude-stream-json-v1",
  "outcome": "success",
  "sessionId": "native-session-id",
  "expectedSessionId": null,
  "expectedSessionIdMatches": null,
  "sessionIdConsistent": true,
  "finalText": "DONE",
  "model": "claude-sonnet-5",
  "usage": {},
  "costUsd": 0.01,
  "changedFiles": [],
  "changedFilesSource": "git-diff",
  "exitCode": 0,
  "signal": null,
  "nativeResultSubtype": "success",
  "nativeIsError": false,
  "nativeError": null,
  "nativeMalformedLineCount": 0,
  "spawnError": null
}
```

`outcome` is:

- `success` only for a zero exit, a valid native success result, consistent
  session evidence, and no malformed extra native line;
- `failure` for a child failure, signal, spawn failure, native error, session
  mismatch, or a malformed stream that also claims success;
- `unknown` when the child exits zero but no valid terminal native result
  proves success or failure.

Unknown evidence is `null`. It is not an empty success-shaped value. A session
mismatch changes the metadata outcome to `failure`, but the bridge still
preserves the child exit status.

## Git changed-file evidence

For `changedFiles: "git-diff"`, the bridge records read-only Git state before
and after the child. It compares the HEAD commit, commit-tree paths, status
descriptors, file modes, file content, and symlink targets.

The result includes tracked, staged, renamed, deleted, and untracked paths
that changed during the run, including changes committed by the child.
Unchanged pre-existing dirt is excluded. A clean Git result is `[]`. A non-Git
worktree or a Git read failure reports both changed-file fields as `null`.

Changed files are evidence only. They do not prove semantic success.

## OMP no-user-input policy

For the verified OMP version, Native OMP accepts:

```bash
omp copilot --headless-policy no-user-input --print "PROMPT"
```

The launcher creates a mode-0600 invocation-only overlay that contains:

```yaml
ask:
  enabled: false
```

It passes the overlay through OMP `--config`, removes it after normal exit or
a signal, and does not change the managed profile. An unverified OMP version
fails closed. Inventory reports `prompt-only` until a paid live run proves the
overlay's hard-deny behavior.

## Publication evidence

`docs/headless-evidence.json` records the exact harness version, event
contracts, capability object, deterministic cases, and recorded live cases
for each positive publication.

Run the deterministic gate with:

```bash
scripts/verify-headless-contracts
make headless-matrix
make headless-matrix-test
```

Live probes can consume paid quota and require explicit opt-in:

```bash
TRELLAGE_HEADLESS_SANDBOX_PROFILE=tests/fixtures/headless-live-claude/profile.toml \
  scripts/verify-headless-contracts --live
TRELLAGE_HEADLESS_SANDBOX_PROFILE=tests/fixtures/headless-live-claude/profile.toml \
  make headless-matrix-live
```

The checked-in fixture resolves to the recorded Claude Code `2.1.229`
contract. `TRELLAGE_HEADLESS_SANDBOX_PROFILE` can instead name another
full-inventory profile with that exact contract. The live driver also requires
the recorded Native `cpx`, `cldx`, and `omp` versions.

A runtime or profile must remain conservative when its exact version and
evidence record do not match.
