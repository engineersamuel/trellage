# Trellage Native Pi extension profile

`picx` is a standalone Trellage Native launcher with one profile, `default`.
It runs upstream `@earendil-works/pi-coding-agent@0.84.2` and routes
`copilot-proxy-rs/gpt-5.6-sol:medium` through the local
`http://127.0.0.1:8080/v1` OpenAI Responses endpoint.

The profile installs exactly this ordered extension set:

1. `git:github.com/DietrichGebert/ponytail`
2. `npm:pi-web-access`
3. `npm:pi-subagents@0.34.0`
4. `npm:@ff-labs/pi-fff@0.10.5`
5. `npm:pi-context-view`
6. `npm:pi-mcp-adapter`
7. `npm:@narumitw/pi-btw@0.11.0`
8. `npm:@plannotator/pi-extension@0.20.3`
9. `npm:@narumitw/pi-goal@0.48.0`
10. `npm:@quintinshaw/pi-dynamic-workflows@2.14.1`

The launcher owns
`~/.local/share/trellage/profiles/pi/picx-default`. It sets
`PI_CODING_AGENT_DIR` to the profile's `agent` directory, stores sessions in
the profile's `sessions` directory, and does not use `~/.pi`, `~/.omp`, or the
host Pi installation. The old
`~/.omp/profiles/trellage-picx-default` profile is not used or deleted.

Managed `settings.json` declares the ten packages and selects the proxy model.
Managed `models.json` defines the proxy-backed model. Managed `mcp.json` sets
`settings.hostConfigDiscovery` to `off` and has no imports, so host-specific
Claude, Codex, Cursor, or OMP MCP configuration is not loaded. Standard shared
MCP files remain available under the documented `pi-mcp-adapter` precedence.

Setup also installs `humanlayer/skills` `show-me` into the isolated Pi profile
and snapshots `~/.copilot/models.json` as read-only
`.copilot-models.json`. Launches remove host Copilot, OpenAI, and Azure OpenAI
credential variables because the managed proxy provider uses no API key.

The local `copilot-proxy-rs` service must be healthy and advertise
`gpt-5.6-sol` from `/v1/models`. `picx doctor` checks both conditions.

```bash
./install.sh
picx setup
picx doctor
picx -p "what extensions are installed"
picx inventory default --json
```

Bare `picx` and `picx default` select the same profile. Ordinary launches do
not update the pinned Pi release or the extension set. The bare Pi runtime
does not require the former Oh My Pi source patches for `pi-context-view` or
`pi-fff`.

Run the deterministic contract with:

```bash
make native-picx-profile
```
