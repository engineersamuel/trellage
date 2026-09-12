---
description: "Conventions for the Trellage Effect-based TypeScript profile compiler"
paths: "packages/trellage-cli/**/*.ts"
---

# Trellage CLI TypeScript rules

- Use Effect services, schemas, errors, and control flow where practical.
- Keep filesystem and process effects behind injectable services.
- Preserve deterministic rendering, lock-file behavior, and source-policy checks.
- Add or update focused Vitest coverage for behavior changes.
- Run `bun run lint`, `bun run format:check`, `bun run test`, and `bun run check` in `packages/trellage-cli`.
- Run source directly with the pinned Bun runtime. Use explicit `.ts`/`.tsx`
  relative imports and public workspace exports; do not emit application code.
