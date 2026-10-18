# Native run catalog

Use `trx run list` to read local harness and profile readiness. Use `--json` for
the schema-versioned catalog:

```sh
mise run trx -- run list
mise run trx -- run list --json
```

`trx list` remains available as a compact compatibility view. `trx run list`
provides the extended, read-only catalog with local readiness and Guide
eligibility. It does not launch agents, run setup, inspect credential stores,
or make network or model calls.

The JSON keeps harness and profile definitions separate:

```json
{
  "schemaVersion": 2,
  "harnesses": [],
  "profiles": [],
  "unavailable": { "harnesses": [], "profiles": [] }
}
```

Each profile definition appears once. Its `harnesses` list names compatible
harnesses; `readyHarnesses` and `guideHarnesses` show local readiness and Guide
eligibility. A profile appears under `unavailable.profiles` only when no
compatible harness is ready. Partial failures appear under `unavailableOn`.
Always-on profiles contribute to readiness but are not standalone choices.

`readiness` reports blocking local checks, automatic setup that may occur during
launch, and items that cannot be verified locally. Authentication and service
reachability are not verified. Incomplete selection metadata stays visible but
is not eligible for Guide recommendations. Missing prerequisites make a
profile unavailable; listing never installs them.

The effective user config is read from
`~/.config/trellage/config.toml`, `$XDG_CONFIG_HOME/trellage/config.toml`, or
`TRELLAGE_CONFIG`. `config.example.toml` contains shipped defaults. Listing
does not create, update, or replace user configuration. If no user config
exists, shipped defaults are projected in memory.

An unprepared source runtime fails with a preparation instruction. Prepare it
explicitly before listing:

```sh
scripts/install-source-runtime.sh --prepare
mise run trx -- run list --json | jq '.profiles[] | {id, argument, readyHarnesses}'
```

Configuration errors return a nonzero status and a diagnostic. A successful
empty catalog is valid. Output order is stable.
