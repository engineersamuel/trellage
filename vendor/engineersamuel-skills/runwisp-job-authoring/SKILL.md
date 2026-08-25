---
name: runwisp-job-authoring
description: Use when creating, changing, debugging, or validating RunWisp filesystem job packages, job.toml manifests, or runwisp-job doctor/run behavior.
---

# RunWisp Job Authoring

Keep these locations distinct:

- **Job repository**: repository containing the job package.
- **Jobkit source**: prefer a local Jobkit checkout matching the runtime Jobkit version; otherwise use `https://github.com/engineersamuel/runwisp-jobkit` at its matching tag or commit. If the version is unknown, use the default branch and state that assumption.
- **Scheduler/runtime configuration**: actual scheduler and runtime configuration.

## Workflow

1. Identify the target package from the request. If multiple `job.toml` files are plausible, ask which one; set `JOB_DIR` to its directory. From that path, use host repository-instruction discovery. Separately read the Jobkit source's `README.md`, `docs/authoring.md`, relevant implementation/tests, and `examples/`. Never resolve these paths relative to the job repository or installed skill.
2. Follow the closest current Jobkit example and job-repository conventions. Do not implement undocumented external behavior.
3. Package owns dependencies, forwarded-argument validation, side effects, output, exit codes, and runtime inputs.
4. Run package tests, then `runwisp-job doctor JOB_DIR` with the filesystem, environment, and user context the scheduler will use.
5. When available, verify forwarded arguments with a safe dry run through `runwisp-job run JOB_DIR [ARG ...]`. Side effects require authorization.

## Manifest

Jobkit recognizes only seven fields; unknown fields are rejected. Confirm required fields and defaults against the Jobkit source documentation:

| Field | Purpose |
| --- | --- |
| `schema` | Supported manifest schema. |
| `id` | Nonempty diagnostic label, not a registry key. |
| `kind` | Current execution kind. |
| `cwd` | Working directory relative to the job directory. |
| `argv` | Nonempty executable and argument vector. |
| `required_env` | Names whose values must be present and nonblank. |
| `required_files` | Relative, readable regular files needed at runtime. |

`cwd` and every `required_files` entry must be relative and resolve inside the job directory. The working directory must be accessible; required files must be readable regular files. Reject absolute paths, parent traversal, and symlink escapes. Put only environment variable names in the manifest. Never expose secret values in manifests, examples, logs, tests, or public files.

Preserve shell-free `argv`: Jobkit appends forwarded arguments unchanged without shell parsing. Use a shell only when required; the job then owns quoting and safety.

## Evidence boundaries

`doctor` is passive: it checks the manifest, paths, nonblank environment values, files, and executable without running the job or printing values. A pass does not prove runtime behavior, forwarded arguments, external services, or side effects.

On `run`, Jobkit changes to `cwd` and replaces itself with the job. Stdout, stderr, exit status, and signals come from the job.

Jobkit does not discover jobs, install dependencies, store secrets, configure schedules, or provide a sandbox. For schedule, retry, notification, secret injection, deployment path, or service-account work, inspect the scheduler/runtime configuration and its authoritative schema separately. If you cannot locate it, report the blocker. Do not infer these details from Jobkit or invent private deployment details.
