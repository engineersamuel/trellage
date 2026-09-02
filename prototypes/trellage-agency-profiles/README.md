# Trellage Agency profiles

`agx` starts Agency's managed GitHub Copilot CLI with a named Agency profile
and an isolated `COPILOT_HOME`. It preserves the real `HOME`, current worktree,
terminal, Git, SSH, Azure, and package-manager environment. This is state
isolation, not a container or security boundary.

Install Agency interactively with:

```bash
curl -sSfL https://aka.ms/InstallTool.sh | sh -s agency
```

`agx` checks both `PATH` and Agency's standard install path,
`~/.config/agency/CurrentVersion/agency`.

The first profile is repository-local:

```bash
agx setup trellage-azure
agx doctor trellage-azure
agx inventory trellage-azure --json
agx trellage-azure
```

Run it from this repository or one of its subdirectories. `agx` requires the
current Git worktree root to contain the committed `agency.toml`; it never
changes the working directory to discover that file.

The launch command is:

```bash
COPILOT_HOME="$HOME/.local/share/trellage/profiles/agency/trellage-azure/home" \
  agency copilot --profile-only trellage-azure -- <copilot-arguments>
```

The `--` separator is required: arguments before it belong to Agency, while
arguments after it belong to Copilot.

## Profile composition

`trellage-azure` enables:

- Agency's `msft-learn` built-in.
- Azure MCP `@azure/mcp@2.0.5` over stdio.
- Eleven exact read-only tools for subscription, resource-group/resource, ACR,
  storage, and resource-health inventory.

The profile passes both an exact tool list and Azure MCP's `--read-only` flag.
It contains no create, update, delete, upload, deployment, secret, tenant, or
subscription value. It uses `--profile-only`, so base Agency configuration and
ambient Copilot, VS Code, and repository MCP discovery are excluded as
documented by Agency. Agency can still add compile-time default MCPs; the
current internal Agency source is the authority for those defaults. The profile
does not claim a default is disabled unless `agx doctor` can validate that
policy through the installed Agency build.

Azure authentication is inherited, never copied. `agx` supports:

- `EnvironmentCredential` when `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and
  `AZURE_TENANT_ID` are all present.
- `AzureCliCredential` when `az account show` succeeds.

`agx` never runs `az login`, opens a browser, prints credential values, follows
credential symlinks, or writes authentication data.

On Microsoft-managed devices, `npx` inherits the host npm registry. Configure
the approved CFS registry before launch:

```text
https://packagefeedproxy.microsoft.io/npm/
```

The package selector is pinned. Normal launches do not update Agency or change
the Azure MCP version, although `npx` can populate its normal package cache
when the exact package is not already available.

## State and lifecycle

Managed launcher files:

```text
~/.local/share/trellage/agx/
~/.local/bin/agx
```

Profile state:

```text
~/.local/share/trellage/profiles/agency/trellage-azure/
```

`setup` and `repair` create or validate only the owned profile root, isolated
Copilot home, and `native-common` floating skills. Re-run `./install.sh`, or use
the repository native rebuild, to update the launcher and catalog. Uninstall
removes only the owned launcher runtime and exact command symlink; profile
homes and Agency-managed state outside Trellage are preserved.

## Test

```bash
bash tests/contract.sh
```

The static contract does not start Agency, a model, or Azure MCP. Live proof is
separate and requires an interactive terminal, existing Azure authentication,
and explicit exact-version gates:

```bash
TRELLAGE_AGENCY_LIVE=1 \
TRELLAGE_AGENCY_VERSION='<exact Agency version>' \
TRELLAGE_AGENCY_COPILOT_VERSION='<exact managed Copilot version>' \
  tests/live.sh
```

The driver checks the installed versions and `agx doctor`, then gives the
operator a fixed `/env`, `/mcp`, and read-only request checklist. After exit it
fails if the main `~/.copilot` changed, the isolated profile has no state, or
the operator does not confirm the expected MCP composition and successful
read-only results.
