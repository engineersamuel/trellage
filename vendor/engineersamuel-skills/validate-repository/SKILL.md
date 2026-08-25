---
name: validate-repository
description: Use when changing skill definitions, packaging, repository metadata, or release automation in this repository.
---

# Validate repository

Run the checks that match the changed surface:

1. Run `python3 scripts/validate.py` for skill metadata, discovery, behavior contracts, and release packaging.
2. Run `npx skills add . --list` when skill discovery or layout changes.
3. Run `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7` when the release workflow changes.
4. Inspect the diff and confirm no provider-specific dependency was added to a portable skill.

Report the exact commands and outcomes. Do not claim validation that was not run.
