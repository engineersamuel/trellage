# Trellage Native Pi extension profile

`picx` is a standalone Trellage Native launcher with one profile, `default`.
It runs the latest stable upstream `@earendil-works/pi-coding-agent` release
resolved on first use and routes
`copilot-proxy-rs/gpt-5.6-sol:medium` through the local
`http://127.0.0.1:8080/v1` OpenAI Responses endpoint.

The profile installs exactly this ordered extension set:

1. `git:github.com/DietrichGebert/ponytail`
2. `npm:pi-web-access`
3. `npm:pi-subagents`
4. `npm:@ff-labs/pi-fff`
5. `npm:pi-context-view`
6. `npm:pi-mcp-adapter`
7. `npm:@narumitw/pi-btw`
8. `npm:@plannotator/pi-extension`
9. `npm:@narumitw/pi-goal`
10. `npm:@quintinshaw/pi-dynamic-workflows`

The launcher owns
`~/.local/share/trellage/profiles/pi/picx-default`. It sets
`PI_CODING_AGENT_DIR` to the profile's `agent` directory, stores sessions in
the profile's `sessions` directory, and does not use `~/.pi`, `~/.omp`, or the
host Pi installation. The old
`~/.omp/profiles/trellage-picx-default` profile is not used or deleted.

Managed `settings.json` declares the ten packages and selects the proxy model.
Pi owns and can update a string `lastChangelogVersion`; doctor accepts that UI
state and repair preserves it. Invalid non-string values are removed by repair.
Managed `models.json` defines the proxy-backed model. Managed `mcp.json` sets
`settings.hostConfigDiscovery` to `off` and has no imports, so host-specific
Claude, Codex, Cursor, or OMP MCP configuration is not loaded. Standard shared
MCP files remain available under the documented `pi-mcp-adapter` precedence.

Setup installs the shared floating `native-common` skill bundle into the
isolated Pi profile and snapshots `~/.copilot/models.json` as read-only
`.copilot-models.json`. The first native setup fetches the bundle; later
launches reuse the shared cache until `trx skills update` refreshes it.
Launches remove host Copilot, OpenAI, and Azure OpenAI credential variables
because the managed proxy provider uses no API key.

The local `copilot-proxy-rs` service must be healthy and advertise
`gpt-5.6-sol` from `/v1/models`. `picx doctor` checks both conditions.
`picx inventory default --json` applies the same readiness checks without
changing profile state. It returns structured `healthy`, `unhealthy`, or
`not-setup` readiness; use `picx doctor` when a profile is unhealthy and the
detailed diagnostic is needed.

```bash
./install.sh
picx setup
picx doctor
picx update --check
picx update
picx -p "what extensions are installed"
picx inventory default --json
```

First setup resolves the latest stable Pi release through `mise`, installs it,
and records the exact installed version in the local `installed-version`
receipt under `~/.local/share/trellage/picx`. Bare `picx` and `picx default`
select the same profile. Ordinary launches reuse the receipt-selected version
and installed extensions without a network request. Setup and explicit
`picx update` resolve the current stable releases for unversioned npm extension
specs. A failed update preserves the last good installed version, extensions,
and receipt. The extension set remains the cataloged ordered set. The bare Pi
runtime does not require the former Oh My Pi source patches for
`pi-context-view` or `pi-fff`.

Capability reporting remains version-gated. Pi `0.84.2` keeps its tested
headless claims. Other installed versions remain usable but report
conservative headless capability values until verified.
`--headless-policy no-user-input` fails closed unless the installed version
exactly matches the profile catalog's `testedHarnessVersion`.

Run the deterministic contract with:

```bash
make native-picx-profile
```
