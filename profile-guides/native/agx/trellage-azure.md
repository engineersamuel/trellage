---
schemaVersion: 1
capabilities:
  - agency-named-profile
  - isolated-copilot-home
  - microsoft-learn
  - read-only-azure-inventory
bestFor:
  - Inspecting Azure subscriptions, resource groups, ACR repositories, storage, and resource health while working in the Trellage repository
  - Using Agency-managed Copilot with a deterministic repository-local MCP profile
avoidFor:
  - Azure deployment or write operations; the profile exposes read-only tools only
  - Work outside a Trellage worktree; the first release requires repository-root agency.toml
  - Tasks that need a container security boundary; agx runs directly on the host
prerequisites:
  - id: agency
    description: Microsoft Agency installed and available on PATH.
  - id: azure-auth
    description: Complete Azure environment credentials or an existing authenticated Azure CLI session.
  - id: node-tools
    description: Node.js, npm, and npx available with the correct host package registry.
workflows:
  - id: inspect-azure-inventory
    description: Read subscription, resource-group, ACR, storage, and resource-health inventory without deployment or mutation tools.
    examples:
      - List the Azure resource groups and registries used by this repository
      - Inspect storage accounts and resource health without changing anything
      - Show which subscriptions contain unhealthy resources
    promptTemplate: |
      Use only the configured read-only Azure and Microsoft Learn MCP tools. Do not create, update, delete, deploy, upload, or change permissions.

      {{intent}}
---

# Native Agency (`agx`) - `trellage-azure` profile

`agx trellage-azure` runs `agency copilot --profile-only trellage-azure` from
the current Trellage worktree. It preserves the real home and working directory
while setting a validated, profile-specific `COPILOT_HOME`.

The profile enables Microsoft Learn and a pinned Azure MCP `2.0.5` server with
an exact read-only inventory tool list. Azure authentication remains in the
host credential provider; Trellage does not copy or print it.

Use:

```bash
agx setup trellage-azure
agx doctor trellage-azure
agx trellage-azure
```

This native profile isolates Copilot state but is not a security boundary.
