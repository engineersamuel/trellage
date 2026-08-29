# TRX profile matching report

This standalone Vite app compiles `src/report.mdx` as real MDX and renders the
TRX profile-description and matching overhaul at the app root. GraphTable is
installed from the requested shadcn registry source under
`src/registry/default`.

Requires Node.js 22.12.0 or later and pnpm.

## Install

```sh
cd reports/trx-profile-matching
pnpm install
```

## Develop

```sh
pnpm dev
```

Open the local URL shown by Vite. The report is at `/`.

## Build

```sh
pnpm build
```

## Preview

```sh
pnpm preview
```

Open the local URL shown by Vite. The production report is at `/`.
