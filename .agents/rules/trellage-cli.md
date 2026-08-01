---
description: "Conventions for the Trellage Effect-based TypeScript profile compiler"
paths: "packages/trellage-cli/**/*.ts"
---

# Trellage CLI TypeScript rules

- Use Effect services, schemas, errors, and control flow where practical.
- Keep filesystem and process effects behind injectable services.
- Preserve deterministic rendering, lock-file behavior, and source-policy checks.
- Add or update focused Vitest coverage for behavior changes.
- Run `npm run lint`, `npm run format:check`, `npm test`, `npm run check`, and `npm run build` in `packages/trellage-cli`.
