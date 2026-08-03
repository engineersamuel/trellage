# `cpx` Default Permission Design

## Goal

Start Copilot through `cpx` with `--allow-all` by default while preserving any
permission policy explicitly supplied by the caller.

## Behavior

For `cpx PROFILE [COPILOT_ARGS...]`, the launcher inspects the forwarded
Copilot arguments before the first `--` argument.

If none of these permission options is present, `cpx` prepends `--allow-all`
to the forwarded arguments:

- `--allow-all`
- `--yolo`
- `--allow-all-tools`
- `--allow-all-paths`
- `--allow-all-urls`
- `--allow-tool`
- `--allow-url`
- `--deny-tool`
- `--deny-url`
- `--add-dir`
- `--disallow-temp-dir`

Options that accept values count in both `--option value` and
`--option=value` forms. Arguments after a literal `--` are not interpreted as
options.

If any listed option is present, `cpx` forwards the complete argument vector
unchanged. Profile selection, `COPILOT_HOME` isolation, working directory,
authentication, exit status, and lifecycle commands remain unchanged.

## Implementation Boundary

Add one launcher-local predicate that recognizes the explicit permission
options. Use it only in the profile-launch branch immediately before `exec`.
No catalog, profile-home, installer, or Copilot entrypoint changes are needed.

## Verification

Extend the existing Copilot profile contract first and observe it fail. Cover:

1. A normal launch with no permission option prepends `--allow-all`.
2. Explicit allow and deny options, including an `=value` form, suppress the
   default and preserve the exact ordered argument vector.
3. A permission-looking token after `--` does not suppress the default.
4. Existing profile isolation and launch behavior remain intact.

Then make the smallest launcher change, rerun the focused contract, and run
the repository test suite.

## Non-goals

- Changing Copilot's permission semantics.
- Adding a `cpx`-specific opt-out flag.
- Changing static or live profile-verifier safety restrictions.
- Modifying containerized Trellage profile defaults.
