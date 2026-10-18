---
schemaVersion: 2
templates:
  inspect-azure-inventory: >-
    Use only the configured read-only Azure and Microsoft Learn MCP tools. Do
    not create, update, delete, deploy, upload, or change permissions.


    {{intent}}
---

# Native Agency (`agency`) - `trellage-azure` profile

`trx run agency azure` runs `agency copilot --profile-only trellage-azure` from
the current Trellage worktree. It preserves the real home and working directory
while setting a validated, profile-specific `COPILOT_HOME`.

The profile enables Microsoft Learn and a pinned Azure MCP `2.0.5` server with
an exact read-only inventory tool list. Azure authentication remains in the
host credential provider; Trellage does not copy or print it.

Use:

```bash
trx setup agency azure
trx doctor agency azure
trx run agency azure
```

This native profile isolates Copilot state but is not a security boundary.
