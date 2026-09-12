---
applyTo: "packages/trellage-cli/**/*.ts"
description: "Conventions for the Trellage Effect-based TypeScript profile compiler"
---

# Trellage CLI TypeScript rules

Read and follow the canonical shared rule at [`.agents/rules/trellage-cli.md`](../../.agents/rules/trellage-cli.md).
Run `bun run lint` and `bun run format:check` with the package source tests and
no-emit type checks before completion. There is no application build step.
