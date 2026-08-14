# Deja memory policy

## Default and ownership

Deja memory is enabled by default: `TRELLAGE_MEMORY=deja`. Set
`TRELLAGE_MEMORY=off` for one command to disable Deja lookup and exchange
changes. `trellage --no-memory` and `trx --no-memory` do the same for one
launch.

The native shared runtime is one pinned Deja 0.17.0 binary and helper at:

```text
~/.local/share/trellage/deja/
```

“Shared” and “global” mean one OS user account. They do not mean all users on
the computer, a Trellage team, or a remote service. The runtime is owner-owned
and private. Every native launcher uses this exact helper; it does not search
`PATH` for an ambient `deja` or `deja-memory`.

`scripts/rebuild-profile-images.sh --native-only` refreshes this runtime once,
then installs native launchers in order, then installs `trx`. A direct native
launcher install also refreshes it unless `TRELLAGE_MEMORY=off` is set.

## Lifecycle and commands

With memory enabled, each native or sandbox agent launch does:

```text
prepare → harness → finalize
```

`prepare` imports validated batches, indexes them, and installs auto-recall
with `DEJA_RECALL=safe`. `finalize` indexes and exports new batches. It still
runs when the harness fails. A Deja failure is a warning; the harness exit
status remains authoritative.

Manual commands use the same boundary without a harness:

```sh
trx memory status
trx memory sync
trellage memory status --profile codex-superpowers
trellage memory sync --profile codex-superpowers
```

`status` is content-free. `sync` does not call a model or paid service.
Sandbox sync requires the already-running, current profile container. It copies
validated batches through a private container stage; it creates no container
and adds no Docker mount. Native `trx memory sync` runs profiles serially in
fixed catalog order.

Native profile homes and their Deja indexes stay isolated. Sandbox state stays
in its isolated profile state volume. The shared exchange contains only
validated batches and is stored under:

```text
$XDG_STATE_HOME/trellage/deja/exchange/
# or ~/.local/state/trellage/deja/exchange/
```

The static native profile matrix checks the exact private runtime, pinned
release marker, content-free status, and safe prepare/finalize lifecycle for
each statically passing managed Codex profile. It invokes no model or paid
service. The lifecycle
can update only those local Deja indexes and exchange batches.

## Data and retention

Exchange and staging directories are owner-only. Valid batch files are regular,
owner-owned `0600` newline-complete JSONL objects. Redaction reduces exposure,
but redacted batches can still contain sensitive prose. Treat the exchange and
all local Deja state as sensitive, owner-readable data.

Forget and tombstones are local-only Deja actions. They affect the selected
profile and machine; they are not a v1 global revocation protocol. v1 has no
global revocation and no garbage collection. Trellage does not migrate or
delete older local Deja stores, indexes, or exchange batches.

Native launcher uninstall removes only that launcher's owned command and
runtime. It deliberately retains the shared Deja runtime, all Deja state, and
exchange batches because other launchers can use them. It also never migrates,
deletes, or reinterprets existing `.weavekit/deja-shared` evidence.

For more than one machine, use Deja SSH sync between the machines. Trellage
does not provide a Weavekit transport, does not use `.weavekit/deja-shared` as
a transport, and does not add a host mount for memory exchange.
