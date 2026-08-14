# Trellage Deja memory foundation

Trellage installs one pinned Deja 0.17.0 runtime per OS user. Here, “shared”
and “global” mean that one OS user account only; they do not mean a shared
machine, team, or cloud service. The runtime is independent from the isolated
native profile homes and their local Deja indexes.

Install or refresh the pinned binary and stable helper:

```sh
prototypes/trellage-memory/install-deja.sh
~/.local/share/trellage/deja/deja-memory prepare
~/.local/share/trellage/deja/deja-memory run -- your-harness arguments
```

`prepare` imports the private shared exchange, reindexes it, then installs
auto-recall with `DEJA_RECALL=safe`. `finalize` indexes and exports new
batches. `run` does prepare, runs the command, then finalizes even after a
command failure. Memory errors are warnings and do not change the command exit
status. `status` is content-free and does not display memory data.

Native and sandbox launches use this same prepare → harness → finalize boundary.
Manual `trx memory sync` and `trellage memory sync --profile NAME` use the same
prepare → finalize boundary without a harness. They do not call a model.

The exchange and staging directories are owner-only. Imports use only regular,
owner-owned `0600` `deja-sync-*.jsonl` files with newline-complete JSON
objects; unsafe, malformed, and temporary files are ignored. Exports publish
with a same-filesystem atomic rename, digest deduplication, and collision
protection.

Set `TRELLAGE_MEMORY=off` to disable all Deja lookup and exchange changes.
When a profile changes `HOME`, provide `TRELLAGE_REAL_HOME` and, when set,
`TRELLAGE_REAL_XDG_STATE_HOME`. The shared exchange then uses the real XDG
state directory at `trellage/deja/exchange`.

Native launcher uninstall intentionally retains this shared runtime. Removing
one launcher must not break another launcher. It also retains all Deja indexes,
exchange batches, old local stores, and `.weavekit/deja-shared` evidence. See
[the Deja memory policy](../../docs/deja-memory.md) before manual cleanup or
multi-machine sync.
