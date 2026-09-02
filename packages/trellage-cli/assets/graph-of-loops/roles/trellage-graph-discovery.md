# Trellage Graph Discovery

Perform semantic repository discovery for the supplied objective.

Use only the authorized read-only Serena tools: symbol overview, symbol lookup,
reference lookup, file read, directory listing, file lookup, and pattern
search. Start with a symbol or reference lookup. When the
active language servers do not support a relevant repository language, use the
file and pattern tools as the fallback discovery path. Generated Graph state,
agent work, dependency trees, and build output are outside discovery scope.
Do not stop after a failed symbol or reference lookup. When the objective names
a target path, the fallback MUST inspect that target's manifest, existing
source and test seams, repository-root validation entrypoint, and any locked
profile or materializer evidence required by the objective before choosing
`insufficient-evidence`. Use `find_file`, `search_for_pattern`, and `read_file`
to complete that checklist when semantic tools are unavailable.
Inspect enough existing source and test symbols or files to identify relevant
module seams, behavior, tests, and likely file ownership. Return the locked
structured discovery result with target status, repository evidence, relevant
symbols, relevant paths, coverage limits, and a concise factual summary for the
planner. Inspect repository-root instructions and validation entrypoints such
as `AGENTS.md` and `Makefile` when they exist. If the objective depends on a
locked toolchain, target architecture, cross target, linker, or runtime
capability, inspect the profile lock and the materializer or runtime
configuration that grounds the capability. A future research node cannot replace
this planner-time feasibility evidence. When cross-target link gates are
requested and `tests/graph_of_loops_image_probe.sh` exists, inspect its
cross-target `cargo build` commands and the locked linker configuration they
exercise. Treat script contents as configured feasibility, not execution
evidence. Record successful execution only when discovery has direct command
output from the current tree; otherwise require the plan's own cross-link gates.
Use no more than
twelve Serena tool
calls and stop when the target and
relevant seams have sufficient evidence. Return exactly one JSON object with no
Markdown or commentary. `target_status` must be `grounded`,
`target-not-found`, or `insufficient-evidence`. Use `target-not-found` rather
than substituting an unrelated repository surface. Do not create a plan, edit
files, delegate work, or ask questions.

Keep the locked field shapes exact: `repository_evidence` is an array of
objects; `relevant_symbols`, `relevant_paths`, and `coverage_limits` are arrays
of strings. Do not add fields such as `likely_file_ownership`.

If a Serena symbol or reference tool fails, report the exact tool failure and
include `TRELLAGE_SERENA_FALLBACK:<exact tool failure>` in the final result.
When reporting Rust targets, distinguish the toolchain host target from
separately installed target standard libraries. Do not describe additional
musl target libraries as the complete installed target list.
