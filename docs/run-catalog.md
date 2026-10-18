# Run selection catalog

```sh
mise run trx -- run list          # current worktree, readable output
mise run trx -- run list --json   # current worktree, JSON
trx run list --json               # installed router, after updating it
```

`mise run trx` and plain `trx` can run different versions. The mise task runs
this checkout; plain `trx` resolves through PATH to the installed router.
An installed router that says `unknown harness: list` predates this command.
Installing/updating the router is separate from editing its source.

`trx list` is retired. When invoked through the worktree, its migration error
includes the full `mise run trx -- run list` replacement so it does not send
you back to an older installed executable.

## Two sets, not a combination matrix

The JSON has separate harness and profile sets. A shared profile is not repeated
under every harness:

```json
{
  "schemaVersion": 2,
  "harnesses": [],
  "profiles": [],
  "unavailable": { "harnesses": [], "profiles": [] }
}
```

- Harness entries contain their identity, description, strengths, weaknesses,
  task guidance, local readiness, and sandbox policy. They have no nested
  `profiles` array.
- Each profile definition appears once, identified by its TOML key in `id`.
  `argument` is its launch argument; `harnesses` contains compatible harness IDs,
  `readyHarnesses` identifies locally ready choices, and `guideHarnesses` identifies
  choices eligible for Guide recommendations.
- Distinct definitions that happen to use the same short argument, such as
  `default`, remain distinct IDs (for example `preset-pi-default` and
  `preset-claude-default`). Shared definitions, such as a custom `review` profile,
  occur only once regardless of how many harnesses support them.
- A profile belongs in `unavailable.profiles` only when it is unavailable on all
  compatible harnesses. Partial profile-specific failures appear in `unavailableOn`;
  harness-wide failures are explained once in `unavailable.harnesses`.
- Always-on profiles contribute prerequisites but are not standalone recommendations.
  Arbitrary multi-profile permutations and ad hoc skill combinations are not listed.

Pair-specific execution and workflow checks remain internal to Guide. The public
profile entry retains common headless/Herdr/goal information; `null` means unknown
or not uniform across its compatible harnesses. It does not emit a matrix of
launch commands or duplicate workflow templates for every pair. To launch, choose
one of the profile's ready harness IDs and use its `argument`:

```sh
trx run HARNESS PROFILE_ARGUMENT
```

The readable form likewise has separate **Harnesses** and **Profiles** sections.

## Configuration is the source of truth

Both listing and Guide read selection metadata from the effective
`~/.config/trellage/config.toml`, `$XDG_CONFIG_HOME/trellage/config.toml`, or an
explicit `TRELLAGE_CONFIG` file. The explicit file takes precedence.

`config.example.toml` contains the shipped defaults. Create a user config
without replacing an existing one:

```sh
mkdir -p ~/.config/trellage
if [ ! -e ~/.config/trellage/config.toml ]; then
  install -m 0600 config.example.toml ~/.config/trellage/config.toml
fi
```

For XDG or an explicitly selected file, use that location instead. Review custom
profiles, source pins, and environment policy before changing an existing file.
Listing never creates or upgrades a user config. Where ordinary launch would
initialize defaults, listing projects them in memory only. An explicitly selected
or intentionally empty native config remains authoritative.

```toml
[native.profiles.review]
label = "Focused review"
harnesses = ["pi", "claude"]

[native.profiles.review.selection]
description = "Review a bounded patch before integration."
best_for = ["Finding correctness and regression risks in a patch"]
strengths = ["Narrow review scope"]
weaknesses = ["No specialized implementation workflow"]
avoid_for = ["Unbounded redesign without an agreed review scope"]
capabilities = ["patch-review"]
```

This produces one `review` definition with two harness references, not two profile
rows. Metadata describes a profile; existing skills, plugins, instructions, and
prerequisites configure its actual behavior. Do not put secrets in metadata or
workflow templates: selection information is exported and supplied to decision models.

Harness metadata uses `[native.harnesses.HARNESS.selection]`. An explicit local
selection table replaces the shipped one. User profiles override shipped names;
missing metadata does not inherit potentially false claims from the overridden
preset. Local metadata cannot invent a runnable harness adapter.

## Missing metadata and availability

A nonempty description and at least one `best_for` item make minimum metadata
complete. Other assessments are optional: omission is JSON `null`, while an
explicitly authored empty list remains `[]`. JSON uses `bestFor` and `avoidFor`.

Incomplete profiles remain runnable and visible as `metadataStatus: "incomplete"`,
but Guide excludes them. Existing user copies of older configs may need these
fields added; they are not silently merged from new shipped descriptions.

`readiness` contains `status`, blocking `reasons`, informational `automaticSetup`,
and `unverified` checks. Checks inspect local binaries/configuration/prerequisites.
Missing required tools or environment variables make a choice unavailable. Routine
first-launch generation, fetching selected resources, or cloning a configured
profile repository does not alone disqualify it when local prerequisites exist.

Authentication validity and service reachability remain unverified. Credential
helper availability is not proof of a working token. Listing never interrogates
keychains, launches agents, makes network/model calls, installs dependencies, or
writes configuration/cache receipts. An unprepared source worktree fails with an
explicit preparation instruction rather than installing anything:

```sh
scripts/install-source-runtime.sh --prepare
mise run trx -- run list --json
```

Output ordering is stable. Zero ready choices is a successful listing. Invalid
configuration fails with a nonzero status and stderr diagnostic, not partial JSON.

```sh
mise run trx -- run list --json | jq '.harnesses'
mise run trx -- run list --json | jq '.profiles[] | {id, argument, readyHarnesses}'
mise run trx -- run list --json | jq '.unavailable'
```

## Guide and maintained content

Guide uses the same configuration and readiness service, resolving valid launch
pairs internally rather than publishing all pairs. It recommends only eligible
choices; fewer than three eligible choices can produce a smaller recommendation
set. No eligible choices means an actionable diagnostic without a model call.

A complete custom profile without specialized instructions uses a built-in `task`
workflow. TOML owns specialized workflow descriptions/examples and invocation policy;
Markdown holds detailed notes and templates. An explicitly broken reference does
not silently become a generic workflow. See [authoring](../profile-guides/README.md).
Selected workflows recheck readiness and metadata/instruction revisions before use.
Admin and upgrade keep their unfiltered maintenance inventories.

Model inventory and model tradeoffs stay in `copilot-proxy-rs`.

```sh
bun scripts/generate-run-catalog-content.ts
bun scripts/generate-run-catalog-content.ts --check
```

The generator updates the example and legacy description projections. It does
not read or publish the retired Herdr compatibility ledger; that status remains
unverified. Edit canonical inputs, not derived copies; user files are untouched.
